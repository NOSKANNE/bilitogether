'use client'

import { useState } from 'react'
import { Link2, Loader2, PlayCircle, ListPlus, LinkIcon, Pencil, Music } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { formatTime } from '@/lib/bili'
import type { BiliVideoMeta } from '@/lib/bili'
import type { ControlAction, PlaylistItem } from '@/lib/room-types'

interface VideoPickerProps {
  sendControl: (payload: ControlAction) => Promise<{ ok: boolean; error?: string }>
  /** 成员投稿入口（需房主审核后才会进入播放队列） */
  sendSubmit: (video: Omit<PlaylistItem, 'id'>) => Promise<{ ok: boolean; error?: string; pending?: boolean; duplicated?: boolean }>
  isOwner: boolean
  onAdded: () => void
}

/** 选片/点播：粘贴链接 → 解析 → 房主：立即播放/加入列表；成员：投稿（房主审核后进入队列） */
export function VideoPicker({ sendControl, sendSubmit, isOwner, onAdded }: VideoPickerProps) {
  const { toast } = useToast()
  const [input, setInput] = useState('')
  const [resolving, setResolving] = useState(false)
  const [video, setVideo] = useState<BiliVideoMeta | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [editableTitle, setEditableTitle] = useState('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)

  const resolve = async () => {
    const v = input.trim()
    if (!v) return
    setResolving(true)
    setVideo(null)
    try {
      const res = await fetch(`/api/bili/resolve?input=${encodeURIComponent(v)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || '解析失败')
      setVideo(json.video)
      setDegraded(!!json.degraded)
      setEditableTitle(json.video.title || '')
      setPage(json.video.page || 1)
      setInput('')
    } catch (err) {
      toast({ title: '解析失败', description: (err as Error).message, variant: 'destructive' })
    } finally {
      setResolving(false)
    }
  }

  const videoPayload = () =>
    video
      ? {
          bvid: video.bvid,
          page,
          title: (editableTitle.trim() || video.title) + (video.pages.length > 1 && page > 1 ? ` P${page}` : ''),
          cover: video.cover,
          upName: video.upName,
          duration: video.pages.length > 0 ? video.pages.find((p) => p.page === page)?.duration || video.duration : video.duration,
          addedBy: '',
        }
      : null

  const playNow = async () => {
    const payload = videoPayload()
    if (!payload) return
    setBusy(true)
    await sendControl({ action: 'setVideo', video: payload })
    // 同时加入列表方便连播
    await sendControl({ action: 'addPlaylistItem', video: payload })
    setVideo(null)
    setBusy(false)
    onAdded()
  }

  const addToList = async () => {
    const payload = videoPayload()
    if (!payload) return
    setBusy(true)
    if (isOwner) {
      const res = await sendControl({ action: 'addPlaylistItem', video: payload })
      setVideo(null)
      setBusy(false)
      onAdded()
      if (res?.ok) toast({ title: '已加入播放列表 📀' })
    } else {
      const res = await sendSubmit(payload)
      setVideo(null)
      setBusy(false)
      onAdded()
      if (res?.ok) {
        toast(
          res.duplicated
            ? { title: '列表里已经有这首啦 🎵' }
            : { title: '投稿成功，等待房主审核 🎵', description: '审核通过后将自动进入播放队列' }
        )
      } else if (res?.error) {
        toast({ title: '投稿失败', description: res.error, variant: 'destructive' })
      }
    }
  }

  return (
    <div className="rounded-xl border border-surface-border bg-surface/80 p-3 backdrop-blur sm:p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-surface-muted-foreground">
        {isOwner ? (
          <>
            <ListPlus className="h-3.5 w-3.5 text-[#fb7299]" />
            房主选片：解析后可立即播放或加入连播列表
          </>
        ) : (
          <>
            <Music className="h-3.5 w-3.5 text-[#fb7299]" />
            点播台：投稿后由房主审核，通过即进入播放队列 🎵
          </>
        )}
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <LinkIcon className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-surface-muted-foreground" />
          <Input
            value={input}
            placeholder="粘贴B站视频链接 / BV号 / av号（支持b23短链与分P）"
            className="border-surface-border bg-surface-2 pl-9 text-surface-foreground placeholder:text-surface-muted-foreground focus-visible:ring-[#fb7299]"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && resolve()}
            disabled={resolving}
          />
        </div>
        <Button className="shrink-0 bg-[#fb7299] hover:bg-[#f45d8b]" onClick={resolve} disabled={resolving || !input.trim()}>
          {resolving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Link2 className="mr-1 h-4 w-4" />}
          {resolving ? '解析中' : '解析'}
        </Button>
      </div>

      {video && (
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-[#fb7299]/25 bg-[#fb7299]/5 p-3 sm:flex-row sm:items-center">
          {video.cover && (
            <img
              src={video.cover}
              alt={video.title}
              className="h-20 w-full shrink-0 rounded-md object-cover sm:w-36"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <Pencil className="mt-2 h-3.5 w-3.5 shrink-0 text-surface-muted-foreground" />
              <Input
                value={editableTitle}
                onChange={(e) => setEditableTitle(e.target.value)}
                maxLength={120}
                className="h-8 border-transparent bg-transparent px-1 text-sm font-semibold text-surface-foreground hover:border-surface-border focus-visible:bg-surface-2 focus-visible:ring-[#fb7299]"
                placeholder="视频标题"
              />
            </div>
            <p className="mt-0.5 pl-6 text-xs text-surface-muted-foreground">
              {video.bvid ? `${video.bvid}` : ''}
              {video.pages.length > 1 ? ` · 共${video.pages.length}P` : ''}
              {video.duration > 0 ? ` · 时长 ${formatTime(video.duration)}` : ''}
            </p>
            {degraded && (
              <p className="mt-1 pl-6 text-[11px] text-amber-400/80">
                当前网络环境下视频信息获取受限，标题可手动编辑；播放不受影响。
              </p>
            )}
            {video.pages.length > 1 && (
              <div className="mt-2 flex items-center gap-2 pl-6">
                <span className="text-xs text-surface-muted-foreground">选择分P（共{video.pages.length}P）：</span>
                <Select value={String(page)} onValueChange={(v) => setPage(Number(v))}>
                  <SelectTrigger className="h-8 w-[240px] border-surface-border bg-surface-2 text-xs text-surface-foreground hover:bg-surface-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-surface-border bg-surface text-surface-foreground">
                    {video.pages.map((p) => (
                      <SelectItem key={p.page} value={String(p.page)}>
                        P{p.page} {p.part}（{formatTime(p.duration)}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            {isOwner && (
              <Button className="bg-[#fb7299] hover:bg-[#f45d8b]" onClick={playNow} disabled={busy}>
                <PlayCircle className="mr-1 h-4 w-4" /> 立即播放
              </Button>
            )}
            <Button
              variant={isOwner ? 'outline' : 'default'}
              className={isOwner ? 'border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3' : 'bg-[#fb7299] hover:bg-[#f45d8b]'}
              onClick={addToList}
              disabled={busy}
            >
              {isOwner ? (
                <>
                  <ListPlus className="mr-1 h-4 w-4" /> 加入列表
                </>
              ) : (
                <>
                  <Music className="mr-1 h-4 w-4" /> 投稿点播
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
