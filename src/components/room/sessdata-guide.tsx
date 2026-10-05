'use client'

import { useCallback, useEffect, useState } from 'react'
import { Cookie, ExternalLink, KeyRound, Loader2, LogOut, ScanLine, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'

interface CredentialStatus {
  configured: boolean
  source: 'file' | 'env' | null
  sessdataMask: string | null
  hasJct: boolean
  uname: string | null
  avatar: string | null
  savedAt: number | null
}

interface SessdataGuideProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 打开扫码登录弹窗（推荐路径） */
  onStartLogin: () => void
}

const MANUAL_STEPS = [
  {
    icon: Cookie,
    title: '获取 SESSDATA',
    lines: [
      '用电脑浏览器登录 bilibili.com',
      '按 F12 打开开发者工具 → 应用/Application → 存储 → Cookies',
      '找到名为 SESSDATA 的条目，复制它的值（原样复制，含 %2C 等转义，不要手动解码）',
    ],
  },
  {
    icon: KeyRound,
    title: '获取 bili_jct（仅发送弹幕需要）',
    lines: [
      '在同一个 Cookies 列表里找到 bili_jct，复制它的值',
      '扫码登录无需这一步（会自动同时抓取 SESSDATA 与 bili_jct）',
    ],
  },
  {
    icon: KeyRound,
    title: '配置到服务端',
    lines: [
      '在项目根目录的 .env 文件中新增两行：',
      'BILI_SESSDATA=你复制的值',
      'BILI_BILI_JCT=你复制的值（不发弹幕可省略）',
      '保存后重启 Next.js 服务即可生效',
    ],
  },
]

/**
 * 画质解锁指引弹窗：
 * - 顶部实时状态卡（每 3s 轮询 /api/bili/login，扫码成功后自动更新）
 * - 推荐路径：扫码登录（打开 BiliLoginDialog，服务端自动抓取 SESSDATA 落盘）
 * - 手动配置指引（自建部署 / CLI 爱好者）
 */
export function SessdataGuide({ open, onOpenChange, onStartLogin }: SessdataGuideProps) {
  const { toast } = useToast()
  const [status, setStatus] = useState<CredentialStatus | null>(null)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/bili/login')
      const json = (await res.json().catch(() => null)) as CredentialStatus & { ok: boolean } | null
      if (json?.ok) setStatus(json)
    } catch {
      /* 忽略，下轮再取 */
    }
  }, [])

  // 打开时立即拉取（setTimeout 让出 effect 主体，符合 react-hooks/set-state-in-effect）+ 每 3s 轮询
  useEffect(() => {
    if (!open) return
    const initial = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), 3000)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, [open, refresh])

  const doLogout = async () => {
    setConfirmLogout(false)
    setLoggingOut(true)
    try {
      const res = await fetch('/api/bili/login', { method: 'DELETE' })
      const json = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null
      if (json?.ok) {
        toast({ title: '已退出登录', description: '服务端凭据已清除，画质将回到未登录上限（720P）' })
      } else {
        toast({ title: '退出失败', description: json?.error || '请稍后重试', variant: 'destructive' })
      }
    } catch {
      toast({ title: '退出失败', description: '网络异常，请稍后重试', variant: 'destructive' })
    }
    void refresh()
    setLoggingOut(false)
  }

  const configured = !!status?.configured
  const isEnvSource = status?.source === 'env'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-surface-border bg-surface text-surface-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base text-surface-foreground">
            <Cookie className="h-4.5 w-4.5 text-[#fb7299]" />
            解锁 1080P / 4K 画质
            {status === null ? (
              <Badge className="h-5 bg-surface-3 px-1.5 text-[10px] text-surface-muted-foreground">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> 检测中
              </Badge>
            ) : configured ? (
              <Badge className="h-5 bg-emerald-500/15 px-1.5 text-[10px] text-emerald-400">
                {isEnvSource ? '.env 已配置' : '已扫码登录'}
              </Badge>
            ) : (
              <Badge className="h-5 bg-amber-500/15 px-1.5 text-[10px] text-amber-400">未配置</Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-surface-muted-foreground">
            B站对未登录用户限制最高 720P。让服务端持有B站登录凭据（SESSDATA）后，房间全员即可解锁 1080P
            及以上真实画质；凭据同时包含 bili_jct 时还能解锁「发送弹幕」。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* ---- 状态卡 ---- */}
          {configured ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-3">
                {status?.avatar ? (
                  <img src={status.avatar} alt="账号头像" className="h-10 w-10 shrink-0 rounded-full border border-emerald-500/30" referrerPolicy="no-referrer" />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-lg">👤</span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-surface-foreground">
                    {status?.uname || 'B站账号'}
                    <span className="ml-2 font-mono text-[10px] font-normal text-surface-muted-foreground">SESSDATA {status?.sessdataMask}</span>
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-surface-muted-foreground">
                    <Badge className="h-4.5 bg-emerald-500/15 px-1.5 text-[10px] text-emerald-400">
                      {isEnvSource ? '来源：.env 手工配置' : '来源：扫码登录'}
                    </Badge>
                    {status?.hasJct && <Badge className="h-4.5 bg-[#fb7299]/15 px-1.5 text-[10px] text-[#fb7299]">可发弹幕</Badge>}
                    {status?.savedAt ? <span>{new Date(status.savedAt).toLocaleString('zh-CN')}</span> : null}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loggingOut}
                  className="h-8 shrink-0 border-red-500/40 bg-transparent text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  title={isEnvSource ? '.env 手工配置的凭据请在服务器上编辑 .env 移除' : '清除服务端凭据'}
                  onClick={() => setConfirmLogout(true)}
                >
                  {loggingOut ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <LogOut className="mr-1 h-3.5 w-3.5" />}
                  退出登录
                </Button>
              </div>
              {!isEnvSource && (
                <p className="mt-2 border-t border-emerald-500/15 pt-2 text-[11px] leading-relaxed text-emerald-200/70">
                  换个账号？点击退出后重新扫码即可（自动覆盖旧凭据并刷新全员画质）。
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-[#fb7299]/30 bg-[#fb7299]/5 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-surface-foreground">
                <ScanLine className="h-4 w-4 text-[#fb7299]" />
                扫码登录，自动配置（推荐）
              </p>
              <p className="mb-3 text-xs leading-relaxed text-surface-muted-foreground">
                弹出B站官方扫码登录页，B站 App 确认后服务端自动抓取 SESSDATA + bili_jct 写入配置文件（.env
                同步更新），全程无需手动复制粘贴，立即生效。
              </p>
              <Button onClick={onStartLogin} className="w-full bg-[#fb7299] font-medium hover:bg-[#f45d8b]">
                <ScanLine className="mr-1.5 h-4 w-4" />
                弹出B站扫码登录
              </Button>
            </div>
          )}

          {/* ---- 手动配置指引（折叠） ---- */}
          <details className="group rounded-lg border border-surface-border bg-surface-2/60">
            <summary className="cursor-pointer list-none p-3 text-xs font-medium text-surface-muted-foreground transition-colors hover:text-surface-foreground">
              <span className="flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" />
                手动配置 .env（备用方案，自建部署用）
                <span className="ml-auto text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
              </span>
            </summary>
            <div className="space-y-2.5 px-3 pb-3">
              {MANUAL_STEPS.map((s, i) => (
                <div key={s.title} className="rounded-md border border-surface-border bg-surface/60 p-2.5">
                  <p className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-surface-foreground">
                    <span className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-[#fb7299]/15 text-[10px] font-bold text-[#fb7299]">
                      {i + 1}
                    </span>
                    <s.icon className="h-3 w-3 text-[#fb7299]" />
                    {s.title}
                  </p>
                  <ul className="space-y-0.5 pl-6.5 text-[11px] leading-relaxed text-surface-muted-foreground">
                    {s.lines.map((line) => (
                      <li
                        key={line}
                        className={line.startsWith('BILI_SESSDATA=') || line.startsWith('BILI_BILI_JCT=') ? 'font-mono text-amber-300' : ''}
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>

          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <p className="text-xs leading-relaxed text-emerald-200/80">
              凭据仅保存在服务端（扫码写入 data/bili-credentials.json 并镜像到 .env），不会下发给任何浏览器；观众端无感知，只是画质列表变多了、可以发弹幕了。
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-xs leading-relaxed text-amber-200/80">
              凭证相当于登录态，请使用小号；B站 Cookie 会定期刷新，失效时画质会自动降回 720P，重新扫码即可恢复。
            </p>
          </div>

          <p className="flex items-center gap-1.5 pt-1 text-[11px] text-surface-muted-foreground">
            <ExternalLink className="h-3 w-3" />
            请不要向任何人泄露你的 SESSDATA；后扫码者会覆盖先扫码者的凭据。
          </p>
        </div>

        {/* 退出登录二次确认 */}
        <AlertDialog open={confirmLogout} onOpenChange={setConfirmLogout}>
          <AlertDialogContent className="border-surface-border bg-surface text-surface-foreground">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-base">退出B站登录？</AlertDialogTitle>
              <AlertDialogDescription className="text-xs leading-relaxed text-surface-muted-foreground">
                将清除服务端保存的 SESSDATA / bili_jct（同时移除 .env 中对应行），全员画质回到未登录上限
                720P、发送弹幕恢复不可用。确定继续吗？
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-surface-border bg-surface-2 text-surface-foreground">取消</AlertDialogCancel>
              <AlertDialogAction className="bg-red-500 text-white hover:bg-red-600" onClick={() => void doLogout()}>
                退出登录
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
