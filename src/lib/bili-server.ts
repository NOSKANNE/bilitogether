/**
 * B站服务端共享工具（供 /api/bili/* 路由复用）
 * 模块级缓存随 Next.js 进程存续
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

export interface CidCacheEntry {
  ts: number
  cid: number
  pages: number
  cidMap: Record<number, number>
  /** 每P真实时长（秒），用于交叉校验抗风控 */
  durations: Record<number, number>
}

const cidCache = new Map<string, CidCacheEntry>()
const CID_TTL = 10 * 60 * 1000

/**
 * 解析 cid + 真实分P时长：
 * 优先 pagelist 接口（轻量、抗风控），失败回退 view API（带缓存）
 */
export async function resolveCid(
  bvid: string,
  page: number
): Promise<{ cid: number; durations: Record<number, number> } | null> {
  const cached = cidCache.get(bvid)
  if (cached && Date.now() - cached.ts < CID_TTL) {
    const cid = cached.pages > 1 ? cached.cidMap[page] ?? cached.cidMap[1] ?? null : cached.cid
    if (cid) return { cid, durations: cached.durations }
  }
  // 方案一：pagelist 接口（每P cid+时长，不易触发风控）
  try {
    const res = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const json = (await res.json()) as {
        code: number
        data?: { cid: number; page: number; duration?: number }[]
      }
      const pages = Array.isArray(json.data) ? json.data : []
      if (json.code === 0 && pages.length > 0) {
        const target = pages.find((p) => p.page === page) || pages[0]
        const cidMap: Record<number, number> = {}
        const durations: Record<number, number> = {}
        for (const p of pages) {
          cidMap[p.page] = p.cid
          durations[p.page] = p.duration || 0
        }
        cidCache.set(bvid, { ts: Date.now(), cid: target.cid, pages: pages.length, cidMap, durations })
        return { cid: target.cid, durations }
      }
    }
  } catch {
    /* 降级到 view API */
  }
  // 方案二：view API（被风控时返回 HTML 会解析失败）
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return cached ? { cid: cached.cid, durations: cached.durations } : null
    const json = (await res.json()) as {
      code: number
      data?: { cid?: number; pages?: { page: number; cid: number; duration?: number }[] }
    }
    if (json.code !== 0 || !json.data) return cached ? { cid: cached.cid, durations: cached.durations } : null
    const pages = json.data.pages || []
    if (pages.length > 0) {
      const target = pages.find((p) => p.page === page) || pages[0]
      const cidMap: Record<number, number> = {}
      const durations: Record<number, number> = {}
      for (const p of pages) {
        cidMap[p.page] = p.cid
        durations[p.page] = p.duration || 0
      }
      cidCache.set(bvid, { ts: Date.now(), cid: target.cid, pages: pages.length, cidMap, durations })
      return { cid: target.cid, durations }
    }
    if (json.data.cid) {
      cidCache.set(bvid, { ts: Date.now(), cid: json.data.cid, pages: 1, cidMap: { 1: json.data.cid }, durations: { 1: 0 } })
      return { cid: json.data.cid, durations: { 1: 0 } }
    }
    return cached ? { cid: cached.cid, durations: cached.durations } : null
  } catch {
    return cached ? { cid: cached.cid, durations: cached.durations } : null
  }
}

/** BV 号格式校验（大小写敏感，绝不能 toUpperCase） */
export function isBvid(bvid: string): boolean {
  return /^BV[0-9A-Za-z]{10}$/.test(bvid)
}
