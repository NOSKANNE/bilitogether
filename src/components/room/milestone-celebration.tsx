'use client'

import { useEffect, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { PartyPopper } from 'lucide-react'
import type { MilestoneEvent } from '@/hooks/use-room-socket'

interface MilestoneCelebrationProps {
  milestone: MilestoneEvent | null
  onDone: () => void
}

/** 庆祝粒子：确定性伪随机（避免 SSR/重渲染抖动），12 枚 emoji 从中心向四周飞散下落 */
const PARTICLE_EMOJIS = ['🎉', '✨', '🎊', '⭐', '💫', '🌟']

function buildParticles(seed: number) {
  // LCG 确定性伪随机（与分享卡片同款思路），同一次事件内稳定
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  const rand = () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
  return Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * Math.PI * 2 + rand() * 0.6
    const dist = 90 + rand() * 90
    return {
      emoji: PARTICLE_EMOJIS[i % PARTICLE_EMOJIS.length],
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist - 30,
      rotate: (rand() - 0.5) * 220,
      scale: 0.8 + rand() * 0.9,
      delay: rand() * 0.12,
    }
  })
}

/** 观看里程碑庆祝横幅：全房间广播 room:milestone 时弹出（4.5s 自动消失，不可交互） */
export function MilestoneCelebration({ milestone, onDone }: MilestoneCelebrationProps) {
  const particles = useMemo(
    () => buildParticles(milestone ? milestone.name.length * 977 + milestone.label.length * 31 : 1),
    [milestone]
  )

  /* 自动消失：里程碑变更时重置计时器 */
  useEffect(() => {
    if (!milestone) return
    const t = setTimeout(onDone, 4500)
    return () => clearTimeout(t)
  }, [milestone, onDone])

  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-[80] flex justify-center" aria-live="polite">
      <AnimatePresence>
        {milestone && (
          <motion.div
            key={milestone.id}
            initial={{ opacity: 0, y: -32, scale: 0.85 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 320, damping: 22 }}
            className="relative"
          >
            {/* 粒子层 */}
            <div className="absolute left-1/2 top-1/2">
              {particles.map((p, i) => (
                <motion.span
                  key={i}
                  className="absolute select-none whitespace-nowrap text-xl will-change-transform"
                  initial={{ opacity: 0, x: 0, y: 0, scale: 0.3, rotate: 0 }}
                  animate={{
                    opacity: [0, 1, 1, 0],
                    x: p.x,
                    y: [0, p.y, p.y + 46, p.y + 78],
                    scale: p.scale,
                    rotate: p.rotate,
                  }}
                  transition={{ duration: 1.6, delay: p.delay, ease: 'easeOut', times: [0, 0.15, 0.6, 1] }}
                >
                  {p.emoji}
                </motion.span>
              ))}
            </div>

            {/* 主体横幅 */}
            <div className="relative flex items-center gap-3 rounded-2xl border border-[#fb7299]/40 bg-gradient-to-r from-[#fb7299]/25 via-surface/95 to-[#fb7299]/25 px-6 py-3.5 shadow-2xl shadow-black/40 backdrop-blur-md">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#fb7299] to-[#e05a83] text-white shadow-lg shadow-[#fb7299]/30">
                <PartyPopper className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-surface-foreground">
                  {milestone.name} {milestone.label}
                </p>
                <p className="text-xs text-surface-muted-foreground">感谢陪伴，继续一起看下去吧～ 🍿</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
