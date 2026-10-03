import { NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { parseVideoInput, type BiliVideoMeta } from '@/lib/bili'

interface ViewApiResponse {
  code: number
  message?: string
  data?: {
    bvid: string
    aid: number
    title: string
    pic: string
    duration: number
    owner?: { name?: string }
    pages?: { page: number; part: string; duration: number; cid: number }[]
  }
}

// 内存缓存 10 分钟
const metaCache = new Map<string, { ts: number; meta: BiliVideoMeta }>()
const CACHE_TTL = 10 * 60 * 1000

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** 方案一：B站官方 API（普通网络环境可用） */
async function fetchViewMeta(bvid: string): Promise<BiliVideoMeta | null> {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as ViewApiResponse
    if (json.code !== 0 || !json.data) return null
    const d = json.data
    return {
      bvid: d.bvid,
      page: 1,
      title: d.title,
      cover: d.pic || null,
      upName: d.owner?.name || null,
      duration: d.duration || 0,
      pages: (d.pages || []).map((p) => ({ page: p.page, part: p.part, duration: p.duration })),
    }
  } catch {
    return null
  }
}

/** 方案二：page_reader 抓取页面标题（官方 API 被风控时降级） */
async function fetchMetaViaReader(bvid: string): Promise<BiliVideoMeta | null> {
  try {
    const zai = await ZAI.create()
    const result = await zai.functions.invoke('page_reader', {
      url: `https://www.bilibili.com/video/${bvid}/`,
    })
    const title = (result?.data?.title || '').trim()
    if (!title) return null
    // 去掉 "_哔哩哔哩_bilibili" 后缀
    const cleanTitle = title
      .replace(/_哔哩哔哩_bilibili\s*$/, '')
      .replace(/_bilibili\s*$/, '')
      .replace(/- bilibili\s*$/, '')
      .trim()
    // B站失效/404 页面的标题固定为 "视频去哪了呢？"
    if (!cleanTitle || cleanTitle.includes('出错啦') || cleanTitle.includes('404') || cleanTitle.includes('视频去哪了呢')) {
      return null
    }
    return {
      bvid,
      page: 1,
      title: cleanTitle,
      cover: null,
      upName: null,
      duration: 0,
      pages: [],
    }
  } catch {
    return null
  }
}

/** pagelist 接口（轻量、抗风控）：分P标题 + 时长，用于补全/降级 */
async function fetchPagelist(bvid: string): Promise<{ page: number; part: string; duration: number }[] | null> {
  try {
    const res = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      code: number
      data?: { page: number; part?: string; duration?: number }[]
    }
    if (json.code !== 0 || !Array.isArray(json.data) || json.data.length === 0) return null
    return json.data.map((p) => ({ page: p.page, part: p.part || `P${p.page}`, duration: p.duration || 0 }))
  } catch {
    return null
  }
}

/** GET /api/bili/resolve?input=... — 解析 BV/av/链接/b23短链 → 视频元数据（多层降级） */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    let input = (searchParams.get('input') || '').trim()
    if (!input) {
      return NextResponse.json({ error: '请输入视频链接、BV号或av号' }, { status: 400 })
    }

    let page = 1

    // b23.tv 短链：先跟随重定向拿到真实链接
    if (/b23\.tv|bili2233/i.test(input)) {
      try {
        if (!/^https?:\/\//i.test(input)) input = `https://${input}`
        const res = await fetch(input, {
          redirect: 'follow',
          headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
          signal: AbortSignal.timeout(8000),
        })
        input = res.url || input
      } catch {
        /* 短链解析失败则按原文匹配 BV */
      }
    }

    const parsed = parseVideoInput(input)
    if (!parsed.bvid) {
      return NextResponse.json({ error: '未能识别 BV 号，请检查输入' }, { status: 400 })
    }
    page = parsed.page || 1
    const bvid = parsed.bvid

    // 缓存
    const cached = metaCache.get(bvid)
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return NextResponse.json({ video: { ...cached.meta, page } })
    }

    let meta = await fetchViewMeta(bvid)
    if (!meta) {
      meta = await fetchMetaViaReader(bvid)
    }
    if (!meta) {
      // 最终降级：仍允许播放（pagelist 至少提供分P信息时标题用分P名）
      const pl = await fetchPagelist(bvid)
      if (pl && pl.length > 0) {
        const cur = pl.find((p) => p.page === page) || pl[0]
        meta = {
          bvid,
          page: 1,
          title: cur.part,
          cover: null,
          upName: null,
          duration: cur.duration,
          pages: pl,
        }
        metaCache.set(bvid, { ts: Date.now(), meta })
        return NextResponse.json({ video: { ...meta, page }, degraded: true })
      }
      meta = { bvid, page: 1, title: `视频 ${bvid}`, cover: null, upName: null, duration: 0, pages: [] }
      metaCache.set(bvid, { ts: Date.now() - CACHE_TTL + 2 * 60 * 1000, meta }) // 仅缓存2分钟
      return NextResponse.json({ video: { ...meta, page }, degraded: true })
    }
    // 元数据缺分P/时长时用 pagelist 补全（reader 降级路径常见）
    if (meta.pages.length === 0 || meta.duration === 0) {
      const pl = await fetchPagelist(bvid)
      if (pl && pl.length > 0) {
        meta.pages = pl.map((p) => ({ page: p.page, part: p.part, duration: p.duration }))
        const cur = pl.find((p) => p.page === page) || pl[0]
        if (meta.duration === 0) meta.duration = cur.duration
        if (meta.pages.length > 1 && page > 1 && cur.page === page) {
          meta.title = `${meta.title} P${page}`
        }
      }
    }
    metaCache.set(bvid, { ts: Date.now(), meta })

    return NextResponse.json({ video: { ...meta, page } })
  } catch (err) {
    console.error('[bili/resolve] failed:', err)
    return NextResponse.json({ error: '解析失败，请稍后重试' }, { status: 500 })
  }
}
