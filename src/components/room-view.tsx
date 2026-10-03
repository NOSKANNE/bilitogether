'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Clapperboard,
  Copy,
  Check,
  LogOut,
  Crown,
  Users,
  Loader2,
  AlertTriangle,
  Link2,
  QrCode,
  Keyboard,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useUserStore } from '@/store/room-store'
import { useRoomSocket } from '@/hooks/use-room-socket'
import { useSyncPlayer, type PlayerMode } from '@/hooks/use-sync-player'
import { useDanmaku } from '@/hooks/use-danmaku'
import { PlayerStage } from '@/components/room/player-stage'
import { ControlBar } from '@/components/room/control-bar'
import { RoomSidebar } from '@/components/room/room-sidebar'
import { VideoPicker } from '@/components/room/video-picker'
import { InviteQrDialog } from '@/components/room/invite-qr-dialog'
import { MilestoneCelebration } from '@/components/room/milestone-celebration'
import { ShortcutsDialog } from '@/components/room/shortcuts-dialog'
import { ThemeToggle } from '@/components/theme-toggle'
import { useToast } from '@/hooks/use-toast'
import { addRecentRoom } from '@/lib/recent-rooms'

/** 历史观看统计（uid -> 累计秒数，含离线成员） */
export interface WatchStatEntry {
  uid: string
  name: string
  seconds: number
}

interface RoomViewProps {
  code: string
}

export function RoomView({ code }: RoomViewProps) {
  const { uid, baseUid, nickname, device } = useUserStore()
  const { toast } = useToast()
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)
  const [qrOpen, setQrOpen] = useState(false)
  const [autoNext, setAutoNext] = useState(true)
  const [watchStats, setWatchStats] = useState<WatchStatEntry[]>([])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // 播放模式：native（真实视频流，可真画质切换）/ iframe（B站外链，兼容+弹幕）
  const [mode, setMode] = useState<PlayerMode>(() => {
    if (typeof window === 'undefined') return 'native'
    return window.localStorage.getItem('bilitogether:mode') === 'iframe' ? 'iframe' : 'native'
  })
  const switchMode = useCallback(
    (m: PlayerMode) => {
      setMode(m)
      try {
        window.localStorage.setItem('bilitogether:mode', m)
      } catch {
        /* noop */
      }
    },
    []
  )

  const room = useRoomSocket({
    code,
    uid,
    baseUid,
    nickname,
    device,
    enabled: true,
  })

  /* 拉取历史观看统计（含离线成员），供成员面板观看榜单展示 */
  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetch(`/api/rooms/${encodeURIComponent(code)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled && Array.isArray(data?.watchStats)) setWatchStats(data.watchStats)
        })
        .catch(() => undefined)
    }
    load()
    const t = setInterval(load, 35000) // 与服务端 30s 刷盘节奏对齐，榜上能看到刚入库的增量
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [code])

  /* 同步服务自愈：入房时确保 socket 服务在线（沙箱会话清理可能杀掉它，Next 托管拉起可长期存活） */
  useEffect(() => {
    void fetch('/api/system/ensure-sync-service').catch(() => undefined)
  }, [])

  /* 记录最近房间（扫码/邀请链接/直接跳转等一切入房路径都覆盖） */
  useEffect(() => {
    addRecentRoom(code, room.roomName || '')
  }, [code, room.roomName])

  /* 全局快捷键：?（Shift+/）呼出快捷键帮助；输入框聚焦时不触发 */
  useEffect(() => {
    if (!room.joined) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?') return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
      e.preventDefault()
      setShortcutsOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [room.joined])

  const player = useSyncPlayer({
    playback: room.playback,
    isOwner: room.isOwner,
    playlist: room.playlist,
    sendControl: room.sendControl,
    sendTick: room.sendTick,
    sendWatch: room.sendWatch,
    autoNext,
    mode,
  })

  const sendControl = room.sendControl
  const sendMoment = room.sendMoment

  /** 精彩时刻打点（全员）；失败时 toast 原因（冷却/未连接等） */
  const addMoment = useCallback(
    (t: number) => {
      void sendMoment(t).then((res) => {
        if (!res.ok) toast({ title: res.error || '打点失败', variant: 'destructive' })
      })
    },
    [sendMoment, toast]
  )
  /** 播放器上的播放/暂停（全员同步）；以本地 video 真实状态为准（服务端状态有 ≤2s 心跳延迟）；片尾按播放 = 从头重播 */
  const togglePlay = useCallback(() => {
    const pb = room.playback
    if (!pb?.bvid) return
    const video = player.videoRef.current
    const localPlaying = video && mode === 'native' ? !video.paused && !video.ended : !!pb.playing
    if (localPlaying) {
      void sendControl({ action: 'pause', position: player.getEstimate() })
      return
    }
    const est = player.getEstimate()
    const atEnd = pb.duration > 0 && est >= pb.duration - 1.5
    void sendControl({ action: 'play', position: atEnd ? 0 : est })
  }, [room.playback, sendControl, player, mode])

  /** 切换画质（全员同步，原生模式为真实切换） */
  const changeQuality = useCallback(
    (qn: number) => {
      void sendControl({ action: 'setQn', qn })
    },
    [sendControl]
  )

  /** 键盘/快捷方式快速跳转（全员同步） */
  const skip = useCallback(
    (delta: number) => {
      void sendControl({ action: 'skip', delta })
    },
    [sendControl]
  )

  /** 房主点击时刻芯片 → 全员跳转 */
  const seekToMoment = useCallback(
    (t: number) => {
      void sendControl({ action: 'seek', position: t })
    },
    [sendControl]
  )

  /** 取当前播放进度（打点用）：优先本地 video 真实值，回退服务端估算 */
  const getCurrentTime = useCallback(() => {
    const v = player.videoRef.current
    if (mode === 'native' && v && v.readyState > 0) return v.currentTime
    return player.getEstimate()
  }, [player, mode])

  /** 弹幕数据（原生模式自绘；跟随开关与否都预加载，避免开关时闪加载） */
  const danmaku = useDanmaku(room.playback?.bvid || null, room.playback?.page || 1, mode === 'native' && !!room.playback?.bvid)

  const name = nickname || '访客'

  const copy = async (what: 'code' | 'link') => {
    try {
      const text = what === 'code' ? code : `${window.location.origin}/#/room/${code}`
      await navigator.clipboard.writeText(text)
      setCopied(what)
      toast({ title: what === 'code' ? '房间码已复制 📋' : '邀请链接已复制 🔗' })
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast({ title: '复制失败，请手动复制', description: what === 'code' ? code : `${window.location.origin}/#/room/${code}` })
    }
  }

  const leave = () => {
    window.location.hash = '#/'
  }

  /* ============ 连接中 / 错误态 ============ */
  if (!room.joined) {
    return (
      <div className="dark flex min-h-screen flex-col items-center justify-center gap-4 bg-cinema px-6 text-center">
        {room.joinError ? (
          <>
            <AlertTriangle className="h-12 w-12 text-[#fb7299]" />
            <h1 className="text-xl font-bold text-surface-foreground">无法加入房间</h1>
            <p className="max-w-sm text-sm text-surface-muted-foreground">{room.joinError}（房间码：{code}）</p>
            <div className="flex gap-2">
              <Button variant="outline" className="border-surface-border bg-surface text-surface-foreground hover:bg-surface-2" onClick={leave}>
                返回首页
              </Button>
              <Button className="bg-[#fb7299] hover:bg-[#f45d8b]" onClick={() => window.location.reload()}>
                重试
              </Button>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="h-10 w-10 animate-spin text-[#fb7299]" />
            <p className="text-sm text-surface-muted-foreground">正在连接房间 {code} …</p>
          </>
        )}
      </div>
    )
  }

  /* ============ 房间主界面 ============ */
  /* dark class 固定在根元素：影院页不随全局主题翻转（@custom-variant 基于 class 策略），
     内部 shadcn 原语（Button/Tabs/Switch 等）始终解析深色变体；
     表面/文字用影院 surface token，Portal 弹层同样恒深色。 */
  return (
    <div className="dark flex min-h-screen flex-col bg-cinema text-surface-foreground xl:h-screen xl:overflow-hidden">
      {/* 顶栏 */}
      <header className="shrink-0 border-b border-surface-border bg-surface/70 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-3 px-4">
          <button className="flex items-center gap-2" onClick={leave} title="返回首页">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#fb7299] text-white">
              <Clapperboard className="h-4 w-4" />
            </span>
            <span className="hidden font-bold sm:inline">
              Bili<span className="text-[#fb7299]">Together</span>
            </span>
          </button>

          <div className="mx-1 hidden h-6 w-px bg-surface-border sm:block" />

          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-surface-foreground">
              {room.roomName || `房间 ${code}`}
              {room.isOwner && (
                <Badge className="h-5 bg-[#fb7299]/20 px-1.5 text-[10px] font-bold text-[#fb7299]">
                  <Crown className="mr-0.5 h-3 w-3" /> 我是房主
                </Badge>
              )}
            </p>
            <p className="truncate text-xs text-surface-muted-foreground">
              房主：{room.members.find((m) => m.isOwner)?.name || room.creatorName}
            </p>
          </div>

          {/* 房间码 */}
          <button
            onClick={() => copy('code')}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[#fb7299]/30 bg-[#fb7299]/10 px-3 font-mono text-sm font-bold tracking-[0.2em] text-[#fb7299] transition-colors hover:bg-[#fb7299]/20"
            title="点击复制房间码"
          >
            {code}
            {copied === 'code' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5 opacity-60" />}
          </button>

          <Button
            variant="outline"
            size="icon"
            className="hidden h-9 w-9 shrink-0 border-surface-border bg-surface-2 hover:bg-surface-3 sm:inline-flex"
            onClick={() => copy('link')}
            title="复制邀请链接"
          >
            {copied === 'link' ? <Check className="h-4 w-4 text-emerald-400" /> : <Link2 className="h-4 w-4" />}
          </Button>

          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0 border-[#fb7299]/30 bg-[#fb7299]/10 text-[#fb7299] hover:border-[#fb7299]/50 hover:bg-[#fb7299]/20"
            onClick={() => setQrOpen(true)}
            title="二维码邀请（手机扫码入房）"
          >
            <QrCode className="h-4 w-4" />
          </Button>

          <InviteQrDialog open={qrOpen} onOpenChange={setQrOpen} code={code} />

          <ThemeToggle />

          <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} isOwner={room.isOwner} />

          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0 border-surface-border bg-surface-2 text-surface-foreground hover:border-[#fb7299]/40 hover:bg-[#fb7299]/10 hover:text-[#fb7299]"
            onClick={() => setShortcutsOpen(true)}
            title="键盘快捷键（按 ? 也能打开）"
            aria-label="快捷键帮助"
          >
            <Keyboard className="h-4 w-4" />
          </Button>

          <Badge variant="outline" className="hidden h-9 gap-1.5 border-surface-border px-3 text-surface-foreground md:flex">
            <Users className="h-3.5 w-3.5 text-[#fb7299]" />
            {room.members.length}
          </Badge>

          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0 border-surface-border bg-surface-2 text-surface-foreground hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400"
            onClick={leave}
            title="离开房间"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* 主体 */}
      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 p-4 xl:min-h-0 xl:flex-row">
        {/* 左侧：播放器 + 控制 */}
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <PlayerStage
              hasVideo={player.hasVideo}
              isOwner={room.isOwner}
              title={room.playback?.title || null}
              cover={room.playback?.cover || null}
              playing={!!room.playback?.playing}
              mode={mode}
              videoProps={player.videoProps}
              streamLoading={player.streamLoading}
              streamError={player.streamError}
              streamErrorCode={player.streamErrorCode}
              grantedQn={player.grantedQn}
              qualities={player.qualities}
              qualityDowngraded={player.qualityDowngraded}
              needsGesture={player.needsGesture}
              locallyPlaying={player.locallyPlaying}
              onRetryStream={player.retryStream}
              onRetryPlayback={player.retryPlayback}
              onTogglePlay={togglePlay}
              onQualityChange={changeQuality}
              onUseCompat={() => switchMode('iframe')}
              onSkip={skip}
              danmakuItems={danmaku.items}
              danmakuRoomOn={!!room.playback?.danmaku}
              danmakuTarget={room.playback?.bvid ? { bvid: room.playback.bvid, page: room.playback.page || 1 } : null}
              selfUid={uid}
              rate={room.playback?.rate || 1}
              moments={room.moments}
              onAddMoment={addMoment}
              onSeekToMoment={seekToMoment}
              getCurrentTime={getCurrentTime}
              iframeSrc={player.iframeSrc}
              iframeKey={player.iframeKey}
            />
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}>
            {room.playback && (
              <ControlBar
                playback={room.playback}
                isOwner={room.isOwner}
                connected={room.connected}
                directApi={player.directApi}
                autoNext={autoNext}
                onAutoNextChange={setAutoNext}
                sendControl={room.sendControl}
                resyncSelf={player.resyncSelf}
                getEstimate={player.getEstimate}
                mode={mode}
                onModeChange={switchMode}
                qualities={player.qualities}
                grantedQn={player.grantedQn}
                qualityDowngraded={player.qualityDowngraded}
                requestedQn={room.playback?.qn || 64}
                durationOverride={player.totalLength}
                streamLogged={player.streamLogged}
                refreshStream={player.retryStream}
              />
            )}
          </motion.div>

          {/* 选片/点播：房主直接控制；成员投稿（房主审核后进入队列） */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.15 }}>
            <VideoPicker
              sendControl={room.sendControl}
              sendSubmit={room.sendSubmit}
              isOwner={room.isOwner}
              onAdded={() => undefined}
            />
          </motion.div>

          {/* 观影提示 */}
          <p className="hidden text-xs leading-relaxed text-surface-muted-foreground lg:block">
            {mode === 'native'
              ? '提示：原生模式直接播放B站视频流，房主切换画质/倍速全员真实生效，弹幕已回归（右上角可调字号/透明度/速度）。'
              : '提示：兼容模式使用B站官方外链播放器（带弹幕），画质仅支持「最高可用」，倍速不受控。'}
            {room.isOwner
              ? mode === 'native'
                ? ' 房主切换视频/画质/倍速后，所有成员将自动同步。'
                : ' 房主切换视频/弹幕后，所有成员将自动同步。'
              : ' 成员投稿需房主审核；如感觉进度不一致，点击「回到同步点」即可。'}
          </p>
        </section>

        {/* 右侧：聊天/成员/列表 */}
        <aside className="flex h-[520px] shrink-0 flex-col xl:h-auto xl:min-h-0 xl:w-[380px]">
          <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4, delay: 0.2 }} className="flex min-h-0 flex-1 flex-col">
            <RoomSidebar
              messages={room.messages}
              members={room.members}
              playlist={room.playlist}
              playback={room.playback}
              selfUid={uid}
              selfName={name}
              isOwner={room.isOwner}
              watchStats={watchStats}
              roomName={room.roomName}
              roomCode={code}
              onSend={room.sendChat}
              onPlayItem={(itemId) => void room.sendControl({ action: 'playPlaylistItem', itemId })}
              onMoveItem={(itemId, dir) => void room.sendControl({ action: 'movePlaylistItem', itemId, dir })}
              onPlayNext={() => void room.sendControl({ action: 'playNextItem' })}
              onRemoveItem={(itemId) => void room.sendControl({ action: 'removePlaylistItem', itemId })}
              onClear={() => void room.sendControl({ action: 'clearPlaylist' })}
              onReviewItem={(itemId, approve) => void room.sendControl({ action: 'reviewQueueItem', itemId, approve })}
              onTransfer={(targetUid) => room.transferOwner(targetUid)}
              typingPeers={room.typingPeers}
              onTypingChange={room.sendTyping}
            />
          </motion.div>
        </aside>
      </main>

      {/* 观看里程碑庆祝动效（全房间广播） */}
      <MilestoneCelebration milestone={room.milestone} onDone={room.clearMilestone} />
    </div>
  )
}
