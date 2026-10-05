'use client'

import { useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** hydration 探测：SSR/首帧 false，客户端挂载后 true（避免 setState-in-effect 级联渲染） */
const emptySubscribe = () => () => {}
const useMounted = () => useSyncExternalStore(emptySubscribe, () => true, () => false)

/**
 * 深浅色主题切换按钮（next-themes，class 策略，defaultTheme=light）。
 * - mounted 前渲染 Moon 占位：服务端/首帧主题恒为 light，图标与最终渲染一致，避免 hydration 闪烁；
 * - 配色走语义 token；全站页面（含房间页的影院 surface token）均跟随全局主题真实翻转，
 *   点击后在首页与观影房内都有即时视觉反馈。
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const mounted = useMounted()

  const isDark = mounted && resolvedTheme === 'dark'

  return (
    <Button
      variant="outline"
      size="icon"
      className={`h-9 w-9 shrink-0 border-border/70 bg-card/60 text-foreground backdrop-blur transition-colors hover:border-[#fb7299]/40 hover:text-[#fb7299] ${className}`}
      aria-label="切换深浅色主题"
      title={isDark ? '切换到浅色主题' : '切换到深色主题'}
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  )
}
