'use client'

import { useEffect, useState } from 'react'
import { Music, Sparkles, Settings2, Info, Timer, Pencil } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import type { ControlAction, RoomSettings } from '@/lib/room-types'

interface RoomSettingsDialogProps {
  settings: RoomSettings
  isOwner: boolean
  roomName: string
  sendControl: (payload: ControlAction) => Promise<{ ok: boolean; error?: string; name?: string }>
  open: boolean
  onOpenChange: (v: boolean) => void
}

const SLOW_MODE_CHOICES = [
  { value: '0', label: '关闭' },
  { value: '5', label: '5 秒' },
  { value: '10', label: '10 秒' },
  { value: '30', label: '30 秒' },
]

/** 房间设置（仅房主可改）：房间改名 + 成员权限开关，实时生效、全员广播、重启不丢 */
export function RoomSettingsDialog({ settings, isOwner, roomName, sendControl, open, onOpenChange }: RoomSettingsDialogProps) {
  const { toast } = useToast()
  const [nameDraft, setNameDraft] = useState(roomName)
  const [renaming, setRenaming] = useState(false)

  // 弹窗每次打开时同步最新房间名到输入框
  useEffect(() => {
    if (open) setNameDraft(roomName)
  }, [open, roomName])

  const toggle = (key: keyof Pick<RoomSettings, 'allowSubmit' | 'allowMoment'>, value: boolean) => {
    void sendControl({ action: 'setRoomSettings', settings: { [key]: value } })
  }

  const changeSlowMode = (value: string) => {
    void sendControl({ action: 'setRoomSettings', settings: { slowModeSeconds: Number(value) } })
  }

  const rename = async () => {
    const name = nameDraft.trim()
    if (!name) {
      toast({ title: '房间名不能为空', variant: 'destructive' })
      return
    }
    if (name === roomName) return
    setRenaming(true)
    try {
      const res = await sendControl({ action: 'setRoomName', name })
      if (res?.ok) {
        toast({ title: `房间已改名为「${name}」 ✏️` })
      } else if (res?.error) {
        toast({ title: '改名失败', description: res.error, variant: 'destructive' })
      }
    } finally {
      setRenaming(false)
    }
  }

  const dirty = nameDraft.trim() !== roomName && nameDraft.trim() !== ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {isOwner && (
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={`h-9 w-9 shrink-0 border-surface-border bg-surface-2 text-surface-foreground transition-colors hover:border-[#fb7299]/40 hover:bg-[#fb7299]/10 hover:text-[#fb7299] ${open ? 'border-[#fb7299]/50 bg-[#fb7299]/10 text-[#fb7299]' : ''}`}
            title="房间设置（改名与成员权限）"
            aria-label="房间设置"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="border-surface-border bg-surface text-surface-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Settings2 className="h-4 w-4 text-[#fb7299]" />
            房间设置
          </DialogTitle>
          <DialogDescription className="text-xs text-surface-muted-foreground">
            改名与权限开关实时生效并广播全房间，修改会自动保存（重启不丢）。
          </DialogDescription>
        </DialogHeader>

        <div className="bt-scroll flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {/* 房间改名 */}
          <div className="rounded-lg border border-surface-border bg-surface-2 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-surface-foreground">
              <Pencil className="h-3.5 w-3.5 text-[#fb7299]" />
              房间名称
            </p>
            <div className="flex gap-2">
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && rename()}
                maxLength={30}
                placeholder="给房间起个名字（最多 30 字）"
                className="h-9 border-surface-border bg-surface text-sm text-surface-foreground placeholder:text-surface-muted-foreground focus-visible:ring-[#fb7299]"
                aria-label="房间名称"
              />
              <Button
                size="sm"
                className="h-9 shrink-0 bg-[#fb7299] hover:bg-[#f45d8b]"
                onClick={rename}
                disabled={renaming || !dirty}
                aria-label="保存房间名"
              >
                {renaming ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>

          {/* 成员投稿开关 */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-surface-border bg-surface-2 p-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#fb7299]/15">
                <Music className="h-4 w-4 text-[#fb7299]" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-surface-foreground">成员投稿点播</p>
                <p className="mt-0.5 text-xs text-surface-muted-foreground">
                  {settings.allowSubmit ? '成员可以投稿视频，由你审核后进入播放队列' : '已关闭：成员无法投稿，仅你可以选片'}
                </p>
              </div>
            </div>
            <Switch
              checked={settings.allowSubmit}
              onCheckedChange={(v) => toggle('allowSubmit', v)}
              aria-label="允许成员投稿点播"
            />
          </div>

          {/* 成员打点开关 */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-surface-border bg-surface-2 p-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-400/15">
                <Sparkles className="h-4 w-4 text-amber-400" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-surface-foreground">成员打点精彩时刻</p>
                <p className="mt-0.5 text-xs text-surface-muted-foreground">
                  {settings.allowMoment ? '所有人都可以按 M 或点打点按钮记录精彩进度' : '已关闭：仅你可以打点回看标记'}
                </p>
              </div>
            </div>
            <Switch
              checked={settings.allowMoment}
              onCheckedChange={(v) => toggle('allowMoment', v)}
              aria-label="允许成员打点精彩时刻"
            />
          </div>

          {/* 聊天慢速模式 */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-surface-border bg-surface-2 p-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-400/15">
                <Timer className="h-4 w-4 text-sky-400" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-surface-foreground">聊天慢速模式</p>
                <p className="mt-0.5 text-xs text-surface-muted-foreground">
                  {settings.slowModeSeconds > 0
                    ? `成员每 ${settings.slowModeSeconds} 秒只能发一条消息，防止刷屏`
                    : '限制成员发言频率，人多的房间保持聊天可读'}
                </p>
              </div>
            </div>
            <Select value={String(settings.slowModeSeconds)} onValueChange={changeSlowMode}>
              <SelectTrigger
                className="h-9 w-[88px] shrink-0 border-surface-border bg-surface text-xs text-surface-foreground hover:bg-surface-3"
                aria-label="聊天慢速模式间隔"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-surface-border bg-surface text-surface-foreground">
                {SLOW_MODE_CHOICES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="flex items-start gap-1.5 rounded-lg bg-[#fb7299]/8 px-3 py-2 text-[11px] leading-relaxed text-surface-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#fb7299]" />
            房主本人不受以上开关限制；被关闭的成员侧会立即收到提示并隐藏对应入口。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
