'use client'

import { useEffect, useMemo, useRef, useState, type DetailedHTMLProps, type RefObject, type VideoHTMLAttributes } from 'react'
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Download,
  Film,
  Gauge,
  Loader2,
  Maximize,
  MessageSquare,
  MessageSquareOff,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Send,
  Settings2,
  Sparkles,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import { formatTime, qualityLabel } from '@/lib/bili'
import type { DanmakuItem } from '@/hooks/use-danmaku'
import type { RoomMoment } from '@/lib/room-types'
import { DanmakuLayer } from '@/components/room/danmaku-layer'
import { EmojiPicker } from '@/components/room/emoji-picker'
import type { PlayerMode } from '@/hooks/use-sync-player'

interface PlayerStageProps {
  hasVideo: boolean
  isOwner: boolean
  title: string | null
  cover: string | null
  playing: boolean
  mode: PlayerMode
  /* native */
  videoProps: DetailedHTMLProps<VideoHTMLAttributes<HTMLVideoElement>, HTMLVideoElement>
  streamLoading: boolean
  streamError: string | null
  streamErrorCode: string | null
  grantedQn: number | null
  qualities: { qn: number; desc: string }[]
  qualityDowngraded: boolean
  needsGesture: boolean
  locallyPlaying: boolean
  onRetryStream: () => void
  onRetryPlayback: () => void
  onTogglePlay: () => void
  onQualityChange: (qn: number) => void
  onUseCompat: () => void
  /** 键盘左右键快速跳转（房主） */
  onSkip?: (delta: number) => void
  /* 弹幕 */
  danmakuItems: DanmakuItem[]
  danmakuRoomOn: boolean
  /* 发送弹幕：当前视频目标（原生模式才可发） */
  danmakuTarget: { bvid: string; page: number } | null
  selfUid: string
  /* 播放倍速（角标展示） */
  rate: number
  /* 精彩时刻：全员打点；房主点击时刻芯片跳转（原生模式） */
  moments: RoomMoment[]
  onAddMoment: (t: number) => void
  onSeekToMoment: (t: number) => void
  /** 取当前播放进度（打点用：优先本地 video 真实值，回退服务端估算） */
  getCurrentTime: () => number
  /* iframe */
  iframeSrc: string
  iframeKey: number
}

export function PlayerStage({
  hasVideo,
  isOwner,
  title,
  cover,
  playing,
  mode,
  videoProps,
  streamLoading,
  streamError,
  streamErrorCode,
  grantedQn,
  qualities,
  qualityDowngraded,
  needsGesture,
  locallyPlaying,
  onRetryStream,
  onRetryPlayback,
  onTogglePlay,
  onQualityChange,
  onUseCompat,
  onSkip,
  danmakuItems,
  danmakuRoomOn,
  danmakuTarget,
  selfUid,
  rate,
  moments,
  onAddMoment,
  onSeekToMoment,
  getCurrentTime,
  iframeSrc,
  iframeKey,
}: PlayerStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [muted, setMuted] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { toast } = useToast()

  /* ---- 发送弹幕（服务端统一凭据，未配置时优雅降级） ---- */
  const [dmText, setDmText] = useState('')
  const [dmSending, setDmSending] = useState(false)
  const sendDanmaku = async () => {
    const text = dmText.trim()
    if (!text || dmSending || !danmakuTarget) return
    setDmSending(true)
    try {
      const res = await fetch('/api/bili/danmaku/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bvid: danmakuTarget.bvid, page: danmakuTarget.page, text, uid: selfUid }),
      })
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (res.ok && json?.ok) {
        setDmText('')
        showHint('🎉 弹幕已发送（B站延迟几秒后可见）')
      } else {
        toast({
          title: '弹幕发送失败',
          description: json?.error || `请求失败（${res.status}）`,
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: '弹幕发送失败', description: '网络异常，请稍后再试', variant: 'destructive' })
    } finally {
      setDmSending(false)
    }
  }

  /* ---- 精彩时刻打点（全员；原生模式；快捷键 M） ---- */
  const addMoment = () => {
    if (mode !== 'native' || !hasVideo || streamLoading || streamError) return
    const t = Math.max(0, getCurrentTime())
    onAddMoment(t)
    showHint(`已打点 ⭐ ${formatTime(t)}`)
  }

  /* ---- 触屏设备：无 hover，点按视频呼出/隐藏控制条（自动隐藏） ---- */
  const isTouch = useMemo(
    () => (typeof window === 'undefined' ? false : window.matchMedia('(hover: none), (pointer: coarse)').matches),
    []
  )
  const [touchControls, setTouchControls] = useState(false)
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showTouchControls = () => {
    setTouchControls(true)
    if (touchTimer.current) clearTimeout(touchTimer.current)
    touchTimer.current = setTimeout(() => setTouchControls(false), 4000)
  }
  const hideTouchControls = () => {
    setTouchControls(false)
    if (touchTimer.current) clearTimeout(touchTimer.current)
  }

  /* ---- 弹幕本地偏好（每用户独立，持久化到 localStorage） ---- */
  const [dmLocalOn, setDmLocalOn] = useState(() => readDmPref('on', true))
  const [dmScale, setDmScale] = useState(() => readDmPref('scale', 1))
  const [dmOpacity, setDmOpacity] = useState(() => readDmPref('opacity', 0.9))
  const [dmSpeed, setDmSpeed] = useState(() => readDmPref('speed', 1))
  const [dmBlocked, setDmBlocked] = useState<string[]>(() => readDmBlockList())
  const [blockInput, setBlockInput] = useState('')
  /* 屏蔽词导入（粘贴 JSON 数组或逐行文本，自动去重合并，上限 50） */
  const [blockImportOpen, setBlockImportOpen] = useState(false)
  const [blockImportText, setBlockImportText] = useState('')
  const dmVisible = danmakuRoomOn && dmLocalOn && danmakuItems.length > 0

  // 关键词过滤（大小写不敏感的子串匹配；保序不影响发射指针）
  const blockedLower = useMemo(() => dmBlocked.map((k) => k.toLowerCase()), [dmBlocked])
  const filteredDanmaku = useMemo(() => {
    if (blockedLower.length === 0) return danmakuItems
    return danmakuItems.filter((it) => {
      const text = it.x.toLowerCase()
      return !blockedLower.some((kw) => kw && text.includes(kw))
    })
  }, [danmakuItems, blockedLower])
  const blockedCount = danmakuItems.length - filteredDanmaku.length

  const showHint = (text: string) => {
    setHint(text)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(null), 1800)
  }

  // 静音本地状态应用到 video
  useEffect(() => {
    const v = stageRef.current?.querySelector('video')
    if (v) v.muted = muted
  }, [muted])

  // 弹幕偏好持久化
  useEffect(() => {
    try {
      window.localStorage.setItem('bilitogether:dm', JSON.stringify({ on: dmLocalOn, scale: dmScale, opacity: dmOpacity, speed: dmSpeed }))
    } catch {
      /* noop */
    }
  }, [dmLocalOn, dmScale, dmOpacity, dmSpeed])

  // 屏蔽词持久化
  useEffect(() => {
    try {
      window.localStorage.setItem('bilitogether:dm-block', JSON.stringify(dmBlocked))
    } catch {
      /* noop */
    }
  }, [dmBlocked])

  const addBlockKeyword = () => {
    const kw = blockInput.trim().slice(0, 30)
    if (!kw) return
    if (dmBlocked.some((k) => k.toLowerCase() === kw.toLowerCase())) {
      showHint('该关键词已在屏蔽列表')
      setBlockInput('')
      return
    }
    setDmBlocked((prev) => (prev.length >= 50 ? prev : [...prev, kw]))
    setBlockInput('')
  }

  /** 导出屏蔽词：复制 JSON 到剪贴板（可发给朋友或备份） */
  const exportBlockList = async () => {
    if (dmBlocked.length === 0) {
      toast({ title: '还没有屏蔽词可导出' })
      return
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(dmBlocked, null, 0))
      toast({ title: `已复制 ${dmBlocked.length} 个屏蔽词到剪贴板 📋`, description: 'JSON 数组格式，可直接发给朋友或备份' })
    } catch {
      toast({ title: '复制失败，请检查浏览器剪贴板权限', variant: 'destructive' })
    }
  }

  /** 导入屏蔽词：兼容 JSON 数组与逐行/逗号分隔两种格式，去重合并（上限 50） */
  const importBlockList = () => {
    const raw = blockImportText.trim()
    if (!raw) return
    let incoming: string[] = []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) incoming = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      // 非 JSON：按行/逗号/顿号分隔的纯文本
      incoming = raw.split(/[\n,，、]/).map((s) => s.trim())
    }
    incoming = [...new Set(incoming.map((s) => s.trim().slice(0, 30)).filter(Boolean))]
    if (incoming.length === 0) {
      toast({ title: '没有识别到可导入的关键词', variant: 'destructive' })
      return
    }
    const before = dmBlocked.length
    setDmBlocked((prev) => [...new Set([...prev, ...incoming])].slice(0, 50))
    const added = incoming.filter((k) => !dmBlocked.some((p) => p.toLowerCase() === k.toLowerCase())).length
    toast({ title: `已导入 ${added} 个新屏蔽词（总计 ${Math.min(50, before + added)} 个）⭐` })
    setBlockImportText('')
    setBlockImportOpen(false)
  }

  const toggleFullscreen = () => {
    const video = stageRef.current?.querySelector('video')
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    if (stageRef.current?.requestFullscreen) {
      stageRef.current.requestFullscreen().catch(() => {
        // iOS Safari 降级：视频元素自身全屏
        const el = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
        try {
          el?.webkitEnterFullscreen?.()
        } catch {
          /* noop */
        }
      })
    } else {
      const el = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
      try {
        el?.webkitEnterFullscreen?.()
      } catch {
        /* noop */
      }
    }
  }

  const onStageClick = () => {
    if (mode !== 'native' || !hasVideo || streamLoading) return
    if (isTouch) {
      // 触屏：点按切换控制条可见性（B站 App 同款交互），控制条上再操作播放/画质
      if (touchControls) {
        hideTouchControls()
      } else {
        showTouchControls()
      }
      return
    }
    if (isOwner) {
      onTogglePlay()
    } else {
      showHint('播放进度由房主控制 👑')
    }
  }

  /* ============ 空状态 ============ */
  if (!hasVideo) {
    return (
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-surface-border bg-gradient-to-br from-surface via-cinema to-[#1a0e12]">
        <div className="pointer-events-none absolute inset-0 opacity-40 [background:radial-gradient(circle_at_30%_20%,rgba(251,114,153,0.15),transparent_50%),radial-gradient(circle_at_70%_80%,rgba(251,114,153,0.08),transparent_40%)]" />
        <div className="relative z-10 flex flex-col items-center gap-4 px-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#fb7299]/15 ring-1 ring-[#fb7299]/30">
            {isOwner ? <Film className="h-8 w-8 text-[#fb7299]" /> : <Clapperboard className="h-8 w-8 text-[#fb7299]" />}
          </div>
          <div>
            <p className="text-lg font-semibold text-surface-foreground">
              {isOwner ? '粘贴一个B站视频链接，开场！' : '等待房主选择播放内容…'}
            </p>
            <p className="mt-1 text-sm text-surface-muted-foreground">
              {isOwner ? '支持 BV 号 / av 号 / 完整链接 / b23.tv 短链' : '房主正在挑片，稍等片刻 🍿'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  /* ============ iframe 兼容模式 ============ */
  if (mode === 'iframe') {
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-surface-border bg-black shadow-2xl shadow-black/50">
        <iframe
          key={iframeKey}
          id="bili-player-iframe"
          src={iframeSrc}
          title={title || 'bilibili player'}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowFullScreen
          scrolling="no"
          frameBorder={0}
        />
        <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs text-amber-300 backdrop-blur">
          兼容模式（iframe）· 画质受B站外链限制
        </div>
      </div>
    )
  }

  /* ============ 原生播放器 ============ */
  return (
    <div
      ref={stageRef}
      className="group relative aspect-video w-full select-none overflow-hidden rounded-xl border border-surface-border bg-black shadow-2xl shadow-black/50"
      onClick={onStageClick}
      tabIndex={0}
      role="button"
      aria-label={isOwner ? '播放器：点击或按空格播放/暂停（全员同步）' : '播放器：进度由房主控制'}
      onKeyDown={(e) => {
        // 键盘可达性：空格/K 播放暂停（房主），左右键快速跳转（房主），M 打点精彩时刻（全员）
        // 输入框聚焦时不拦截（弹幕输入/发送条都在舞台内部，需排除冒泡）
        const target = e.target as HTMLElement | null
        const tag = target?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
        if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
          e.preventDefault()
          if (isOwner) onTogglePlay()
          else showHint('播放进度由房主控制 👑')
        } else if (isOwner && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault()
          onSkip?.(e.key === 'ArrowLeft' ? -10 : 10)
        } else if (e.key === 'm' || e.key === 'M') {
          e.preventDefault()
          addMoment()
        }
      }}
    >
      {/* 视频本体（poster 提升加载观感）；点击统一走 onStageClick（呼出控制条/房主暂停）。
          注意：video 上必须直接绑定 onClick 并阻止冒泡重复触发，React 事件从媒体元素向上派发不可靠 */}
      <video
        {...videoProps}
        poster={cover || undefined}
        onClick={(e) => {
          e.stopPropagation()
          onStageClick()
        }}
        className={`absolute inset-0 h-full w-full object-contain cursor-pointer ${activeVideoVisible(streamLoading, streamError)}`}
      />

      {/* 弹幕层（原生模式，房主总开关 && 本地开关 && 已加载数据；本地屏蔽词已过滤） */}
      <DanmakuLayer
        items={filteredDanmaku}
        videoRef={videoProps.ref as RefObject<HTMLVideoElement | null>}
        visible={dmVisible && !streamLoading && !streamError}
        speed={dmSpeed}
        opacity={dmOpacity}
        scale={dmScale}
      />

      {/* 弹幕发送条（B站同款：顶部居中悬浮输入，原生模式且无加载/错误时展示） */}
      {!streamLoading && !streamError && (
        <div
          className="absolute left-1/2 top-9 z-20 w-[min(300px,62vw)] -translate-x-1/2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1.5 rounded-full border border-white/15 bg-black/45 p-1 pl-3 backdrop-blur-md transition-colors focus-within:border-[#fb7299]/70 focus-within:bg-black/60">
            <input
              value={dmText}
              maxLength={100}
              placeholder="发个友善的弹幕见证当下~"
              aria-label="发送弹幕"
              className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-surface-muted-foreground"
              onChange={(e) => setDmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void sendDanmaku()
              }}
            />
            {dmText.length >= 60 && (
              <span
                className={`shrink-0 font-mono text-[10px] tabular-nums ${dmText.length >= 90 ? 'text-amber-300' : 'text-surface-muted-foreground'}`}
                aria-live="polite"
              >
                {dmText.length}/100
              </span>
            )}
            {/* 快捷表情（复用聊天选择器；弹幕条顶部悬浮 → 向下弹出） */}
            <EmojiPicker
              side="bottom"
              triggerClassName="h-6 w-6 rounded-full border-0 bg-transparent text-white/60 hover:bg-white/10 hover:text-[#fb7299] [&_svg]:h-4 [&_svg]:w-4"
              triggerLabel="插入弹幕表情"
              onPick={(emoji) => setDmText((prev) => (prev + emoji).slice(0, 100))}
            />
            <button
              className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-[#fb7299] px-3 text-xs font-semibold text-white transition-colors hover:bg-[#f45d8b] disabled:opacity-50"
              disabled={dmSending || !dmText.trim() || !danmakuTarget}
              onClick={() => void sendDanmaku()}
            >
              {dmSending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              发送
            </button>
          </div>
        </div>
      )}

      {/* 加载中 */}
      {streamLoading && !streamError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
          <Loader2 className="h-9 w-9 animate-spin text-[#fb7299]" />
          <p className="text-sm text-surface-foreground">正在加载视频流…</p>
          <p className="text-xs text-surface-muted-foreground">从B站获取真实播放地址中</p>
        </div>
      )}

      {/* 错误态 */}
      {streamError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center backdrop-blur">
          <AlertTriangle className="h-10 w-10 text-amber-400" />
          <p className="max-w-md text-sm text-surface-foreground">{streamError}</p>
          <p className="max-w-md text-xs text-surface-muted-foreground">
            可能原因：B站风控 / 网络限制该 CDN / 视频不支持直链。可重试或切换到兼容模式（B站官方 iframe 播放器）。
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button size="sm" className="h-9 bg-[#fb7299] text-white hover:bg-[#f45d8b]" onClick={(e) => { e.stopPropagation(); onRetryStream() }}>
              <RefreshCcw className="mr-1 h-4 w-4" /> 重试加载
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3"
              onClick={(e) => { e.stopPropagation(); onUseCompat() }}
            >
              <MonitorPlay className="mr-1 h-4 w-4" /> 切换兼容模式
            </Button>
          </div>
        </div>
      )}

      {/* 手势覆盖层（浏览器自动播放策略；房主已暂停/已播完时无需手势） */}
      {needsGesture && playing && !streamError && (
        <div
          className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black/70 backdrop-blur-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex h-20 w-20 items-center justify-center rounded-full bg-[#fb7299] shadow-2xl shadow-[#fb7299]/40 transition-transform hover:scale-105"
            onClick={onRetryPlayback}
            title="开始观看"
          >
            <Play className="h-9 w-9 translate-x-0.5 text-white" fill="currentColor" />
          </button>
          <span className="text-sm font-medium text-surface-foreground">点击开始观看（浏览器要求一次点击）</span>
          <button
            className="mt-1 flex items-center gap-1.5 rounded-full border border-surface-foreground/20 px-4 py-1.5 text-xs text-surface-foreground transition-colors hover:border-surface-foreground/40 hover:text-white"
            onClick={() => {
              const v = stageRef.current?.querySelector('video')
              if (v) v.muted = true
              setMuted(true)
              onRetryPlayback()
            }}
          >
            <VolumeX className="h-3.5 w-3.5" /> 静音同步观看（点左下角喇叭恢复声音）
          </button>
        </div>
      )}

      {/* 点击提示（跟随者） */}
      {hint && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <span className="rounded-full bg-black/70 px-4 py-2 text-sm text-surface-foreground backdrop-blur">{hint}</span>
        </div>
      )}

      {/* 暂停遮罩提示（非房主视角：房间真实暂停时才显示，避免本地状态瞬时脱节误导） */}
      {!streamLoading && !streamError && !needsGesture && !locallyPlaying && !isOwner && !playing && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <span className="rounded-full bg-black/60 px-4 py-2 text-sm text-surface-foreground backdrop-blur">房主已暂停 ⏸</span>
        </div>
      )}

      {/* 精彩时刻：芯片栏（左）+ 打点按钮（右）。全员可打点；房主点击芯片全员跳转；
          悬浮于控制条上方，触屏下同样保持可见（芯片本身不参与控制条自动隐藏） */}
      {!streamLoading && !streamError && (
        <div className="absolute inset-x-3 bottom-[84px] z-20 flex items-end gap-2" onClick={(e) => e.stopPropagation()}>
          {moments.length > 0 && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {moments.map((m, i) => (
                <button
                  key={m.id}
                  className="bt-fade-up pointer-events-auto flex shrink-0 items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur transition-colors hover:bg-[#fb7299]/85"
                  style={{ animationDelay: `${Math.min(i * 45, 360)}ms` }}
                  title={`${m.name} 打点于 ${formatTime(m.t)}，点击${isOwner ? '全员跳转' : '告诉房主你想回看'}`}
                  onClick={() => {
                    if (isOwner) {
                      onSeekToMoment(m.t)
                      showHint(`已跳转到 ⭐ ${formatTime(m.t)}`)
                    } else {
                      showHint('想让房主跳到这里？在聊天里喊一声 👋')
                    }
                  }}
                >
                  <Sparkles className="h-3 w-3 shrink-0 text-white/80" />
                  <span className="font-mono font-bold tabular-nums">{formatTime(m.t)}</span>
                  <span className="max-w-16 truncate opacity-70">{m.name}</span>
                </button>
              ))}
            </div>
          )}
          <button
            className="pointer-events-auto ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-black/55 px-3 text-xs font-semibold text-white backdrop-blur transition-colors hover:bg-[#fb7299]"
            title="打点精彩时刻（快捷键 M），记录当下进度方便回看"
            onClick={addMoment}
          >
            <Sparkles className="h-3.5 w-3.5" />
            打点
          </button>
        </div>
      )}

      {/* 底部控制条（桌面端 hover 呼出；触屏端点按视频呼出，4s 自动隐藏） */}
      {!streamLoading && !streamError && (
        <div
          className={`absolute inset-x-0 bottom-0 z-20 flex items-center gap-1.5 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2.5 pt-8 transition-opacity duration-200 sm:gap-2 sm:px-4 ${
            isTouch
              ? touchControls
                ? 'opacity-100'
                : 'pointer-events-none opacity-0'
              : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  className="h-10 w-10 rounded-full bg-[#fb7299] text-white shadow-lg shadow-[#fb7299]/30 hover:bg-[#f45d8b]"
                  onClick={isOwner ? onTogglePlay : () => showHint('播放进度由房主控制 👑')}
                >
                  {playing ? <Pause className="h-4.5 w-4.5" /> : <Play className="h-4.5 w-4.5 translate-x-px" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isOwner ? (playing ? '暂停（全员）' : '播放（全员）') : '由房主控制'}</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div className="flex-1" />

          {/* 弹幕本地开关（每用户） */}
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`flex h-9 w-9 items-center justify-center rounded-lg backdrop-blur transition-colors ${
                    danmakuRoomOn && dmLocalOn
                      ? 'bg-white/10 text-white hover:bg-white/20'
                      : 'bg-white/5 text-surface-muted-foreground hover:bg-white/10'
                  }`}
                  onClick={() => setDmLocalOn((v) => !v)}
                  title={danmakuRoomOn ? (dmLocalOn ? '隐藏弹幕（仅自己）' : '显示弹幕（仅自己）') : '房主已关闭房间弹幕'}
                  disabled={!danmakuRoomOn}
                >
                  {danmakuRoomOn && dmLocalOn ? <MessageSquare className="h-4 w-4" /> : <MessageSquareOff className="h-4 w-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>弹幕显示（仅影响自己的屏幕）</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* 弹幕设置（本地偏好） */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
                title="弹幕设置"
                onClick={(e) => e.stopPropagation()}
              >
                <Settings2 className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="top"
              className="w-64 border-surface-border bg-surface/95 text-surface-foreground backdrop-blur"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="mb-3 flex items-center justify-between text-sm font-semibold">
                弹幕设置
                <span className="text-[11px] font-normal text-surface-muted-foreground">
                  共 {danmakuItems.length} 条{blockedCount > 0 ? ` · 已屏蔽 ${blockedCount} 条` : ''}
                </span>
              </p>
              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex justify-between text-xs text-surface-muted-foreground">
                    <span>字号</span>
                    <span className="font-mono">{Math.round(dmScale * 100)}%</span>
                  </div>
                  <Slider
                    value={[dmScale]}
                    min={0.7}
                    max={1.6}
                    step={0.05}
                    onValueChange={(v) => setDmScale(v[0])}
                    className="[&_[data-slot=slider-range]]:bg-[#fb7299] [&_[data-slot=slider-thumb]]:border-[#fb7299]"
                  />
                </div>
                <div>
                  <div className="mb-1.5 flex justify-between text-xs text-surface-muted-foreground">
                    <span>不透明度</span>
                    <span className="font-mono">{Math.round(dmOpacity * 100)}%</span>
                  </div>
                  <Slider
                    value={[dmOpacity]}
                    min={0.2}
                    max={1}
                    step={0.05}
                    onValueChange={(v) => setDmOpacity(v[0])}
                    className="[&_[data-slot=slider-range]]:bg-[#fb7299] [&_[data-slot=slider-thumb]]:border-[#fb7299]"
                  />
                </div>
                <div>
                  <div className="mb-1.5 flex justify-between text-xs text-surface-muted-foreground">
                    <span>速度</span>
                    <span className="font-mono">{dmSpeed.toFixed(2)}x</span>
                  </div>
                  <Slider
                    value={[dmSpeed]}
                    min={0.5}
                    max={2}
                    step={0.1}
                    onValueChange={(v) => setDmSpeed(v[0])}
                    className="[&_[data-slot=slider-range]]:bg-[#fb7299] [&_[data-slot=slider-thumb]]:border-[#fb7299]"
                  />
                </div>
                {/* 关键词屏蔽（本地过滤，只影响自己的屏幕） */}
                <div>
                  <div className="mb-1.5 flex justify-between text-xs text-surface-muted-foreground">
                    <span>关键词屏蔽</span>
                    <span className="font-mono">{dmBlocked.length > 0 ? `${dmBlocked.length}/50` : '未启用'}</span>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={blockInput}
                      maxLength={30}
                      placeholder="输入关键词，回车添加"
                      aria-label="添加弹幕屏蔽关键词"
                      className="h-8 min-w-0 flex-1 rounded-md border border-surface-border bg-surface-2 px-2 text-xs text-surface-foreground outline-none placeholder:text-surface-muted-foreground focus:border-[#fb7299]/60"
                      onChange={(e) => setBlockInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addBlockKeyword()
                        }
                      }}
                    />
                    <button
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#fb7299] text-white transition-colors hover:bg-[#f45d8b] disabled:opacity-40"
                      title="添加屏蔽词"
                      aria-label="添加屏蔽词"
                      disabled={!blockInput.trim()}
                      onClick={addBlockKeyword}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  {dmBlocked.length > 0 && (
                    <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                      {dmBlocked.map((kw) => (
                        <span
                          key={kw}
                          className="flex max-w-full items-center gap-1 rounded-full border border-[#fb7299]/30 bg-[#fb7299]/10 py-0.5 pl-2 pr-1 text-[11px] text-[#fb7299]"
                        >
                          <span className="max-w-28 truncate" title={kw}>{kw}</span>
                          <button
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[#fb7299]/30"
                            title="移除屏蔽词"
                            aria-label={`移除屏蔽词 ${kw}`}
                            onClick={() => setDmBlocked((prev) => prev.filter((k) => k !== kw))}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {/* 导入 / 导出（剪贴板 JSON，方便备份与分享给朋友） */}
                  <div className="mt-2">
                    {!blockImportOpen ? (
                      <div className="flex items-center gap-1">
                        <button
                          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-surface-muted-foreground transition-colors hover:bg-surface-3 hover:text-[#fb7299]"
                          onClick={() => setBlockImportOpen(true)}
                        >
                          <Upload className="h-3 w-3" /> 导入
                        </button>
                        <button
                          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-surface-muted-foreground transition-colors hover:bg-surface-3 hover:text-[#fb7299]"
                          onClick={() => void exportBlockList()}
                        >
                          <Download className="h-3 w-3" /> 导出
                        </button>
                        <span className="ml-auto text-[10px] text-surface-muted-foreground/70">粘贴 JSON 或逐行文本</span>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-surface-border bg-surface-2 p-2">
                        <textarea
                          value={blockImportText}
                          onChange={(e) => setBlockImportText(e.target.value)}
                          maxLength={2000}
                          rows={3}
                          placeholder={'粘贴屏蔽词：["剧透","广告"] 或每行一个'}
                          aria-label="粘贴要导入的屏蔽词"
                          className="w-full resize-none rounded-md border border-surface-border bg-cinema px-2 py-1.5 text-[11px] text-surface-foreground outline-none placeholder:text-surface-muted-foreground/70 focus:border-[#fb7299]/60"
                        />
                        <div className="mt-1.5 flex items-center justify-end gap-1.5">
                          <button
                            className="rounded-md px-2 py-1 text-[11px] text-surface-muted-foreground transition-colors hover:bg-surface-3 hover:text-surface-foreground"
                            onClick={() => {
                              setBlockImportOpen(false)
                              setBlockImportText('')
                            }}
                          >
                            取消
                          </button>
                          <button
                            className="flex items-center gap-1 rounded-md bg-[#fb7299] px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-[#f45d8b] disabled:opacity-40"
                            disabled={!blockImportText.trim()}
                            onClick={importBlockList}
                          >
                            <Check className="h-3 w-3" /> 确认导入
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* 画质：房主可切换（真实切换视频流）；跟随者展示当前画质 */}
          {isOwner && qualities.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={`flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-semibold text-white backdrop-blur transition-colors hover:bg-white/20 ${qualityDowngraded ? 'ring-1 ring-amber-400/60' : ''}`}
                  title="切换画质（全员同步）"
                >
                  <Gauge className="h-4 w-4 text-[#fb7299]" />
                  {grantedQn ? qualityLabel(grantedQn) : '画质'}
                  {qualityDowngraded && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52 border-surface-border bg-surface/95 text-surface-foreground backdrop-blur">
                <DropdownMenuLabel className="text-xs text-surface-muted-foreground">切换画质（全员生效）</DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-surface-3" />
                {qualities.map((q) => (
                  <DropdownMenuItem
                    key={q.qn}
                    className="cursor-pointer justify-between data-[highlighted]:bg-[#fb7299]/20 data-[highlighted]:text-[#fb7299]"
                    onClick={() => onQualityChange(q.qn)}
                  >
                    <span>{q.desc || qualityLabel(q.qn)}</span>
                    {grantedQn === q.qn && <Check className="h-4 w-4 text-[#fb7299]" />}
                  </DropdownMenuItem>
                ))}
                {qualityDowngraded && (
                  <>
                    <DropdownMenuSeparator className="bg-surface-3" />
                    <p className="px-2 py-1.5 text-[11px] leading-relaxed text-amber-400/90">
                      未登录状态最高 {grantedQn ? qualityLabel(grantedQn) : ''}。在服务端配置 BILI_SESSDATA 可解锁 1080P 及以上画质。
                    </p>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <button
              className="flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-semibold text-white backdrop-blur"
              title={isOwner ? '画质列表加载中' : '画质由房主控制'}
            >
              <Gauge className="h-4 w-4 text-[#fb7299]" />
              {grantedQn ? qualityLabel(grantedQn) : '画质'}
            </button>
          )}

          {/* 静音（本地） */}
          <button
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
            onClick={() => {
              const v = stageRef.current?.querySelector('video')
              if (v) {
                v.muted = !muted
                // 取消静音时浏览器可能因自动播放策略暂停视频，须在用户手势内立即恢复
                if (!muted && v.paused) {
                  v.play().catch(() => undefined)
                }
              }
              setMuted((m) => !m)
            }}
            title={muted ? '取消静音' : '静音'}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>

          {/* 全屏 */}
          <button
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
            onClick={toggleFullscreen}
            title="全屏"
          >
            <Maximize className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 顶部：标题 + 画质/倍速角标（非 hover 也可见） */}
      {!streamLoading && !streamError && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between bg-gradient-to-b from-black/60 to-transparent px-3 pb-6 pt-2.5 sm:px-4">
          <p className="max-w-[60%] truncate text-xs text-surface-foreground sm:text-sm">{title || ''}</p>
          <div className="flex items-center gap-1.5">
            {rate && rate !== 1 ? (
              <span className="rounded-md bg-[#fb7299]/80 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide text-white backdrop-blur">
                {rate === 1 ? '1.0x' : `${rate}x`}
              </span>
            ) : null}
            {grantedQn ? (
              <span
                className={`rounded-md bg-black/50 px-2 py-0.5 text-[10px] font-bold tracking-wide text-surface-foreground backdrop-blur ${qualityDowngraded ? 'text-amber-300' : ''}`}
              >
                {qualityLabel(grantedQn)}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

/** 加载/错误时隐藏视频画面（保留元素以便恢复） */
function activeVideoVisible(loading: boolean, error: string | null): string {
  if (error) return 'invisible'
  if (loading) return 'opacity-0'
  return 'opacity-100'
}

/** 读取弹幕本地偏好（SSR 安全） */
function readDmPref<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem('bilitogether:dm')
    if (!raw) return fallback
    const obj = JSON.parse(raw) as Record<string, unknown>
    const v = obj[key]
    return (typeof v === typeof fallback && v !== null ? (v as T) : fallback)
  } catch {
    return fallback
  }
}

/** 读取本地弹幕屏蔽词列表（最多 50 条，非法数据静默忽略） */
function readDmBlockList(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem('bilitogether:dm-block')
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 50)
  } catch {
    return []
  }
}
