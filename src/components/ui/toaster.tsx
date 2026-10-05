"use client"

import { useSyncExternalStore } from "react"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

/** hydration 安全的 hash 路由探测：是否处于房间页（影院深色上下文） */
const emptySubscribe = () => () => {}
function useInRoomHash(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb)
      return () => window.removeEventListener("hashchange", cb)
    },
    () => typeof window !== "undefined" && window.location.hash.startsWith("#/room"),
    () => false
  )
}

export function Toaster() {
  const { toasts } = useToast()
  // 房间页永远是影院深色，其 toast 亦恒深色，与页面上下文一致（浅色主题下也不反白）
  const inRoom = useInRoomHash()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast
            key={id}
            {...props}
            // 房间页恒为影院深色：给 toast 元素加 dark class，default 变体的
            // bg-background/text-foreground 等 CSS 变量即解析为深色值
            className={cn("dark", props.className)}
          >
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
