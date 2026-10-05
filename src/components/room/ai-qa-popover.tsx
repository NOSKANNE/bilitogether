'use client'

/**
 * 房间内 AI 影伴问答浮层（控制条弹出）
 * 结合视频标题 + 当前进度 + 最近聊天，向 LLM 提观影相关问题：
 * 剧情猜测 / 背景科普 / 吐槽互动。信息有限时 AI 会诚实说明是推测。
 *
 * 增强：
 * - 历史持久化：对话按 房间+视频 存 localStorage（上限 40 条），换视频/刷新不丢
 * - 打字机流式：AI 回答逐字上屏（bt-caret 光标），长回答按字数自适应速度
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, CornerDownLeft, History, Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'

interface QaMessage {
  role: 'user' | 'ai'
  text: string
}

interface AiQaPopoverProps {
  /** 当前视频标题（可能为 null：解析受限） */
  videoTitle: string | null
  /** 房间码（历史持久化按 房间+视频 分键） */
  roomCode?: string
  /** 取当前播放秒数（进度上下文） */
  getCurrentTime: () => number
  /** 视频总时长（秒，0 表示未知） */
  duration: number
  /** 最近聊天上下文（最多取 30 条，由父级裁剪） */
  chatContext: { name: string; text: string }[]
  /** 弹幕发送条是否可见（控制浮层定位微调，可忽略） */
  align?: 'start' | 'center' | 'end'
}

/** localStorage 键：按 房间+视频 隔离对话历史 */
function storageKey(roomCode?: string, videoTitle?: string | null): string {
  const room = (roomCode || 'noroom').toUpperCase()
  const vid = (videoTitle || '未加载视频').slice(0, 80)
  return `bilitogether:aiqa:${room}:${vid}`
}

/** 存储上限：仅保留最近 40 条（user+ai 合计） */
const MAX_STORED = 40

/** 快捷问题（随上下文轻变化） */
function quickQuestions(hasTitle: boolean): string[] {
  return hasTitle
    ? ['这是什么视频？', '接下来会怎样？', '帮我吐槽两句', '看点冷知识']
    : ['大家在聊什么？', '给房间起个氛围名', '帮我吐槽两句', '看点冷知识']
}

/** 宽容校验/归一化 localStorage 恢复的数据 */
function sanitizeStored(raw: unknown): QaMessage[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((m): m is QaMessage => {
      if (!m || typeof m !== 'object') return false
      const it = m as Partial<QaMessage>
      return (it.role === 'user' || it.role === 'ai') && typeof it.text === 'string' && it.text.length > 0
    })
    .map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }))
    .slice(-MAX_STORED)
}

export function AiQaPopover({ videoTitle, roomCode, getCurrentTime, duration, chatContext }: AiQaPopoverProps) {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<QaMessage[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  /* ---- 打字机流式：streamIdx 指向正在逐字上屏的消息，streamPos 为已显示字符数 ---- */
  const [streamIdx, setStreamIdx] = useState<number | null>(null)
  const [streamPos, setStreamPos] = useState(0)
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  /* ---- 历史恢复标识（顶部小chip「已恢复上次对话」） ---- */
  const [restoredCount, setRestoredCount] = useState(0)
  const hydratedRef = useRef(false)

  /* 最新消息长度镜像（await 恢复后取值，避免闭包过期导致流式下标错位） */
  const lenRef = useRef(0)
  lenRef.current = messages.length

  /** 停止流式（清定时器 + 结束逐字态） */
  const stopStream = useCallback(() => {
    if (streamTimer.current) {
      clearInterval(streamTimer.current)
      streamTimer.current = null
    }
    setStreamIdx(null)
    setStreamPos(0)
  }, [])

  /** 开始逐字上屏：速度随字数自适应（短句 1.2s 内，长文 ~2.8s 封顶） */
  const startStream = useCallback((idx: number, fullText: string) => {
    if (streamTimer.current) {
      clearInterval(streamTimer.current)
      streamTimer.current = null
    }
    setStreamIdx(null) // 结束上一条未完成的流
    setStreamPos(0)
    setStreamIdx(idx)
    const total = fullText.length
    const perTick = Math.max(1, Math.ceil(total / 140))
    streamTimer.current = setInterval(() => {
      setStreamPos((p) => {
        const next = p + perTick
        if (next >= total) {
          if (streamTimer.current) {
            clearInterval(streamTimer.current)
            streamTimer.current = null
          }
          setStreamIdx(null)
          return 0
        }
        return next
      })
    }, 20)
  }, [])

  // 组件卸载时兜底清理定时器
  useEffect(() => () => {
    if (streamTimer.current) clearInterval(streamTimer.current)
  }, [])

  /* ---- 历史持久化：按 房间+视频 分键，useEffect 恢复（避免 SSR 水合不一致） ---- */
  useEffect(() => {
    hydratedRef.current = false
    stopStream()
    setMessages([])
    setRestoredCount(0)
    try {
      const raw = window.localStorage.getItem(storageKey(roomCode, videoTitle))
      const restored = sanitizeStored(raw ? JSON.parse(raw) : null)
      if (restored.length > 0) {
        setMessages(restored)
        setRestoredCount(restored.length)
      }
    } catch {
      /* 存储损坏或隐私模式：静默降级为空对话 */
    }
    hydratedRef.current = true
  }, [roomCode, videoTitle])

  /* ---- 持久化：对话变化且不在流式中时写回（空数组不写，由「清空」显式移除） ---- */
  useEffect(() => {
    if (!hydratedRef.current || messages.length === 0 || streamIdx !== null) return
    try {
      window.localStorage.setItem(storageKey(roomCode, videoTitle), JSON.stringify(messages.slice(-MAX_STORED)))
    } catch {
      /* noop */
    }
  }, [messages, streamIdx, roomCode, videoTitle])

  // 回答更新时滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, asking, streamPos])

  const ask = async (q: string) => {
    const text = q.trim()
    if (!text || asking) return
    setQuestion('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', text }])
    setAsking(true)
    try {
      const res = await fetch('/api/ai/video-qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: text,
          videoTitle: videoTitle || '',
          chatContext: chatContext.slice(-30),
          watchPosition: Math.round(getCurrentTime()),
          duration,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data?.ok) throw new Error(data?.error || `请求失败（${res.status}）`)
      const answer = String(data.answer)
      // 流式上屏：lenRef 在 await 恢复后已含刚加入的用户消息，即 AI 消息的真实下标
      const idx = lenRef.current
      setMessages((prev) => [...prev, { role: 'ai', text: answer }])
      startStream(idx, answer)
    } catch (err) {
      setError(err instanceof Error ? err.message : '提问失败，请稍后再试')
    } finally {
      setAsking(false)
    }
  }

  /** 清空对话（同时移除本地存储） */
  const clearConversation = () => {
    stopStream()
    setMessages([])
    setRestoredCount(0)
    try {
      window.localStorage.removeItem(storageKey(roomCode, videoTitle))
    } catch {
      /* noop */
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`flex h-9 w-9 items-center justify-center rounded-lg backdrop-blur transition-colors ${
                  open ? 'bg-[#fb7299] text-white' : 'bg-white/10 text-white hover:bg-white/20'
                }`}
                aria-label="问问 AI 影伴"
                onClick={(e) => e.stopPropagation()}
              >
                <Bot className="h-4 w-4" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>问问 AI 影伴 🤖</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        className="dark w-[340px] rounded-xl border-[#fb7299]/30 bg-surface/95 p-0 shadow-2xl backdrop-blur sm:w-[380px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-surface-border bg-gradient-to-r from-[#fb7299]/12 to-transparent px-3.5 py-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#fb7299] text-white shadow-sm shadow-[#fb7299]/40">
            <Bot className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">AI 影伴</p>
            <p className="truncate text-[11px] text-surface-muted-foreground">
              {videoTitle ? <>结合《{videoTitle}》和你聊</> : '结合房间聊天陪你聊'}
            </p>
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-surface-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground"
              onClick={clearConversation}
              aria-label="清空对话"
            >
              <RotateCcw className="h-3 w-3" /> 清空
            </button>
          )}
        </div>

        {/* 对话区 */}
        <div ref={scrollRef} className="max-h-[300px] min-h-[140px] overflow-y-auto px-3.5 py-3">
          {messages.length === 0 && !asking && (
            <div className="flex h-full flex-col justify-center gap-2.5 py-2">
              <p className="flex items-center gap-1.5 text-xs text-surface-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-[#fb7299]" /> 试试问点有意思的：
              </p>
              <div className="flex flex-wrap gap-1.5">
                {quickQuestions(!!videoTitle).map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="rounded-full border border-[#fb7299]/30 bg-[#fb7299]/5 px-2.5 py-1 text-xs text-foreground/85 transition-colors hover:border-[#fb7299]/60 hover:bg-[#fb7299]/15"
                    onClick={() => void ask(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 历史恢复提示 chip */}
          {restoredCount > 0 && (
            <div className="mb-2.5 flex justify-center">
              <span className="flex items-center gap-1 rounded-full bg-surface-3 px-2.5 py-0.5 text-[10px] text-surface-muted-foreground">
                <History className="h-3 w-3" />
                已恢复上次对话 · {restoredCount} 条
              </span>
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            {messages.map((m, i) => {
              const isStreaming = i === streamIdx
              const shown = isStreaming ? m.text.slice(0, streamPos) : m.text
              return m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <span className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#fb7299] px-3 py-1.5 text-sm leading-relaxed text-white">
                    {m.text}
                  </span>
                </div>
              ) : (
                <div key={i} className="flex justify-start">
                  <span className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-surface-border bg-surface-2 px-3 py-2 text-sm leading-relaxed text-surface-foreground">
                    {shown}
                    {isStreaming && <span className="bt-caret" aria-hidden />}
                  </span>
                </div>
              )
            })}
            {asking && (
              <div className="flex justify-start">
                <span className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-surface-border bg-surface-2 px-3 py-2" aria-live="polite">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#fb7299]" />
                  <span className="bt-typing-dot h-1 w-1 rounded-full bg-[#fb7299]" />
                  <span className="bt-typing-dot h-1 w-1 rounded-full bg-[#fb7299]" style={{ animationDelay: '0.2s' }} />
                  <span className="bt-typing-dot h-1 w-1 rounded-full bg-[#fb7299]" style={{ animationDelay: '0.4s' }} />
                </span>
              </div>
            )}
            {error && <p className="text-center text-xs text-destructive">{error}</p>}
          </div>
        </div>

        {/* 输入区 */}
        <div className="border-t border-surface-border p-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface-2 px-2.5 py-1.5 focus-within:border-[#fb7299]/50">
            <input
              value={question}
              maxLength={120}
              placeholder="问问 AI：剧情/背景/吐槽…"
              className="min-w-0 flex-1 bg-transparent text-sm text-surface-foreground outline-none placeholder:text-surface-muted-foreground"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void ask(question)
                }
                e.stopPropagation()
              }}
              aria-label="向 AI 影伴提问"
            />
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#fb7299] text-white transition-colors hover:bg-[#f45d8b] disabled:opacity-40"
              disabled={!question.trim() || asking}
              onClick={() => void ask(question)}
              aria-label="发送问题"
            >
              <CornerDownLeft className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
