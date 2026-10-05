'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface StreamSegment {
  url: string
  backups: string[]
  /** 分片时长（秒） */
  length: number
  size: number
}

export interface StreamInfo {
  /** 流格式：dash = dash.js/MSE 播放（支持 1080P+）；mp4 = 渐进式回退（上限 720P） */
  type: 'dash' | 'mp4'
  /** B站实际授予的画质 */
  quality: number
  /** 可选画质列表（B站 accept_quality，含未登录时的限制） */
  qualities: { qn: number; desc: string }[]
  segments: StreamSegment[]
  /** dash 模式：服务端生成的 MPD 清单（XML 文本，媒体经本站代理） */
  mpd?: string
  /** 总时长（秒） */
  totalLength: number
  /** 服务端是否配置了 B站登录凭证 */
  logged: boolean
}

interface UseBiliStreamResult {
  stream: StreamInfo | null
  loading: boolean
  error: string | null
  errorCode: string | null
  reload: () => void
  /** 取流序号：每次手动 reload 递增（重试/登录刷新后强制重新装载播放器） */
  seq: number
}

const streamCache = new Map<string, { ts: number; data: StreamInfo }>()
const CACHE_TTL = 8 * 60 * 1000

/** 清空客户端流缓存（扫码登录成功后调用，强制下次取流走服务端新凭据） */
export function clearBiliStreamClientCache(): void {
  streamCache.clear()
}

/* ---- DASH（MSE）能力探测：决定向服务端请求的流格式 ----
 * dash.js 需要 MediaSource Extensions 播放音视频分离的 fMP4。
 * 老 iOS Safari（<17.1）无 MSE → 自动回退渐进式 MP4（上限 720P）。 */
let dashSupport: boolean | null = null
export function supportsDashPlayback(): boolean {
  if (dashSupport !== null) return dashSupport
  try {
    dashSupport =
      typeof window !== 'undefined' &&
      typeof (window as { MediaSource?: unknown }).MediaSource !== 'undefined' &&
      typeof window.MediaSource.isTypeSupported === 'function' &&
      window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"')
  } catch {
    dashSupport = false
  }
  return dashSupport
}

/**
 * 加载某个视频（bvid+page+qn）的真实视频流：
 * 调用 /api/bili/playurl → dash（MPD）或 mp4（分片地址）+ 实际画质 + 画质列表
 * 同 key 结果内存缓存 8 分钟（切换画质再切回时秒开）
 */
export function useBiliStream(bvid: string | null, page: number, qn: number, enabled: boolean): UseBiliStreamResult {
  const [stream, setStream] = useState<StreamInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const seqRef = useRef(0)
  const ctrlRef = useRef<AbortController | null>(null)

  // MSE 能力仅在客户端可知；SSR/hydration 阶段保持 false，挂载后重算
  const [dashOk, setDashOk] = useState(false)
  useEffect(() => {
    setDashOk(supportsDashPlayback())
  }, [])

  const fmt = dashOk ? 'dash' : 'mp4'

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    seqRef.current += 1
    const seq = seqRef.current

    const run = async () => {
      // 先让出一个微任务，避免在 effect 体内同步 setState（React Compiler 规则）
      await Promise.resolve()
      if (seq !== seqRef.current) return

      if (!enabled || !bvid) {
        setStream(null)
        setLoading(false)
        setError(null)
        setErrorCode(null)
        return
      }

      const key = `${bvid}|${page}|${qn}|${fmt}`
      const cached = streamCache.get(key)
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        setStream(cached.data)
        setLoading(false)
        setError(null)
        setErrorCode(null)
        return
      }

      setLoading(true)
      setError(null)
      setErrorCode(null)

      const controller = new AbortController()
      ctrlRef.current = controller
      try {
        const res = await fetch(`/api/bili/playurl?bvid=${bvid}&page=${page}&qn=${qn}&fmt=${fmt}`, {
          signal: controller.signal,
        })
        if (seq !== seqRef.current) return
        const json = await res.json().catch(() => null)
        if (seq !== seqRef.current) return
        if (!res.ok || !json?.ok) {
          setError(json?.error || `加载视频流失败（${res.status}）`)
          setErrorCode(json?.code || String(res.status))
          setStream(null)
          return
        }
        const info: StreamInfo = {
          type: json.type === 'dash' && json.mpd ? 'dash' : 'mp4',
          quality: json.quality,
          qualities: json.qualities || [],
          segments: json.segments || [],
          mpd: json.mpd,
          totalLength: json.totalLength || 0,
          logged: !!json.logged,
        }
        streamCache.set(key, { ts: Date.now(), data: info })
        setStream(info)
      } catch (err: unknown) {
        if ((err as Error).name === 'AbortError' || seq !== seqRef.current) return
        setError('网络异常，视频流加载失败')
        setErrorCode('NETWORK')
        setStream(null)
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    }

    void run()

    return () => {
      ctrlRef.current?.abort()
      ctrlRef.current = null
    }
  }, [bvid, page, qn, fmt, enabled, tick])

  return useMemo(
    () => ({ stream, loading, error, errorCode, reload, seq: tick }),
    [stream, loading, error, errorCode, reload, tick]
  )
}
