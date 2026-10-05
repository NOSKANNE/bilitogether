'use client'

/**
 * AI 房间氛围速览弹窗
 * 调用 POST /api/ai/chat-summary 分析最近聊天/弹幕，生成氛围摘要卡片：
 * 氛围词 + 热度评分 + 热议话题 + 精彩发言 + 一键填入推荐弹幕
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, RefreshCw, Loader2, Send, Quote, Flame } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ChatMessage } from '@/lib/room-types'

interface ChatSummary {
  mood: string
  moodEmoji: string
  vibeScore: number
  topics: string[]
  highlights: { name: string; text: string }[]
  suggestDanmaku: string
}

interface AiSummaryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  messages: ChatMessage[]
  /** 当前视频标题（供 AI 结合内容分析） */
  videoTitle?: string
  /** 点击「发送弹幕」时把推荐文案填入聊天输入框 */
  onSuggestSend: (text: string) => void
}

/** 氛围热度对应文案 */
function vibeLabel(score: number): string {
  if (score >= 85) return '高能炸裂'
  if (score >= 65) return '气氛火热'
  if (score >= 40) return '轻松愉快'
  if (score >= 20) return '有点安静'
  return '处于冷场'
}

/** 氛围热度条颜色分级 */
function vibeBarClass(score: number): string {
  if (score >= 85) return '[&>div]:bg-gradient-to-r [&>div]:from-rose-500 [&>div]:to-amber-400'
  if (score >= 40) return '[&>div]:bg-gradient-to-r [&>div]:from-pink-500 [&>div]:to-rose-400'
  return '[&>div]:bg-gradient-to-r [&>div]:from-slate-400 [&>div]:to-slate-300'
}

export function AiSummaryDialog({ open, onOpenChange, messages, videoTitle, onSuggestSend }: AiSummaryDialogProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ChatSummary | null>(null)
  const [analyzedCount, setAnalyzedCount] = useState(0)
  /** 防止重复自动分析：每次打开弹窗只自动触发一次 */
  const autoRanRef = useRef(false)

  const analyze = useCallback(async () => {
    const userMessages = messages
      .filter((m) => m.kind !== 'system' && m.text.trim())
      .map((m) => ({ name: m.name, text: m.text, ts: m.ts }))

    if (userMessages.length === 0) {
      setError('聊天区还很安静，先说点什么或发条弹幕再来生成氛围速览吧～')
      setSummary(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/ai/chat-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: userMessages, videoTitle: videoTitle || '' }),
      })
      const data = await res.json()
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `请求失败（${res.status}）`)
      }
      setSummary(data.summary as ChatSummary)
      setAnalyzedCount(Number(data.analyzedCount) || userMessages.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [messages, videoTitle])

  // 每次打开自动分析一次；消息更新后允许重新打开再次触发
  useEffect(() => {
    if (open && !autoRanRef.current) {
      autoRanRef.current = true
      void analyze()
    }
    if (!open) {
      autoRanRef.current = false
      setError(null)
    }
  }, [open, analyze])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
        {/* 头部渐变横幅 */}
        <div className="relative bg-gradient-to-br from-pink-500/15 via-rose-500/10 to-transparent px-6 pt-6 pb-4">
          <DialogHeader className="space-y-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-pink-500" aria-hidden />
              AI 氛围速览
              <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0 font-normal">Beta</Badge>
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              基于最近聊天与弹幕风格生成 · {videoTitle ? <>正在看《{videoTitle}》</> : '结合当前房间内容'}
            </DialogDescription>
          </DialogHeader>
        </div>

        <ScrollArea className="max-h-[60vh]">
          <div className="px-6 pb-4 space-y-4">
            {loading && (
              <div className="flex flex-col items-center justify-center gap-3 py-10" aria-live="polite">
                <div className="relative">
                  <Loader2 className="size-8 animate-spin text-pink-500" aria-hidden />
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-pink-500">AI</span>
                </div>
                <p className="text-sm text-muted-foreground">正在解读房间的空气…</p>
              </div>
            )}

            {!loading && error && (
              <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/30 px-4 py-6 text-center" aria-live="polite">
                <p className="text-sm text-muted-foreground">{error}</p>
                {messages.some((m) => m.kind !== 'system') && (
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => void analyze()}>
                    <RefreshCw className="size-3.5 mr-1" aria-hidden /> 重试
                  </Button>
                )}
              </div>
            )}

            {!loading && summary && (
              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                {/* 氛围主卡 */}
                <div className="rounded-xl border bg-gradient-to-br from-background to-muted/40 p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-4xl leading-none select-none" aria-hidden>{summary.moodEmoji}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-lg font-bold tracking-wide">{summary.mood}</span>
                        <span className="text-xs text-muted-foreground">{vibeLabel(summary.vibeScore)}</span>
                      </div>
                      <Progress
                        value={summary.vibeScore}
                        className={`mt-2 h-2 ${vibeBarClass(summary.vibeScore)}`}
                        aria-label={`氛围热度 ${summary.vibeScore} 分`}
                      />
                      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1"><Flame className="size-3 text-rose-500" aria-hidden />氛围热度</span>
                        <span>{summary.vibeScore}/100</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 热议话题 */}
                {summary.topics.length > 0 && (
                  <section aria-label="热议话题">
                    <h4 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">💬 热议话题</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {summary.topics.map((t, i) => (
                        <Badge key={`${t}-${i}`} variant="outline" className="rounded-full border-pink-500/30 bg-pink-500/5 text-foreground/80 font-normal">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </section>
                )}

                {/* 精彩发言 */}
                {summary.highlights.length > 0 && (
                  <section aria-label="精彩发言">
                    <h4 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">✨ 精彩发言</h4>
                    <div className="space-y-2">
                      {summary.highlights.map((h, i) => (
                        <div key={`${h.name}-${i}`} className="group relative rounded-lg border bg-muted/30 px-3 py-2 pl-8">
                          <Quote className="absolute left-2.5 top-2.5 size-3.5 text-pink-500/60" aria-hidden />
                          <p className="text-sm leading-snug">{h.text}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">—— {h.name}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* 推荐弹幕 */}
                <section aria-label="推荐弹幕">
                  <h4 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">🎯 推荐弹幕</h4>
                  <div className="flex items-center gap-2 rounded-lg border border-pink-500/30 bg-pink-500/5 px-3 py-2.5">
                    <p className="min-w-0 flex-1 text-sm font-medium leading-snug">{summary.suggestDanmaku}</p>
                    <Button
                      size="sm"
                      className="h-7 shrink-0 gap-1 text-xs"
                      onClick={() => {
                        onSuggestSend(summary.suggestDanmaku)
                        onOpenChange(false)
                      }}
                    >
                      <Send className="size-3" aria-hidden /> 发送
                    </Button>
                  </div>
                </section>

                <p className="text-center text-[11px] text-muted-foreground">
                  已分析最近 {analyzedCount} 条消息 · 由 AI 生成仅供参考
                </p>
              </div>
            )}
          </div>
        </ScrollArea>

        {!loading && summary && (
          <div className="border-t bg-muted/20 px-6 py-3">
            <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => void analyze()} disabled={loading}>
              <RefreshCw className="size-3.5" aria-hidden /> 刷新分析
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
