// 最近房间快速重入（localStorage 持久化，最多保留 5 个，按最近时间排序）

export interface RecentRoom {
  code: string
  name: string
  ts: number
}

const KEY = 'bt_recent_rooms'
const MAX = 5

export function getRecentRooms(): RecentRoom[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list
      .filter((r) => r && typeof r.code === 'string' && r.code.length >= 4)
      .slice(0, MAX)
  } catch {
    return []
  }
}

/** 记录/提升一个房间到最近列表顶部（去重，最多 MAX 条） */
export function addRecentRoom(code: string, name: string): void {
  if (typeof window === 'undefined') return
  const c = code.trim().toUpperCase()
  if (c.length < 4) return
  try {
    const list = getRecentRooms().filter((r) => r.code !== c)
    list.unshift({ code: c, name: (name || '').trim() || `房间 ${c}`, ts: Date.now() })
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    /* noop */
  }
}

export function removeRecentRoom(code: string): void {
  if (typeof window === 'undefined') return
  try {
    const list = getRecentRooms().filter((r) => r.code !== code.toUpperCase())
    window.localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* noop */
  }
}
