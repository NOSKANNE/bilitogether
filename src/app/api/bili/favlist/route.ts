import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'

/** 单个可导入视频（精简元数据，播放列表条目可直接消费） */
export interface FavVideoItem {
  bvid: string
  title: string
  cover: string | null
  upName: string | null
  duration: number
}

interface FavListResponse {
  code: number
  message?: string
  data?: {
    info?: { id?: number; title?: string; media_count?: number; upper?: { name?: string } }
    medias?: {
      bvid?: string
      title?: string
      cover?: string
      duration?: number
      upper?: { name?: string }
    }[] | null
  } | null
}

interface SeasonResponse {
  code: number
  message?: string
  data?: {
    meta?: { name?: string; total?: number }
    archives?: {
      bvid?: string
      title?: string
      pic?: string
      duration?: number
      owner?: { name?: string }
    }[]
  } | null
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** 单次最多抓取的视频数（播放列表服务端上限即 50，超出无法入列） */
const MAX_VIDEOS = 50
const PAGE_SIZE = 20

/* ---------------- Wbi 签名（B站 2023+ 反爬，部分 IP 需要签名才返回 medias） ---------------- */

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14,
  39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59,
  6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

let wbiCache: { key: string; ts: number } | null = null

async function getMixinKey(): Promise<string | null> {
  try {
    if (wbiCache && Date.now() - wbiCache.ts < 3600_000) return wbiCache.key
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(8000),
    })
    const json = (await res.json()) as { code?: number; data?: { wbi_img?: { img_url?: string; sub_url?: string } } }
    const img = json.data?.wbi_img?.img_url?.split('/').pop()?.replace('.gif', '')
    const sub = json.data?.wbi_img?.sub_url?.split('/').pop()?.replace('.gif', '')
    if (!img || !sub) return null
    const raw = img + sub
    const key = MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32)
    wbiCache = { key, ts: Date.now() }
    return key
  } catch {
    return null
  }
}

/** wbi 参数签名：追加 wts + w_rid（md5） */
function encWbi(params: Record<string, string | number>, mixinKey: string): string {
  const wts = Math.floor(Date.now() / 1000)
  const all: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(all)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k])).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))}`
    )
    .join('&')
  const wRid = createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${wRid}`
}

/* ---------------- 输入解析 ---------------- */

/** 解析用户输入 → 收藏夹 / 合集 描述；不支持时返回 null */
function parseFavInput(
  raw: string
): { kind: 'favlist'; fid: string } | { kind: 'season'; mid: string; sid: string } | null {
  const input = raw.trim()
  if (!input) return null

  // 纯数字 → 直接视为收藏夹 media_id（fid）
  if (/^\d{4,20}$/.test(input)) return { kind: 'favlist', fid: input }

  const mid = input.match(/space\.bilibili\.com\/(\d+)/i)?.[1]
  const fid = input.match(/[?&]fid=(\d+)/i)?.[1]
  const sid = input.match(/[?&]sid=(\d+)/i)?.[1] || input.match(/\/lists\/(\d+)/i)?.[1]

  if (fid) return { kind: 'favlist', fid }
  // 合集：collectiondetail?sid= / 新版 /lists/{sid}
  if (sid) {
    if (!mid) return null // 合集 API 必须携带 mid
    return { kind: 'season', mid, sid }
  }
  return null
}

/* ---------------- 上游请求 ---------------- */

async function fetchJson<T>(url: string, extraHeaders?: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.bilibili.com/', ...extraHeaders },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** 收藏夹单页：先直连，medias 被风控置空时自动升级为 wbi 签名重试 */
async function fetchFavPage(fid: string, pn: number, mixinKey: string | null) {
  const base = { media_id: fid, pn, ps: PAGE_SIZE, keyword: '', order: 'mtime', type: 0, tid: 0, platform: 'web' }
  const plainUrl = `https://api.bilibili.com/x/v3/fav/resource/list?${new URLSearchParams(Object.entries(base).map(([k, v]) => [k, String(v)])).toString()}`
  const first = await fetchJson<FavListResponse>(plainUrl, { Origin: 'https://space.bilibili.com' })
  // 判定风控：code=0 但 medias 为 null（B站对数据中心 IP 的定向风控）
  if (first?.code === 0 && first.data && !Array.isArray(first.data.medias) && mixinKey) {
    const signedUrl = `https://api.bilibili.com/x/v3/fav/resource/list?${encWbi(base, mixinKey)}`
    const signed = await fetchJson<FavListResponse>(signedUrl, {
      Referer: 'https://space.bilibili.com/',
      Origin: 'https://space.bilibili.com',
    })
    if (signed?.code === 0 && Array.isArray(signed.data?.medias)) return signed
    return first // 返回原始响应（调用方按风控处理）
  }
  return first
}

/** 合集单页 */
async function fetchSeasonPage(mid: string, sid: string, pn: number) {
  const url = `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${encodeURIComponent(mid)}&season_id=${encodeURIComponent(sid)}&page_num=${pn}&page_size=${PAGE_SIZE}`
  return fetchJson<SeasonResponse>(url)
}

/** 从收藏夹分页响应提取规范化视频数组 */
function extractFavVideos(json: FavListResponse | null): FavVideoItem[] {
  const medias = json?.data?.medias
  if (!Array.isArray(medias)) return []
  return medias
    .filter((m) => m.bvid && m.title && m.title !== '已失效视频')
    .map((m) => ({
      bvid: m.bvid as string,
      title: (m.title as string).trim(),
      cover: m.cover || null,
      upName: m.upper?.name || null,
      duration: Number(m.duration || 0),
    }))
}

/**
 * GET /api/bili/favlist?input=... — B站收藏夹 / 合集批量解析
 * 支持：favlist URL（fid）、合集 URL（collectiondetail?sid= / /lists/{sid}）、纯数字 fid
 * 最多返回 50 条（与播放列表容量一致）
 * 风控场景：返回 riskControlled: true + 片单元信息（标题/总数），前端引导改用「多行批量粘贴」
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const input = (searchParams.get('input') || '').trim()
    if (!input) {
      return NextResponse.json({ error: '请粘贴收藏夹或合集链接' }, { status: 400 })
    }

    const target = parseFavInput(input)
    if (!target) {
      return NextResponse.json(
        { error: '未能识别收藏夹/合集链接。支持 space.bilibili.com 的 favlist 与合集页（或直接粘贴收藏夹 fid 数字）' },
        { status: 400 }
      )
    }

    if (target.kind === 'favlist') {
      const mixinKey = await getMixinKey()
      const first = await fetchFavPage(target.fid, 1, mixinKey)
      if (!first || first.code !== 0 || !first.data) {
        const msg =
          first?.code === -403
            ? '这个收藏夹是私密的，仅所有人可见，无法导入'
            : first?.code === -400
              ? '收藏夹不存在或已被删除'
              : '收藏夹获取失败，可能被风控，请稍后重试'
        return NextResponse.json({ error: msg }, { status: 404 })
      }
      const info = first.data.info || {}
      const title = (info.title || '收藏夹').trim()
      const total = Number(info.media_count || 0)

      // 风控判定：能拿到片单信息但列表被置空
      if (!Array.isArray(first.data.medias)) {
        if (total > 0) {
          return NextResponse.json({
            kind: 'favlist',
            id: target.fid,
            title,
            total,
            fetched: 0,
            videos: [],
            riskControlled: true,
            owner: info.upper?.name || null,
          })
        }
        return NextResponse.json({ error: `《${title}》是空的收藏夹，没有可导入的视频` }, { status: 404 })
      }

      const videos: FavVideoItem[] = []
      let pn = 1
      while (videos.length < MAX_VIDEOS && pn <= 3) {
        const json = pn === 1 ? first : await fetchFavPage(target.fid, pn, mixinKey)
        const pageVideos = extractFavVideos(json)
        if (pageVideos.length === 0) break
        videos.push(...pageVideos)
        const rawLen = json?.data?.medias?.length || 0
        if (rawLen < PAGE_SIZE) break
        pn += 1
      }

      if (videos.length === 0) {
        return NextResponse.json({ error: `《${title}》里没有可导入的视频（可能为空或全部失效）` }, { status: 404 })
      }
      return NextResponse.json({
        kind: 'favlist',
        id: target.fid,
        title,
        total,
        fetched: Math.min(videos.length, MAX_VIDEOS),
        videos: videos.slice(0, MAX_VIDEOS),
        owner: info.upper?.name || null,
      })
    }

    // 合集
    const first = await fetchSeasonPage(target.mid, target.sid, 1)
    if (!first || first.code !== 0 || !first.data) {
      // -352 = 风控；返回 riskControlled 让前端引导
      if (first?.code === -352) {
        return NextResponse.json({
          kind: 'season',
          id: target.sid,
          title: '合集',
          total: 0,
          fetched: 0,
          videos: [],
          riskControlled: true,
        })
      }
      return NextResponse.json(
        { error: first?.code === -404 ? '合集不存在或已被删除' : '合集获取失败，可能被风控，请稍后重试' },
        { status: 404 }
      )
    }
    const meta = first.data.meta || {}
    const title = (meta.name || '合集').trim()
    const total = Number(meta.total || 0)
    const videos: FavVideoItem[] = []

    let pn = 1
    while (videos.length < MAX_VIDEOS && pn <= 3) {
      const json = pn === 1 ? first : await fetchSeasonPage(target.mid, target.sid, pn)
      const archives = json?.data?.archives
      if (!Array.isArray(archives) || archives.length === 0) break
      videos.push(
        ...archives
          .filter((a) => a.bvid && a.title)
          .map((a) => ({
            bvid: a.bvid as string,
            title: (a.title as string).trim(),
            cover: a.pic || null,
            upName: a.owner?.name || null,
            duration: Number(a.duration || 0),
          }))
      )
      if (archives.length < PAGE_SIZE) break
      pn += 1
    }

    if (videos.length === 0) {
      return NextResponse.json({ error: `《${title}》里没有可导入的视频（可能为空）` }, { status: 404 })
    }
    return NextResponse.json({
      kind: 'season',
      id: target.sid,
      title,
      total,
      fetched: Math.min(videos.length, MAX_VIDEOS),
      videos: videos.slice(0, MAX_VIDEOS),
    })
  } catch (err) {
    console.error('[bili/favlist] failed:', err)
    return NextResponse.json({ error: '解析失败，请稍后重试' }, { status: 500 })
  }
}
