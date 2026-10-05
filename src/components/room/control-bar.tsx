'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Cookie,
  Crosshair,
  Crown,
  Gauge,
  MessageSquare,
  MessageSquareOff,
  MonitorPlay,
  Pause,
  Play,
  RefreshCcw,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  ScanLine,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import { clearBiliStreamClientCache } from '@/hooks/use-bili-stream'
import { QUALITY_OPTIONS, qualityLabel } from '@/lib/bili'
import type { ControlAction, PlaybackState, RoomMoment } from '@/lib/room-types'
import type { PlayerMode } from '@/hooks/use-sync-player'
import { SessdataGuide } from '@/components/room/sessdata-guide'
import { BiliLoginDialog } from '@/components/room/bili-login-dialog'

/** 倍速档位（与同步服务白名单一致） */
export const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const rateLabel = (r: number) => (r === 1 ? '1.0x' : `${r}x`)

interface ControlBarProps {
  playback: PlaybackState | null
  isOwner: boolean
  connected: boolean
  directApi: boolean
  autoNext: boolean
  onAutoNextChange: (v: boolean) => void
  sendControl: (payload: ControlAction) => Promise<{ ok: boolean; error?: string }>
  resyncSelf: () => void
  getEstimate: () => number
  /* 画质/模式 */
  mode: PlayerMode
  onModeChange: (m: PlayerMode) => void
  qualities: { qn: number; desc: string }[]
  grantedQn: number | null
  qualityDowngraded: boolean
  requestedQn: number
  durationOverride: number
  /** 服务端是否已配置 B站登录凭据（SESSDATA） */
  streamLogged: boolean
  /** 扫码登录成功后刷新当前流（清缓存重新取流，保持进度无缝升级画质） */
  refreshStream: () => void
  /** 精彩时刻打点（用于进度条标记） */
  moments: RoomMoment[]
}

export function ControlBar({
  playback,
  isOwner,
  connected,
  directApi,
  autoNext,
  onAutoNextChange,
  sendControl,
  resyncSelf,
  getEstimate,
  mode,
  onModeChange,
  qualities,
  grantedQn,
  qualityDowngraded,
  requestedQn,
  durationOverride,
  streamLogged,
  refreshStream,
  moments = [],
}: ControlBarProps) {
  const { toast } = useToast()
  const [display, setDisplay] = useState(0)
  const [dragging, setDragging] = useState<number | null>(null)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)

  /**
   * 扫码登录成功：
   * - 服务端流缓存已在登录时清空（bili-credentials invalidateCaches）
   * - 房主：自动把全员切到最高可用画质（请求 qn=120，B站按账号权益授予——
   *   普通账号得 1080P、大会员得 1080P+/4K，这是「解锁」的核心动作）
   * - 跟随者：仅清客户端缓存并重取当前流（画质仍由房主控制）
   */
  const handleLoggedIn = useCallback(
    (account: { uname?: string | null } | null) => {
      toast({
        title: `🎉 已登录 ${account?.uname || 'B站账号'}`,
        description: isOwner ? '正在为全员切换到最高可用画质…' : '服务端凭据已就绪，等待房主切换画质',
      })
      clearBiliStreamClientCache()
      if (isOwner) {
        void sendControl({ action: 'setQn', qn: 120 })
      } else {
        refreshStream()
      }
    },
    [toast, isOwner, sendControl, refreshStream]
  )

  const hasVideo = !!playback?.bvid
  const duration = playback?.duration || durationOverride || 0

  /* ---- 进度条增强：当前视频的打点标记 + hover 时间气泡 ---- */
  const videoMoments = useMemo(
    () =>
      moments
        .filter((m) => m.bvid === playback?.bvid && duration > 0 && m.t >= 0 && m.t <= duration)
        .sort((a, b) => a.t - b.t),
    [moments, playback?.bvid, duration]
  )
  const hoverFromEvent = (e: React.MouseEvent<HTMLElement>) => {
    if (duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    setHoverTime(ratio * duration)
  }
  const bubbleTime = dragging !== null ? dragging : hoverTime
  const bubblePct =
    bubbleTime !== null && duration > 0
      ? Math.min(94, Math.max(6, (bubbleTime / duration) * 100))
      : 0
  const momentPct = (t: number) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0)

  useEffect(() => {
    const timer = setInterval(() => {
      if (dragging === null) setDisplay(getEstimate())
    }, 250)
    return () => clearInterval(timer)
  }, [getEstimate, dragging])

  if (!hasVideo) return null

  const doControl = async (payload: ControlAction) => {
    if (busy) return
    setBusy(true)
    await sendControl(payload)
    setTimeout(() => setBusy(false), 400)
  }

  const current = dragging !== null ? dragging : display
  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0

  // 循环模式：off 顺序 / list 列表循环 / one 单曲循环（房主点击循环切换）
  const loopMode = playback?.loop || 'off'
  const LOOP_META = {
    off: { label: '顺序播放', icon: Repeat, tip: '循环：顺序播放（点击开启列表循环）' },
    list: { label: '列表循环', icon: Repeat, tip: '循环：列表循环（播完回到第一集；点击切换单曲循环）' },
    one: { label: '单曲循环', icon: Repeat1, tip: '循环：单曲循环（点击关闭循环）' },
  } as const
  const LoopIcon = LOOP_META[loopMode].icon
  const nextLoop = loopMode === 'off' ? 'list' : loopMode === 'list' ? 'one' : 'off'

  // 画质列表：优先使用 B站 playurl 返回的真实列表，兼容模式回退到预设
  const qualityList =
    mode === 'native' && qualities.length > 0
      ? qualities.map((q) => ({ qn: q.qn, label: q.desc || qualityLabel(q.qn) }))
      : QUALITY_OPTIONS.map((q) => ({ qn: q.qn, label: q.label }))
  const activeQn = mode === 'native' && grantedQn ? grantedQn : playback.qn
  const activeLabel = qualityList.find((q) => q.qn === activeQn)?.label || qualityLabel(activeQn)
  const activeRate = playback.rate && playback.rate > 0 ? playback.rate : 1

  return (
    <div className="rounded-xl border border-surface-border bg-surface/80 p-3 backdrop-blur sm:p-4">
      {/* 进度条 */}
      <div className="mb-3 flex items-center gap-3">
        <span className="w-14 shrink-0 font-mono text-xs text-surface-muted-foreground sm:text-sm">{formatTimeSafe(current)}</span>
        {isOwner && duration > 0 ? (
          <div className="relative flex-1" onMouseMove={hoverFromEvent} onMouseLeave={() => setHoverTime(null)}>
            <Slider
              value={[Math.min(current, duration)]}
              max={duration}
              step={1}
              thumbLabel="播放进度（拖拽全员同步）"
              onPointerDown={() => setDragging(current)}
              onValueChange={(v) => setDragging(v[0])}
              onValueCommit={(v) => {
                setDragging(null)
                void doControl({ action: 'seek', position: v[0] })
              }}
              className="w-full [&_[data-slot=slider-range]]:bg-[#fb7299] [&_[data-slot=slider-thumb]]:border-[#fb7299] [&_[data-slot=slider-track]]:bg-surface-3"
            />
            {/* 打点标记（可点击跳转） */}
            {videoMoments.map((m) => (
              <button
                key={m.id}
                type="button"
                className="group/mark absolute top-1/2 z-10 flex h-4 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center"
                style={{ left: `${momentPct(m.t)}%` }}
                title={`⭐ ${m.name} · ${formatTimeSafe(m.t)}（点击全员跳转）`}
                aria-label={`跳转到打点 ${formatTimeSafe(m.t)}`}
                onClick={() => void doControl({ action: 'seek', position: m.t })}
              >
                <span className="h-2.5 w-[3px] rounded-full bg-amber-300 shadow-[0_0_4px_rgba(252,211,77,0.9)] transition-transform group-hover/mark:scale-y-125" />
              </button>
            ))}
            {/* hover/拖拽时间气泡 */}
            {bubbleTime !== null && duration > 0 && (
              <div
                className="pointer-events-none absolute -top-7 z-20 -translate-x-1/2 rounded-md bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white shadow-lg ring-1 ring-white/15"
                style={{ left: `${bubblePct}%` }}
              >
                {formatTimeSafe(bubbleTime)}
              </div>
            )}
          </div>
        ) : (
          <div
            className="relative h-1.5 flex-1 overflow-visible rounded-full bg-surface-3"
            onMouseMove={hoverFromEvent}
            onMouseLeave={() => setHoverTime(null)}
          >
            <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#fb7299]/70 to-[#fb7299] transition-[width] duration-300" style={{ width: `${pct}%` }} />
            {/* 打点标记（成员只读展示） */}
            {videoMoments.map((m) => (
              <span
                key={m.id}
                className="pointer-events-none absolute top-1/2 h-2.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-300 shadow-[0_0_4px_rgba(252,211,77,0.9)]"
                style={{ left: `${momentPct(m.t)}%` }}
                title={`⭐ ${m.name} · ${formatTimeSafe(m.t)}`}
              />
            ))}
            {hoverTime !== null && duration > 0 && (
              <div
                className="pointer-events-none absolute -top-6 z-20 -translate-x-1/2 rounded-md bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white shadow-lg ring-1 ring-white/15"
                style={{ left: `${bubblePct}%` }}
              >
                {formatTimeSafe(hoverTime)}
              </div>
            )}
          </div>
        )}
        <span className="w-14 shrink-0 text-right font-mono text-xs text-surface-muted-foreground sm:text-sm">
          {duration > 0 ? formatTimeSafe(duration) : '--:--'}
        </span>
      </div>

      {/* 控制区 */}
      <div className="flex flex-wrap items-center gap-2">
        {isOwner ? (
          <>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    className="h-11 w-11 rounded-full bg-[#fb7299] text-white shadow-lg shadow-[#fb7299]/30 hover:bg-[#f45d8b]"
                    disabled={!connected || busy}
                    aria-label={playback.playing ? '暂停（全员同步）' : '播放（全员同步）'}
                    onClick={() =>
                      doControl(
                        playback.playing
                          ? { action: 'pause', position: getEstimate() }
                          : { action: 'play', position: getEstimate() }
                      )
                    }
                  >
                    {playback.playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 translate-x-0.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{playback.playing ? '暂停' : '播放'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3"
                    disabled={busy}
                    aria-label="快退 10 秒（全员同步）"
                    onClick={() => void doControl({ action: 'skip', delta: -10 })}
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>快退 10s（全员）</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3"
                    disabled={busy}
                    aria-label="快进 10 秒（全员同步）"
                    onClick={() => void doControl({ action: 'skip', delta: 10 })}
                  >
                    <RotateCw className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>快进 10s（全员）</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <div className="mx-1 hidden h-8 w-px bg-surface-3 sm:block" />

            {/* 画质（原生模式：真实画质列表，切换即换流） */}
            <Select
              value={String(mode === 'native' ? grantedQn ?? playback.qn : playback.qn)}
              onValueChange={(v) => void doControl({ action: 'setQn', qn: Number(v) })}
            >
              <SelectTrigger
                className={`h-10 w-[130px] border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3 ${qualityDowngraded ? 'ring-1 ring-amber-500/50' : ''}`}
                title={qualityDowngraded ? `实际播放 ${activeLabel}（未登录限制）` : '切换画质（全员同步）'}
                aria-label="切换画质（全员同步）"
              >
                <Gauge className="mr-1 h-4 w-4 shrink-0 text-[#fb7299]" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-surface-border bg-surface text-surface-foreground">
                {qualityList.map((q) => (
                  <SelectItem
                    key={q.qn}
                    value={String(q.qn)}
                    className="cursor-pointer focus:bg-[#fb7299]/15 focus:text-[#fb7299]"
                  >
                    {q.label}
                    {mode === 'native' && grantedQn === q.qn && <span className="ml-1.5 text-[10px] text-[#fb7299]">当前</span>}
                  </SelectItem>
                ))}
                {mode === 'native' && qualityDowngraded && (
                  <p className="mt-1 border-t border-surface-border px-2 pb-1 pt-1.5 text-[11px] leading-relaxed text-amber-400/90">
                    未登录最高 {activeLabel}。扫码登录B站账号后全员可解锁 1080P / 4K。
                  </p>
                )}
                {mode === 'iframe' && (
                  <p className="mt-1 border-t border-surface-border px-2 pb-1 pt-1.5 text-[11px] leading-relaxed text-surface-muted-foreground">
                    兼容模式下画质由B站外链播放器决定，仅「最高可用」生效。
                  </p>
                )}
                <button
                  className="flex w-full items-center gap-1.5 border-t border-surface-border px-2 py-2 text-left text-[11px] text-[#fb7299] transition-colors hover:bg-[#fb7299]/10"
                  onClick={() => (streamLogged ? setGuideOpen(true) : setLoginOpen(true))}
                >
                  {streamLogged ? (
                    <>
                      <Cookie className="h-3.5 w-3.5" />
                      画质已解锁 · 管理登录凭据
                    </>
                  ) : (
                    <>
                      <ScanLine className="h-3.5 w-3.5" />
                      扫码解锁 1080P / 4K（免配置）
                    </>
                  )}
                </button>
              </SelectContent>
            </Select>

            {/* 倍速（房主控制全员同步；兼容模式下B站 iframe 内部倍速不受控） */}
            <Select
              value={String(activeRate)}
              onValueChange={(v) => void doControl({ action: 'setRate', rate: Number(v), position: getEstimate() })}
            >
              <SelectTrigger
                className="h-10 w-[92px] border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3"
                title={isOwner ? '倍速（全员同步，进度估算已包含倍速）' : '倍速由房主控制'}
                aria-label={isOwner ? '切换倍速（全员同步）' : '倍速由房主控制'}
              >
                <span className="mr-1 font-mono text-[13px] font-bold text-[#fb7299]">{rateLabel(activeRate)}</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-surface-border bg-surface text-surface-foreground">
                {RATE_OPTIONS.map((r) => (
                  <SelectItem
                    key={r}
                    value={String(r)}
                    disabled={!isOwner}
                    className="cursor-pointer focus:bg-[#fb7299]/15 focus:text-[#fb7299]"
                  >
                    {rateLabel(r)}
                    {r === 1 && <span className="ml-1.5 text-[10px] text-surface-muted-foreground">正常</span>}
                  </SelectItem>
                ))}
                {!isOwner && (
                  <p className="mt-1 border-t border-surface-border px-2 pb-1 pt-1.5 text-[11px] leading-relaxed text-surface-muted-foreground">
                    倍速由房主控制 👑
                  </p>
                )}
              </SelectContent>
            </Select>

            {/* 弹幕（房主级总开关，全员生效；原生=自绘弹幕层，兼容=iframe内置） */}
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-surface-border bg-surface-2 px-3 text-sm text-surface-foreground">
              {playback.danmaku ? <MessageSquare className="h-4 w-4" /> : <MessageSquareOff className="h-4 w-4" />}
              <span className="hidden sm:inline">弹幕</span>
              <Switch
                checked={playback.danmaku}
                onCheckedChange={(v) => void doControl({ action: 'setDanmaku', danmaku: v })}
                aria-label="弹幕开关（全员生效）"
              />
            </label>

            {/* 自动连播 */}
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-surface-border bg-surface-2 px-3 text-sm text-surface-foreground">
              <Crown className="h-4 w-4 text-[#fb7299]" />
              <span className="hidden sm:inline">连播</span>
              <Switch checked={autoNext} onCheckedChange={onAutoNextChange} aria-label="自动连播开关" />
            </label>

            {/* 循环模式（房主循环切换：顺序 → 列表循环 → 单曲循环） */}
            <button
              type="button"
              className={`flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
                loopMode === 'off'
                  ? 'border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3'
                  : 'border-[#fb7299]/40 bg-[#fb7299]/10 text-[#fb7299] hover:bg-[#fb7299]/20'
              }`}
              title={LOOP_META[loopMode].tip}
              aria-label={`播放模式：${LOOP_META[loopMode].label}（点击切换）`}
              disabled={busy}
              onClick={() => void doControl({ action: 'setLoop', loop: nextLoop })}
            >
              <LoopIcon className="h-4 w-4" />
              <span className="hidden md:inline">{LOOP_META[loopMode].label}</span>
            </button>

            <Button
              variant="outline"
              size="sm"
              className="h-10 border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3"
              disabled={busy}
              aria-label="全员重新同步到房主进度"
              onClick={() => void doControl({ action: 'resync' })}
            >
              <RefreshCcw className="mr-1 h-4 w-4" />
              全员重新同步
            </Button>
          </>
        ) : (
          <>
            <Badge
              variant="secondary"
              className={`h-8 bg-[#fb7299]/15 px-3 text-[#fb7299] ${playback.playing ? '' : 'opacity-80'}`}
            >
              {playback.playing ? (
                <span className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#fb7299] opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-[#fb7299]" />
                  </span>
                  正在同步播放
                </span>
              ) : (
                '房主已暂停'
              )}
            </Badge>
            <Badge variant="outline" className="h-8 border-surface-border text-surface-muted-foreground">
              <Gauge className="mr-1 h-3 w-3 text-[#fb7299]" />
              {activeLabel}
            </Badge>
            {activeRate !== 1 && (
              <Badge variant="outline" className="h-8 border-[#fb7299]/40 bg-[#fb7299]/10 font-mono text-[#fb7299]">
                {rateLabel(activeRate)}
              </Badge>
            )}
            {loopMode !== 'off' && (
              <Badge variant="outline" className="h-8 border-[#fb7299]/40 bg-[#fb7299]/10 text-[#fb7299]">
                <LoopIcon className="mr-1 h-3 w-3" />
                {LOOP_META[loopMode].label}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-10 border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3"
              onClick={resyncSelf}
            >
              <Crosshair className="mr-1 h-4 w-4" />
              回到同步点
            </Button>
          </>
        )}

        {/* 连接状态 + 模式 */}
        <div className="ml-auto flex items-center gap-2">
          <Select value={mode} onValueChange={(v) => onModeChange(v as PlayerMode)}>
            <SelectTrigger className="h-9 w-[118px] border-surface-border bg-surface-2 text-xs text-surface-foreground hover:bg-surface-3" title="播放模式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-surface-border bg-surface text-surface-foreground">
              <SelectItem value="native">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-[#fb7299]" /> 原生·真画质
                </span>
              </SelectItem>
              <SelectItem value="iframe">
                <span className="flex items-center gap-1.5">
                  <MonitorPlay className="h-3.5 w-3.5 text-[#fb7299]" /> 兼容·带弹幕
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          <span className={`inline-flex items-center gap-1.5 text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
            {connected ? '已连接' : '断开'}
          </span>
          {directApi && mode === 'iframe' && (
            <Badge variant="outline" className="h-6 border-emerald-500/40 px-2 text-[10px] text-emerald-400">
              播放器直连
            </Badge>
          )}
          <button
            className="hidden h-9 w-9 items-center justify-center rounded-lg text-surface-muted-foreground transition-colors hover:bg-surface-2 hover:text-[#fb7299] md:inline-flex"
            title={streamLogged ? '画质解锁管理' : '扫码登录解锁高画质'}
            onClick={() => (streamLogged ? setGuideOpen(true) : setLoginOpen(true))}
          >
            <Cookie className="h-4 w-4" />
          </button>
        </div>
      </div>

      <SessdataGuide open={guideOpen} onOpenChange={setGuideOpen} onStartLogin={() => setLoginOpen(true)} />
      <BiliLoginDialog open={loginOpen} onOpenChange={setLoginOpen} onLoggedIn={handleLoggedIn} />
    </div>
  )
}

function formatTimeSafe(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
