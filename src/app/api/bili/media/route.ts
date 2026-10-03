import { NextResponse } from 'next/server'
import { isAllowedMediaHost } from '@/lib/bili-dash'

/**
 * GET /api/bili/media?u=<上游m4s地址>&b=<备用地址1,备用地址2>
 *
 * B站 DASH 媒体流透明代理（Range 透传）：
 * - 浏览器直连B站 CDN 的 Referer/CORS 策略相互矛盾（实测主 CDN 要求 B站 Referer、
 *   备用 CDN 禁止任何 Referer），无法稳定直连；服务端带 B站 Referer 请求永远成功
 * - dash.js 的所有媒体请求（init/sidx/分片 Range）都经过本代理
 * - 上游失败时自动轮换备用地址（服务端重试，浏览器无感）
 * - 安全：仅允许 https/http + 域名白名单（bilivideo.com / akamaized.net / szbdyd.com）
 *
 * 【分片级服务端缓存】同步观影场景下全房间观众进度几乎一致（±6s 漂移），
 * 会几乎同时请求同一分片的同一 Range —— 无缓存时服务器→CDN 流量 = N 倍叠加，
 * 服务器出口带宽成为全场卡顿瓶颈。缓存后 N 个观众共享 1 份上游字节，
 * 同时天然吸收 CDN 403 抖动（抖动窗口内的重复请求直接命中缓存）。
 */

const UPSTREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/* ---------------- 分片缓存（LRU + TTL + in-flight 合并） ---------------- */

const CACHE_TTL_MS = 90_000 // 分片重用窗口：同房观众同步观看，错峰拉片 <10s，90s 足够覆盖
const CACHE_MAX_BYTES = 192 * 1024 * 1024 // 上限 ~192MB（1080P 单分片 ~4MB，多房间共存也安全）
const MAX_CACHED_BYTES = 16 * 1024 * 1024 // 单条上限：超大响应（4K 长分片等）不进缓存，防内存尖峰

interface CacheEntry {
  ts: number
  status: number
  buf: ArrayBuffer
  ct: string
  cl: string | null
  cr: string | null
}

const segCache = new Map<string, CacheEntry>()
let segCacheBytes = 0
/** in-flight 请求合并：多观众并发拉同一分片时只向上游发一次 */
const inflight = new Map<string, Promise<CacheEntry | null>>()

function cacheGet(key: string): CacheEntry | null {
  const hit = segCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    segCache.delete(key)
    segCacheBytes -= hit.buf.byteLength
    return null
  }
  // LRU touch：删除后重插移到队尾（Map 保持插入序）
  segCache.delete(key)
  segCache.set(key, hit)
  return hit
}

function cachePut(key: string, entry: CacheEntry): void {
  const old = segCache.get(key)
  if (old) {
    segCache.delete(key)
    segCacheBytes -= old.buf.byteLength
  }
  segCache.set(key, entry)
  segCacheBytes += entry.buf.byteLength
  // 超限驱逐最旧（队头），直至放下当前条目
  while (segCacheBytes > CACHE_MAX_BYTES) {
    const oldest = segCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    const evicted = segCache.get(oldest)
    segCache.delete(oldest)
    if (evicted) segCacheBytes -= evicted.buf.byteLength
  }
}

/* ---------------- 上游请求 ---------------- */

function parseTargets(u: string | null, b: string | null): string[] {
  const list: string[] = []
  if (u) list.push(u)
  if (b) for (const x of b.split(',')) if (x.trim()) list.push(x.trim())
  return list.filter(isAllowedMediaHost)
}

const backoff = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 按目标列表顺序请求（主地址 → 备用地址，两轮退避），成功返回缓存条目；全部失败返回 null。
 *  抛出 Error(状态码) 表示上游明确拒绝（403/404/5xx），调用方透传状态码。 */
async function fetchUpstreamMulti(targets: string[], range: string | undefined): Promise<CacheEntry | null> {
  let lastStatus = 502
  // B站 CDN（尤其 undici 连接池复用场景）存在间歇性 403/超时抖动：
  // 同一签名 URL 先 403 后 206 实测复现。对全部 target 做两轮带退避重试。
  for (let round = 0; round < 2; round++) {
    if (round > 0) await backoff(600)
    for (const target of targets) {
      try {
        const upstream = await fetch(target, {
          headers: {
            // 媒体 CDN 以 B站 Referer 请求最稳（实测必需之一）；UA 用桌面浏览器指纹
            Referer: 'https://www.bilibili.com/',
            'User-Agent': UPSTREAM_UA,
            ...(range ? { Range: range } : {}),
          },
          signal: AbortSignal.timeout(30000),
        })
        // 403/404/5xx 视为该镜像本次失败 → 轮换下一个；两轮后仍失败才报给浏览器
        if (!upstream.ok && upstream.status !== 206) {
          lastStatus = upstream.status
          try {
            await upstream.body?.cancel()
          } catch {
            /* noop */
          }
          continue
        }

        const buf = await upstream.arrayBuffer()
        return {
          ts: Date.now(),
          status: upstream.status,
          buf,
          ct: upstream.headers.get('content-type') || 'video/mp4',
          cl: upstream.headers.get('content-length'),
          cr: upstream.headers.get('content-range'),
        }
      } catch {
        lastStatus = 504
      }
    }
  }
  if (lastStatus !== 502 && lastStatus !== 504) throw new Error(String(lastStatus))
  return null
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const targets = parseTargets(searchParams.get('u'), searchParams.get('b'))
  if (targets.length === 0) {
    return NextResponse.json({ error: '非法媒体地址' }, { status: 403 })
  }

  const range = req.headers.get('range') || undefined
  // 缓存 key 以主地址+Range 为准（备用地址返回的字节与主地址一致）
  const cacheKey = `${targets[0]}|${range || ''}`

  // 命中缓存：直接回字节（多观众共享，零上游流量）
  const hit = cacheGet(cacheKey)
  if (hit) {
    return cacheResponse(hit, true)
  }

  // in-flight 合并：并发同一分片只发一次上游请求，其余等同一个结果
  // （ArrayBuffer 可被多个 Response 包装复用，并发消费安全）
  let flight = inflight.get(cacheKey)
  if (!flight) {
    flight = fetchUpstreamMulti(targets, range)
      .then((entry) => {
        if (entry && entry.buf.byteLength <= MAX_CACHED_BYTES) cachePut(cacheKey, entry)
        return entry
      })
      .finally(() => {
        inflight.delete(cacheKey)
      })
    inflight.set(cacheKey, flight)
  }

  let entry: CacheEntry | null
  try {
    entry = await flight
  } catch (err) {
    return NextResponse.json({ error: '媒体上游不可用' }, { status: Number((err as Error).message) || 502 })
  }
  if (!entry) {
    return NextResponse.json({ error: '媒体上游不可用' }, { status: 502 })
  }
  return cacheResponse(entry, false)
}

function cacheResponse(entry: CacheEntry, hit: boolean): Response {
  const headers = new Headers()
  headers.set('Content-Type', entry.ct)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', 'private, max-age=600')
  headers.set('X-Media-Cache', hit ? 'HIT' : 'MISS')
  if (entry.cl) headers.set('Content-Length', entry.cl)
  if (entry.cr) headers.set('Content-Range', entry.cr)
  return new Response(entry.buf, { status: entry.status, headers })
}
