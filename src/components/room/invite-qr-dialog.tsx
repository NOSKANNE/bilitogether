'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Copy, QrCode, Smartphone } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'

interface InviteQrDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  code: string
}

/** 邀请二维码弹窗：手机扫码直接入房，免去手动输码 */
export function InviteQrDialog({ open, onOpenChange, code }: InviteQrDialogProps) {
  const { toast } = useToast()
  const [dataUrl, setDataUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const link = typeof window !== 'undefined' ? `${window.location.origin}/#/room/${code}` : ''

  useEffect(() => {
    if (!open) return
    let alive = true
    QRCode.toDataURL(link, {
      width: 480,
      margin: 2,
      color: { dark: '#18181b', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (alive) setDataUrl(url)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [open, link])

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      toast({ title: '邀请链接已复制 🔗' })
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast({ title: '复制失败，请手动复制', description: link })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-surface-border bg-surface text-surface-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <QrCode className="h-5 w-5 text-[#fb7299]" />
            扫码加入房间
          </DialogTitle>
          <DialogDescription className="text-xs text-surface-muted-foreground">
            手机相机或B站客户端扫码，秒进「一起看」房间
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          {/* 二维码卡片 */}
          <div className="rounded-2xl border border-surface-border bg-white p-3 shadow-lg shadow-black/30">
            {dataUrl ? (
              <img src={dataUrl} alt={`房间 ${code} 的邀请二维码`} className="h-52 w-52" />
            ) : (
              <div className="flex h-52 w-52 items-center justify-center">
                <QrCode className="h-10 w-10 animate-pulse text-zinc-300" />
              </div>
            )}
          </div>

          {/* 房间码大字展示 */}
          <div className="flex flex-col items-center gap-1">
            <span className="font-mono text-3xl font-bold tracking-[0.35em] text-[#fb7299]">{code}</span>
            <span className="text-[11px] text-surface-muted-foreground">扫不了码？让朋友在首页输入上面的房间码</span>
          </div>

          <Button
            onClick={copyLink}
            className="w-full bg-[#fb7299] font-medium hover:bg-[#f45d8b]"
          >
            {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
            {copied ? '已复制' : '复制邀请链接'}
          </Button>

          <p className="flex items-center gap-1.5 text-center text-[11px] leading-relaxed text-surface-muted-foreground">
            <Smartphone className="h-3.5 w-3.5 shrink-0" />
            同一网络下手机打开链接即自动进入房间，播放进度与画质全同步
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
