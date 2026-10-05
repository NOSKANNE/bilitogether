'use client'

import { useEffect, useRef, useState } from 'react'

export interface DanmakuItem {
  /** 出现时间（秒） */
  t: number
  /** 类型 1-3滚动 4底部 5顶部 */
  m: number
  /** 字号 */
  s: number
  /** 颜色十进制 */
  c: number
  /** 文本 */
  x: string
}

interface UseDanmakuResult {
  items: DanmakuItem[]
  loading: boolean
  count: number
}

// 客户端缓存：同视频重复打开秒出
const dmCache = new Map<string, DanmakuItem[]>()

/**
 * 加载某视频的弹幕列表（原生模式）
 * bvid+page 变化自动重新拉取；enabled=false 时不请求
 */
export function useDanmaku(bvid: string | null, page: number, enabled: boolean): UseDanmakuResult {
  const [items, setItems] = useState<DanmakuItem[]>([])
  const [loading, setLoading] = useState(false)
  const seqRef = useRef(0)

  useEffect(() => {
    seqRef.current += 1
    const seq = seqRef.current

    const run = async () => {
      await Promise.resolve() // 微任务让出，避免 effect 内同步 setState
      if (seq !== seqRef.current) return
      if (!enabled || !bvid) {
        setItems([])
        setLoading(false)
        return
      }
      const key = `${bvid}|${page}`
      const cached = dmCache.get(key)
      if (cached) {
        setItems(cached)
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const res = await fetch(`/api/bili/danmaku?bvid=${bvid}&page=${page}`)
        if (seq !== seqRef.current) return
        const json = await res.json().catch(() => null)
        if (seq !== seqRef.current) return
        const list: DanmakuItem[] = json?.ok && Array.isArray(json.items) ? json.items : []
        dmCache.set(key, list)
        setItems(list)
      } catch {
        if (seq === seqRef.current) setItems([])
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    }

    void run()
  }, [bvid, page, enabled])

  return { items, loading, count: items.length }
}
