'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crown, Monitor, Smartphone, Tablet, Send, Play, Trash2, ListVideo, Users, MessagesSquare, Video, Clock3, Eye, Trophy, MoreVertical, SkipForward, ChevronsUp, ChevronUp, ChevronDown, Share2, Music, Hourglass, Check, X } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { EmojiPicker } from '@/components/room/emoji-picker'
import { WatchCardDialog } from '@/components/room/watch-card-dialog'
import { formatTime } from '@/lib/bili'
import type { WatchStatEntry } from '@/components/room-view'
import type { ChatMessage, PlaybackState, PlaylistItem, RoomMember } from '@/lib/room-types'

interface RoomSidebarProps {
  messages: ChatMessage[]
  members: RoomMember[]
  playlist: PlaylistItem[]
  playback: PlaybackState | null
  selfUid: string
  /** 当前用户昵称（用于「我的投稿」标记） */
  selfName?: string
  isOwner: boolean
  /** 历史观看统计（含离线成员，供榜单展示） */
  watchStats?: WatchStatEntry[]
  /** 房间名（分享卡片用） */
  roomName?: string
  /** 房间码（分享卡片用） */
  roomCode: string
  onSend: (text: string) => void
  onPlayItem: (itemId: string) => void
  onMoveItem: (itemId: string, dir: 'up' | 'down' | 'top') => void
  onPlayNext: () => void
  onRemoveItem: (itemId: string) => void
  onClear: () => void
  onReviewItem: (itemId: string, approve: boolean) => void
  onTransfer: (uid: string) => void
  /** 正在其他成员打字的列表（4s 无更新自动过期） */
  typingPeers?: { uid: string; name: string }[]
  /** 上报本端正在输入状态 */
  onTypingChange?: (typing: boolean) => void
}

const DEVICE_ICON = { pc: Monitor, mobile: Smartphone, tablet: Tablet }

/** 时长格式化：61s → 1分钟；3700s → 1.0小时 */
function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0分钟'
  if (sec < 60) return '<1分钟'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟`
  const h = Math.floor(min / 60)
  const rem = min % 60
  return rem > 0 ? `${h}小时${rem}分` : `${h}小时`
}

export function RoomSidebar({
  messages,
  members,
  playlist,
  playback,
  selfUid,
  selfName = '',
  isOwner,
  watchStats = [],
  roomName = '',
  roomCode,
  onSend,
  onPlayItem,
  onMoveItem,
  onPlayNext,
  onRemoveItem,
  onClear,
  onReviewItem,
  onTransfer,
  typingPeers = [],
  onTypingChange,
}: RoomSidebarProps) {
  const [text, setText] = useState('')
  const chatBottomRef = useRef<HTMLDivElement>(null)
  const [cardOpen, setCardOpen] = useState(false)

  /* ---- 「正在输入」上报：输入中上报 true，2.5s 无输入/发送/清空/失焦自动上报 false ---- */
  const typingSentRef = useRef(false)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopTyping = useCallback(() => {
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
    }
    if (typingSentRef.current) {
      typingSentRef.current = false
      onTypingChange?.(false)
    }
  }, [onTypingChange])
  useEffect(() => stopTyping, [stopTyping])
  const handleInputChange = (v: string) => {
    setText(v)
    if (!onTypingChange) return
    if (!v.trim()) {
      stopTyping()
      return
    }
    if (!typingSentRef.current) {
      typingSentRef.current = true
      onTypingChange(true)
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(stopTyping, 2500)
  }

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const currentKey = playback?.bvid ? `${playback.bvid}|${playback.page}` : ''

  const send = () => {
    const v = text.trim()
    if (!v) return
    onSend(v)
    setText('')
    stopTyping()
  }

  const deviceCount = useMemo(() => {
    const m = { pc: 0, mobile: 0, tablet: 0 }
    for (const mem of members) m[mem.device]++
    return m
  }, [members])

  /* 在线时长每 10s 刷新一次（服务端 joinedAt 计算，本地展示） */
  const [, setClockTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setClockTick((v) => v + 1), 10000)
    return () => clearInterval(t)
  }, [])

  const totalWatch = useMemo(() => members.reduce((s, m) => s + (m.watchSeconds || 0), 0), [members])

  /* 点歌台：待播条目数与剩余时长（不含正在播放/待审核条目） */
  const queueStats = useMemo(() => {
    const approved = playlist.filter((p) => !p.pending)
    let pendingCount = 0
    let remainingSec = 0
    let seenCurrent = false
    for (const item of approved) {
      const playingNow = currentKey === `${item.bvid}|${item.page}`
      if (playingNow) {
        seenCurrent = true
        continue
      }
      if (seenCurrent) {
        pendingCount++
        remainingSec += item.duration || 0
      }
    }
    // 当前播放的条目不在列表（房主直接粘贴）：全部都是待播
    if (!seenCurrent) {
      pendingCount = approved.length
      remainingSec = approved.reduce((s, i) => s + (i.duration || 0), 0)
    }
    return { pendingCount, remainingSec }
  }, [playlist, currentKey])

  /* 待审核投稿（成员投稿，房主审批后才进入正式队列） */
  const pendingItems = useMemo(() => playlist.filter((p) => p.pending), [playlist])
  const approvedItems = useMemo(() => playlist.filter((p) => !p.pending), [playlist])

  /* 观看时长榜：历史统计与在线成员实时数据合并（在线者按 baseUid 归属覆盖，
     避免同一人因 tab 级 uid 与浏览器级 baseUid 不同 key 而出现两条） */
  const watchBoard = useMemo(() => {
    const map = new Map<string, { uid: string; name: string; seconds: number; online: boolean }>()
    for (const w of watchStats) {
      if (w.seconds > 0) map.set(w.uid, { uid: w.uid, name: w.name, seconds: w.seconds, online: false })
    }
    for (const m of members) {
      const cur = m.watchSeconds || 0
      if (cur > 0) {
        const key = m.baseUid || m.uid
        map.set(key, { uid: key, name: m.name, seconds: cur, online: true })
      }
    }
    return [...map.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 8)
  }, [watchStats, members])

  return (
    <>
    <Tabs defaultValue="chat" className="flex h-full min-h-0 flex-col gap-0 overflow-hidden rounded-xl border border-surface-border bg-surface/80 backdrop-blur">
      <TabsList className="h-12 w-full shrink-0 justify-start rounded-b-none border-b border-surface-border bg-surface/90 px-2">
        <TabsTrigger value="chat" className="gap-1.5 data-[state=active]:text-[#fb7299]">
          <MessagesSquare className="h-4 w-4" /> 聊天
        </TabsTrigger>
        <TabsTrigger value="members" className="gap-1.5 data-[state=active]:text-[#fb7299]">
          <Users className="h-4 w-4" /> 成员
          <Badge variant="secondary" className="ml-1 h-5 bg-[#fb7299]/15 px-1.5 text-[10px] text-[#fb7299]">
            {members.length}
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="playlist" className="gap-1.5 data-[state=active]:text-[#fb7299]">
          <ListVideo className="h-4 w-4" /> 列表
          {(playlist.length > 0 || pendingItems.length > 0) && (
            <Badge variant="secondary" className="ml-1 h-5 bg-[#fb7299]/15 px-1.5 text-[10px] text-[#fb7299]">
              {playlist.length}
              {pendingItems.length > 0 && (
                <span title="有待审核投稿" className="ml-0.5 inline-flex">
                  <Hourglass className="h-2.5 w-2.5 text-amber-400" />
                </span>
              )}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>

      {/* 聊天 */}
      <TabsContent value="chat" className="mt-0 flex min-h-0 flex-1 flex-col">
        <ScrollArea className="bt-scroll min-h-0 flex-1 px-3 py-2 xl:h-auto">
          <div className="flex flex-col gap-2 pr-2">
            {messages.length === 0 && (
              <p className="py-8 text-center text-sm text-surface-muted-foreground">还没有消息，说点什么吧～</p>
            )}
            {messages.map((m) =>
              m.kind === 'system' ? (
                <p key={m.id} className="my-1 text-center text-xs leading-relaxed text-surface-muted-foreground">
                  {m.text}
                </p>
              ) : m.uid === selfUid ? (
                <div key={m.id} className="flex flex-col items-end">
                  <span className="mb-0.5 text-[10px] text-surface-muted-foreground">{m.name} · 我</span>
                  <span className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#fb7299] px-3 py-1.5 text-sm text-white">
                    {m.text}
                  </span>
                </div>
              ) : (
                <div key={m.id} className="flex flex-col items-start">
                  <span className="mb-0.5 text-[10px] text-surface-muted-foreground">{m.name}</span>
                  <span className="max-w-[85%] rounded-2xl rounded-bl-sm bg-surface-2 px-3 py-1.5 text-sm text-surface-foreground">
                    {m.text}
                  </span>
                </div>
              )
            )}
            <div ref={chatBottomRef} />
          </div>
        </ScrollArea>
        <div className="shrink-0 border-t border-surface-border p-3">
          {/* 「正在输入」指示器（最多展示 2 个昵称，其余用「等人」汇总） */}
          {typingPeers.length > 0 && (
            <p className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-[#fb7299]" aria-live="polite">
              <span className="flex items-end gap-0.5" aria-hidden>
                <i className="bt-typing-dot h-1 w-1 rounded-full bg-[#fb7299]" />
                <i className="bt-typing-dot h-1 w-1 rounded-full bg-[#fb7299]" style={{ animationDelay: '0.2s' }} />
                <i className="bt-typing-dot h-1 w-1 rounded-full bg-[#fb7299]" style={{ animationDelay: '0.4s' }} />
              </span>
              {typingPeers.slice(0, 2).map((p) => p.name).join('、')}
              {typingPeers.length > 2 ? ` 等 ${typingPeers.length} 人` : ''}
              正在输入…
            </p>
          )}
          <div className="flex gap-2">
            <EmojiPicker onPick={(e) => setText((prev) => (prev + e).slice(0, 300))} />
            <Input
              value={text}
              maxLength={300}
              placeholder="发条消息…"
              className="border-surface-border bg-surface-2 text-surface-foreground placeholder:text-surface-muted-foreground focus-visible:ring-[#fb7299]"
              onChange={(e) => handleInputChange(e.target.value)}
              onBlur={stopTyping}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <Button size="icon" className="h-10 w-10 shrink-0 bg-[#fb7299] hover:bg-[#f45d8b]" onClick={send} disabled={!text.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </TabsContent>

      {/* 成员 */}
      <TabsContent value="members" className="bt-scroll mt-0 min-h-0 flex-1 overflow-y-auto px-3 py-3 xl:h-auto">
        <div className="mb-3 flex items-center justify-between text-xs text-surface-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Video className="h-3.5 w-3.5" />
            {deviceCount.pc} 台电脑 · {deviceCount.mobile} 台手机 · {deviceCount.tablet} 台平板
          </span>
          {totalWatch > 0 && (
            <span className="flex items-center gap-1" title="本房间所有成员累计观看（历史+本次，已持久化，重启不丢失）">
              <Eye className="h-3.5 w-3.5 text-[#fb7299]" />
              累计 {formatDuration(totalWatch)}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2 pr-1">
          {members.map((m) => {
            const Icon = DEVICE_ICON[m.device] || Monitor
            const onlineSec = m.onlineSeconds ?? Math.max(0, Math.floor((Date.now() - m.joinedAt) / 1000))
            const watchSec = m.watchSeconds || 0
            return (
              <div
                key={m.uid}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                  m.uid === selfUid ? 'border-[#fb7299]/40 bg-[#fb7299]/5' : 'border-surface-border bg-surface-2/50'
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${
                    m.isOwner ? 'bg-gradient-to-br from-[#fb7299] to-[#e05a83]' : 'bg-surface-3'
                  }`}
                >
                  {m.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-surface-foreground">
                    {m.name}
                    {m.isOwner && <Crown className="h-3.5 w-3.5 shrink-0 text-[#fb7299]" />}
                    {m.uid === selfUid && <span className="text-[10px] text-surface-muted-foreground">（我）</span>}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-surface-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Icon className="h-3 w-3" />
                      {m.device === 'mobile' ? '手机' : m.device === 'tablet' ? '平板' : '电脑'}
                    </span>
                    <span className="flex items-center gap-1" title="本次在线时长">
                      <Clock3 className="h-3 w-3" />
                      在线 {formatDuration(onlineSec)}
                    </span>
                    <span className="flex items-center gap-1" title="累计真实观看时长（历史+本次，重启不丢失）">
                      <Eye className="h-3 w-3 text-[#fb7299]/70" />
                      观看 <span className="font-mono text-[#fb7299]/90">{formatDuration(watchSec)}</span>
                    </span>
                  </p>
                </div>
                {isOwner && !m.isOwner && (
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 shrink-0 px-2 text-xs text-surface-muted-foreground hover:bg-[#fb7299]/10 hover:text-[#fb7299] dark:hover:bg-[#fb7299]/10"
                          onClick={() => onTransfer(m.uid)}
                        >
                          <Crown className="mr-1 h-3.5 w-3.5" />
                          移交
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>把房主权限移交给 {m.name}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            )
          })}
          {members.length === 0 && <p className="py-6 text-center text-sm text-surface-muted-foreground">加载中…</p>}
        </div>

        {/* 观看时长榜（历史 + 实时合并，重启不丢失） */}
        {watchBoard.length > 0 && (
          <div className="mt-4 rounded-lg border border-surface-border bg-surface/60 p-3">
            <p className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-surface-foreground">
              <Trophy className="h-3.5 w-3.5 text-amber-400" />
              观看时长榜
              <span className="ml-auto font-normal text-[10px] text-surface-muted-foreground">历史+本次 · 重启不丢</span>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-surface-muted-foreground transition-colors hover:bg-[#fb7299]/15 hover:text-[#fb7299]"
                      title="生成分享卡片"
                      aria-label="生成观看榜分享卡片"
                      onClick={() => setCardOpen(true)}
                    >
                      <Share2 className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>生成分享卡片（含邀请二维码）</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </p>
            <div className="flex flex-col gap-1.5">
              {watchBoard.map((w, i) => {
                const top = watchBoard[0]?.seconds || 1
                const pct = Math.max(6, Math.round((w.seconds / top) * 100))
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null
                return (
                  <div
                    key={w.uid}
                    className="bt-fade-up flex items-center gap-2"
                    style={{ animationDelay: `${Math.min(i * 45, 360)}ms` }}
                  >
                    <span className={`w-5 shrink-0 text-center text-xs ${medal ? '' : 'font-mono text-surface-muted-foreground'}`}>{medal || i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-xs leading-tight">
                        <span className={`truncate ${w.uid === selfUid ? 'font-semibold text-[#fb7299]' : 'text-surface-foreground'}`}>{w.name}</span>
                        {w.online && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" title="在线" />}
                      </p>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                        <div
                          className={`h-full rounded-full ${i === 0 ? 'bg-gradient-to-r from-amber-400 to-[#fb7299]' : 'bg-[#fb7299]/50'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-surface-muted-foreground" title="累计观看时长">
                      {formatDuration(w.seconds)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </TabsContent>

      {/* 播放列表 */}
      <TabsContent value="playlist" className="bt-scroll mt-0 min-h-0 flex-1 overflow-y-auto px-3 py-3 xl:h-auto">
        {playlist.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <ListVideo className="h-8 w-8 text-surface-muted-foreground" />
            <p className="text-sm text-surface-muted-foreground">列表还是空的</p>
            {isOwner ? (
              <p className="text-xs text-surface-muted-foreground">在左侧粘贴视频链接即可添加</p>
            ) : (
              <p className="text-xs text-surface-muted-foreground">在左侧投稿点播，房主审核后自动进入队列 🎵</p>
            )}
          </div>
        ) : (
          <>
            {/* 点歌台队列头：统计 + 房主下一首（按正式队列统计，不含待审核） */}
            <div className="mb-2.5 flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface/60 px-3 py-2">
              <p className="truncate text-xs text-surface-muted-foreground" title={`待播 ${queueStats.pendingCount} 条 · 剩余约 ${formatDuration(queueStats.remainingSec)}`}>
                共 {approvedItems.length} 条 · 待播 {queueStats.pendingCount} 条
                {queueStats.remainingSec > 0 && ` · 剩余约 ${formatDuration(queueStats.remainingSec)}`}
              </p>
              {isOwner && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        className="h-7 shrink-0 bg-[#fb7299] px-2.5 text-xs text-white hover:bg-[#f45d8b]"
                        onClick={onPlayNext}
                      >
                        <SkipForward className="mr-1 h-3.5 w-3.5" />
                        下一首
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>立即播放队列中的下一个（全员同步）</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            {approvedItems.length === 0 && (
              <p className="mb-2 py-4 text-center text-xs text-surface-muted-foreground">正式队列空空如也，快挑下一首吧 🎬</p>
            )}
            <div className="flex flex-col gap-2 pr-1">
              {approvedItems.map((item, idx) => {
                const playingNow = currentKey === `${item.bvid}|${item.page}`
                return (
                  <div
                    key={item.id}
                    className={`bt-fade-up group flex items-center gap-3 rounded-lg border p-2 transition-colors ${
                      playingNow ? 'border-[#fb7299]/50 bg-[#fb7299]/8' : 'border-surface-border bg-surface-2/50 hover:border-surface-foreground/15'
                    }`}
                    style={{ animationDelay: `${Math.min(idx * 50, 400)}ms` }}
                  >
                    <span className="w-5 shrink-0 text-center font-mono text-xs text-surface-muted-foreground">{idx + 1}</span>
                    {item.cover ? (
                      <img
                        src={item.cover}
                        alt={item.title}
                        className="h-10 w-[72px] shrink-0 rounded-md object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="flex h-10 w-[72px] shrink-0 items-center justify-center rounded-md bg-surface-3">
                        <Play className="h-4 w-4 text-surface-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-sm ${playingNow ? 'font-semibold text-[#fb7299]' : 'text-surface-foreground'}`}>
                        {playingNow && <span className="mr-1 inline-block animate-pulse">▶</span>}
                        {item.title}
                      </p>
                      <p className="truncate text-xs text-surface-muted-foreground">
                        {item.upName ? `${item.upName} · ` : ''}
                        {item.duration > 0 ? formatTime(item.duration) : ''}
                        {item.page > 1 ? ` · P${item.page}` : ''}
                        {item.addedBy && <span className="text-[#fb7299]/60"> · 来自 {item.addedBy}</span>}
                      </p>
                    </div>
                    {isOwner && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        {!playingNow && (
                          <TooltipProvider delayDuration={300}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-surface-muted-foreground hover:bg-[#fb7299]/10 hover:text-[#fb7299] dark:hover:bg-[#fb7299]/10"
                                  onClick={() => onPlayItem(item.id)}
                                >
                                  <Play className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>立即播放</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-surface-muted-foreground hover:bg-surface-3 hover:text-surface-foreground"
                              title="更多操作"
                            >
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-40 border-surface-border bg-surface text-surface-foreground">
                            {!playingNow && (
                              <DropdownMenuItem className="cursor-pointer gap-2 data-[highlighted]:bg-[#fb7299]/15 data-[highlighted]:text-[#fb7299]" onClick={() => onMoveItem(item.id, 'top')}>
                                <ChevronsUp className="h-4 w-4" /> 移到最前
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem className="cursor-pointer gap-2 data-[highlighted]:bg-[#fb7299]/15 data-[highlighted]:text-[#fb7299]" disabled={idx === 0} onClick={() => onMoveItem(item.id, 'up')}>
                              <ChevronUp className="h-4 w-4" /> 上移
                            </DropdownMenuItem>
                            <DropdownMenuItem className="cursor-pointer gap-2 data-[highlighted]:bg-[#fb7299]/15 data-[highlighted]:text-[#fb7299]" disabled={idx === approvedItems.length - 1} onClick={() => onMoveItem(item.id, 'down')}>
                              <ChevronDown className="h-4 w-4" /> 下移
                            </DropdownMenuItem>
                            <DropdownMenuSeparator className="bg-surface-3" />
                            <DropdownMenuItem className="cursor-pointer gap-2 text-red-400 data-[highlighted]:bg-red-500/15 data-[highlighted]:text-red-400" onClick={() => onRemoveItem(item.id)}>
                              <Trash2 className="h-4 w-4" /> 从列表移除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* 待审核投稿区（成员投稿 → 房主审批） */}
            {pendingItems.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 p-2.5">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-300/90">
                  <Hourglass className="h-3.5 w-3.5" />
                  待审核投稿 · {pendingItems.length} 条
                  <span className="ml-auto font-normal text-[10px] text-surface-muted-foreground">
                    {isOwner ? '通过后进入播放队列' : '等待房主审核'}
                  </span>
                </p>
                <div className="flex flex-col gap-2">
                  {pendingItems.map((item, idx) => (
                    <div
                      key={item.id}
                      className="bt-fade-up flex items-center gap-3 rounded-lg border border-amber-400/20 bg-surface-2/60 p-2"
                      style={{ animationDelay: `${Math.min(idx * 50, 300)}ms` }}
                    >
                      <Music className="h-4 w-4 shrink-0 text-amber-300/80" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-surface-foreground">{item.title}</p>
                        <p className="truncate text-xs text-surface-muted-foreground">
                          {item.duration > 0 ? `${formatTime(item.duration)} · ` : ''}
                          <span className="text-[#fb7299]/70">{item.addedBy || '成员'} 投稿</span>
                          {item.addedBy && item.addedBy === selfName && ' · 我的投稿'}
                        </p>
                      </div>
                      {isOwner ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <TooltipProvider delayDuration={300}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  className="h-7 w-7 bg-emerald-500/90 text-white hover:bg-emerald-500"
                                  onClick={() => onReviewItem(item.id, true)}
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>通过（加入播放队列）</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider delayDuration={300}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="h-7 w-7 border-surface-border bg-surface text-surface-muted-foreground hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400"
                                  onClick={() => onReviewItem(item.id, false)}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>婉拒</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      ) : (
                        <span className="shrink-0 animate-pulse rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] text-amber-300">
                          审核中…
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isOwner && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 w-full text-xs text-surface-muted-foreground hover:bg-red-500/10 hover:text-red-400 dark:hover:bg-red-500/10"
                onClick={onClear}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" /> 清空列表
              </Button>
            )}
          </>
        )}
      </TabsContent>
    </Tabs>
      <WatchCardDialog
        open={cardOpen}
        onOpenChange={setCardOpen}
        roomName={roomName}
        code={roomCode}
        entries={watchBoard.map((w) => ({ name: w.name, seconds: w.seconds, online: w.online }))}
      />
    </>
  )
}
