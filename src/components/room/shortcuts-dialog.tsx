'use client'

import { Keyboard, MousePointerClick, MessageSquare, Captions } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface ShortcutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isOwner: boolean
}

interface ShortcutRow {
  keys: string[]
  desc: string
  scope: string
}

function KeyCap({ k }: { k: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-surface-border bg-surface-2 px-1.5 font-mono text-[11px] font-semibold text-surface-foreground shadow-sm">
      {k}
    </kbd>
  )
}

/** 快捷键帮助面板：房间顶栏按钮或按 ? 呼出 */
export function ShortcutsDialog({ open, onOpenChange, isOwner }: ShortcutsDialogProps) {
  const playerShortcuts: ShortcutRow[] = [
    { keys: ['Space', '/ K'], desc: '播放 / 暂停（全员同步）', scope: isOwner ? '房主' : '成员提示' },
    { keys: ['←', '/ →'], desc: '快退 / 快进 10 秒（全员同步）', scope: '房主' },
    { keys: ['M'], desc: '打点精彩时刻，记录当前进度方便回看', scope: '全员' },
    { keys: ['?'], desc: '打开 / 关闭本帮助', scope: '全员' },
  ]
  const otherShortcuts: ShortcutRow[] = [
    { keys: ['Enter'], desc: '发送聊天消息 / 发送弹幕', scope: '输入框内' },
    { keys: ['Esc'], desc: '关闭弹窗 / 弹层', scope: '全员' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-surface-border bg-surface text-surface-foreground sm:rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Keyboard className="h-4.5 w-4.5 text-[#fb7299]" />
            键盘快捷键
          </DialogTitle>
          <DialogDescription className="text-xs text-surface-muted-foreground">
            在房间内使用快捷键控制播放，操作全员实时同步。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-surface-foreground">
              <MousePointerClick className="h-3.5 w-3.5 text-[#fb7299]" /> 播放器
            </p>
            <div className="flex flex-col gap-1.5">
              {playerShortcuts.map((row) => (
                <div
                  key={row.desc}
                  className="flex items-center justify-between gap-3 rounded-lg border border-surface-border bg-surface-2/50 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {row.keys.map((k, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-[10px] text-surface-muted-foreground">或</span>}
                        <KeyCap k={k} />
                      </span>
                    ))}
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs text-surface-foreground">{row.desc}</span>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
                        row.scope === '房主'
                          ? 'bg-[#fb7299]/15 text-[#fb7299]'
                          : 'bg-surface-3 text-surface-muted-foreground'
                      }`}
                    >
                      {row.scope}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-surface-foreground">
              <MessageSquare className="h-3.5 w-3.5 text-[#fb7299]" /> 聊天与弹幕
            </p>
            <div className="flex flex-col gap-1.5">
              {otherShortcuts.map((row) => (
                <div
                  key={row.desc}
                  className="flex items-center justify-between gap-3 rounded-lg border border-surface-border bg-surface-2/50 px-3 py-2"
                >
                  <div className="flex items-center gap-1.5">
                    {row.keys.map((k) => (
                      <KeyCap key={k} k={k} />
                    ))}
                  </div>
                  <span className="truncate text-xs text-surface-foreground">{row.desc}</span>
                  <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] text-surface-muted-foreground">
                    {row.scope}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <p className="flex items-start gap-1.5 rounded-lg bg-[#fb7299]/8 px-3 py-2 text-[11px] leading-relaxed text-surface-muted-foreground">
            <Captions className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#fb7299]" />
            快捷键在输入框聚焦时不会触发（打字不受影响）；触屏设备点按视频画面可呼出 / 隐藏控制条。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
