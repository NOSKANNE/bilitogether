'use client'

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { DanmakuItem } from '@/hooks/use-danmaku'

interface DanmakuLayerProps {
  items: DanmakuItem[]
  videoRef: RefObject<HTMLVideoElement | null>
  visible: boolean
  /** 速度倍率 0.5-2 */
  speed: number
  /** 不透明度 0.2-1 */
  opacity: number
  /** 字号倍率 0.7-1.6 */
  scale: number
}

interface ScrollRow {
  freeAt: number // 该行何时可容纳新弹幕（时间戳 ms）
}

interface FixedSlot {
  freeAt: number
}

const SCROLL_BASE_SEC = 9 // 默认横穿屏幕 9s
const FIXED_LIFE_MS = 4000

/**
 * 自绘弹幕引擎（原生模式）：
 * - rAF 读取 video.currentTime，精确到帧地按时间轴发射弹幕
 * - 滚动弹幕按行分配（估算行空闲时间防重叠），顶部/底部固定弹幕占槽
 * - 暂停时冻结所有动画（WAAPI animation.pause），恢复播放续播
 * - seek（|Δt|>1.5s）时清屏并将指针二分到新时间
 * - 全部命令式 DOM + Web Animations API，React 不参与逐条渲染
 */
export function DanmakuLayer({ items, videoRef, visible, speed, opacity, scale }: DanmakuLayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const itemsRef = useRef<DanmakuItem[]>(items)
  const speedRef = useRef(speed)
  const scaleRef = useRef(scale)
  const opacityRef = useRef(opacity)

  useEffect(() => {
    itemsRef.current = items
  }, [items])
  useEffect(() => {
    speedRef.current = speed
  }, [speed])
  useEffect(() => {
    scaleRef.current = scale
  }, [scale])
  useEffect(() => {
    opacityRef.current = opacity
  }, [opacity])

  // 可见性切换：清屏 + 重置指针
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''
    ptrRef.current = -1
    lastTRef.current = -1
    if (!visible) return
    const v = videoRef.current
    if (v) {
      lastTRef.current = v.currentTime
      ptrRef.current = lowerBound(itemsRef.current, v.currentTime)
    }
  }, [visible, videoRef])

  const ptrRef = useRef(-1)
  const lastTRef = useRef(-1)
  const scrollRowsRef = useRef<ScrollRow[]>([])
  const topSlotsRef = useRef<FixedSlot[]>([])
  const bottomSlotsRef = useRef<FixedSlot[]>([])
  const animsRef = useRef<Set<Animation>>(new Set())
  const activeCountRef = useRef(0)

  useEffect(() => {
    if (!visible) return
    const container = containerRef.current
    if (!container) return

    let raf = 0
    const clearAll = () => {
      for (const a of animsRef.current) a.cancel()
      animsRef.current.clear()
      container.textContent = ''
      activeCountRef.current = 0
    }

    const spawn = (item: DanmakuItem, nowMs: number) => {
      if (activeCountRef.current > 80) return
      const video = videoRef.current
      if (!video) return
      const W = container.clientWidth
      const H = container.clientHeight
      if (W <= 0 || H <= 0) return

      const fontBase = Math.max(13, Math.min(21, Math.round(H / 22)))
      const fontSize = Math.round(fontBase * (item.s >= 36 ? 1.35 : 1) * scaleRef.current)
      const lineH = Math.round(fontSize * 1.35)
      const color = `#${item.c.toString(16).padStart(6, '0')}`

      const el = document.createElement('span')
      el.className = 'danmaku-item'
      el.textContent = item.x
      el.style.fontSize = `${fontSize}px`
      el.style.lineHeight = `${lineH}px`
      el.style.color = color
      el.style.opacity = String(opacityRef.current)
      container.appendChild(el)

      const speedPx = (W / SCROLL_BASE_SEC) * speedRef.current

      if (item.m === 4 || item.m === 5) {
        // 顶部 / 底部固定
        const slots = item.m === 5 ? topSlotsRef.current : bottomSlotsRef.current
        const maxSlots = Math.max(2, Math.floor((H * 0.5) / lineH))
        while (slots.length < maxSlots) slots.push({ freeAt: 0 })
        let slotIdx = slots.findIndex((s) => s.freeAt <= nowMs)
        if (slotIdx === -1) slotIdx = 0
        slots[slotIdx].freeAt = nowMs + FIXED_LIFE_MS
        el.style.left = '50%'
        el.style.transform = 'translateX(-50%)'
        el.style.top = item.m === 5 ? `${slotIdx * lineH + 4}px` : 'unset'
        el.style.bottom = item.m === 4 ? `${slotIdx * lineH + 4}px` : 'unset'
        activeCountRef.current++
        const anim = el.animate(
          [
            { opacity: 0, offset: 0 },
            { opacity: opacityRef.current, offset: 0.06 },
            { opacity: opacityRef.current, offset: 0.9 },
            { opacity: 0, offset: 1 },
          ],
          { duration: FIXED_LIFE_MS, fill: 'forwards' }
        )
        animsRef.current.add(anim)
        anim.finished
          .catch(() => undefined)
          .then(() => {
            el.remove()
            animsRef.current.delete(anim)
            activeCountRef.current--
          })
        return
      }

      // 1/2/3 滚动弹幕
      const rowCount = Math.max(4, Math.floor((H * 0.75) / lineH))
      const rows = scrollRowsRef.current
      while (rows.length < rowCount) rows.push({ freeAt: 0 })
      let rowIdx = rows.findIndex((r) => r.freeAt <= nowMs)
      if (rowIdx === -1) {
        // 全满：找最快空闲的行
        let min = Infinity
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].freeAt < min) {
            min = rows[i].freeAt
            rowIdx = i
          }
        }
      }
      const row = rows[rowIdx]

      const textW = el.offsetWidth || item.x.length * fontSize
      const duration = (W + textW) / speedPx
      // 尾部完全进入视野后该行才空闲（单位 ms）
      row.freeAt = nowMs + ((textW + 12) / speedPx) * 1000

      el.style.top = `${rowIdx * lineH + 4}px`
      el.style.left = '0'
      el.style.transform = `translateX(${W}px)`
      activeCountRef.current++
      const anim = el.animate([{ transform: `translateX(${W}px)` }, { transform: `translateX(${-textW - 8}px)` }], {
        duration: duration * 1000,
        easing: 'linear',
        fill: 'forwards',
      })
      animsRef.current.add(anim)
      anim.finished
        .catch(() => undefined)
        .then(() => {
          el.remove()
          animsRef.current.delete(anim)
          activeCountRef.current--
        })
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const video = videoRef.current
      if (!video) return
      const t = video.currentTime
      const lastT = lastTRef.current

      if (lastT < 0) {
        lastTRef.current = t
        ptrRef.current = lowerBound(itemsRef.current, t)
        return
      }

      // seek 检测：清屏 + 重定位
      if (Math.abs(t - lastT) > 1.5) {
        clearAll()
        scrollRowsRef.current = []
        topSlotsRef.current = []
        bottomSlotsRef.current = []
        ptrRef.current = lowerBound(itemsRef.current, t)
        lastTRef.current = t
        return
      }

      if (t > lastT) {
        const nowMs = Date.now()
        // 发射 (lastT, t] 区间的弹幕
        const arr = itemsRef.current
        let p = ptrRef.current
        if (p < 0) p = lowerBound(arr, t)
        while (p < arr.length && arr[p].t <= t) {
          const it = arr[p]
          // 只发射刚过去 0.6s 内的（跳帧时避免雪崩）
          if (t - it.t <= 0.6) spawn(it, nowMs)
          p++
        }
        ptrRef.current = p
      }

      lastTRef.current = t
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      clearAll()
    }
  }, [visible, videoRef])

  // 暂停/恢复：冻结/续播所有动画
  useEffect(() => {
    const video = videoRef.current
    if (!video || !visible) return
    const onPause = () => {
      for (const a of animsRef.current) a.pause()
    }
    const onPlay = () => {
      for (const a of animsRef.current) a.play()
    }
    video.addEventListener('pause', onPause)
    video.addEventListener('play', onPlay)
    return () => {
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlay)
    }
  }, [visible, videoRef])

  if (!visible) return null
  return (
    <div
      ref={containerRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
    />
  )
}

/** 二分查找：第一个 t >= time 的下标 */
function lowerBound(items: DanmakuItem[], time: number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].t < time) lo = mid + 1
    else hi = mid
  }
  return lo
}
