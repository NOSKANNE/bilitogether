/**
 * AI 聊天/弹幕情绪摘要 API
 * POST /api/ai/chat-summary
 *
 * 接收房间最近的聊天消息（含弹幕语气上下文），用 LLM 生成结构化氛围摘要：
 * - mood：整体氛围（一个词）
 * - moodEmoji：氛围 emoji
 * - vibeScore：氛围热度 0-100
 * - topics：热议话题（最多 4 条）
 * - highlights：精彩发言（原文引用，最多 3 条，带发言者）
 * - suggestDanmaku：推荐发送的弹幕（1 条，接地气）
 *
 * 仅服务端使用 z-ai-web-dev-sdk，原始实现绝不暴露凭据。
 */
import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

export const runtime = 'nodejs'

interface SummaryInputMessage {
  /** 发言者昵称（system 消息会跳过） */
  name: string
  text: string
  ts: number
}

interface ChatSummaryPayload {
  mood: string
  moodEmoji: string
  vibeScore: number
  topics: string[]
  highlights: { name: string; text: string }[]
  suggestDanmaku: string
}

const MOOD_EMOJI_WHITELIST = new Set([
  '🔥', '😂', '🥳', '😭', '😲', '🤔', '😴', '❤️', '🎉', '🍿', '👀', '💪', '🫡', '🤩', '😤', '🥹',
])

function clampText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 对 LLM 返回做宽容解析与归一化，保证前端拿到的结构稳定 */
function normalizeSummary(raw: string, fallbackName: string): ChatSummaryPayload {
  let parsed: Partial<ChatSummaryPayload> = {}
  try {
    // LLM 可能用 ```json 包裹，剥掉
    const stripped = raw.replace(/```(?:json)?/gi, '').trim()
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start >= 0 && end > start) {
      parsed = JSON.parse(stripped.slice(start, end + 1))
    }
  } catch {
    // 解析失败则降级为纯文本 mood
    parsed = { mood: clampText(raw.trim() || '热情似火', 12) }
  }

  const mood = clampText(String(parsed.mood ?? '欢快热烈').trim() || '欢快热烈', 12)
  const moodEmojiRaw = String(parsed.moodEmoji ?? '🔥').trim()
  const moodEmoji = MOOD_EMOJI_WHITELIST.has(moodEmojiRaw) ? moodEmojiRaw : '🔥'

  let vibeScore = Number(parsed.vibeScore)
  if (!Number.isFinite(vibeScore)) vibeScore = 70
  vibeScore = Math.min(100, Math.max(0, Math.round(vibeScore)))

  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.slice(0, 4).map((t) => clampText(String(t ?? '').trim(), 24)).filter(Boolean)
    : []

  const highlights = Array.isArray(parsed.highlights)
    ? parsed.highlights.slice(0, 3).map((h) => {
        const obj = h as { name?: unknown; text?: unknown }
        const name = clampText(String(obj?.name ?? fallbackName).trim() || fallbackName, 12)
        const text = clampText(String(obj?.text ?? '').trim(), 60)
        return text ? { name, text } : null
      }).filter((x): x is { name: string; text: string } => !!x)
    : []

  const suggestDanmaku = clampText(String(parsed.suggestDanmaku ?? '这波氛围直接拉满！').trim() || '这波氛围直接拉满！', 30)

  return { mood, moodEmoji, vibeScore, topics, highlights, suggestDanmaku }
}

export async function POST(req: NextRequest) {
  let body: { messages?: SummaryInputMessage[]; videoTitle?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const rawMessages = Array.isArray(body?.messages) ? body.messages : []
  const videoTitle = clampText(String(body?.videoTitle ?? '').trim(), 60)

  // 只保留用户消息，过滤系统消息/超长文本，截取最近 60 条防 token 爆炸
  const messages = rawMessages
    .filter((m) => m && typeof m.text === 'string' && m.text.trim() && typeof m.name === 'string')
    .map((m) => ({ name: clampText(m.name.trim(), 12), text: clampText(m.text.trim(), 100), ts: Number(m.ts) || 0 }))
    .slice(-60)

  if (messages.length === 0) {
    return NextResponse.json({ ok: false, error: '暂无可分析的聊天内容' }, { status: 400 })
  }

  const transcript = messages
    .map((m) => `${m.name}：${m.text}`)
    .join('\n')

  try {
    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content: [
            '你是「B站一起观影房间」的氛围分析师。用户会给你一段房间聊天记录（可能夹杂弹幕风格的短句）和正在观看的视频标题。',
            '请输出严格的 JSON（不要任何多余文字），字段如下：',
            '{"mood":"两到四字氛围词","moodEmoji":"单个emoji(🔥😂🥳😭😲🤔😴❤️🎉🍿👀💪🫡🤩😤🥹里选)","vibeScore":0到100整数,"topics":["话题1","话题2"],"highlights":[{"name":"发言者","text":"原文"}],"suggestDanmaku":"一条接地气的推荐弹幕"}',
            '规则：',
            '- mood 概括整体氛围（如：欢乐整活、温情催泪、高能炸裂）',
            '- vibeScore 根据聊天密度与情绪强度打分，安静房间给低分',
            '- topics 提炼大家正在聊的内容（最多4条，每条不超过12字）',
            '- highlights 挑选最有代表性的原话（最多3条，必须引用聊天记录原文）',
            '- suggestDanmaku 结合视频内容与聊天氛围，适合直接发到B站的弹幕（不超过20字，口语化）',
            '- 若聊天记录很少或没有实质内容，也请基于仅有的信息合理输出 JSON，topics 和 highlights 可以为空数组',
            videoTitle ? `- 当前视频标题：${videoTitle}` : '- 未提供视频标题，从聊天内容自行推测',
          ].join('\n'),
        },
        { role: 'user', content: transcript },
      ],
      thinking: { type: 'disabled' },
    })

    const raw = completion.choices[0]?.message?.content ?? ''
    if (!raw.trim()) {
      return NextResponse.json({ ok: false, error: 'AI 未返回内容，请稍后重试' }, { status: 502 })
    }

    const summary = normalizeSummary(raw, messages[messages.length - 1]?.name ?? '大家')
    return NextResponse.json({ ok: true, summary, analyzedCount: messages.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误'
    return NextResponse.json({ ok: false, error: `AI 服务异常：${msg}` }, { status: 500 })
  }
}
