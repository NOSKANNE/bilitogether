import { NextResponse } from 'next/server'
import { BROWSER_UA, isBvid, resolveCid } from '@/lib/bili-server'

/**
 * GET /api/bili/danmaku?bvid=&page=
 *
 * B站弹幕获取（原生模式自绘弹幕的数据源）：
 * - comment.bilibili.com/{cid}.xml（deflate 压缩，Node fetch 自动解压）
 * - 服务端解析 XML → 紧凑 JSON 数组 [{t,m,s,c,x}]
 * - 仅保留可渲染类型：1/2/3 滚动、4 底部、5 顶部（跳过 6/7/8/9 高级/代码/字幕弹幕）
 * - cid 解析复用 bili-server 共享缓存；弹幕按 cid 缓存 10 分钟
 */

interface DanmakuItem {
  /** 出现时间（秒） */
  t: number
  /** 弹幕类型 1-3滚动 4底部 5顶部 */
  m: number
  /** 字号 */
  s: number
  /** 颜色（十进制 RGB，16777215=白色） */
  c: number
  /** 文本 */
  x: string
}

const dmCache = new Map<string, { ts: number; items: DanmakuItem[] }>()
const DM_TTL = 10 * 60 * 1000
const MAX_ITEMS = 6000

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 10)))
}

async function fetchDanmaku(cid: number): Promise<DanmakuItem[] | null> {
  try {
    const res = await fetch(`https://comment.bilibili.com/${cid}.xml`, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const xml = await res.text()
    const items: DanmakuItem[] = []
    const re = /<d p="([^"]+)">([\s\S]*?)<\/d>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml)) !== null) {
      const parts = m[1].split(',')
      const text = decodeEntities(m[2]).trim().slice(0, 100)
      if (!text) continue
      const t = parseFloat(parts[0])
      const mode = parseInt(parts[1], 10) || 1
      if (!isFinite(t) || t < 0) continue
      if (![1, 2, 3, 4, 5].includes(mode)) continue
      const size = parseInt(parts[2], 10) || 25
      const color = parseInt(parts[3], 10)
      items.push({
        t,
        m: mode,
        s: size,
        c: isFinite(color) && color >= 0 ? color : 16777215,
        x: text,
      })
    }
    if (items.length === 0) return null
    items.sort((a, b) => a.t - b.t)
    return items.slice(0, MAX_ITEMS)
  } catch {
    return null
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const bvid = (searchParams.get('bvid') || '').trim()
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)

    if (!isBvid(bvid)) {
      return NextResponse.json({ error: 'bvid 格式不正确' }, { status: 400 })
    }

    const resolved = await resolveCid(bvid, page)
    if (!resolved) {
      return NextResponse.json({ error: '无法获取视频 cid', code: 'NO_CID' }, { status: 404 })
    }
    const { cid } = resolved

    const cacheKey = String(cid)
    const cached = dmCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < DM_TTL) {
      return NextResponse.json({ ok: true, cached: true, cid, count: cached.items.length, items: cached.items })
    }

    const items = await fetchDanmaku(cid)
    if (items === null) {
      // 无弹幕（新视频）也算成功，返回空数组；只有网络异常才是 null→空
      return NextResponse.json({ ok: true, cid, count: 0, items: [] })
    }
    dmCache.set(cacheKey, { ts: Date.now(), items })
    if (dmCache.size > 300) {
      const now = Date.now()
      for (const [k, v] of dmCache) {
        if (now - v.ts > DM_TTL) dmCache.delete(k)
      }
    }
    return NextResponse.json({ ok: true, cid, count: items.length, items })
  } catch (err) {
    console.error('[bili/danmaku] failed:', err)
    return NextResponse.json({ error: '获取弹幕失败' }, { status: 500 })
  }
}
