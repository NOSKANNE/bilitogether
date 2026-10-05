/**
 * 封面主色提取 API（房间氛围光用）
 * GET /api/bili/cover-color?u=<封面URL>
 *
 * 服务端 fetch 封面图 → sharp 提取 dominant 主色，避免浏览器端 canvas
 * 被 B站 CDN 跨域污染。带内存 LRU 缓存（同封面只取一次），支持
 * i0/i1/i2.hdslb.com 与 @ 压缩后缀参数。
 *
 * 返回：{ ok: true, hex: "#rrggbb", rgb: [r,g,b] }
 * 失败：{ ok: false, error }（前端静默降级，不显示氛围光）
 */
import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'

export const runtime = 'nodejs'

/** B站图片 CDN 白名单（含图片处理 CDN 与动态封面 OSS） */
const HOST_WHITELIST = [
  'i0.hdslb.com',
  'i1.hdslb.com',
  'i2.hdslb.com',
  'i3.hdslb.com',
  'i4.hdslb.com',
  'i9.hdslb.com',
  's1.hdslb.com',
  'archive.biliimg.com',
]

/** 简易 LRU：url -> { hex, rgb, at }，上限 200 */
const cache = new Map<string, { hex: string; rgb: [number, number, number]; at: number }>()
const CACHE_MAX = 200
const CACHE_TTL = 30 * 60 * 1000 // 30 分钟

function cacheGet(key: string) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  // LRU 触摸：删了重插保持最新
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cacheSet(key: string, val: { hex: string; rgb: [number, number, number] }) {
  cache.set(key, { ...val, at: Date.now() })
  if (cache.size > CACHE_MAX) {
    // 淘汰最老一条
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('u') || ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return NextResponse.json({ ok: false, error: '非法 URL' }, { status: 400 })
  }

  // SSRF 防护：仅允许 http(s) + 白名单域名
  if (!/^https?:$/.test(url.protocol) || !HOST_WHITELIST.includes(url.hostname)) {
    return NextResponse.json({ ok: false, error: '域名不在白名单' }, { status: 400 })
  }

  const cached = cacheGet(raw)
  if (cached) {
    return NextResponse.json({ ok: true, ...cached, cached: true })
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0 (BiliTogether cover-color)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`封面下载失败 ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) throw new Error('封面为空')

    // 缩到 32x32 消除细节干扰后取 dominant；fallback 平均色
    let r = 0, g = 0, b = 0
    try {
      const stats = await sharp(buf).resize(32, 32, { fit: 'cover' }).stats()
      const d = stats.dominant
      r = d.r; g = d.g; b = d.b
    } catch {
      const { data, info } = await sharp(buf).resize(4, 4, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true })
      let n = 0
      for (let i = 0; i < data.length; i += info.channels) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
      }
      r /= n; g /= n; b /= n
    }

    // 提升饱和度与亮度下限：太暗/太灰的主色氛围感差，映射到更"发光"的色值
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max < 60) { r = Math.min(255, r + 40); g = Math.min(255, g + 30); b = Math.min(255, b + 35) }
    // 混入品牌粉做轻微 harmonize（保持主题一致性）：10% 混合
    r = r * 0.9 + 251 * 0.1
    g = g * 0.9 + 114 * 0.1
    b = b * 0.9 + 153 * 0.1

    const rgb: [number, number, number] = [Math.round(r), Math.round(g), Math.round(b)]
    const val = { hex: toHex(...rgb), rgb }
    cacheSet(raw, val)
    return NextResponse.json({ ok: true, ...val })
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误'
    return NextResponse.json({ ok: false, error: msg }, { status: 200 })
  }
}
