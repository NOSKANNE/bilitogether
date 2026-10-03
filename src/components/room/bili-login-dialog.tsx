'use client'

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { CheckCircle2, Loader2, LogIn, RefreshCcw, ScanLine, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface BiliAccount {
  mid?: string
  uname?: string | null
  avatar?: string | null
}

interface BiliLoginDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 登录成功（服务端已抓取 SESSDATA 落盘）后回调 */
  onLoggedIn?: (account: BiliAccount | null) => void
}

type Phase = 'loading' | 'ready' | 'expired' | 'success' | 'error'

/**
 * B站扫码登录弹窗（自动配置服务端凭据）：
 * 1. 打开时经服务端生成B站官方登录二维码（passport.qrcode/generate）
 * 2. 前端渲染二维码 + 每 2s 轮询 /api/bili/login/qr/poll
 * 3. 用户在B站 App 确认登录后，服务端从 Set-Cookie 抓取 SESSDATA/bili_jct
 *    写入 data/bili-credentials.json 与 .env，并清空流缓存 → 全员画质即时解锁
 */
export function BiliLoginDialog({ open, onOpenChange, onLoggedIn }: BiliLoginDialogProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [scanState, setScanState] = useState<'waiting' | 'scanned'>('waiting')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [error, setError] = useState('')
  const [remaining, setRemaining] = useState(0)
  const [account, setAccount] = useState<BiliAccount | null>(null)
  const [attempt, setAttempt] = useState(0)

  // 回调用 ref 承接，避免父组件重渲染导致轮询 effect 重启（effect 内同步，符合 react-hooks/refs）
  const onLoggedInRef = useRef(onLoggedIn)
  const onOpenChangeRef = useRef(onOpenChange)
  useEffect(() => {
    onLoggedInRef.current = onLoggedIn
  }, [onLoggedIn])
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])
  const expiresAtRef = useRef(0)

  useEffect(() => {
    if (!open) return
    let alive = true
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let closeTimer: ReturnType<typeof setTimeout> | null = null

    const run = async () => {
      setPhase('loading')
      setScanState('waiting')
      setQrDataUrl('')
      setError('')
      setAccount(null)
      await Promise.resolve()
      if (!alive) return

      try {
        const res = await fetch('/api/bili/login/qr')
        const json = (await res.json().catch(() => null)) as
          | { ok: boolean; qrcodeKey?: string; qrUrl?: string; expiresIn?: number; error?: string }
          | null
        if (!alive) return
        if (!json?.ok || !json.qrcodeKey || !json.qrUrl) {
          setPhase('error')
          setError(json?.error || '生成登录二维码失败')
          return
        }
        const key = json.qrcodeKey
        const dataUrl = await QRCode.toDataURL(json.qrUrl, {
          width: 480,
          margin: 2,
          color: { dark: '#18181b', light: '#ffffff' },
          errorCorrectionLevel: 'M',
        })
        if (!alive) return
        setQrDataUrl(dataUrl)
        setPhase('ready')
        const expiresIn = json.expiresIn || 180
        expiresAtRef.current = Date.now() + expiresIn * 1000
        setRemaining(expiresIn)

        const pollOnce = async () => {
          if (!alive) return
          if (Date.now() >= expiresAtRef.current) {
            setPhase((p) => (p === 'ready' || p === 'loading' ? 'expired' : p))
            return
          }
          try {
            const r = await fetch(`/api/bili/login/qr/poll?qrcodeKey=${encodeURIComponent(key)}`)
            const j = (await r.json().catch(() => null)) as
              | { ok: boolean; state?: 'waiting' | 'scanned' | 'expired' | 'confirmed'; account?: BiliAccount | null; error?: string }
              | null
            if (!alive) return
            if (j?.ok) {
              if (j.state === 'waiting') setScanState('waiting')
              else if (j.state === 'scanned') setScanState('scanned')
              else if (j.state === 'expired') {
                setPhase('expired')
                return
              } else if (j.state === 'confirmed') {
                setPhase('success')
                setAccount(j.account ?? null)
                onLoggedInRef.current?.(j.account ?? null)
                // 成功后短暂停留让用户看到结果，再自动关闭
                closeTimer = setTimeout(() => {
                  if (alive) onOpenChangeRef.current(false)
                }, 2000)
                return
              }
            }
          } catch {
            /* 单次轮询失败忽略，继续下一轮 */
          }
          pollTimer = setTimeout(() => void pollOnce(), 2000)
        }
        void pollOnce()
      } catch {
        if (alive) {
          setPhase('error')
          setError('网络异常，生成登录二维码失败')
        }
      }
    }

    void run()
    const countdown = setInterval(() => {
      const left = Math.max(0, Math.ceil((expiresAtRef.current - Date.now()) / 1000))
      setRemaining(left)
      if (left <= 0) setPhase((p) => (p === 'ready' ? 'expired' : p))
    }, 1000)

    return () => {
      alive = false
      clearInterval(countdown)
      if (pollTimer) clearTimeout(pollTimer)
      if (closeTimer) clearTimeout(closeTimer)
    }
  }, [open, attempt])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-surface-border bg-surface text-surface-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base text-surface-foreground">
            <ScanLine className="h-4.5 w-4.5 text-[#fb7299]" />
            扫码登录B站账号
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-surface-muted-foreground">
            无需输入账号密码：B站 App 扫一扫并确认后，服务端自动抓取登录凭据（SESSDATA）写入配置文件，全员解锁 1080P / 4K 画质与发送弹幕。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          {/* 二维码卡片（含状态覆盖层） */}
          <div className="relative rounded-2xl border border-surface-border bg-white p-3 shadow-lg shadow-black/30">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="B站扫码登录二维码" className={`h-52 w-52 transition-opacity ${phase === 'expired' || phase === 'success' ? 'opacity-25' : ''}`} />
            ) : (
              <div className="flex h-52 w-52 items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-zinc-300" />
              </div>
            )}

            {phase === 'ready' && scanState === 'scanned' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-white/95">
                <CheckCircle2 className="h-9 w-9 text-emerald-500" />
                <p className="text-sm font-semibold text-zinc-800">已扫描</p>
                <p className="text-xs text-zinc-500">请在手机上确认登录</p>
              </div>
            )}

            {phase === 'expired' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-zinc-900/92 p-4 text-center">
                <TriangleAlert className="h-7 w-7 text-amber-400" />
                <p className="text-sm font-medium text-zinc-100">二维码已过期</p>
                <Button size="sm" className="mt-1 bg-[#fb7299] hover:bg-[#f45d8b]" onClick={() => setAttempt((a) => a + 1)}>
                  <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
                  重新生成
                </Button>
              </div>
            )}

            {phase === 'success' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-white/95 p-4 text-center">
                <CheckCircle2 className="h-10 w-10 text-emerald-500" />
                <p className="text-sm font-bold text-zinc-800">登录成功 🎉</p>
                {account?.uname && <p className="max-w-[11rem] truncate text-xs text-zinc-500">{account.uname}</p>}
                <p className="text-xs text-emerald-600">正在为全员解锁高清画质…</p>
              </div>
            )}
          </div>

          {/* 状态文字 */}
          {phase === 'loading' && <p className="flex items-center gap-2 text-xs text-surface-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在生成二维码…</p>}
          {phase === 'ready' && (
            <p className="flex items-center gap-2 text-xs text-surface-muted-foreground">
              {scanState === 'waiting' ? (
                <>
                  <LogIn className="h-3.5 w-3.5 text-[#fb7299]" />
                  请使用B站 App 扫描二维码登录
                </>
              ) : (
                <span className="text-emerald-400">已扫描，等待手机确认…</span>
              )}
              <span className="ml-auto font-mono text-[11px] text-surface-muted-foreground/70">{remaining}s</span>
            </p>
          )}
          {phase === 'error' && (
            <div className="flex w-full items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
              <p className="text-xs text-red-300">{error}</p>
              <Button size="sm" variant="outline" className="h-7 border-surface-border px-2 text-xs" onClick={() => setAttempt((a) => a + 1)}>
                <RefreshCcw className="mr-1 h-3 w-3" />
                重试
              </Button>
            </div>
          )}

          {/* 步骤提示 */}
          <ol className="w-full space-y-1.5 rounded-lg border border-surface-border bg-surface-2/60 p-3 text-xs leading-relaxed text-surface-muted-foreground">
            <li className="flex gap-2"><span className="font-bold text-[#fb7299]">1.</span> 打开B站 App（右上角「≡」或搜索页相机）</li>
            <li className="flex gap-2"><span className="font-bold text-[#fb7299]">2.</span> 使用「扫一扫」扫描上方二维码</li>
            <li className="flex gap-2"><span className="font-bold text-[#fb7299]">3.</span> 在手机上点击「确认登录」，本页面会自动完成配置</li>
          </ol>

          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-surface-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            凭据仅保存在本站服务器（data/bili-credentials.json + .env），不会下发给浏览器；建议使用小号登录。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
