/**
 * AI 视频问答 API（房间内「问问 AI」）
 * POST /api/ai/video-qa
 *
 * 输入：{ question, videoTitle, chatContext?, watchPosition?, duration? }
 * 输出：{ ok, answer }
 *
 * LLM 结合视频标题 + 最近聊天上下文回答观影问题（剧情猜测/背景科普/吐槽互动）。
 * 信息有限时要求诚实说明「只根据标题推测」，禁止编造具体情节。
 */
import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

export const runtime = 'nodejs'

interface QaInput {
  question?: string
  videoTitle?: string
  chatContext?: { name?: string; text?: string }[]
  watchPosition?: number
  duration?: number
}

const MAX_QUESTION = 120
const MAX_CHAT = 30

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function formatPos(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '开头'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}分${s}秒` : `${s}秒`
}

export async function POST(req: NextRequest) {
  let body: QaInput
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const question = clamp(String(body?.question ?? '').trim(), MAX_QUESTION)
  if (!question) {
    return NextResponse.json({ ok: false, error: '问题不能为空' }, { status: 400 })
  }

  const videoTitle = clamp(String(body?.videoTitle ?? '').trim(), 80)
  const watchPosition = Number(body?.watchPosition) || 0
  const duration = Number(body?.duration) || 0

  const chatContext = (Array.isArray(body?.chatContext) ? body.chatContext : [])
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_CHAT)
    .map((m) => `${clamp(String(m.name ?? '').trim() || '成员', 12)}：${clamp(m.text.trim(), 80)}`)

  try {
    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content: [
            '你是「B站一起观影房间」里的 AI 影伴，风格轻松活泼、偶尔用B站弹幕梗，回答简短（一般不超过 120 字，最多 180 字）。',
            '你能看到的信息：正在看的视频标题、当前播放进度、房间最近聊天（可能为空）。',
            '回答规则：',
            '- 只根据可见信息回答；信息不足以确定剧情/内容时，明确说「只看标题猜的话」并给出娱乐性推测',
            '- 绝不编造具体情节、演员、数据等确定性事实',
            '- 语气像一起看片的朋友，可以直接回应聊天里的梗',
            '- 如果问题与视频/观影无关（如写代码），礼貌引导回观影话题',
            '- 直接回答，不要输出 JSON，不要用 markdown 标题',
            videoTitle ? `- 正在看：《${videoTitle}》` : '- 未提供视频标题（可能解析受限），可从聊天内容推测',
            `- 当前进度：${formatPos(watchPosition)}${duration > 0 ? ` / 总时长约 ${Math.round(duration / 60)} 分钟` : ''}`,
            chatContext.length > 0 ? `- 最近房间聊天：\n${chatContext.join('\n')}` : '- 房间暂时没有聊天内容',
          ].join('\n'),
        },
        { role: 'user', content: question },
      ],
      thinking: { type: 'disabled' },
    })

    const raw = completion.choices[0]?.message?.content ?? ''
    if (!raw.trim()) {
      return NextResponse.json({ ok: false, error: 'AI 走神了，请再问一次' }, { status: 502 })
    }
    return NextResponse.json({ ok: true, answer: clamp(raw.trim(), 400) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误'
    return NextResponse.json({ ok: false, error: `AI 服务异常：${msg}` }, { status: 500 })
  }
}
