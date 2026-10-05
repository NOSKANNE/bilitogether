'use client'

import { useState } from 'react'
import { Smile } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/** B站风常用表情（Unicode，跨平台可用） */
const EMOJIS = [
  '😂', '🤣', '😍', '🥺', '😭', '😅', '😉', '😋', '🤔', '🙄',
  '🤡', '😱', '🤯', '😳', '🥵', '🥶', '😴', '🤗', '🤭', '🤫',
  '👀', '✨', '💥', '🔥', '⭐', '💫', '🎉', '🎊', '👏', '🙏',
  '👍', '👎', '👌', '🤝', '💪', '🙌', '❤️', '💔', '💯', '🉑',
  '😇', '😈', '👻', '💩', '🌹', '🍕', '🍺', '🍬', '🍉', '🧋',
  '🍿', '📺', '🎮', '🎧', '🀄', '⚽', '🏎️', '🚀', '🌈', '☀️',
]

/** 经典颜文字 & 弹幕黑话 */
const KAOMOJIS = [
  '(≧▽≦)', '(๑•̀ㅂ•́)و✧', 'ヾ(≧∇≦*)ゝ', '(´・ω・`)', 'Σ(っ °Д °;)っ',
  '╰(*°▽°*)╯', '(ง •_•)ง', '(●\'◡\'●)', '(T_T)', 'orz',
  '_(:з」∠)_', '(＃°Д°)', '(๑╹ヮ╹๑)ﾂ', '☆⌒(≧▽° )', '(￣▽￣)~*',
  '23333', 'dddd', 'awsl', 'yyds', 'xswl',
  'u1s1', '爷青回', '泪目', '名场面', '下次一定',
]

interface EmojiPickerProps {
  onPick: (emoji: string) => void
  /** 自定义触发按钮样式（twMerge 合并默认样式，可覆盖尺寸/配色） */
  triggerClassName?: string
  /** 触发按钮无障碍标签（默认「插入表情」） */
  triggerLabel?: string
  /** 弹出方向（默认 top；顶部悬浮工具条传 bottom） */
  side?: 'top' | 'bottom'
}

/** 聊天/弹幕表情选择器：B站风 emoji + 颜文字，点选即插入输入框 */
export function EmojiPicker({ onPick, triggerClassName, triggerLabel, side = 'top' }: EmojiPickerProps) {
  const [open, setOpen] = useState(false)

  const pick = (v: string) => {
    onPick(v)
    // 连续输入体验：不关闭面板，用户点外部/发消息时才收起
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-surface-border bg-surface-2 text-surface-muted-foreground transition-colors hover:border-[#fb7299]/40 hover:text-[#fb7299]',
            triggerClassName
          )}
          title={triggerLabel ?? '表情'}
          aria-label={triggerLabel ?? '插入表情'}
        >
          <Smile className={`h-5 w-5 transition-transform ${open ? 'scale-110 text-[#fb7299]' : ''}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="end"
        className="w-72 border-surface-border bg-surface/95 p-0 backdrop-blur"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Tabs defaultValue="emoji" className="w-full">
          <TabsList className="h-9 w-full justify-start rounded-b-none border-b border-surface-border bg-surface px-2">
            <TabsTrigger value="emoji" className="h-7 px-2.5 text-xs text-surface-muted-foreground data-[state=active]:text-[#fb7299]">
              😄 表情
            </TabsTrigger>
            <TabsTrigger value="kaomoji" className="h-7 px-2.5 text-xs text-surface-muted-foreground data-[state=active]:text-[#fb7299]">
              ✦ 颜文字
            </TabsTrigger>
          </TabsList>
          <TabsContent value="emoji" className="mt-0 p-2">
            <div className="bt-scroll grid max-h-44 grid-cols-10 gap-0.5 overflow-y-auto">
              {EMOJIS.map((e, i) => (
                <button
                  key={`${e}-${i}`}
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded text-base leading-none transition-transform hover:scale-125 hover:bg-white/10"
                  onClick={() => pick(e)}
                  aria-label={`插入表情 ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </TabsContent>
          <TabsContent value="kaomoji" className="mt-0 p-2">
            <div className="bt-scroll flex max-h-44 flex-wrap gap-1 overflow-y-auto">
              {KAOMOJIS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="rounded-md border border-surface-border bg-surface-2/60 px-2 py-1 text-xs text-surface-foreground transition-colors hover:border-[#fb7299]/40 hover:bg-[#fb7299]/10 hover:text-[#fb7299]"
                  onClick={() => pick(k)}
                >
                  {k}
                </button>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}
