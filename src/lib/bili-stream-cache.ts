/**
 * B站 playurl 流地址服务端缓存（从 playurl 路由抽出为共享模块）：
 * - key = bvid|page|qn，TTL 由调用方决定
 * - 扫码登录 / 退出登录后必须调用 clearBiliStreamCache()，
 *   否则登录前后缓存的流地址/画质授予不会刷新
 */

export interface StreamCacheEntry<T> {
  ts: number
  result: T
}

const cache = new Map<string, StreamCacheEntry<unknown>>()

/** 命中且未过期则返回，否则 null */
export function streamCacheGet<T>(key: string, ttlMs: number): T | null {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < ttlMs) return hit.result as T
  if (hit) cache.delete(key)
  return null
}

export function streamCacheSet<T>(key: string, result: T): void {
  cache.set(key, { ts: Date.now(), result })
  // 防止无限增长：超过容量时清掉最旧的一半
  if (cache.size > 400) {
    const entries = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)
    for (let i = 0; i < entries.length / 2; i++) cache.delete(entries[i][0])
  }
}

export function streamCacheClear(): void {
  cache.clear()
}
