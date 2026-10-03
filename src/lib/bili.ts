// Bilibili 相关工具库：链接解析、外链播放器 URL 构建、画质定义

/** B站清晰度 qn 值 */
export interface QualityOption {
  qn: number
  label: string
  desc: string
}

export const QUALITY_OPTIONS: QualityOption[] = [
  { qn: 16, label: '360P 流畅', desc: '省流量，弱网友好' },
  { qn: 32, label: '480P 清晰', desc: '均衡之选' },
  { qn: 64, label: '720P 高清', desc: '大多数场景推荐' },
  { qn: 80, label: '1080P 全高清', desc: '登录B站后可用，最常用' },
]

export const DEFAULT_QN = 64

/** B站全部清晰度 qn → 短标签（playurl accept_description 的兜底映射） */
export const QN_LABELS: Record<number, string> = {
  6: '240P 极速',
  16: '360P 流畅',
  32: '480P 清晰',
  64: '720P 高清',
  74: '720P60 高帧率',
  80: '1080P 高清',
  112: '1080P+ 高码率',
  116: '1080P60 高帧率',
  120: '4K 超清',
  125: 'HDR 真彩',
  126: '杜比视界',
  127: '8K 超高清',
}

/** qn → 显示标签；未知值回退到 `${qn}P` */
export function qualityLabel(qn: number, desc?: string): string {
  if (desc) return desc
  return QN_LABELS[qn] || `${qn}P`
}

export interface BiliVideoMeta {
  bvid: string
  page: number
  title: string
  cover: string | null
  upName: string | null
  duration: number
  pages: { page: number; part: string; duration: number }[]
}

const BV_RE = /(BV[0-9A-Za-z]{10})/i
const AV_RE = /av(\d{2,15})/i

/** 从任意输入（BV号 / av号 / 完整链接 / b23.tv短链 / ss号）中解析出 bvid + page */
export function parseVideoInput(input: string): { bvid?: string; page: number } {
  const raw = (input || '').trim()
  if (!raw) return { page: 1 }
  // 完整 URL：提取查询参数里的 p
  let page = 1
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw)
      const p = parseInt(u.searchParams.get('p') || '1', 10)
      if (!isNaN(p) && p > 0) page = p
    } else {
      const pm = raw.match(/[?&]p=(\d+)/)
      if (pm) page = Math.max(1, parseInt(pm[1], 10))
    }
  } catch {
    /* ignore */
  }
  const bvMatch = raw.match(BV_RE)
  if (bvMatch) return { bvid: bvMatch[1], page }
  const avMatch = raw.match(AV_RE)
  if (avMatch) {
    // av 号转 BV 号（B站官方算法）
    return { bvid: avToBv(avMatch[1]), page }
  }
  return { page }
}

/** av号 → BV号（社区通用算法） */
export function avToBv(av: string): string {
  const XOR_CODE = 23442827791579
  const MASK_CODE = 2251799813685247
  const ALPHABET = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'
  const base = ALPHABET.length
  const template = [...'BV1**4*1*7**']
  const order = [11, 10, 3, 8, 4, 6]
  const out = [...template]
  let n = BigInt(Math.floor((Number(av) ^ XOR_CODE) & MASK_CODE))
  for (let i = 0; i < 6; i++) {
    out[order[i]] = ALPHABET[Number(n % BigInt(base))]
    n = n / BigInt(base)
  }
  return out.join('')
}

/**
 * 构建 B站外链播放器 iframe URL
 * 参数: bvid / page / qn+high_quality / danmaku / autoplay / t(起始秒)
 */
export function buildEmbedUrl(opts: {
  bvid: string
  page?: number
  qn?: number
  danmaku?: boolean
  autoplay?: boolean
  t?: number
}): string {
  const { bvid, page = 1, qn = DEFAULT_QN, danmaku = true, autoplay = false, t = 0 } = opts
  const params = new URLSearchParams()
  params.set('bvid', bvid)
  if (page > 1) params.set('page', String(page))
  params.set('high_quality', qn >= 80 ? '1' : '0')
  params.set('qn', String(qn))
  params.set('danmaku', danmaku ? '1' : '0')
  params.set('autoplay', autoplay ? '1' : '0')
  if (t > 0) params.set('t', String(Math.floor(t)))
  params.set('enable_api', '1')
  return `https://player.bilibili.com/player.html?${params.toString()}`
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 生成 6 位房间码（去除易混淆字符） */
export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

/** postMessage 探测候选（live.bilibili.com 活动播放器协议 + 常见猜测格式） */
export function buildPostMessageProbes(action: 'play' | 'pause' | 'seek', value?: number): string[] {
  const probes: unknown[] = [
    `setPlayer-${JSON.stringify({ type: action, value: action === 'seek' ? value : action === 'play' })}`,
    JSON.stringify({ type: action, value }),
    { type: action, value },
    { cmd: action, value },
    { action, value },
  ]
  if (action === 'seek') {
    probes.push(`setPlayer-${JSON.stringify({ type: 'sprint', value })}`)
    probes.push(JSON.stringify({ type: 'sprint', value }))
  }
  return probes.map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
}
