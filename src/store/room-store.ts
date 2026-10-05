'use client'

import { create } from 'zustand'

interface UserStore {
  /** 房间内成员身份：baseUid + 每标签页实例后缀（同浏览器多标签页互为独立观众） */
  uid: string
  /** 基础身份：localStorage 持久，观看统计按它归属（跨标签页/跨天累计不丢） */
  baseUid: string
  nickname: string
  device: 'pc' | 'mobile' | 'tablet'
  setNickname: (n: string) => void
}

function genUid(): { uid: string; baseUid: string } {
  if (typeof window === 'undefined') return { uid: 'ssr', baseUid: 'ssr' }
  // 基础身份：localStorage 持久（跨天回来仍能续上观看历史）
  let baseUid = localStorage.getItem('bt_uid')
  if (!baseUid) {
    baseUid = 'u_' + Math.random().toString(36).slice(2, 12)
    localStorage.setItem('bt_uid', baseUid)
  }
  // 标签页实例后缀：同一浏览器的每个标签页是独立观众。
  // 否则同一 uid 开两个标签页（如误点自己的邀请链接）会双双被视为房主，
  // 心跳 tick 与控制动作互相对撞，播放状态每 2s 抖动一次。
  // sessionStorage 刷新不丢（房主刷新页面不丢权），关标签页即弃。
  let tab = sessionStorage.getItem('bt_uid_tab')
  if (!tab) {
    tab = Math.random().toString(36).slice(2, 6)
    sessionStorage.setItem('bt_uid_tab', tab)
  }
  return { uid: `${baseUid}.${tab}`, baseUid }
}

function genDevice(): 'pc' | 'mobile' | 'tablet' {
  if (typeof window === 'undefined') return 'pc'
  const w = window.innerWidth
  return w < 768 ? 'mobile' : w < 1024 ? 'tablet' : 'pc'
}

function readUrlOverrides(): { uid?: string; nick?: string } {
  if (typeof window === 'undefined') return {}
  try {
    const sp = new URLSearchParams(window.location.search)
    return {
      uid: sp.get('uid') || undefined,
      nick: sp.get('nick') || undefined,
    }
  } catch {
    return {}
  }
}

const overrides = readUrlOverrides()
const identity = overrides.uid ? { uid: overrides.uid, baseUid: overrides.uid } : genUid()

export const useUserStore = create<UserStore>((set) => ({
  // 支持通过 URL 参数覆盖身份（邀请链接预填昵称 / 多用户测试）
  uid: identity.uid,
  baseUid: identity.baseUid,
  nickname: overrides.nick || (typeof window !== 'undefined' ? localStorage.getItem('bt_nickname') || '' : ''),
  device: genDevice(),
  setNickname: (n) => {
    if (typeof window !== 'undefined' && !overrides.nick) localStorage.setItem('bt_nickname', n)
    set({ nickname: n })
  },
}))
