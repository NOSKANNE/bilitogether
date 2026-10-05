'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DetailedHTMLProps,
  type RefObject,
  type VideoHTMLAttributes,
} from 'react'
import { buildEmbedUrl, buildPostMessageProbes } from '@/lib/bili'
import { estimatePosition, type ControlAction, type PlaybackState, type PlaylistItem } from '@/lib/room-types'
import { useBiliStream, type StreamInfo } from '@/hooks/use-bili-stream'

export type PlayerMode = 'native' | 'iframe'

interface UseSyncPlayerArgs {
  playback: PlaybackState | null
  isOwner: boolean
  playlist: PlaylistItem[]
  sendControl: (payload: ControlAction) => Promise<{ ok: boolean; error?: string }>
  sendTick: (position: number, playing: boolean) => void
  sendWatch: (deltaSeconds: number) => void
  autoNext: boolean
  /** native: 真实视频流（支持真画质切换）；iframe: B站外链播放器（兼容模式） */
  mode: PlayerMode
}

export interface SyncPlayerState {
  mode: PlayerMode
  hasVideo: boolean
  getEstimate: () => number
  resyncSelf: () => void
  /* ---- native 模式 ---- */
  videoRef: RefObject<HTMLVideoElement | null>
  videoProps: DetailedHTMLProps<VideoHTMLAttributes<HTMLVideoElement>, HTMLVideoElement>
  activeSrc: string
  streamLoading: boolean
  streamError: string | null
  streamErrorCode: string | null
  streamReady: boolean
  grantedQn: number | null
  qualities: { qn: number; desc: string }[]
  /** 请求画质高于实际授予（未登录 1080P 降级等） */
  qualityDowngraded: boolean
  /** 服务端是否已配置 BILI_SESSDATA（决定是否展示解锁指引） */
  streamLogged: boolean
  /** 流格式：dash（MSE，支持 1080P+）/ mp4（渐进式回退） */
  streamType: 'dash' | 'mp4' | null
  /** 流的真实总时长（秒），0 表示未知 */
  totalLength: number
  needsGesture: boolean
  locallyPlaying: boolean
  retryStream: () => void
  retryPlayback: () => void
  getRealPosition: () => number | null
  /* ---- iframe 兼容模式 ---- */
  iframeSrc: string
  iframeKey: number
  directApi: boolean
}

const clampPos = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** dash.js 最小结构类型（避免静态引入打包体积；运行时动态 import） */
interface DashPlayerLike {
  initialize(view?: HTMLVideoElement, source?: string, autoPlay?: boolean, startTime?: number): void
  updateSettings(settings: unknown): void
  reset(): void
  on(type: string, listener: (e: { error?: { code?: unknown; message?: string }; type?: string }) => void): void
}

/**
 * 同步引擎 v2（双模式 + 双流格式）：
 *
 * 【native 原生模式 · dash 流（默认，浏览器支持 MSE）】
 * - useBiliStream 调 /api/bili/playurl?fmt=dash → 服务端返回 MPD（媒体经本站代理）
 * - dash.js（动态 import，MSE）接管 <video>：音视频分离 fMP4，支持 1080P/4K
 * - 任意 seek = video.currentTime（sidx 索引按字节范围拉取分片）
 * - dash.js 致命错误 → 自动 retryStream（最多 2 次，播放成功后重置）
 *
 * 【native 原生模式 · mp4 流（MSE 不可用回退 / DASH 解析失败）】
 * - 渐进式 MP4（platform=html5，上限 720P），多分片 durl 顺序播放
 * - 换片/换P：seek 到服务器估算进度；仅换画质：保持本地 currentTime 无缝切换
 * - onError 自动切备用地址
 *
 * 【共通同步机制】
 * - revision 变化 → 应用 play/pause + 大偏差 seek（>1.5s）
 * - 跟随者每 4s 漂移校正（>2.5s 才动）；房主每 2s 心跳上报「真实 currentTime」
 * - autoplay 被浏览器拒绝 → needsGesture 覆盖层，点击后恢复
 *
 * 【iframe 兼容模式】
 * - 原 v1 逻辑：状态变化重建 iframe URL（t=估算进度）
 */
export function useSyncPlayer({
  playback,
  isOwner,
  playlist,
  sendControl,
  sendTick,
  sendWatch,
  autoNext,
  mode,
}: UseSyncPlayerArgs): SyncPlayerState {
  /* ---------------- 公共状态 ---------------- */
  const [iframeSrc, setIframeSrc] = useState('')
  const [iframeKey, setIframeKey] = useState(0)
  const [directApi, setDirectApi] = useState(false)
  const anchorRef = useRef<{ position: number; atMs: number; playing: boolean }>({ position: 0, atMs: Date.now(), playing: false })
  const lastAutoNextRef = useRef(0)
  const playbackRef = useRef<PlaybackState | null>(null)
  useEffect(() => {
    playbackRef.current = playback
  }, [playback])

  // 锚点跟随（tick 不改 revision，只更新锚点）
  useEffect(() => {
    if (!playback) return
    anchorRef.current = { position: playback.position, atMs: Date.now(), playing: playback.playing }
  }, [playback?.position, playback?.updatedAt, playback?.playing])

  const computeEstimate = useCallback(() => {
    const pb = playbackRef.current
    if (!pb) return 0
    return estimatePosition(pb, Date.now())
  }, [])

  /* ---------------- native：流加载 ---------------- */
  const pbBvid = playback?.bvid || null
  const pbPage = playback?.page || 1
  const pbQn = playback?.qn || 64
  const { stream, loading: streamLoading, error: streamError, errorCode: streamErrorCode, reload: retryStream, seq: streamSeq } =
    useBiliStream(pbBvid, pbPage, pbQn, mode === 'native')

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [activeSrc, setActiveSrc] = useState('')
  const [needsGesture, setNeedsGesture] = useState(false)
  const [locallyPlaying, setLocallyPlaying] = useState(false)

  const streamRef = useRef<StreamInfo | null>(null)
  useEffect(() => {
    streamRef.current = stream
  }, [stream])

  const segIndexRef = useRef(0)
  const pendingSeekRef = useRef<number | null>(null) // 分片内/全局偏移秒
  const appliedRevisionRef = useRef(0)
  const lastDriftFixRef = useRef(0)

  /* ---- dash.js 实例管理 ---- */
  const dashRef = useRef<{ dp: DashPlayerLike; key: string } | null>(null)
  const dashBlobRef = useRef<string | null>(null)
  const dashRetryRef = useRef(0)

  /* 装载守卫（dash 销毁时重置，支持严格模式二次挂载与重试） */
  const lastLoadedKeyRef = useRef('')

  const destroyDash = useCallback(() => {
    const entry = dashRef.current
    dashRef.current = null
    if (entry) {
      try {
        entry.dp.reset()
      } catch {
        /* noop */
      }
    }
    if (dashBlobRef.current) {
      try {
        URL.revokeObjectURL(dashBlobRef.current)
      } catch {
        /* noop */
      }
      dashBlobRef.current = null
    }
    // 严格模式二次挂载后能重新装载：重置 loadKey 守卫
    lastLoadedKeyRef.current = ''
  }, [])

  /* 卸载时销毁 dash 实例（防泄漏） */
  useEffect(() => destroyDash, [destroyDash])

  const segOffset = useCallback((index: number): number => {
    const segs = streamRef.current?.segments
    if (!segs) return 0
    let acc = 0
    for (let i = 0; i < Math.min(index, segs.length); i++) acc += segs[i].length || 0
    return acc
  }, [])

  const getRealPosition = useCallback((): number | null => {
    const video = videoRef.current
    if (!video || video.readyState < 1 || !streamRef.current) return null
    // dash：单文件完整时间线，currentTime 即全局进度
    if (streamRef.current.type === 'dash') return video.currentTime
    return segOffset(segIndexRef.current) + video.currentTime
  }, [segOffset])

  const getEstimate = useCallback(() => {
    if (mode === 'native') {
      const real = getRealPosition()
      if (real !== null) return real
    }
    return computeEstimate()
  }, [mode, getRealPosition, computeEstimate])

  /** dash 媒体就绪前 play() 调用会落空/被打断，仅 mp4 或已就绪时应用 */
  const applyPlaying = useCallback((playing: boolean) => {
    const video = videoRef.current
    if (!video) return
    if (streamRef.current?.type === 'dash' && video.readyState < 1) return
    if (playing) {
      if (video.paused) {
        const p = video.play()
        if (p && typeof p.catch === 'function') {
          p.catch((err: DOMException) => {
            if (err?.name === 'NotAllowedError') setNeedsGesture(true)
          })
        }
      }
    } else if (!video.paused) {
      video.pause()
    }
  }, [])

  /** 全局时间位置 seek（dash：直接 currentTime；mp4：跨分片换 src） */
  const seekGlobal = useCallback(
    (globalPos: number) => {
      const video = videoRef.current
      const st = streamRef.current
      if (!video) return
      if (!st) {
        video.currentTime = Math.max(0, globalPos)
        return
      }
      if (st.type === 'dash') {
        const total = st.totalLength || 0
        const realDur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : total
        const maxPos = Math.max(0.5, (realDur > 0 ? realDur : total) - 0.4)
        try {
          video.currentTime = clampPos(globalPos, 0, maxPos)
        } catch {
          /* MSE 未就绪时忽略；漂移校正会再试 */
        }
        return
      }
      const segs = st.segments
      if (!segs || segs.length === 0) {
        video.currentTime = Math.max(0, globalPos)
        return
      }
      const total = st.totalLength || segs.reduce((s, x) => s + (x.length || 0), 0)
      // 元数据里的分片长度可能与实际媒体时长略有出入，以真实 duration 为准（若已知）
      const realDur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : total
      const maxPos = Math.max(0.5, total - Math.max(0.5, total - realDur) - 0.4)
      const pos = clampPos(globalPos, 0, maxPos)
      let acc = 0
      for (let i = 0; i < segs.length; i++) {
        const len = segs[i].length || 0
        if (pos < acc + len || i === segs.length - 1) {
          const segLen = i === segIndexRef.current && realDur === len ? realDur : len
          const within = clampPos(pos - acc, 0, Math.max(0.1, segLen - 0.4))
          if (i !== segIndexRef.current) {
            segIndexRef.current = i
            pendingSeekRef.current = within
            setActiveSrc(segs[i].url)
          } else {
            try {
              video.currentTime = within
            } catch {
              pendingSeekRef.current = within
            }
          }
          return
        }
        acc += len
      }
    },
    []
  )

  /* ---- native：流到达 / 媒体变化 → 装载 ---- */
  useEffect(() => {
    if (mode !== 'native') return
    const st = stream
    if (!st) return

    const video = videoRef.current
    if (!video) return

    const isDash = st.type === 'dash' && !!st.mpd
    const loadKey = `${pbBvid}|${pbPage}|${pbQn}|${st.quality}|${st.type}|${streamSeq}`
    if (loadKey === lastLoadedKeyRef.current) return
    const isFirstLoad = lastLoadedKeyRef.current === ''
    const prevKey = lastLoadedKeyRef.current

    const qnOnlyChange =
      !isFirstLoad && prevKey.split('|').slice(0, 2).join('|') === `${pbBvid}|${pbPage}`

    // 起始位置：仅换画质/重试 → 保持本地进度；换片 → 服务器估算进度
    let startAt: number
    if (qnOnlyChange && video.readyState >= 1) {
      startAt = getRealPosition() ?? computeEstimate()
    } else {
      segIndexRef.current = 0
      startAt = computeEstimate()
      const pb = playbackRef.current
      if (pb && pb.duration > 0 && startAt >= pb.duration - 1) startAt = Math.max(0, pb.duration - 1)
    }

    // 销毁旧装载（mp4 场景为 no-op；重置 loadKey 守卫后再写入新 key）
    destroyDash()
    lastLoadedKeyRef.current = loadKey

    if (isDash) {
      /* ---------- dash.js 装载 ---------- */
      segIndexRef.current = 0
      // MPD 里的媒体 BaseURL 是相对路径（/api/bili/media…）。dash.js 以 manifest 自身
      // URL 为 base 做解析，而 manifest 是 blob: URL —— 相对路径会解析失败导致零请求。
      // 必须先改写为浏览器自身的绝对地址，再放进 blob 清单。
      const mpdText = st.mpd!.replace(
        /(<BaseURL>)\/api\/bili\/media/g,
        `$1${window.location.origin}/api/bili/media`
      )
      const blob = URL.createObjectURL(new Blob([mpdText], { type: 'application/dash+xml' }))
      dashBlobRef.current = blob
      // 起始位置用 dash.js 原生 startTime 参数（在 MSE 建立前即定向分片加载）。
      // 不能走 pendingSeek@loadedmetadata：MSE open 前后时序竞态会吞掉大 seek。
      const dashStartAt = clampPos(startAt, 0, Math.max(0.1, (st.totalLength || computeEstimate()) - 0.3))
      let cancelled = false
      void (async () => {
        try {
          const mod = await import('dashjs')
          if (cancelled || videoRef.current !== video) return
          const factory = (mod as unknown as { MediaPlayer?: () => { create(): DashPlayerLike }; default?: { MediaPlayer?: () => { create(): DashPlayerLike } } })
          const MP = factory.MediaPlayer || factory.default?.MediaPlayer
          if (!MP) throw new Error('dashjs MediaPlayer factory missing')
          const dp = MP().create()
          dp.updateSettings({
            streaming: {
              abr: { autoSwitchBitrate: { video: false, audio: false } },
              // B站 CDN 经代理偶发 403 抖动（代理已重试），这里再提高 dash.js 侧容忍度，
              // 避免单次分片失败就触发 error → 全量重装
              retryAttempts: { MediaSegment: 5, InitializationSegment: 5, IndexSegment: 5, MPD: 3 },
              retryIntervals: { MediaSegment: 400, InitializationSegment: 400, IndexSegment: 400 },
            },
          })
          dp.on('error', () => {
            // dash.js v5 的 error 事件无 severity 字段；下载/致命错误统一自动重试（限次，
            // 成功起播后重置）。retryStream 会重新取流并以当前进度重装播放器。
            if (dashRetryRef.current < 2) {
              dashRetryRef.current += 1
              setTimeout(() => retryStream(), 800)
            }
          })
          dp.on('playbackStarted', () => {
            dashRetryRef.current = 0
            setNeedsGesture(false)
          })
          dp.initialize(video, blob, false, dashStartAt)
          dashRef.current = { dp, key: loadKey }
        } catch {
          // dash.js 加载失败（极端环境）→ 回退 mp4 流
          if (!cancelled) retryStream()
        }
      })()
      // 播放状态在 loadedmetadata（MSE 元数据就绪）时由 handleLoadedMetadata 应用
      return () => {
        cancelled = true
      }
    }

    /* ---------- 渐进式 mp4 装载（多分片顺序播） ---------- */
    const segs = st.segments
    if (!segs || segs.length === 0) return

    video.dataset.backupTried = '0'
    const idx = Math.min(segIndexRef.current, segs.length - 1)
    segIndexRef.current = idx
    const targetUrl = segs[idx].url
    setActiveSrc(targetUrl)
    pendingSeekRef.current = clampPos(startAt - segOffset(idx), 0, Math.max(0.1, (segs[idx].length || 0) - 0.3))

    // 仅当 video 当前加载的已是目标流（如同 URL 重试）时才立即 seek；
    // 若 src 即将变化，必须把 pendingSeek 留给 loadedmetadata 事件（否则旧元素上 seek 会被重置）
    if (video.readyState >= 1 && (video.currentSrc === targetUrl || video.src === targetUrl)) {
      try {
        video.currentTime = pendingSeekRef.current
        pendingSeekRef.current = null
      } catch {
        /* 等 loadedmetadata */
      }
    }
    applyPlaying(!!playbackRef.current?.playing)
  }, [stream, streamSeq, pbBvid, pbPage, pbQn, mode, segOffset, computeEstimate, getRealPosition, applyPlaying, destroyDash, retryStream])

  /* ---- native：revision 变化 → 播放/暂停 + 偏差校正 ---- */
  useEffect(() => {
    if (mode !== 'native' || !playback || !playback.bvid) return
    if (playback.revision === appliedRevisionRef.current) return
    appliedRevisionRef.current = playback.revision

    const video = videoRef.current
    if (!video || !streamRef.current) return
    const target = estimatePosition(playback, Date.now())
    anchorRef.current = { position: target, atMs: Date.now(), playing: playback.playing }

    const real = getRealPosition()
    if (real !== null && Math.abs(real - target) > 1.5) {
      seekGlobal(target)
    }
    applyPlaying(playback.playing)
  }, [playback, mode, getRealPosition, seekGlobal, applyPlaying])

  /* ---- native：跟随者对「播放状态翻转」作出反应（含无 revision 的 tick） ----
   * 房主视频被浏览器后台节流暂停/媒体键暂停/播完后自动暂停等场景不会产生 control
   * 动作（revision 不变），真实状态只随 playback:tick 到达。若只在 revision 门控里
   * 应用播放/暂停，跟随者将永远错过这些翻转（漂移校正在 pb.playing=false 时禁用），
   * 导致房主已暂停而跟随者一直播到片尾。此处在 playing 值翻转时立即对齐状态与位置。 */
  const lastPlayingRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (mode !== 'native' || !playback?.bvid) return
    const playing = !!playback.playing
    const prev = lastPlayingRef.current
    lastPlayingRef.current = playing
    if (prev === null || prev === playing) return
    const video = videoRef.current
    if (!video || !streamRef.current) return
    if (pendingSeekRef.current !== null) return // 新媒体装载中，loadedmetadata 后会应用最新状态
    const target = estimatePosition(playback, Date.now())
    anchorRef.current = { position: target, atMs: Date.now(), playing }
    const real = getRealPosition()
    if (real !== null && Math.abs(real - target) > 1.5) {
      seekGlobal(target)
    }
    applyPlaying(playing)
  }, [playback, mode, getRealPosition, seekGlobal, applyPlaying])

  /* ---- native：视频事件桥 ---- */
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    // 新媒体加载后 playbackRate 会重置为默认值，重新应用房间倍速
    const rate = playbackRef.current?.rate || 1
    if (video.playbackRate !== rate) {
      try {
        video.playbackRate = rate
      } catch {
        /* noop */
      }
    }
    if (pendingSeekRef.current !== null) {
      try {
        video.currentTime = pendingSeekRef.current
      } catch {
        /* noop */
      }
      pendingSeekRef.current = null
    }
    applyPlaying(!!playbackRef.current?.playing)
  }, [applyPlaying])

  const handleEnded = useCallback(() => {
    // mp4 多分片：继续下一段
    const st = streamRef.current
    if (st?.type === 'mp4') {
      const segs = st.segments
      if (segs && segIndexRef.current < segs.length - 1) {
        const next = segIndexRef.current + 1
        segIndexRef.current = next
        setActiveSrc(segs[next].url)
        return
      }
    }
    // 播完（或 dash 单文件播完）
    const pb = playbackRef.current
    if (isOwner && pb) {
      const loop = pb.loop || 'off'
      // 单曲循环：从头重播（play position=0，服务端 revision++ 后全员同步）
      if (loop === 'one') {
        const now = Date.now()
        if (now - lastAutoNextRef.current > 5000) {
          lastAutoNextRef.current = now
          void sendControl({ action: 'play', position: 0 })
          return
        }
      }
      // 列表循环 / 顺序连播：播下一集（列表循环支持回绕到第一个）
      if (autoNext || loop === 'list') {
        const idx = playlist.findIndex((p) => p.bvid === pb.bvid && p.page === pb.page)
        if (idx >= 0) {
          const nextIdx = idx < playlist.length - 1 ? idx + 1 : loop === 'list' ? 0 : -1
          if (nextIdx >= 0 && playlist[nextIdx]) {
            const now = Date.now()
            if (now - lastAutoNextRef.current > 10000) {
              lastAutoNextRef.current = now
              void sendControl({ action: 'playPlaylistItem', itemId: playlist[nextIdx].id })
              return
            }
          }
        }
      }
      void sendControl({ action: 'pause', position: pb.duration || getRealPosition() || 0 })
    }
  }, [isOwner, autoNext, playlist, sendControl, getRealPosition])

  const handleError = useCallback(() => {
    // dash 模式的错误由 dash.js 'error' 事件桥接处理；此处仅处理 mp4 渐进流
    const st = streamRef.current
    if (!st || st.type !== 'mp4') return
    const video = videoRef.current
    const segs = st.segments
    if (!video || !segs || segs.length === 0) return
    const cur = segs[segIndexRef.current]
    if (!cur) return
    // 播放中出错：记住当前分片内进度，切备用地址后从原位续播（回退 0.5s 重新缓冲）
    const resumeAt = video.currentTime > 1 ? Math.max(0, video.currentTime - 0.5) : null
    // 依次尝试备用地址
    const tried = Number(video.dataset.backupTried || 0)
    if (tried < cur.backups.length) {
      video.dataset.backupTried = String(tried + 1)
      if (resumeAt !== null) pendingSeekRef.current = resumeAt
      setActiveSrc(cur.backups[tried])
    } else if (segIndexRef.current === 0 && segs.length > 1) {
      // 主分片全挂 → 尝试第二分片（罕见）；若同片内进度超出第二分片时长则从头开始
      const nextLen = segs[1].length || 0
      segIndexRef.current = 1
      if (resumeAt !== null && nextLen > 0 && resumeAt < nextLen - 0.5) {
        pendingSeekRef.current = resumeAt
      }
      setActiveSrc(segs[1].url)
    }
    // 其余情况保持错误态，由 UI 提示重试
  }, [])

  const handlePlayEvt = useCallback(() => {
    setLocallyPlaying(true)
    setNeedsGesture(false)
  }, [])
  const handlePauseEvt = useCallback(() => setLocallyPlaying(false), [])

  const retryPlayback = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const p = video.play()
    if (p && typeof p.catch === 'function') {
      p.catch(() => setNeedsGesture(true))
    }
  }, [])

  /* ---- native：房间倍速变化 → 应用到 video 元素 ---- */
  const pbRate = playback?.rate || 1
  useEffect(() => {
    if (mode !== 'native') return
    const video = videoRef.current
    if (!video) return
    const rate = pbRate > 0 ? pbRate : 1
    if (video.playbackRate !== rate) {
      try {
        video.playbackRate = rate
      } catch {
        /* 某些浏览器限制 rate 范围 */
      }
    }
  }, [pbRate, mode])

  /* ---- native：跟随者漂移校正（每 4s） ----
   * 两级校正策略：
   * ① 漂移 > 2.5s → 硬 seek（跳帧明显，仅在必要时）
   * ② 漂移 0.5~2.5s → 倍率微调 ±5%（无跳帧，平滑追平；1s 漂移约 20s 内无声消除）
   *    回差设计：0.5s 启动 / 0.3s 释放，避免来回抖动；对齐后恢复房间精确倍速 */
  useEffect(() => {
    if (mode !== 'native' || isOwner) return
    const timer = setInterval(() => {
      const pb = playbackRef.current
      const video = videoRef.current
      if (!pb?.bvid || !video || !streamRef.current) return
      if (video.readyState < 2 || pendingSeekRef.current !== null) return
      const target = estimatePosition(pb, Date.now())
      const real = getRealPosition()
      if (real === null) return
      const realPlaying = !video.paused && !video.ended
      // 兑底自愈：本地播放态与房间不一致（如丢失一次 tick 翻转）→ 对齐状态+位置。
      // 注意 autoplay 被拒（手势覆盖层）时 play() 会拒绝并维持覆盖层，无副作用。
      if (realPlaying !== pb.playing) {
        if (Date.now() - lastDriftFixRef.current > 4000) {
          lastDriftFixRef.current = Date.now()
          if (Math.abs(real - target) > 1.5) seekGlobal(target)
          applyPlaying(pb.playing)
        }
        return
      }
      const drift = real - target // >0 跟随者超前，<0 落后
      if (pb.playing && Math.abs(drift) > 2.5 && Date.now() - lastDriftFixRef.current > 8000) {
        lastDriftFixRef.current = Date.now()
        seekGlobal(target)
        // 回跳后若本地暂停而房间在播（如播完后被拉回），自动恢复播放
        if (video.paused) applyPlaying(true)
        return
      }
      // 亚阈值平滑追平：倍率微调，观感无跳帧（与首页「毫秒级同步」承诺对齐）
      if (pb.playing) {
        const roomRate = pb.rate && pb.rate > 0 ? pb.rate : 1
        try {
          if (drift < -0.5 && drift > -2.5) {
            const nudged = roomRate * 1.05
            if (Math.abs(video.playbackRate - nudged) > 0.001) video.playbackRate = nudged
          } else if (drift > 0.5 && drift < 2.5) {
            const nudged = roomRate * 0.95
            if (Math.abs(video.playbackRate - nudged) > 0.001) video.playbackRate = nudged
          } else if (Math.abs(drift) <= 0.3 && Math.abs(video.playbackRate - roomRate) > 0.001) {
            video.playbackRate = roomRate // 追平 → 恢复房间倍速
          }
        } catch {
          /* 某些浏览器限制 rate 范围 */
        }
      }
    }, 4000)
    return () => clearInterval(timer)
  }, [mode, isOwner, getRealPosition, seekGlobal, applyPlaying])

  /* ---- 跟随者播放态自愈 watchdog ----
   * 兜底 Task 16 已知边界：从流错误态恢复/新页面装载后 play() 被自动播放策略拒绝时，
   * needsGesture 置位存在装载时序竞态（play 事件清 flag 与 reject 置 flag 的时序交错），
   * 覆盖层可能不出现，跟随者停在暂停态无法自救。此处强制兜底：
   * 「房间在播 + 本地已缓冲却持续暂停」连续两个检查周期（~3.2s）→ 显示手势覆盖层。
   * 仅跟随者启用（房主本地暂停即权威状态，且拥有直接控制权）；ended/装载中不触发。 */
  useEffect(() => {
    if (mode !== 'native' || isOwner) return
    let stuck = 0
    const timer = setInterval(() => {
      const pb = playbackRef.current
      const video = videoRef.current
      if (
        !pb?.playing ||
        !video ||
        video.ended ||
        video.readyState < 2 ||
        pendingSeekRef.current !== null ||
        !video.paused
      ) {
        stuck = 0
        return
      }
      stuck += 1
      if (stuck >= 2) setNeedsGesture(true)
    }, 1600)
    return () => clearInterval(timer)
  }, [mode, isOwner])

  /* ---- 房主心跳：每 2s（native 用真实进度+真实播放状态） ----
   * 关键：隐藏标签页里 setInterval 会被浏览器节流（页面隐藏且无音频播放时可低至
   * 每分钟 1 次），房主切到后台后的暂停/恢复状态会延迟几十秒才到达跟随者。
   * Dedicated Worker 的定时器不受页面可见性节流，用它驱动心跳；创建失败降级 setInterval。 */
  useEffect(() => {
    if (!isOwner) return
    const tick = () => {
      const pb = playbackRef.current
      if (!pb?.bvid) return
      const est = getEstimate()
      // 直接读取 video 元素实时状态，避免 React 状态与真实播放状态脱节
      const video = videoRef.current
      const livePlaying = video ? !video.paused && !video.ended : null
      const playing = mode === 'native' ? (livePlaying ?? locallyPlaying) : pb.playing
      anchorRef.current = { position: est, atMs: Date.now(), playing }
      sendTick(est, playing)
    }
    let worker: Worker | null = null
    let url: string | null = null
    try {
      url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 2000)'], { type: 'text/javascript' }))
      worker = new Worker(url)
      worker.onmessage = tick
    } catch {
      worker = null
    }
    const fallback = worker ? null : setInterval(tick, 2000)
    return () => {
      worker?.terminate()
      if (url) URL.revokeObjectURL(url)
      if (fallback) clearInterval(fallback)
    }
  }, [isOwner, mode, locallyPlaying, getEstimate, sendTick])

  /* ---- 观看时长统计：真实播放中累计，每 15s 上报增量 ---- */
  useEffect(() => {
    if (!playback?.bvid) return
    let acc = 0
    const watcher = setInterval(() => {
      const v = videoRef.current
      const pb2 = playbackRef.current
      // 仅在「视频真实在播」时累计（不含暂停/加载/后台挂起）
      if (v && !v.paused && !v.ended && v.readyState >= 2 && pb2?.playing) {
        acc += 5
        if (acc >= 15) {
          const delta = acc
          acc = 0
          sendWatch(delta)
        }
      }
    }, 5000)
    return () => {
      clearInterval(watcher)
      if (acc > 0) sendWatch(acc)
    }
  }, [playback?.bvid, sendWatch])

  /* ---------------- iframe 兼容模式 ---------------- */
  const appliedMediaKeyRef = useRef('')
  useEffect(() => {
    if (mode !== 'iframe' || !playback || !playback.bvid) return
    const mediaKey = `${playback.bvid}|${playback.page}|${playback.qn}|${playback.danmaku}`
    const revisionChanged = playback.revision !== appliedRevisionRef.current
    const mediaChanged = mediaKey !== appliedMediaKeyRef.current
    if (!revisionChanged && !mediaChanged) return

    appliedMediaKeyRef.current = mediaKey
    appliedRevisionRef.current = playback.revision

    const est = estimatePosition(playback, Date.now())
    const src = buildEmbedUrl({
      bvid: playback.bvid,
      page: playback.page,
      qn: playback.qn,
      danmaku: playback.danmaku,
      autoplay: playback.playing,
      t: est,
    })
    anchorRef.current = { position: est, atMs: Date.now(), playing: playback.playing }
    setIframeSrc(src)
    setIframeKey((k) => k + 1)

    const timer = setTimeout(() => {
      try {
        const frame = document.querySelector<HTMLIFrameElement>('#bili-player-iframe')
        if (!frame?.contentWindow) return
        const probes = buildPostMessageProbes(playback.playing ? 'play' : 'pause')
        for (const p of probes) {
          frame.contentWindow.postMessage(p, 'https://player.bilibili.com')
        }
      } catch {
        /* 跨域探测失败属预期 */
      }
    }, 4000)
    return () => clearTimeout(timer)
  }, [playback, mode])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== 'https://player.bilibili.com') return
      setDirectApi(true)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const resyncSelf = useCallback(() => {
    if (mode === 'native') {
      const pb = playbackRef.current
      if (!pb?.bvid) return
      const target = estimatePosition(pb, Date.now())
      anchorRef.current = { position: target, atMs: Date.now(), playing: pb.playing }
      seekGlobal(target)
      applyPlaying(pb.playing)
      return
    }
    const pb = playbackRef.current
    if (!pb?.bvid) return
    const est = estimatePosition(pb, Date.now())
    const src = buildEmbedUrl({
      bvid: pb.bvid,
      page: pb.page,
      qn: pb.qn,
      danmaku: pb.danmaku,
      autoplay: pb.playing,
      t: est,
    })
    anchorRef.current = { position: est, atMs: Date.now(), playing: pb.playing }
    setIframeSrc(src)
    setIframeKey((k) => k + 1)
  }, [mode, seekGlobal, applyPlaying])

  const hasVideo = !!playback?.bvid

  const grantedQn = stream?.quality ?? null
  const qualities = stream?.qualities ?? []
  const qualityDowngraded = grantedQn !== null && grantedQn < pbQn

  const videoProps: DetailedHTMLProps<VideoHTMLAttributes<HTMLVideoElement>, HTMLVideoElement> = useMemo(
    () => ({
      ref: videoRef,
      // dash 模式下 src 必须为空（dash.js 以 MSE 供流，设置 src 会覆盖 MediaSource）
      src: stream?.type === 'dash' ? undefined : activeSrc || undefined,
      playsInline: true,
      preload: 'auto',
      referrerPolicy: 'no-referrer',
      onLoadedMetadata: handleLoadedMetadata,
      onError: handleError,
      onEnded: handleEnded,
      onPlay: handlePlayEvt,
      onPause: handlePauseEvt,
    }),
    [stream?.type, activeSrc, handleLoadedMetadata, handleError, handleEnded, handlePlayEvt, handlePauseEvt]
  )

  return useMemo(
    () => ({
      mode,
      hasVideo,
      getEstimate,
      resyncSelf,
      videoRef,
      videoProps,
      activeSrc,
      streamLoading,
      streamError,
      streamErrorCode,
      streamReady: !!stream,
      grantedQn,
      qualities,
      qualityDowngraded,
      streamLogged: !!stream?.logged,
      streamType: stream?.type ?? null,
      totalLength: stream?.totalLength ?? 0,
      needsGesture,
      locallyPlaying,
      retryStream,
      retryPlayback,
      getRealPosition,
      iframeSrc,
      iframeKey,
      directApi,
    }),
    [
      mode,
      hasVideo,
      getEstimate,
      resyncSelf,
      videoProps,
      activeSrc,
      streamLoading,
      streamError,
      streamErrorCode,
      stream,
      grantedQn,
      qualities,
      qualityDowngraded,
      needsGesture,
      locallyPlaying,
      retryStream,
      retryPlayback,
      getRealPosition,
      iframeSrc,
      iframeKey,
      directApi,
    ]
  )
}
