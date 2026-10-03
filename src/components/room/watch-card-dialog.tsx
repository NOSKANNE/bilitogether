'use client'

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Download, Loader2, Share2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'

/** 分享卡条目（与观看时长榜一致的合并数据） */
export interface ShareCardEntry {
  name: string
  seconds: number
  online: boolean
}

interface WatchCardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  roomName: string
  code: string
  entries: ShareCardEntry[]
}

const W = 900
const H = 1280
const BRAND = '#fb7299'

/** 时长格式化（卡片用短格式）：61→1分钟 / 3700→1小时2分 */
function fmt(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0分钟'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m > 0 ? `${h}小时${m}分` : `${h}小时`
}

/** 确定性伪随机（同一房间每次生成的星点一致） */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"

/** 卡片模板调色板：影院夜色（深）/ 清爽浅色 */
interface CardPalette {
  bg: [string, string, string]
  glow: string
  starPink: string
  starWhite: string
  starCount: number
  eyebrow: string
  title: string
  cardFill: string
  cardStroke: string
  roomName: string
  code: string
  name: string
  firstName: string
  rankNum: string
  duration: string
  track: string
  barRest: string
  totalLabel: string
  totalValue: string
  date: string
  qrLabel: string
  qrCardStroke: string
  footer: string
}

const PALETTES: Record<'dark' | 'light', CardPalette> = {
  dark: {
    bg: ['#120d10', '#0c0a0e', '#150f12'],
    glow: 'rgba(251,114,153,0.28)',
    starPink: 'rgba(251,114,153,0.9)',
    starWhite: '#ffffff',
    starCount: 90,
    eyebrow: 'rgba(251,114,153,0.85)',
    title: '#f4f4f5',
    cardFill: 'rgba(255,255,255,0.045)',
    cardStroke: 'rgba(251,114,153,0.35)',
    roomName: '#f4f4f5',
    code: BRAND,
    name: '#e4e4e7',
    firstName: BRAND,
    rankNum: 'rgba(255,255,255,0.28)',
    duration: 'rgba(244,244,245,0.55)',
    track: 'rgba(255,255,255,0.08)',
    barRest: 'rgba(251,114,153,0.45)',
    totalLabel: 'rgba(244,244,245,0.6)',
    totalValue: BRAND,
    date: 'rgba(244,244,245,0.4)',
    qrLabel: 'rgba(244,244,245,0.75)',
    qrCardStroke: 'rgba(255,255,255,0.08)',
    footer: 'rgba(244,244,245,0.3)',
  },
  light: {
    bg: ['#fff9fa', '#fdeef2', '#fff5f7'],
    glow: 'rgba(251,114,153,0.16)',
    starPink: 'rgba(251,114,153,0.5)',
    starWhite: 'rgba(224,90,131,0.28)',
    starCount: 46,
    eyebrow: 'rgba(224,90,131,0.95)',
    title: '#3b1f28',
    cardFill: 'rgba(255,255,255,0.78)',
    cardStroke: 'rgba(251,114,153,0.5)',
    roomName: '#3b1f28',
    code: '#e05a83',
    name: '#4a2b34',
    firstName: '#e05a83',
    rankNum: 'rgba(59,31,40,0.35)',
    duration: 'rgba(59,31,40,0.55)',
    track: 'rgba(59,31,40,0.08)',
    barRest: 'rgba(251,114,153,0.55)',
    totalLabel: 'rgba(59,31,40,0.6)',
    totalValue: '#e05a83',
    date: 'rgba(59,31,40,0.45)',
    qrLabel: 'rgba(59,31,40,0.65)',
    qrCardStroke: 'rgba(59,31,40,0.1)',
    footer: 'rgba(59,31,40,0.35)',
  },
}

/** 绘制分享卡片（900×1280，双模板：影院深色/清爽浅色 + QR） */
async function buildCard(opts: { roomName: string; code: string; entries: ShareCardEntry[]; template: 'dark' | 'light' }): Promise<string> {
  const { roomName, code, entries, template } = opts
  const P = PALETTES[template]
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')

  // 底：垂直渐变
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, P.bg[0])
  bg.addColorStop(0.5, P.bg[1])
  bg.addColorStop(1, P.bg[2])
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  // 顶部品牌粉辉光
  const glow = ctx.createRadialGradient(W / 2, -80, 40, W / 2, -80, 620)
  glow.addColorStop(0, P.glow)
  glow.addColorStop(1, 'rgba(251,114,153,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, 520)

  // 装饰星点（确定性随机；浅色模板更稀疏更淡）
  const rand = lcg(20260925)
  for (let i = 0; i < P.starCount; i++) {
    const x = rand() * W
    const y = rand() * H * 0.7
    const r = 0.6 + rand() * 1.6
    const pink = rand() > 0.82
    ctx.globalAlpha = 0.25 + rand() * 0.55
    ctx.fillStyle = pink ? P.starPink : P.starWhite
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // 品牌 eyebrow
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.font = `600 26px ${FONT}`
  ctx.fillStyle = P.eyebrow
  ctx.fillText('B i l i T o g e t h e r · B 站一起看', W / 2, 92)

  // 大标题
  ctx.font = `900 74px ${FONT}`
  ctx.fillStyle = P.title
  ctx.fillText('观看时长榜', W / 2, 186)

  // 房间信息卡
  const cardX = 70
  const cardY = 260
  const cardW = W - cardX * 2
  const cardH = 128
  ctx.fillStyle = P.cardFill
  roundRect(ctx, cardX, cardY, cardW, cardH, 24)
  ctx.fill()
  ctx.strokeStyle = P.cardStroke
  ctx.lineWidth = 2
  roundRect(ctx, cardX, cardY, cardW, cardH, 24)
  ctx.stroke()
  // 房间名（左）+ 房间码（右）
  ctx.textAlign = 'left'
  ctx.font = `700 34px ${FONT}`
  ctx.fillStyle = P.roomName
  const roomLabel = roomName.length > 12 ? `${roomName.slice(0, 12)}…` : roomName
  ctx.fillText(roomLabel || '观影房间', cardX + 36, cardY + cardH / 2 - 2)
  ctx.textAlign = 'right'
  ctx.font = `800 40px ui-monospace, SFMono-Regular, Menlo, monospace`
  ctx.fillStyle = P.code
  ctx.fillText(code, cardX + cardW - 36, cardY + cardH / 2 - 2)

  // 榜单
  const listTop = cardY + cardH + 44
  const rowH = 86
  const max = entries[0]?.seconds || 1
  // 空榜占位：无观看记录时给出友好引导（不使用 emoji，规避设备字体差异）
  if (entries.length === 0) {
    ctx.textAlign = 'center'
    ctx.font = `600 34px ${FONT}`
    ctx.fillStyle = P.title
    ctx.fillText('还没有观看记录', W / 2, listTop + 150)
    ctx.font = `400 24px ${FONT}`
    ctx.fillStyle = P.duration
    ctx.fillText('开播之后，这里会记录你们一起看过的每一分钟', W / 2, listTop + 200)
  }
  const medalBg = ['#f5c542', '#c0c7d1', '#d29a6b']
  entries.slice(0, 8).forEach((e, i) => {
    const y = listTop + i * rowH
    // 名次徽章
    const cx = cardX + 40
    if (i < 3) {
      const g = ctx.createLinearGradient(cx - 20, y, cx + 20, y + 20)
      g.addColorStop(0, medalBg[i])
      g.addColorStop(1, i === 0 ? '#fb7299' : medalBg[i])
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, y + 22, 22, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#1c1013'
      ctx.font = `800 22px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText(String(i + 1), cx, y + 23)
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = `700 24px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.fillText(String(i + 1), cx, y + 23)
    }
    // 名字 + 在线点
    ctx.textAlign = 'left'
    ctx.font = `700 30px ${FONT}`
    ctx.fillStyle = i === 0 ? P.firstName : P.name
    const name = e.name.length > 10 ? `${e.name.slice(0, 10)}…` : e.name
    ctx.fillText(name, cx + 44, y + 12)
    if (e.online) {
      const nw = ctx.measureText(name).width
      ctx.fillStyle = '#34d399'
      ctx.beginPath()
      ctx.arc(cx + 50 + nw, y + 8, 6, 0, Math.PI * 2)
      ctx.fill()
    }
    // 时长（右侧）
    ctx.textAlign = 'right'
    ctx.font = `600 26px ui-monospace, monospace`
    ctx.fillStyle = P.duration
    ctx.fillText(fmt(e.seconds), cardX + cardW - 8, y + 10)
    // 进度条
    const barY = y + 42
    const barW = cardW - 84
    ctx.fillStyle = P.track
    roundRect(ctx, cx + 44, barY, barW, 10, 5)
    ctx.fill()
    const pct = Math.max(0.06, e.seconds / max)
    const bar = ctx.createLinearGradient(cx + 44, 0, cx + 44 + barW, 0)
    if (i === 0) {
      bar.addColorStop(0, '#f5c542')
      bar.addColorStop(1, BRAND)
    } else {
      bar.addColorStop(0, P.barRest)
      bar.addColorStop(1, BRAND)
    }
    ctx.fillStyle = bar
    roundRect(ctx, cx + 44, barY, Math.max(14, barW * pct), 10, 5)
    ctx.fill()
  })

  // 底部区：累计 + QR
  const bottomY = listTop + 8 * rowH + 26
  const total = entries.reduce((s, e) => s + e.seconds, 0)
  ctx.textAlign = 'left'
  ctx.font = `600 26px ${FONT}`
  ctx.fillStyle = P.totalLabel
  ctx.fillText('全员累计观看', cardX + 8, bottomY + 30)
  ctx.font = `900 52px ${FONT}`
  ctx.fillStyle = P.totalValue
  ctx.fillText(fmt(total), cardX + 8, bottomY + 84)
  ctx.font = `400 22px ${FONT}`
  ctx.fillStyle = P.date
  ctx.fillText(new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }), cardX + 8, bottomY + 132)

  // QR 卡片（右下）
  const qrSize = 190
  const qrX = W - 70 - qrSize
  const qrY = bottomY - 6
  try {
    const link = `${window.location.origin}/#/room/${code}`
    const qrUrl = await QRCode.toDataURL(link, { width: 380, margin: 1, color: { dark: '#18181b', light: '#ffffff' }, errorCorrectionLevel: 'M' })
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('qr load failed'))
      img.src = qrUrl
    })
    ctx.fillStyle = '#ffffff'
    roundRect(ctx, qrX - 12, qrY - 12, qrSize + 24, qrSize + 24, 18)
    ctx.fill()
    ctx.strokeStyle = P.qrCardStroke
    ctx.lineWidth = 2
    roundRect(ctx, qrX - 12, qrY - 12, qrSize + 24, qrSize + 24, 18)
    ctx.stroke()
    ctx.drawImage(img, qrX, qrY, qrSize, qrSize)
    ctx.textAlign = 'center'
    ctx.font = `600 24px ${FONT}`
    ctx.fillStyle = P.qrLabel
    ctx.fillText('扫码一起来', qrX + qrSize / 2, qrY + qrSize + 28)
  } catch {
    /* QR 失败不影响卡片主体 */
  }

  // 页脚
  ctx.textAlign = 'center'
  ctx.font = `400 20px ${FONT}`
  ctx.fillStyle = P.footer
  ctx.fillText('视频内容与播放能力来自 bilibili · 仅供学习交流', W / 2, H - 42)

  return canvas.toDataURL('image/png')
}

/** 观看时长榜分享卡片：canvas 绘制 → 预览 + PNG 下载（含房间邀请二维码，双模板） */
export function WatchCardDialog({ open, onOpenChange, roomName, code, entries }: WatchCardDialogProps) {
  const { toast } = useToast()
  const [cardUrl, setCardUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [template, setTemplate] = useState<'dark' | 'light'>('dark')
  const urlRef = useRef('')

  useEffect(() => {
    if (!open) return
    let alive = true
    // 生成是异步副作用：把状态切换放进微任务，避免在 effect 体内同步 setState
    void (async () => {
      await Promise.resolve()
      if (!alive) return
      setBusy(true)
      setCardUrl('')
      try {
        const url = await buildCard({ roomName, code, entries, template })
        if (!alive) return
        urlRef.current = url
        setCardUrl(url)
      } catch {
        if (alive) toast({ title: '卡片生成失败', description: '浏览器不支持 canvas，请截图保存', variant: 'destructive' })
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, roomName, code, entries, template, toast])

  const download = () => {
    if (!urlRef.current) return
    const a = document.createElement('a')
    a.href = urlRef.current
    a.download = `BiliTogether观看榜_${code}.png`
    a.click()
    toast({ title: '卡片已开始下载 📸' })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-surface-border bg-surface text-surface-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base text-surface-foreground">
            <Share2 className="h-4.5 w-4.5 text-[#fb7299]" />
            观看榜分享卡片
          </DialogTitle>
          <DialogDescription className="text-xs text-surface-muted-foreground">
            生成影院风榜单图（自带房间邀请二维码），保存后发群/发圈拉人一起看
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3">
          {/* 模板选择（切换即时重绘） */}
          <div className="flex w-full gap-1 rounded-lg border border-surface-border bg-surface-2 p-1" role="radiogroup" aria-label="选择卡片模板">
            {([
              { key: 'dark', label: '影院夜色' },
              { key: 'light', label: '清爽浅色' },
            ] as const).map((t) => (
              <button
                key={t.key}
                role="radio"
                aria-checked={template === t.key}
                onClick={() => setTemplate(t.key)}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  template === t.key
                    ? 'bg-[#fb7299] text-white shadow-sm'
                    : 'text-surface-muted-foreground hover:bg-surface-3 hover:text-surface-foreground'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {busy && (
            <div className="flex h-64 w-full items-center justify-center rounded-xl border border-surface-border bg-surface-2/60">
              <span className="flex flex-col items-center gap-2 text-xs text-surface-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin text-[#fb7299]" />
                正在绘制卡片…
              </span>
            </div>
          )}
          {!busy && cardUrl && (
            <img
              src={cardUrl}
              alt={`房间 ${code} 观看时长榜分享卡片`}
              className="w-full rounded-xl border border-surface-border shadow-lg shadow-black/30"
            />
          )}
          <Button className="w-full bg-[#fb7299] font-medium hover:bg-[#f45d8b]" disabled={!cardUrl} onClick={download}>
            <Download className="mr-1.5 h-4 w-4" />
            下载 PNG
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
