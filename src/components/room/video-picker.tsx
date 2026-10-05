'use client'

import { useMemo, useState } from 'react'
import {
  Link2,
  Loader2,
  PlayCircle,
  ListPlus,
  LinkIcon,
  Pencil,
  Music,
  FolderOpen,
  X,
  ListChecks,
  Crown,
  TriangleAlert,
  Ban,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import { formatTime } from '@/lib/bili'
import type { BiliVideoMeta } from '@/lib/bili'
import type { ControlAction, PlaylistItem } from '@/lib/room-types'

interface VideoPickerProps {
  sendControl: (payload: ControlAction) => Promise<{ ok: boolean; error?: string; added?: number; skipped?: number; dropped?: number }>
  /** 成员投稿入口（需房主审核后才会进入播放队列） */
  sendSubmit: (video: Omit<PlaylistItem, 'id'>) => Promise<{ ok: boolean; error?: string; pending?: boolean; duplicated?: boolean }>
  isOwner: boolean
  /** 房间设置：是否允许成员投稿（房主关闭后成员侧显示关闭提示；房主不受限） */
  submitAllowed?: boolean
  onAdded: () => void
}

/** 收藏夹/合集解析结果（/api/bili/favlist） */
interface FavListResult {
  kind: 'favlist' | 'season'
  id: string
  title: string
  total: number
  fetched: number
  owner?: string | null
  riskControlled?: boolean
  videos: { bvid: string; title: string; cover: string | null; upName: string | null; duration: number }[]
}

/** 批量导入候选（收藏夹抓取或多行链接解析共用） */
interface ImportCandidate {
  bvid: string
  title: string
  cover: string | null
  upName: string | null
  duration: number
  /** 解析失败占位（默认不勾选，展示失败原因） */
  failed?: boolean
  failReason?: string
}

/** 播放列表服务端容量上限 */
const PLAYLIST_CAP = 50
/** 多行批量解析单次上限 */
const MAX_BATCH = 20

/** 客户端预判：输入是否像收藏夹/合集链接（与服务端正则保持一致） */
function looksLikeFavInput(input: string): boolean {
  const v = input.trim()
  if (!v) return false
  if (/^\d{4,20}$/.test(v)) return true
  if (/space\.bilibili\.com\/\d+/i.test(v) && (/[?&]fid=\d+/i.test(v) || /[?&]sid=\d+/i.test(v) || /\/lists\/\d+/i.test(v))) {
    return true
  }
  return false
}

/** 拆分批量输入：换行 / 中英文逗号 / 分号 / 空白分隔（粘贴到 input 时换行会被浏览器转为空格） */
function splitBatchInput(raw: string): string[] {
  return raw
    .split(/[\n\r,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 选片/点播：粘贴链接 → 解析 → 房主：立即播放/加入列表；成员：投稿（房主审核后进入队列）
 *  批量能力：收藏夹/合集链接自动抓取 + 多行链接逐个解析，统一勾选预览、一键入列（房主） */
export function VideoPicker({ sendControl, sendSubmit, isOwner, submitAllowed = true, onAdded }: VideoPickerProps) {
  const { toast } = useToast()
  const [input, setInput] = useState('')
  const [resolving, setResolving] = useState(false)
  const [video, setVideo] = useState<BiliVideoMeta | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [editableTitle, setEditableTitle] = useState('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)

  // 批量导入状态（收藏夹 / 多行粘贴共用）
  const [fav, setFav] = useState<FavListResult | null>(null)
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [importing, setImporting] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)

  const selectedCount = selected.size

  /** 收藏夹头部说明（数量截断提示） */
  const favHint = useMemo(() => {
    if (!fav || fav.riskControlled) return null
    if (fav.fetched < fav.total) return `收藏夹共 ${fav.total} 个视频，已获取前 ${fav.fetched} 个`
    return null
  }, [fav])

  const closeBatch = () => {
    setFav(null)
    setCandidates([])
    setSelected(new Set())
  }

  /** 逐个解析链接 → 候选列表（4 路并发池提速；失败项保留占位并标记） */
  const resolveBatchLinks = async (tokens: string[]) => {
    const batch = tokens.slice(0, MAX_BATCH)
    const results: ImportCandidate[] = new Array(batch.length)
    let done = 0
    let cursor = 0
    const resolveOne = async (i: number) => {
      const token = batch[i]
      try {
        const res = await fetch(`/api/bili/resolve?input=${encodeURIComponent(token)}`)
        const json = await res.json()
        if (!res.ok || !json?.video?.bvid) throw new Error(json?.error || '未能识别')
        const v = json.video as BiliVideoMeta
        const dur = v.pages.length > 0 ? v.pages.find((p) => p.page === (v.page || 1))?.duration || v.duration : v.duration
        results[i] = {
          bvid: v.bvid,
          title: (v.title || v.bvid) + (v.pages.length > 1 && (v.page || 1) > 1 ? ` P${v.page}` : ''),
          cover: v.cover,
          upName: v.upName,
          duration: dur,
        }
      } catch (err) {
        results[i] = { bvid: token, title: token, cover: null, upName: null, duration: 0, failed: true, failReason: (err as Error).message }
      }
      done += 1
      setBatchProgress({ done, total: batch.length })
    }
    // 固定大小并发池：4 路并行（resolve API 含 reader 降级链路，不宜全量并发）
    const CONCURRENCY = 4
    const workers = Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
      while (cursor < batch.length) {
        const i = cursor++
        await resolveOne(i)
      }
    })
    await Promise.all(workers)
    setBatchProgress(null)
    setCandidates(results)
    setSelected(new Set(results.map((r, i) => (r.failed ? -1 : i)).filter((i) => i >= 0)))
  }

  const resolve = async () => {
    const v = input.trim()
    if (!v) return
    setResolving(true)
    setVideo(null)
    closeBatch()
    try {
      // 路径一：收藏夹/合集链接
      if (looksLikeFavInput(v)) {
        const res = await fetch(`/api/bili/favlist?input=${encodeURIComponent(v)}`)
        const json = (await res.json()) as FavListResult & { error?: string }
        if (!res.ok) throw new Error(json?.error || '收藏夹解析失败')
        if (json.riskControlled) {
          toast({
            title: `识别到收藏夹《${json.title}》（共 ${json.total} 个视频）`,
            description: '当前网络环境被B站风控，无法自动获取列表；可以把视频链接多行粘贴到这里批量导入 👇',
            duration: 9000,
          })
          setInput('')
          return
        }
        setFav(json)
        setCandidates(json.videos)
        setSelected(new Set(json.videos.map((_, i) => i)))
        setInput('')
        return
      }

      // 路径二：多行/多条批量粘贴
      const tokens = splitBatchInput(v)
      if (tokens.length > 1) {
        if (tokens.length > MAX_BATCH) {
          toast({ title: `一次最多批量解析 ${MAX_BATCH} 条`, description: `已截取前 ${MAX_BATCH} 条链接` })
        }
        setInput('')
        await resolveBatchLinks(tokens)
        return
      }

      // 路径三：单视频（保持原有交互）
      const res = await fetch(`/api/bili/resolve?input=${encodeURIComponent(v)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || '解析失败')
      setVideo(json.video)
      setDegraded(!!json.degraded)
      setEditableTitle(json.video.title || '')
      setPage(json.video.page || 1)
      setInput('')
    } catch (err) {
      toast({ title: '解析失败', description: (err as Error).message, variant: 'destructive' })
    } finally {
      setResolving(false)
    }
  }

  const videoPayload = () =>
    video
      ? {
          bvid: video.bvid,
          page,
          title: (editableTitle.trim() || video.title) + (video.pages.length > 1 && page > 1 ? ` P${page}` : ''),
          cover: video.cover,
          upName: video.upName,
          duration: video.pages.length > 0 ? video.pages.find((p) => p.page === page)?.duration || video.duration : video.duration,
          addedBy: '',
        }
      : null

  const playNow = async () => {
    const payload = videoPayload()
    if (!payload) return
    setBusy(true)
    await sendControl({ action: 'setVideo', video: payload })
    // 同时加入列表方便连播
    await sendControl({ action: 'addPlaylistItem', video: payload })
    setVideo(null)
    setBusy(false)
    onAdded()
  }

  const addToList = async () => {
    const payload = videoPayload()
    if (!payload) return
    setBusy(true)
    if (isOwner) {
      const res = await sendControl({ action: 'addPlaylistItem', video: payload })
      setVideo(null)
      setBusy(false)
      onAdded()
      if (res?.ok) toast({ title: '已加入播放列表 📀' })
    } else {
      const res = await sendSubmit(payload)
      setVideo(null)
      setBusy(false)
      onAdded()
      if (res?.ok) {
        // 标题截断到 16 字符，避免 toast 过长
        const shortTitle = payload.title.length > 16 ? `${payload.title.slice(0, 16)}…` : payload.title
        toast(
          res.duplicated
            ? { title: `列表里已经有《${shortTitle}》啦 🎵` }
            : { title: `《${shortTitle}》投稿成功，等待房主审核 🎵`, description: '审核通过后将自动进入播放队列' }
        )
      } else if (res?.error) {
        toast({ title: '投稿失败', description: res.error, variant: 'destructive' })
      }
    }
  }

  /** 成员投稿是否被房间设置关闭（房主不受限） */
  const submitBlocked = !isOwner && !submitAllowed

  /** 批量导入选中项（仅房主）：一次 socket 动作入列，服务端整批去重 */
  const importSelected = async () => {
    if (selectedCount === 0) return
    setImporting(true)
    try {
      const videos = candidates
        .filter((c, i) => selected.has(i) && !c.failed)
        .map((c) => ({ ...c, page: 1, addedBy: '' }))
      if (videos.length === 0) return
      const source = fav && !fav.riskControlled ? fav.title : ''
      const res = await sendControl({ action: 'addPlaylistItems', videos, source })
      if (res?.ok) {
        const parts: string[] = []
        if (res.added) parts.push(`成功导入 ${res.added} 个`)
        if (res.skipped) parts.push(`跳过重复 ${res.skipped} 个`)
        if (res.dropped) parts.push(`${res.dropped} 个超出容量未导入`)
        const shownTitle = source && source.length > 14 ? `${source.slice(0, 14)}…` : source
        toast({
          title: parts.length > 0 ? `批量导入完成 📀${shownTitle ? ` · ${shownTitle}` : ''}` : '没有导入新视频',
          description: parts.join(' · '),
        })
        closeBatch()
        onAdded()
      } else {
        toast({ title: '导入失败', description: res?.error || '请稍后重试', variant: 'destructive' })
      }
    } finally {
      setImporting(false)
    }
  }

  const toggleAll = () => {
    const selectable = candidates.map((c, i) => (c.failed ? -1 : i)).filter((i) => i >= 0)
    setSelected(selectedCount === selectable.length ? new Set() : new Set(selectable))
  }

  const toggleOne = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  /** 是否处于批量预览态（收藏夹或多行解析结果） */
  const batchMode = candidates.length > 0
  const failedCount = candidates.filter((c) => c.failed).length

  return (
    <div className="rounded-xl border border-surface-border bg-surface/80 p-3 backdrop-blur sm:p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-surface-muted-foreground">
        {isOwner ? (
          <>
            <ListPlus className="h-3.5 w-3.5 text-[#fb7299]" />
            房主选片：单个视频 / 多行链接批量 / 收藏夹合集一键导入
          </>
        ) : submitBlocked ? (
          <>
            <Ban className="h-3.5 w-3.5 text-surface-muted-foreground" />
            房主已关闭成员投稿，如需点播请联系房主 🙏
          </>
        ) : (
          <>
            <Music className="h-3.5 w-3.5 text-[#fb7299]" />
            点播台：投稿后由房主审核，通过即进入播放队列 🎵
          </>
        )}
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <LinkIcon className="absolute top-3 left-3 h-4 w-4 -translate-y-1/2 text-surface-muted-foreground" />
          <Input
            value={input}
            placeholder={submitBlocked ? '成员投稿已由房主关闭' : '视频链接 / BV号 / 收藏夹链接 / 多行批量粘贴'}
            className="border-surface-border bg-surface-2 pl-9 text-surface-foreground placeholder:text-surface-muted-foreground focus-visible:ring-[#fb7299]"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && resolve()}
            disabled={resolving || submitBlocked}
          />
        </div>
        <Button
          className="shrink-0 bg-[#fb7299] hover:bg-[#f45d8b]"
          onClick={resolve}
          disabled={resolving || !input.trim() || submitBlocked}
        >
          {resolving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Link2 className="mr-1 h-4 w-4" />}
          {resolving ? (batchProgress ? `解析中 ${batchProgress.done}/${batchProgress.total}` : '解析中') : '解析'}
        </Button>
      </div>

      {submitBlocked && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-surface-border bg-surface-2/60 px-3 py-2.5 text-xs text-surface-muted-foreground">
          <Ban className="h-4 w-4 shrink-0" />
          点播台暂时关闭中 —— 房主可在右上角「房间设置」里重新开启成员投稿
        </div>
      )}

      {/* 批量导入卡片（收藏夹抓取 / 多行解析共用） */}
      {batchMode && (
        <div className="mt-3 overflow-hidden rounded-lg border border-[#fb7299]/25 bg-[#fb7299]/5">
          {/* 头部：来源信息 */}
          <div className="flex items-center gap-2 border-b border-[#fb7299]/15 bg-gradient-to-r from-[#fb7299]/12 to-transparent px-3 py-2.5">
            <FolderOpen className="h-4 w-4 shrink-0 text-[#fb7299]" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-surface-foreground">
                  {fav ? fav.title : '批量链接解析'}
                </span>
                {fav && (
                  <Badge variant="secondary" className="h-4 shrink-0 border-transparent bg-[#fb7299]/15 px-1.5 text-[10px] text-[#fb7299]">
                    {fav.kind === 'favlist' ? '收藏夹' : '合集'}
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-[11px] text-surface-muted-foreground">
                {fav ? (
                  <>
                    已获取 {fav.fetched}/{fav.total} 个视频
                    {fav.owner ? ` · UP主 ${fav.owner}` : ''}
                    {favHint ? ` · ${favHint}` : ''}
                  </>
                ) : (
                  <>
                    共 {candidates.length} 条链接
                    {failedCount > 0 ? ` · ${failedCount} 条解析失败（可取消勾选）` : ''}
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              aria-label="关闭批量预览"
              className="rounded-md p-1 text-surface-muted-foreground transition-colors hover:bg-surface-3 hover:text-surface-foreground"
              onClick={closeBatch}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* 预览列表：可滚动 + 勾选 */}
          <div className="bt-scroll max-h-56 overflow-y-auto">
            {candidates.map((c, i) => (
              <label
                key={`${c.bvid}-${i}`}
                className={`flex cursor-pointer items-center gap-2 border-b border-surface-border/40 px-3 py-2 transition-colors last:border-b-0 hover:bg-surface-3/50 ${c.failed ? 'opacity-60' : ''}`}
              >
                <Checkbox
                  checked={selected.has(i)}
                  onCheckedChange={() => toggleOne(i)}
                  disabled={c.failed}
                  aria-label={c.failed ? `《${c.title}》解析失败` : `选择《${c.title}》`}
                  className="data-[state=checked]:border-[#fb7299] data-[state=checked]:bg-[#fb7299] data-[state=checked]:text-white"
                />
                <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-surface-muted-foreground">{i + 1}</span>
                {c.cover ? (
                  <img
                    src={c.cover}
                    alt=""
                    className="hidden h-8 w-14 shrink-0 rounded object-cover sm:block"
                    referrerPolicy="no-referrer"
                    loading="lazy"
                  />
                ) : (
                  <div className="hidden h-8 w-14 shrink-0 rounded bg-surface-3 sm:block" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-surface-foreground" title={c.title}>
                    {c.title}
                  </span>
                  {c.failed && (
                    <span className="flex items-center gap-1 text-[10px] text-red-400/90">
                      <TriangleAlert className="h-3 w-3" />
                      {c.failReason || '解析失败'}
                    </span>
                  )}
                </span>
                {!c.failed && c.upName && (
                  <span className="hidden shrink-0 text-[11px] text-surface-muted-foreground md:inline">{c.upName}</span>
                )}
                {!c.failed && c.duration > 0 && (
                  <span className="shrink-0 text-[11px] tabular-nums text-surface-muted-foreground">{formatTime(c.duration)}</span>
                )}
              </label>
            ))}
          </div>

          {/* 底部操作条 */}
          <div className="flex flex-wrap items-center gap-2 border-t border-[#fb7299]/15 bg-surface/60 px-3 py-2.5">
            <button
              type="button"
              onClick={toggleAll}
              className="flex items-center gap-1.5 text-xs text-surface-muted-foreground transition-colors hover:text-surface-foreground"
            >
              <ListChecks className="h-3.5 w-3.5" />
              {selectedCount === candidates.filter((c) => !c.failed).length && selectedCount > 0 ? '取消全选' : '全选'}
            </button>
            <span className="text-xs text-surface-muted-foreground">
              已选 <span className="font-semibold text-[#fb7299]">{selectedCount}</span> / {candidates.filter((c) => !c.failed).length}
            </span>
            {isOwner ? (
              <Button
                size="sm"
                className="ml-auto bg-[#fb7299] hover:bg-[#f45d8b]"
                onClick={importSelected}
                disabled={importing || selectedCount === 0}
              >
                {importing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ListPlus className="mr-1 h-3.5 w-3.5" />}
                {importing ? '导入中…' : `导入选中 ${selectedCount} 个`}
              </Button>
            ) : (
              <span className="ml-auto flex items-center gap-1 text-[11px] text-surface-muted-foreground">
                <Crown className="h-3.5 w-3.5 text-amber-400" />
                批量导入仅房主可用 · 成员可逐个粘贴链接投稿
              </span>
            )}
          </div>
          <p className="bg-surface/60 px-3 pb-2 text-[10px] text-surface-muted-foreground/70">
            播放列表最多保留 {PLAYLIST_CAP} 条，超出容量的视频不会被导入；已存在的视频自动跳过。
          </p>
        </div>
      )}

      {video && (
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-[#fb7299]/25 bg-[#fb7299]/5 p-3 sm:flex-row sm:items-center">
          {video.cover && (
            <img
              src={video.cover}
              alt={video.title}
              className="h-20 w-full shrink-0 rounded-md object-cover sm:w-36"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <Pencil className="mt-2 h-3.5 w-3.5 shrink-0 text-surface-muted-foreground" />
              <Input
                value={editableTitle}
                onChange={(e) => setEditableTitle(e.target.value)}
                maxLength={120}
                className="h-8 border-transparent bg-transparent px-1 text-sm font-semibold text-surface-foreground hover:border-surface-border focus-visible:bg-surface-2 focus-visible:ring-[#fb7299]"
                placeholder="视频标题"
              />
            </div>
            <p className="mt-0.5 pl-6 text-xs text-surface-muted-foreground">
              {video.bvid ? `${video.bvid}` : ''}
              {video.pages.length > 1 ? ` · 共${video.pages.length}P` : ''}
              {video.duration > 0 ? ` · 时长 ${formatTime(video.duration)}` : ''}
            </p>
            {degraded && (
              <p className="mt-1 pl-6 text-[11px] text-amber-400/80">
                当前网络环境下视频信息获取受限，标题可手动编辑；播放不受影响。
              </p>
            )}
            {video.pages.length > 1 && (
              <div className="mt-2 flex items-center gap-2 pl-6">
                <span className="text-xs text-surface-muted-foreground">选择分P（共{video.pages.length}P）：</span>
                <Select value={String(page)} onValueChange={(v) => setPage(Number(v))}>
                  <SelectTrigger className="h-8 w-[240px] border-surface-border bg-surface-2 text-xs text-surface-foreground hover:bg-surface-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-surface-border bg-surface text-surface-foreground">
                    {video.pages.map((p) => (
                      <SelectItem key={p.page} value={String(p.page)}>
                        P{p.page} {p.part}（{formatTime(p.duration)}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            {isOwner && (
              <Button className="bg-[#fb7299] hover:bg-[#f45d8b]" onClick={playNow} disabled={busy}>
                <PlayCircle className="mr-1 h-4 w-4" /> 立即播放
              </Button>
            )}
            <Button
              variant={isOwner ? 'outline' : 'default'}
              className={isOwner ? 'border-surface-border bg-surface-2 text-surface-foreground hover:bg-surface-3' : 'bg-[#fb7299] hover:bg-[#f45d8b]'}
              onClick={addToList}
              disabled={busy}
            >
              {isOwner ? (
                <>
                  <ListPlus className="mr-1 h-4 w-4" /> 加入列表
                </>
              ) : (
                <>
                  <Music className="mr-1 h-4 w-4" /> 投稿点播
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
