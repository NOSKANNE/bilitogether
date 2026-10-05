'use client'

import { useEffect, useState } from 'react'
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import {
  MonitorSmartphone,
  Crown,
  Gauge,
  MessageCircleHeart,
  ListVideo,
  Share2,
  Clapperboard,
  ArrowRight,
  LogIn,
  Plus,
  Tv,
  ShieldCheck,
  Sparkles,
  History,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ThemeToggle } from '@/components/theme-toggle'
import { useUserStore } from '@/store/room-store'
import { getRecentRooms, removeRecentRoom, type RecentRoom } from '@/lib/recent-rooms'
import { useToast } from '@/hooks/use-toast'

const FEATURES = [
  {
    icon: MonitorSmartphone,
    title: '多端互通',
    desc: 'PC、手机、平板打开同一个房间即可同步观看，无需安装任何 App。',
  },
  {
    icon: Crown,
    title: '房主掌控',
    desc: '房主控制播放、暂停、拖动进度、切换视频，成员自动跟随同步。',
  },
  {
    icon: Gauge,
    title: '画质随心调',
    desc: '360P ~ 1080P 清晰度一键切换，弱网也能流畅追番。',
  },
  {
    icon: MessageCircleHeart,
    title: '实时弹幕聊天',
    desc: '房间内置聊天室，Join/Leave/切片提醒，边看边聊不冷场。',
  },
  {
    icon: ListVideo,
    title: '连播播放列表',
    desc: '把想看的视频丢进列表，播完自动接续下一集。',
  },
  {
    icon: Share2,
    title: '一键邀请',
    desc: '6 位房间码 + 邀请链接，发给朋友即可立刻入房。',
  },
]

const STEPS = [
  { icon: Plus, title: '创建房间', desc: '填一个房名和昵称，一键生成 6 位房间码' },
  { icon: Tv, title: '粘贴B站链接', desc: '支持 BV / av 号、完整链接、b23.tv 短链、分P' },
  { icon: MonitorSmartphone, title: '邀请好友', desc: '手机电脑输入房间码，进度自动同步' },
  { icon: Crown, title: '房主开看', desc: '房主点播放，大家一起看，随时拖进度' },
]

export function HomeView() {
  const { nickname, setNickname } = useUserStore()
  const { toast } = useToast()
  const [nick, setNick] = useState(nickname)
  const [roomName, setRoomName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [creating, setCreating] = useState(false)
  const [joining, setJoining] = useState(false)
  const [recents, setRecents] = useState<RecentRoom[]>([])

  /* 深色星空鼠标视差（spring 平滑；触屏无 mousemove 天然不生效） */
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const starX = useSpring(useTransform(mx, [-0.5, 0.5], [-12, 12]), { stiffness: 50, damping: 18 })
  const starY = useSpring(useTransform(my, [-0.5, 0.5], [-9, 9]), { stiffness: 50, damping: 18 })
  const glowX = useSpring(useTransform(mx, [-0.5, 0.5], [8, -8]), { stiffness: 40, damping: 20 })

  /* 读取最近房间（客户端挂载后） */
  useEffect(() => {
    setRecents(getRecentRooms())
  }, [])

  const saveNick = () => {
    const v = nick.trim().slice(0, 20)
    if (v) setNickname(v)
    return v
  }

  const handleCreate = async () => {
    const who = saveNick()
    if (!who) {
      toast({ title: '请先填写你的昵称', variant: 'destructive' })
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName.trim() || `${who}的观影房`, creatorName: who }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || '创建失败')
      window.location.hash = `#/room/${json.room.code}`
    } catch (err) {
      toast({ title: '创建房间失败', description: (err as Error).message, variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  const handleJoinByCode = async (code: string) => {
    const who = saveNick()
    if (!who) {
      toast({ title: '请先填写你的昵称', variant: 'destructive' })
      return
    }
    setJoining(true)
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || '房间不存在')
      window.location.hash = `#/room/${code}`
    } catch (err) {
      toast({ title: '加入房间失败', description: (err as Error).message, variant: 'destructive' })
      setJoining(false)
    }
  }

  const handleJoin = async () => {
    const who = saveNick()
    if (!who) {
      toast({ title: '请先填写你的昵称', variant: 'destructive' })
      return
    }
    const code = joinCode.trim().toUpperCase()
    if (code.length < 4) {
      toast({ title: '请输入正确的房间码', variant: 'destructive' })
      return
    }
    setJoining(true)
    try {
      const res = await fetch(`/api/rooms/${code}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || '房间不存在')
      window.location.hash = `#/room/${code}`
    } catch (err) {
      toast({ title: '加入房间失败', description: (err as Error).message, variant: 'destructive' })
      setJoining(false)
    }
  }

  return (
    <div
      className="relative flex min-h-screen flex-col overflow-x-clip bg-gradient-to-b from-[#fff7f8] via-white to-[#fff2f4] dark:from-[#161014] dark:via-[#0c0c0e] dark:to-[#151013]"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        mx.set((e.clientX - r.left) / r.width - 0.5)
        my.set((e.clientY - r.top) / r.height - 0.5)
      }}
    >
      {/* 深色氛围层：星空（鼠标视差）+ 粉色辉光（反向微移）+ 噪点（仅深色主题可见，fixed 覆盖全页，不拦截交互） */}
      <div className="pointer-events-none fixed inset-0 z-0 hidden dark:block">
        <motion.div style={{ x: starX, y: starY }} className="bt-stars absolute -inset-4" />
        <motion.div
          style={{ x: glowX }}
          className="absolute -inset-4 [background:radial-gradient(ellipse_60%_40%_at_50%_-5%,rgba(251,114,153,0.16),transparent_70%),radial-gradient(ellipse_40%_30%_at_85%_20%,rgba(251,114,153,0.07),transparent_70%),radial-gradient(ellipse_35%_30%_at_8%_35%,rgba(251,114,153,0.06),transparent_70%)]"
        />
        <div className="bt-noise absolute inset-0 opacity-[0.04]" />
      </div>

      {/* 顶部导航 */}
      <header className="sticky top-0 z-40 border-b border-[#fb7299]/10 bg-card/80 backdrop-blur-md dark:bg-[#161014]/80">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#fb7299] text-white shadow-sm shadow-[#fb7299]/40">
              <Clapperboard className="h-4.5 w-4.5" />
            </div>
            <span className="text-lg font-bold tracking-tight text-foreground">
              Bili<span className="text-[#fb7299]">Together</span>
            </span>
            <Badge variant="secondary" className="ml-1 hidden bg-[#fb7299]/10 text-[#e05a83] sm:inline-flex">
              B站一起看
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <a
              href="https://www.bilibili.com"
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground transition-colors hover:text-[#fb7299]"
            >
              去B站找片 →
            </a>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-4">
        {/* Hero */}
        <section className="flex flex-col items-center gap-6 py-14 text-center md:py-20">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <Badge variant="outline" className="mb-4 border-[#fb7299]/30 bg-card px-3 py-1 text-[#e05a83] shadow-sm dark:border-[#fb7299]/40 dark:bg-[#fb7299]/10 dark:shadow-[0_0_18px_rgba(251,114,153,0.25)]">
              <Sparkles className="mr-1 h-3.5 w-3.5" /> 和朋友云观影 · PC / 手机实时同步
            </Badge>
            <h1 className="text-4xl font-black leading-tight tracking-tight text-foreground md:text-6xl">
              B站视频，<span className="bt-shimmer-text text-[#fb7299]">一起看</span>才够味
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground md:text-lg">
              房主控制播放内容与进度，全员毫秒级同步。支持画质切换、弹幕开关、连播列表，
              手机电脑浏览器打开即用。
            </p>
          </motion.div>

          {/* 创建 / 加入 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="grid w-full max-w-3xl gap-4 md:grid-cols-2"
          >
            {/* 创建房间 */}
            <Card className="border-[#fb7299]/20 shadow-lg shadow-[#fb7299]/5 dark:border-[#fb7299]/30 dark:shadow-[0_8px_40px_-12px_rgba(251,114,153,0.25)]">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#fb7299] text-white shadow-sm shadow-[#fb7299]/50">
                    <Plus className="h-4 w-4" />
                  </span>
                  创建观影房
                </CardTitle>
                <CardDescription>你是房主，负责控制播放</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="你的昵称（必填）"
                  value={nick}
                  maxLength={20}
                  onChange={(e) => setNick(e.target.value)}
                />
                <Input
                  placeholder="房间名（默认：xx的观影房）"
                  value={roomName}
                  maxLength={30}
                  onChange={(e) => setRoomName(e.target.value)}
                />
                <Button
                  className="w-full bg-[#fb7299] text-white shadow-md shadow-[#fb7299]/30 transition-all hover:bg-[#f45d8b] hover:shadow-lg hover:shadow-[#fb7299]/40"
                  onClick={handleCreate}
                  disabled={creating}
                >
                  {creating ? '创建中…' : '立即创建'}
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </CardContent>
            </Card>

            {/* 加入房间 */}
            <Card className="shadow-lg shadow-black/5 dark:shadow-black/40">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-background">
                    <LogIn className="h-4 w-4" />
                  </span>
                  加入观影房
                </CardTitle>
                <CardDescription>输入好友给你的 6 位房间码</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="你的昵称（必填）"
                  value={nick}
                  maxLength={20}
                  onChange={(e) => setNick(e.target.value)}
                />
                <Input
                  placeholder="房间码，如 A3F9KQ"
                  value={joinCode}
                  maxLength={6}
                  className="font-mono text-lg font-bold tracking-[0.3em] uppercase"
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                />
                <Button variant="secondary" className="w-full" onClick={handleJoin} disabled={joining}>
                  {joining ? '加入中…' : '加入房间'}
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>

                {/* 最近房间快速重入 */}
                {recents.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <p className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                      <History className="h-3 w-3" /> 最近去过
                    </p>
                    {recents.map((r) => (
                      <div
                        key={r.code}
                        className="group flex items-center gap-2 rounded-lg border bg-muted/50 px-2.5 py-1.5 transition-colors hover:border-[#fb7299]/40 hover:bg-[#fb7299]/5"
                      >
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => void handleJoinByCode(r.code)}
                          disabled={joining}
                          title={`重新加入 ${r.name}`}
                        >
                          <span className="shrink-0 font-mono text-xs font-bold tracking-wider text-[#fb7299]">{r.code}</span>
                          <span className="truncate text-xs text-muted-foreground">{r.name}</span>
                        </button>
                        <button
                          className="shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-muted-foreground group-hover:opacity-100"
                          onClick={() => {
                            removeRecentRoom(r.code)
                            setRecents(getRecentRooms())
                          }}
                          aria-label={`删除记录 ${r.code}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </section>

        <Separator className="bg-[#fb7299]/10" />

        {/* 特性 */}
        <section className="py-14">
          <h2 className="mb-8 text-center text-2xl font-bold text-foreground md:text-3xl">为什么选择 BiliTogether？</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.05 }}
              >
                <Card className="h-full border transition-all hover:-translate-y-1 hover:border-[#fb7299]/40 hover:shadow-lg hover:shadow-[#fb7299]/10">
                  <CardContent className="flex h-full flex-col gap-3 p-6">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#fb7299]/10 text-[#fb7299]">
                      <f.icon className="h-5 w-5" />
                    </span>
                    <h3 className="font-bold text-foreground">{f.title}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{f.desc}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>

        {/* 使用步骤 */}
        <section className="pb-14">
          <h2 className="mb-8 text-center text-2xl font-bold text-foreground md:text-3xl">四步开看</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <motion.div
                key={s.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.06 }}
                className="relative rounded-xl border bg-card p-5"
              >
                <span className="absolute -top-3 -left-2 flex h-7 w-7 items-center justify-center rounded-full bg-[#fb7299] text-xs font-bold text-white shadow-md shadow-[#fb7299]/30">
                  {i + 1}
                </span>
                <s.icon className="mb-3 h-6 w-6 text-[#fb7299]" />
                <h3 className="mb-1 font-bold text-foreground">{s.title}</h3>
                <p className="text-sm text-muted-foreground">{s.desc}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* 小贴士 */}
        <section className="pb-16">
          <Card className="border-[#fb7299]/20 bg-gradient-to-r from-[#fff7f8] to-white dark:from-[#fb7299]/10 dark:to-transparent">
            <CardContent className="flex items-start gap-3 p-5">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#fb7299]" />
              <div className="text-sm leading-relaxed text-muted-foreground">
                <p className="mb-1 font-semibold text-foreground">画质小贴士</p>
                <p>
                  播放器使用B站官方外链，清晰度与浏览器中的B站登录态相关：
                  未登录最高 720P/1080P，登录B站后可解锁更高清晰度。房主切换画质后全员自动生效。
                  为保证同步体验，请尽量使用房主控制栏操作进度，不要在播放器内手动拖动。
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>

      {/* Sticky Footer */}
      <footer className="relative z-10 mt-auto border-t border-[#fb7299]/10 bg-card/70 py-5 backdrop-blur dark:bg-[#161014]/70">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <Clapperboard className="h-4 w-4 text-[#fb7299]" />
            <span>
              BiliTogether · 视频内容与播放能力来自 <a className="underline decoration-[#fb7299]/40 underline-offset-2 hover:text-[#fb7299]" href="https://www.bilibili.com" target="_blank" rel="noreferrer">bilibili</a>
            </span>
          </div>
          <span>仅供学习交流 · 请遵守B站用户协议</span>
        </div>
      </footer>
    </div>
  )
}
