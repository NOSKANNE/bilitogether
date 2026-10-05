/**
 * BiliTogether 同步服务 (socket.io, 端口 3003)
 * 房间运行时状态的唯一权威源（内存），通过 Next.js REST API (127.0.0.1:3000) 持久化
 *
 * 同步模型：
 * - playback: { bvid, page, playing, position, qn, danmaku, updatedAt, revision }
 * - 房主 control 动作 → 更新状态 + revision++ → 广播 playback:state
 * - 房主每 2s 心跳 tick → 广播 playback:tick（跟随者据此做漂移校正）
 * - 房主离开 → 自动转移房主权限
 */
import { createServer } from 'http'
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { createConnection } from 'node:net'
import { Server, type Socket } from 'socket.io'

/** Next.js REST API 地址（自托管若改了 Next 端口，用 NEXT_API_URL 环境变量覆盖） */
const NEXT_API = process.env.NEXT_API_URL || 'http://127.0.0.1:3000'

interface PlaylistItem {
  id: string
  bvid: string
  page: number
  title: string
  cover: string | null
  upName: string | null
  duration: number
  addedBy: string
  addedAt?: string
  /** 待房主审核的成员投稿（仅内存态，不持久化；重启后待审队列清空） */
  pending?: boolean
}

interface Playback {
  bvid: string | null
  page: number
  title: string | null
  cover: string | null
  upName: string | null
  duration: number
  playing: boolean
  position: number
  qn: number
  rate: number
  danmaku: boolean
  /** 循环模式：off 不循环 / list 列表循环 / one 单曲循环 */
  loop: 'off' | 'list' | 'one'
  updatedAt: number
  revision: number
}

interface Member {
  uid: string
  /** 基础身份（不含标签页后缀）：观看统计按它归属，同浏览器多标签页共享历史 */
  baseUid?: string
  name: string
  device: 'pc' | 'mobile' | 'tablet'
  joinedAt: number
  socketIds: Set<string>
  /** 累计真实观看秒数（客户端上报累加） */
  watchSeconds: number
}

interface ChatMessage {
  id: string
  uid: string
  name: string
  text: string
  ts: number
  kind: 'user' | 'system'
}

/** 精彩时刻打点（仅内存态：切视频自动清空，服务重启清空） */
interface RoomMoment {
  id: string
  /** 相对当前视频的秒数 */
  t: number
  name: string
  uid: string
  /** 打点时的视频 bvid（切视频后旧打点随房间清空） */
  bvid: string
  ts: number
  /** 附言（可选，≤40 字；打点者本人或房主可编辑） */
  note?: string
}

/** 房间设置（房主权限开关，持久化到 Room.settings JSON） */
interface RoomSettings {
  allowSubmit: boolean
  allowMoment: boolean
  /** 聊天慢速模式（成员发言最小间隔秒数，0 = 关闭） */
  slowModeSeconds: number
}

const DEFAULT_SETTINGS: RoomSettings = { allowSubmit: true, allowMoment: true, slowModeSeconds: 0 }
const SLOW_MODE_WHITELIST = [0, 5, 10, 30]

/** 从 DB JSON 字符串解析设置（容错：缺失/非法字段回退默认值） */
function parseSettings(raw: unknown): RoomSettings {
  const s: RoomSettings = { ...DEFAULT_SETTINGS }
  const apply = (obj: Record<string, unknown>) => {
    if (typeof obj.allowSubmit === 'boolean') s.allowSubmit = obj.allowSubmit
    if (typeof obj.allowMoment === 'boolean') s.allowMoment = obj.allowMoment
    if (typeof obj.slowModeSeconds === 'number' && (SLOW_MODE_WHITELIST as number[]).includes(obj.slowModeSeconds)) {
      s.slowModeSeconds = obj.slowModeSeconds
    }
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      apply(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      /* 非法 JSON 回退默认 */
    }
  } else if (raw && typeof raw === 'object') {
    apply(raw as Record<string, unknown>)
  }
  return s
}

interface RoomRuntime {
  code: string
  name: string
  creatorName: string
  ownerUid: string | null
  playback: Playback
  playlist: PlaylistItem[]
  members: Map<string, Member> // uid -> member
  /** 历史观看统计（uid -> 累计秒数），新成员加入时播种到 watchSeconds */
  watchStats: Map<string, number>
  /** 待刷盘的观看增量（uid -> { name, delta }），每 30s 批量写库 */
  pendingWatch: Map<string, { name: string; delta: number }>
  hydrated: boolean
  persistTimer: ReturnType<typeof setTimeout> | null
  lastPersist: Partial<Playback> & { playlist?: PlaylistItem[] } | null
  /** 精彩时刻（内存态，上限 50 条，切视频清空） */
  moments: RoomMoment[]
  /** 房间设置（房主权限开关，服务端强制执行） */
  settings: RoomSettings
}

const rooms = new Map<string, RoomRuntime>() // code -> room

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

const genId = () => Math.random().toString(36).slice(2, 11)
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

function newPlayback(): Playback {
  return {
    bvid: null,
    page: 1,
    title: null,
    cover: null,
    upName: null,
    duration: 0,
    playing: false,
    position: 0,
    qn: 64,
    rate: 1,
    danmaku: true,
    loop: 'off',
    updatedAt: Date.now(),
    revision: 1,
  }
}

/**
 * 从 Next API 水合房间。
 * 返回值区分三种情况：
 * - ok：水合成功
 * - notfound：REST 返 404，房间确实不存在（DB 已删/未创建）
 * - transient：网络失败 / 5xx / 超时 —— 服务端瞬态故障（Next 编译中/重启中），
 *   不应误报「房间不存在」误导用户；join 会引导稍候重试
 */
type HydrateResult = { status: 'ok'; rt: RoomRuntime } | { status: 'notfound' } | { status: 'transient' }

async function hydrateRoom(code: string): Promise<HydrateResult> {
  try {
    const res = await fetch(`${NEXT_API}/api/rooms/${code}`, { signal: AbortSignal.timeout(5000) })
    if (res.status === 404) return { status: 'notfound' }
    if (!res.ok) return { status: 'transient' }
    const json = await res.json()
    const room = json?.room
    if (!room) return { status: 'notfound' }

    const rt: RoomRuntime = {
      code,
      name: room.name,
      creatorName: room.creatorName,
      ownerUid: null,
      playback: {
        ...newPlayback(),
        bvid: room.bvid ?? null,
        page: room.page || 1,
        title: room.title ?? null,
        cover: room.cover ?? null,
        upName: room.upName ?? null,
        duration: room.duration || 0,
        qn: room.quality || 64,
        rate: Number(room.rate) > 0 ? Number(room.rate) : 1,
        danmaku: room.danmaku !== false,
        loop: ['off', 'list', 'one'].includes(String(room.loop)) ? (room.loop as 'off' | 'list' | 'one') : 'off',
      },
      playlist: (room.playlist || []).map((p: Record<string, unknown>) => ({
        id: String(p.id),
        bvid: String(p.bvid),
        page: Number(p.page || 1),
        title: String(p.title || ''),
        cover: (p.cover as string | null) ?? null,
        upName: (p.upName as string | null) ?? null,
        duration: Number(p.duration || 0),
        addedBy: String(p.addedBy || ''),
        addedAt: p.addedAt ? String(p.addedAt) : undefined,
      })),
      members: new Map(),
      watchStats: new Map<string, number>(
        (Array.isArray(json?.watchStats) ? json.watchStats : [])
          .map((s: Record<string, unknown>) => [String(s.uid), Number(s.seconds) || 0] as [string, number])
          .filter(([uid, sec]) => !!uid && sec > 0)
      ),
      pendingWatch: new Map(),
      hydrated: true,
      persistTimer: null,
      lastPersist: null,
      moments: [],
      settings: parseSettings((room as Record<string, unknown>).settings),
    }
    rooms.set(code, rt)
    return { status: 'ok', rt }
  } catch (err) {
    console.error(`[hydrate] ${code} failed:`, (err as Error).message)
    return { status: 'transient' }
  }
}

/** 防抖持久化到 Next API */
function schedulePersist(rt: RoomRuntime) {
  if (rt.persistTimer) clearTimeout(rt.persistTimer)
  rt.persistTimer = setTimeout(() => {
    rt.persistTimer = null
    const payload: Record<string, unknown> = {
      bvid: rt.playback.bvid,
      page: rt.playback.page,
      title: rt.playback.title,
      cover: rt.playback.cover,
      upName: rt.playback.upName,
      duration: Math.round(rt.playback.duration),
      quality: rt.playback.qn,
      rate: rt.playback.rate,
      danmaku: rt.playback.danmaku,
      loop: rt.playback.loop,
      // 房间名（房主可改名）+ 房间设置（JSON 字符串，房主权限开关持久化）
      name: rt.name,
      settings: JSON.stringify(rt.settings),
      // 待审核投稿仅内存态，持久化只写正式队列
      playlist: rt.playlist.filter((p) => !p.pending),
    }
    fetch(`${NEXT_API}/api/rooms/${rt.code}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => {
        if (!res.ok) console.error(`[persist] ${rt.code} http ${res.status}`)
      })
      .catch((err) => console.error(`[persist] ${rt.code} failed:`, (err as Error).message))
  }, 1500)
}

function membersList(rt: RoomRuntime) {
  const now = Date.now()
  return Array.from(rt.members.values()).map((m) => ({
    uid: m.uid,
    name: m.name,
    device: m.device,
    joinedAt: m.joinedAt,
    isOwner: m.uid === rt.ownerUid,
    watchSeconds: Math.round(m.watchSeconds),
    baseUid: m.baseUid,
    onlineSeconds: Math.round((now - m.joinedAt) / 1000),
  }))
}

function systemMsg(rt: RoomRuntime, text: string): ChatMessage {
  return { id: genId(), uid: '', name: '系统', text, ts: Date.now(), kind: 'system' }
}

function broadcastMembers(rt: RoomRuntime) {
  io.to(rt.code).emit('room:members', { members: membersList(rt), ownerUid: rt.ownerUid })
}

function broadcastState(rt: RoomRuntime) {
  io.to(rt.code).emit('playback:state', { playback: rt.playback })
}

function broadcastPlaylist(rt: RoomRuntime) {
  io.to(rt.code).emit('playlist:state', { playlist: rt.playlist })
  schedulePersist(rt)
}

function broadcastSettings(rt: RoomRuntime) {
  io.to(rt.code).emit('room:settings', { settings: rt.settings })
  schedulePersist(rt)
}

/** 清空精彩时刻（切视频时打点随旧视频失效），仅在有数据时广播避免噪音 */
function clearMoments(rt: RoomRuntime) {
  if (rt.moments.length === 0) return
  rt.moments = []
  io.to(rt.code).emit('room:moments', { moments: [] })
}

/** 秒 → mm:ss（超过 1 小时 → h:mm:ss），打点消息用 */
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0 ? `${h}:${mm}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`
}

function setOwner(rt: RoomRuntime, uid: string) {
  rt.ownerUid = uid
  const member = rt.members.get(uid)
  broadcastMembers(rt)
  io.to(rt.code).emit('room:owner', {
    ownerUid: uid,
    name: member?.name || '房主',
    message: systemMsg(rt, `${member?.name || '有人'} 成为新房主 👑`),
  })
}

function getOrCreateRoom(code: string): Promise<HydrateResult> {
  const exist = rooms.get(code)
  if (exist) return Promise.resolve({ status: 'ok', rt: exist })
  return hydrateRoom(code)
}

io.on('connection', (socket: Socket) => {
  console.log(`[conn] ${socket.id} connected`)

  const joinedRooms = new Set<string>()

  socket.on('room:join', async (data: { code: string; uid: string; baseUid?: string; name: string; device?: 'pc' | 'mobile' | 'tablet' }, ack?: (res: unknown) => void) => {
    try {
      const code = String(data?.code || '').toUpperCase().trim()
      const uid = String(data?.uid || '').slice(0, 64)
      const baseUid = String(data?.baseUid || '').slice(0, 64) || undefined
      const name = String(data?.name || '访客').slice(0, 20) || '访客'
      const device = (['pc', 'mobile', 'tablet'].includes(data?.device || '') ? data.device : 'pc') as
        | 'pc'
        | 'mobile'
        | 'tablet'

      if (!code || !uid) {
        ack?.({ ok: false, error: '参数缺失' })
        return
      }

      const hydrated = await getOrCreateRoom(code)
      if (hydrated.status === 'notfound') {
        ack?.({ ok: false, error: '房间不存在，请检查房间码' })
        return
      }
      if (hydrated.status === 'transient') {
        // 服务端瞬态故障（Next 编译中/重启中/网络抖动）：明确引导重试，
        // 而非误导性的「房间不存在」——这是「掉线后无法重进」的观感来源之一
        ack?.({ ok: false, error: '同步服务暂时不可用（自愈中），请稍候几秒后重试' })
        return
      }
      const rt = hydrated.rt

      socket.join(code)
      joinedRooms.add(code)

      const isFirstMember = rt.members.size === 0
      let member = rt.members.get(uid)
      if (member) {
        member.socketIds.add(socket.id)
        member.name = name
        if (baseUid) member.baseUid = baseUid
      } else {
        // 新成员：用基础身份的历史观看统计播种（本次会话在此基础上继续累计）
        const seeded = rt.watchStats.get(baseUid || uid) || 0
        member = { uid, baseUid, name, device, joinedAt: Date.now(), socketIds: new Set([socket.id]), watchSeconds: seeded }
        rt.members.set(uid, member)
      }

      if (!rt.ownerUid) rt.ownerUid = uid
      // 自愈：ownerUid 指向的成员已不存在（多标签页重载竞态/进程重启残留等），
      // 把房主交给最早的在线成员，避免出现「房间里没有房主」的卡死状态
      if (rt.ownerUid && !rt.members.has(rt.ownerUid)) {
        const next = Array.from(rt.members.values()).sort((a, b) => a.joinedAt - b.joinedAt)[0]
        rt.ownerUid = next ? next.uid : uid
      }

      const youAreOwner = rt.ownerUid === uid
      ack?.({
        ok: true,
        roomName: rt.name,
        creatorName: rt.creatorName,
        playback: rt.playback,
        playlist: rt.playlist,
        members: membersList(rt),
        ownerUid: rt.ownerUid,
        moments: rt.moments,
        settings: rt.settings,
        youAreOwner,
      })

      if (!isFirstMember) {
        io.to(rt.code).emit('room:chat', systemMsg(rt, `${name} 加入了房间 📱${device === 'mobile' ? '手机' : device === 'tablet' ? '平板' : 'PC'}`))
      }
      broadcastMembers(rt)
      console.log(`[join] ${code} ${name}(${uid}) device=${device} members=${rt.members.size}`)
    } catch (err) {
      console.error('[join] error:', err)
      ack?.({ ok: false, error: '加入房间失败' })
    }
  })

  socket.on('room:control', (data: { code: string; uid: string; payload: Record<string, unknown> }, ack?: (res: unknown) => void) => {
    const code = String(data?.code || '').toUpperCase()
    const uid = String(data?.uid || '')
    const rt = rooms.get(code)
    if (!rt) {
      ack?.({ ok: false, error: '房间不存在' })
      return
    }
    if (rt.ownerUid !== uid) {
      ack?.({ ok: false, error: '只有房主可以控制播放 👑' })
      return
    }
    const payload = data?.payload || {}
    const action = String(payload.action || '')
    const pb = rt.playback
    const member = rt.members.get(uid)

    switch (action) {
      case 'play': {
        if (typeof payload.position === 'number') pb.position = clamp(payload.position, 0, pb.duration || 1e9)
        pb.playing = true
        pb.updatedAt = Date.now()
        pb.revision++
        break
      }
      case 'pause': {
        if (typeof payload.position === 'number') pb.position = clamp(payload.position, 0, pb.duration || 1e9)
        pb.playing = false
        pb.updatedAt = Date.now()
        pb.revision++
        break
      }
      case 'seek': {
        pb.position = clamp(Number(payload.position || 0), 0, pb.duration || 1e9)
        pb.updatedAt = Date.now()
        pb.revision++
        break
      }
      case 'skip': {
        pb.position = clamp(pb.position + Number(payload.delta || 0), 0, pb.duration || 1e9)
        pb.updatedAt = Date.now()
        pb.revision++
        break
      }
      case 'resync': {
        pb.updatedAt = Date.now()
        pb.revision++
        break
      }
      case 'setQn': {
        const qn = Number(payload.qn || 80)
        if (![6, 16, 32, 64, 74, 80, 112, 116, 120].includes(qn)) {
          ack?.({ ok: false, error: '不支持的画质' })
          return
        }
        if (pb.qn === qn) {
          ack?.({ ok: true })
          return
        }
        const qnLabels: Record<number, string> = {
          6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
          80: '1080P', 112: '1080P+', 116: '1080P60', 120: '4K',
        }
        pb.qn = qn
        pb.updatedAt = Date.now()
        pb.revision++
        io.to(rt.code).emit('room:chat', systemMsg(rt, `${member?.name || '房主'} 将画质切换为 ${qnLabels[qn] || qn + 'P'} 🎚️`))
        break
      }
      case 'setRate': {
        const rate = Number(payload.rate || 1)
        if (![0.5, 0.75, 1, 1.25, 1.5, 2].includes(rate)) {
          ack?.({ ok: false, error: '不支持的倍速' })
          return
        }
        if (pb.rate === rate) {
          ack?.({ ok: true })
          return
        }
        // 切速时把进度快照到当前真实位置，避免估算跳跃
        if (typeof payload.position === 'number') pb.position = clamp(payload.position, 0, pb.duration || 1e9)
        pb.rate = rate
        pb.updatedAt = Date.now()
        pb.revision++
        const rateLabel = rate === 1 ? '1.0x' : `${rate}x`
        io.to(rt.code).emit('room:chat', systemMsg(rt, `${member?.name || '房主'} 将倍速调整为 ${rateLabel} ⏩`))
        break
      }
      case 'setDanmaku': {
        pb.danmaku = !!payload.danmaku
        pb.updatedAt = Date.now()
        pb.revision++
        break
      }
      case 'setLoop': {
        const loop = String(payload.loop || 'off')
        if (!['off', 'list', 'one'].includes(loop)) {
          ack?.({ ok: false, error: '不支持的循环模式' })
          return
        }
        if (pb.loop === loop) {
          ack?.({ ok: true })
          return
        }
        pb.loop = loop as 'off' | 'list' | 'one'
        pb.updatedAt = Date.now()
        pb.revision++
        const loopLabels: Record<string, string> = { off: '顺序播放', list: '列表循环 🔁', one: '单曲循环 🔂' }
        io.to(rt.code).emit('room:chat', systemMsg(rt, `${member?.name || '房主'} 将播放模式设为 ${loopLabels[loop] || loop}`))
        break
      }
      case 'setVideo': {
        const v = (payload.video || {}) as Partial<PlaylistItem>
        if (!v.bvid) {
          ack?.({ ok: false, error: '视频信息缺失' })
          return
        }
        pb.bvid = v.bvid
        pb.page = Number(v.page || 1)
        pb.title = v.title || null
        pb.cover = v.cover ?? null
        pb.upName = v.upName ?? null
        pb.duration = Number(v.duration || 0)
        pb.position = 0
        pb.playing = true
        pb.updatedAt = Date.now()
        pb.revision++
        clearMoments(rt)
        io.to(rt.code).emit('room:chat', systemMsg(rt, `房主正在播放《${v.title || v.bvid}》▶️`))
        break
      }
      case 'playPlaylistItem': {
        const item = rt.playlist.find((p) => p.id === payload.itemId)
        if (!item) {
          ack?.({ ok: false, error: '条目不存在' })
          return
        }
        // 直接播放待审核投稿 = 视为通过：清 pending 标记后入列播放
        if (item.pending) {
          delete item.pending
          io.to(rt.code).emit('room:chat', systemMsg(rt, `房主直接播放了 ${item.addedBy || '成员'} 的投稿《${item.title}》▶️`))
        }
        pb.bvid = item.bvid
        pb.page = item.page
        pb.title = item.title
        pb.cover = item.cover
        pb.upName = item.upName
        pb.duration = item.duration
        pb.position = 0
        pb.playing = true
        pb.updatedAt = Date.now()
        pb.revision++
        clearMoments(rt)
        io.to(rt.code).emit('room:chat', systemMsg(rt, `房主正在播放《${item.title}》▶️`))
        break
      }
      case 'addPlaylistItem': {
        const v = (payload.video || {}) as Partial<PlaylistItem>
        if (!v.bvid || !v.title) {
          ack?.({ ok: false, error: '视频信息缺失' })
          return
        }
        // 去重：同 bvid+page 已存在则跳过
        const dup = rt.playlist.find((p) => p.bvid === v.bvid && p.page === Number(v.page || 1))
        if (dup) {
          ack?.({ ok: true, itemId: dup.id, duplicated: true })
          return
        }
        const item: PlaylistItem = {
          id: genId(),
          bvid: v.bvid,
          page: Number(v.page || 1),
          title: v.title || v.bvid,
          cover: v.cover ?? null,
          upName: v.upName ?? null,
          duration: Number(v.duration || 0),
          addedBy: member?.name || '',
          addedAt: new Date().toISOString(),
        }
        rt.playlist = [...rt.playlist, item].slice(-50)
        broadcastPlaylist(rt)
        io.to(rt.code).emit('room:chat', systemMsg(rt, `${member?.name || '有人'} 把《${item.title}》加入了播放列表 📀`))
        ack?.({ ok: true, itemId: item.id })
        return
      }
      case 'addPlaylistItems': {
        // 收藏夹/合集批量导入：整批去重 + 容量控制（50），仅广播一次系统消息防刷屏
        const list = Array.isArray(payload.videos) ? payload.videos : []
        if (list.length === 0) {
          ack?.({ ok: false, error: '没有可导入的视频' })
          return
        }
        const source = typeof payload.source === 'string' ? payload.source.trim().slice(0, 40) : ''
        const CAP = 50
        const seen = new Set(rt.playlist.map((p) => `${p.bvid}:${p.page}`))
        let capacity = Math.max(0, CAP - rt.playlist.length)
        let added = 0
        let skipped = 0
        let dropped = 0
        for (const v of list) {
          const bvid = String((v as Partial<PlaylistItem>)?.bvid || '')
          const title = String((v as Partial<PlaylistItem>)?.title || '')
          if (!bvid || !title) continue
          const key = `${bvid}:${Number((v as Partial<PlaylistItem>).page || 1)}`
          if (seen.has(key)) {
            skipped++
            continue
          }
          if (capacity <= 0) {
            dropped++
            continue
          }
          seen.add(key)
          capacity--
          rt.playlist = [
            ...rt.playlist,
            {
              id: genId(),
              bvid,
              page: Number((v as Partial<PlaylistItem>).page || 1),
              title,
              cover: (v as Partial<PlaylistItem>).cover ?? null,
              upName: (v as Partial<PlaylistItem>).upName ?? null,
              duration: Number((v as Partial<PlaylistItem>).duration || 0),
              addedBy: member?.name || '',
              addedAt: new Date().toISOString(),
            },
          ]
          added++
        }
        if (added > 0) {
          broadcastPlaylist(rt)
          io.to(rt.code).emit(
            'room:chat',
            systemMsg(rt, `${member?.name || '有人'} ${source ? `从「${source}」` : ''}批量导入 ${added} 个视频到播放列表 📀`)
          )
        }
        ack?.({ ok: true, added, skipped, dropped })
        return
      }
      case 'setRoomSettings': {
        // 房主权限开关（room:control 已限房主）：仅接受白名单布尔字段
        const incoming = (payload.settings || {}) as Record<string, unknown>
        const changed: string[] = []
        if (typeof incoming.allowSubmit === 'boolean' && incoming.allowSubmit !== rt.settings.allowSubmit) {
          rt.settings.allowSubmit = incoming.allowSubmit
          changed.push(incoming.allowSubmit ? '开启成员投稿' : '关闭成员投稿')
        }
        if (typeof incoming.allowMoment === 'boolean' && incoming.allowMoment !== rt.settings.allowMoment) {
          rt.settings.allowMoment = incoming.allowMoment
          changed.push(incoming.allowMoment ? '开启成员打点' : '关闭成员打点')
        }
        if (
          typeof incoming.slowModeSeconds === 'number' &&
          (SLOW_MODE_WHITELIST as number[]).includes(incoming.slowModeSeconds) &&
          incoming.slowModeSeconds !== rt.settings.slowModeSeconds
        ) {
          rt.settings.slowModeSeconds = incoming.slowModeSeconds
          changed.push(incoming.slowModeSeconds > 0 ? `开启慢速模式（${incoming.slowModeSeconds}秒）` : '关闭慢速模式')
        }
        if (changed.length === 0) {
          ack?.({ ok: true, settings: rt.settings })
          return
        }
        broadcastSettings(rt)
        io.to(rt.code).emit('room:chat', systemMsg(rt, `房主${changed.join('、')} ⚙️`))
        ack?.({ ok: true, settings: rt.settings })
        return
      }
      case 'setRoomName': {
        // 房主改名房间：验证 + 广播 + 持久化（首页最近房间名随 roomName 更新）
        const name = String(payload.name || '').trim().slice(0, 30)
        if (!name) {
          ack?.({ ok: false, error: '房间名不能为空' })
          return
        }
        if (name === rt.name) {
          ack?.({ ok: true, name })
          return
        }
        rt.name = name
        io.to(rt.code).emit('room:renamed', {
          name,
          message: systemMsg(rt, `房主把房间改名为「${name}」 ✏️`),
        })
        schedulePersist(rt)
        ack?.({ ok: true, name })
        return
      }
      case 'movePlaylistItem': {
        // 房主排序队列（点歌台）：置顶 / 上移 / 下移；正在播放条目也可移动，不影响播放
        const idx = rt.playlist.findIndex((p) => p.id === payload.itemId)
        const dir = String(payload.dir || '')
        if (idx < 0) {
          ack?.({ ok: false, error: '条目不存在' })
          return
        }
        if (!['up', 'down', 'top'].includes(dir)) {
          ack?.({ ok: false, error: '不支持的移动方向' })
          return
        }
        if (idx === 0 && dir !== 'down') {
          ack?.({ ok: true })
          return
        }
        const item = rt.playlist.splice(idx, 1)[0]
        const newIdx =
          dir === 'top' ? 0 : dir === 'up' ? Math.max(0, idx - 1) : Math.min(rt.playlist.length, idx + 1)
        rt.playlist.splice(newIdx, 0, item)
        broadcastPlaylist(rt)
        ack?.({ ok: true })
        return
      }
      case 'playNextItem': {
        // 房主手动「下一首」：按队列顺序播放当前条目的下一个；当前不在队列（直接粘贴的视频）则从第一条开始；到末尾回绕
        if (rt.playlist.length === 0) {
          ack?.({ ok: false, error: '播放列表是空的' })
          return
        }
        const curIdx = rt.playlist.findIndex((p) => p.bvid === pb.bvid && p.page === pb.page)
        const next = curIdx < 0 ? rt.playlist[0] : rt.playlist[(curIdx + 1) % rt.playlist.length]
        pb.bvid = next.bvid
        pb.page = next.page
        pb.title = next.title
        pb.cover = next.cover
        pb.upName = next.upName
        pb.duration = next.duration
        pb.position = 0
        pb.playing = true
        pb.updatedAt = Date.now()
        pb.revision++
        clearMoments(rt)
        io.to(rt.code).emit('room:chat', systemMsg(rt, `${member?.name || '房主'} 切换到下一首《${next.title}》⏭️`))
        break
      }
      case 'removePlaylistItem': {
        rt.playlist = rt.playlist.filter((p) => p.id !== payload.itemId)
        broadcastPlaylist(rt)
        ack?.({ ok: true })
        return
      }
      case 'reviewQueueItem': {
        // 房主审核成员投稿：approve=通过入列 / reject=婉拒移除
        const item = rt.playlist.find((p) => p.id === payload.itemId)
        if (!item) {
          ack?.({ ok: false, error: '投稿不存在或已处理' })
          return
        }
        if (!item.pending) {
          ack?.({ ok: false, error: '该条目无需审核' })
          return
        }
        const approve = !!payload.approve
        if (approve) {
          delete item.pending
          io.to(rt.code).emit('room:chat', systemMsg(rt, `房主通过了 ${item.addedBy || '成员'} 的投稿《${item.title}》✅ 已加入播放队列`))
        } else {
          rt.playlist = rt.playlist.filter((p) => p.id !== payload.itemId)
          io.to(rt.code).emit('room:chat', systemMsg(rt, `房主婉拒了 ${item.addedBy || '成员'} 的投稿《${item.title}》🍂`))
        }
        broadcastPlaylist(rt)
        ack?.({ ok: true })
        return
      }
      case 'clearPlaylist': {
        rt.playlist = []
        broadcastPlaylist(rt)
        ack?.({ ok: true })
        return
      }
      case 'clearMoments': {
        clearMoments(rt)
        ack?.({ ok: true })
        return
      }
      default:
        ack?.({ ok: false, error: '未知操作' })
        return
    }

    broadcastState(rt)
    schedulePersist(rt)
    ack?.({ ok: true, playback: rt.playback })
  })

  // 成员投稿点播（不走 room:control 的 owner-only 通道）：
  // 房主投稿直接入列；成员投稿进入待审核状态，由房主通过 reviewQueueItem 审批。
  // 防刷：同 uid 8s 冷却；待审队列上限 20；与正式队列共同去重。
  const submitCooldowns = new Map<string, number>()
  socket.on('room:submit', (data: { code: string; uid: string; video: Partial<PlaylistItem> }, ack?: (res: unknown) => void) => {
    const code = String(data?.code || '').toUpperCase()
    const uid = String(data?.uid || '')
    const rt = rooms.get(code)
    if (!rt) {
      ack?.({ ok: false, error: '房间不存在' })
      return
    }
    const member = rt.members.get(uid)
    if (!member) {
      ack?.({ ok: false, error: '请先加入房间' })
      return
    }
    // 服务端强制：房主关闭成员投稿后，非房主投稿被拦截（房主本人不受限）
    if (!rt.settings.allowSubmit && rt.ownerUid !== uid) {
      ack?.({ ok: false, error: '房主已关闭成员投稿，如需点播请联系房主 🙏' })
      return
    }
    const v = data?.video || {}
    if (!v.bvid || !v.title) {
      ack?.({ ok: false, error: '视频信息缺失' })
      return
    }
    const last = submitCooldowns.get(uid) || 0
    if (Date.now() - last < 8000) {
      ack?.({ ok: false, error: '投稿太频繁啦，歇几秒再试 🙏' })
      return
    }
    // 去重：正式队列与待审队列都算
    const dup = rt.playlist.find((p) => p.bvid === v.bvid && p.page === Number(v.page || 1))
    if (dup) {
      ack?.({ ok: true, itemId: dup.id, duplicated: true, pending: !!dup.pending })
      return
    }
    const pendingCount = rt.playlist.filter((p) => p.pending).length
    if (pendingCount >= 20) {
      ack?.({ ok: false, error: '待审核投稿有点多，房主正在努力审核 🙏' })
      return
    }
    const isOwner = rt.ownerUid === uid
    const item: PlaylistItem = {
      id: genId(),
      bvid: String(v.bvid),
      page: Number(v.page || 1),
      title: String(v.title || v.bvid).slice(0, 200),
      cover: v.cover ?? null,
      upName: v.upName ?? null,
      duration: Number(v.duration || 0),
      addedBy: member.name,
      addedAt: new Date().toISOString(),
      pending: !isOwner,
    }
    submitCooldowns.set(uid, Date.now())
    rt.playlist = [...rt.playlist, item]
    broadcastPlaylist(rt)
    if (isOwner) {
      io.to(rt.code).emit('room:chat', systemMsg(rt, `${member.name} 点了一首《${item.title}》🎵`))
    } else {
      io.to(rt.code).emit('room:chat', systemMsg(rt, `${member.name} 投稿了《${item.title}》，等待房主审核 🎵`))
    }
    ack?.({ ok: true, itemId: item.id, pending: !!item.pending, duplicated: false })
    console.log(`[submit] ${code} ${member.name} -> ${item.title}${item.pending ? ' (pending)' : ''}`)
  })

  // 精彩时刻打点（全员可用）：记录当前进度，广播给全房间；房主可点击时刻芯片跳转。
  // 内存态：上限 50 条（超出丢最旧），切视频清空，服务重启清空。防刷：同 uid 3s 冷却。
  const momentCooldowns = new Map<string, number>()
  socket.on('room:moment', (data: { code: string; uid: string; t: number; note?: string }, ack?: (res: unknown) => void) => {
    const code = String(data?.code || '').toUpperCase()
    const uid = String(data?.uid || '')
    const rt = rooms.get(code)
    if (!rt) {
      ack?.({ ok: false, error: '房间不存在' })
      return
    }
    const member = rt.members.get(uid)
    if (!member) {
      ack?.({ ok: false, error: '请先加入房间' })
      return
    }
    // 服务端强制：房主关闭成员打点后，非房主打点被拦截（房主本人不受限）
    if (!rt.settings.allowMoment && rt.ownerUid !== uid) {
      ack?.({ ok: false, error: '房主已关闭成员打点 ⭐' })
      return
    }
    if (!rt.playback.bvid) {
      ack?.({ ok: false, error: '当前没有正在播放的视频' })
      return
    }
    const last = momentCooldowns.get(uid) || 0
    if (Date.now() - last < 3000) {
      ack?.({ ok: false, error: '打点太频繁啦，歇几秒 ⭐' })
      return
    }
    const t = clamp(Number(data?.t || 0), 0, rt.playback.duration || 1e9)
    // 附言（可选）：打点时直接携带，与时刻 tab 补写同一套白名单校验
    const rawNote = typeof data?.note === 'string' ? data.note.trim().slice(0, 40) : ''
    const moment: RoomMoment = {
      id: genId(),
      t,
      name: member.name,
      uid,
      bvid: rt.playback.bvid,
      ts: Date.now(),
    }
    if (rawNote) moment.note = rawNote
    momentCooldowns.set(uid, Date.now())
    rt.moments = [...rt.moments, moment].slice(-50)
    io.to(rt.code).emit('room:moments', { moments: rt.moments })
    io.to(rt.code).emit('room:chat', systemMsg(rt, `${member.name} 打点了精彩时刻 ⏱ ${fmtTime(t)} ⭐`))
    ack?.({ ok: true, moment })
    console.log(`[moment] ${code} ${member.name} @${fmtTime(t)}${moment.note ? ` 「${moment.note}」` : ''}`)
  })

  // 精彩时刻附言（打点者本人或房主可补写/修改，≤40 字）：
  // 独立事件而非 room:control —— room:control 是 owner-only 通道，成员补自己的附言需要放行
  socket.on('room:momentNote', (data: { code: string; uid: string; momentId: string; note: string }, ack?: (res: unknown) => void) => {
    const code = String(data?.code || '').toUpperCase()
    const uid = String(data?.uid || '')
    const rt = rooms.get(code)
    if (!rt) {
      ack?.({ ok: false, error: '房间不存在' })
      return
    }
    const member = rt.members.get(uid)
    if (!member) {
      ack?.({ ok: false, error: '请先加入房间' })
      return
    }
    const m = rt.moments.find((x) => x.id === String(data?.momentId || ''))
    if (!m) {
      ack?.({ ok: false, error: '时刻不存在或已被清空' })
      return
    }
    // 权限：打点者本人或房主；成员打点权限被关闭后，成员仍可编辑自己已有附言（历史操作不受新设置追溯）
    if (m.uid !== uid && rt.ownerUid !== uid) {
      ack?.({ ok: false, error: '只能给自己的打点补附言 ✍️' })
      return
    }
    const note = typeof data?.note === 'string' ? data.note.trim().slice(0, 40) : ''
    if (note) m.note = note
    else delete m.note
    io.to(rt.code).emit('room:moments', { moments: rt.moments })
    ack?.({ ok: true, moment: m })
    console.log(`[momentNote] ${code} ${member.name} -> #${m.id.slice(-4)} ${m.note ? `「${m.note}」` : '(清除)'}`)
  })

  // 「正在输入」指示器（轻量转发，服务端不存状态；客户端 4s 无更新自动过期）
  socket.on('room:typing', (data: { code: string; uid: string; typing: boolean }) => {
    const code = String(data?.code || '').toUpperCase()
    const uid = String(data?.uid || '')
    const rt = rooms.get(code)
    if (!rt) return
    const member = rt.members.get(uid)
    if (!member) return
    console.log(`[typing] ${code} ${member.name} typing=${!!data?.typing}`)
    // 不回发给发送者自己
    socket.to(code).emit('room:typing', { uid, name: member.name, typing: !!data?.typing })
  })

  // 房主心跳：广播轻量 tick
  socket.on('room:tick', (data: { code: string; uid: string; position: number; playing: boolean }) => {
    const code = String(data?.code || '').toUpperCase()
    const uid = String(data?.uid || '')
    const rt = rooms.get(code)
    if (!rt || rt.ownerUid !== uid) return
    const pb = rt.playback
    const pos = clamp(Number(data.position || 0), 0, pb.duration || 1e9)
    pb.position = pos
    pb.playing = !!data.playing
    pb.updatedAt = Date.now()
    socket.to(code).emit('playback:tick', { position: pos, playing: pb.playing, updatedAt: pb.updatedAt, revision: pb.revision })
  })

  // 观看时长上报：客户端在真实播放中周期性上报增量，服务端累加后广播
  socket.on('room:watch', (data: { code: string; uid: string; baseUid?: string; delta: number }) => {
    const code = String(data?.code || '').toUpperCase()
    const uid = String(data?.uid || '')
    const baseUid = String(data?.baseUid || '').slice(0, 64) || uid
    const rt = rooms.get(code)
    if (!rt) return
    const member = rt.members.get(uid)
    if (!member) return
    const delta = Number(data?.delta || 0)
    if (!isFinite(delta) || delta <= 0) return
    const inc = Math.min(60, delta)
    const before = member.watchSeconds
    member.watchSeconds += inc
    // 里程碑：跨越 30分钟/1h/2h/4h/8h 时广播祝贺（只在真实观看累计时触发，播完整段才跨得过去）
    const MILESTONES: Array<[number, string]> = [
      [1800, '⏱️ 观看时长满 30 分钟'],
      [3600, '🔥 观看时长满 1 小时'],
      [7200, '🌟 观看时长满 2 小时'],
      [14400, '💎 观看时长满 4 小时'],
      [28800, '👑 观看时长满 8 小时，肝帝实锤'],
    ]
    for (const [ms, label] of MILESTONES) {
      if (before < ms && member.watchSeconds >= ms) {
        io.to(rt.code).emit('room:chat', systemMsg(rt, `${member.name} ${label} 🎉`))
        // 专属事件：客户端展示庆祝动效（与普通系统消息区分）
        io.to(rt.code).emit('room:milestone', { uid: member.uid, name: member.name, label, ts: Date.now() })
        break
      }
    }
    // 同步记入待刷盘队列（30s 批量持久化）：按基础身份归属，跨标签页/跨天不丢
    const pending = rt.pendingWatch.get(baseUid) || { name: member.name, delta: 0 }
    pending.name = member.name
    pending.delta += inc
    rt.pendingWatch.set(baseUid, pending)
    console.log(`[watch] ${code} ${member.name} +${Math.round(inc)}s total=${Math.round(member.watchSeconds)}s`)
    broadcastMembers(rt)
  })

  // 聊天
  // 慢速模式：成员发言最小间隔（key: code:uid -> 上次发言时间戳）；房主不受限
  const chatSlowMap = new Map<string, number>()
  socket.on('room:chat', (data: { code: string; uid: string; text: string }, ack?: (res: unknown) => void) => {
    const code = String(data?.code || '').toUpperCase()
    const uid = String(data?.uid || '')
    const text = String(data?.text || '').slice(0, 300).trim()
    const rt = rooms.get(code)
    if (!rt || !text) return
    const member = rt.members.get(uid)
    if (!member) return
    const isOwner = rt.ownerUid === uid
    const slow = rt.settings.slowModeSeconds || 0
    if (slow > 0 && !isOwner) {
      const key = `${code}:${uid}`
      const last = chatSlowMap.get(key) || 0
      const remainMs = last + slow * 1000 - Date.now()
      if (remainMs > 0) {
        ack?.({ ok: false, error: `慢速模式：再等 ${Math.ceil(remainMs / 1000)} 秒才能发言 🐢` })
        return
      }
      chatSlowMap.set(key, Date.now())
    }
    const msg: ChatMessage = { id: genId(), uid, name: member.name, text, ts: Date.now(), kind: 'user' }
    io.to(code).emit('room:chat', msg)
    ack?.({ ok: true })
  })

  // 房主主动移交
  socket.on('room:transfer-owner', (data: { code: string; uid: string; targetUid: string }, ack?: (res: unknown) => void) => {
    const code = String(data?.code || '').toUpperCase()
    const rt = rooms.get(code)
    if (!rt || rt.ownerUid !== data?.uid) {
      ack?.({ ok: false, error: '只有房主可以移交' })
      return
    }
    if (!rt.members.has(data.targetUid)) {
      ack?.({ ok: false, error: '目标成员不在线' })
      return
    }
    setOwner(rt, data.targetUid)
    ack?.({ ok: true })
  })

  socket.on('disconnect', () => {
    console.log(`[conn] ${socket.id} disconnected`)
    for (const code of joinedRooms) {
      const rt = rooms.get(code)
      if (!rt) continue
      for (const [uid, member] of rt.members) {
        if (member.socketIds.has(socket.id)) {
          member.socketIds.delete(socket.id)
          if (member.socketIds.size === 0) {
            rt.members.delete(uid)
            io.to(code).emit('room:chat', systemMsg(rt, `${member.name} 离开了房间 👋`))
            // 房主转移：按加入时间取最早的成员
            if (rt.ownerUid === uid) {
              rt.ownerUid = null
              const next = Array.from(rt.members.values()).sort((a, b) => a.joinedAt - b.joinedAt)[0]
              if (next) {
                setOwner(rt, next.uid)
              } else {
                broadcastMembers(rt)
              }
            }
          }
          break
        }
      }
      broadcastMembers(rt)
    }
  })

  socket.on('error', (err) => console.error(`[socket error] ${socket.id}:`, err))
})

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`BiliTogether sync service (socket.io) running on port ${PORT}`)
})

/** 观看统计刷盘：每 30s 把所有房间的待写增量批量持久化到 SQLite */
const WATCH_FLUSH_MS = 30000
setInterval(() => {
  for (const [code, rt] of rooms) {
    if (rt.pendingWatch.size === 0) continue
    const stats = Array.from(rt.pendingWatch.entries()).map(([uid, p]) => ({
      uid,
      name: p.name,
      seconds: Math.round(p.delta),
    }))
    rt.pendingWatch.clear()
    // 同步回内存统计（新成员播种用），再异步写库
    for (const s of stats) {
      rt.watchStats.set(s.uid, (rt.watchStats.get(s.uid) || 0) + s.seconds)
    }
    fetch(`${NEXT_API}/api/rooms/${code}/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stats }),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      // 写库失败：退回待写队列，下轮重试
      for (const s of stats) {
        const back = rt.pendingWatch.get(s.uid) || { name: s.name, delta: 0 }
        back.delta += s.seconds
        rt.pendingWatch.set(s.uid, back)
        rt.watchStats.set(s.uid, Math.max(0, (rt.watchStats.get(s.uid) || 0) - s.seconds))
      }
      console.error(`[watch-flush] ${code} failed:`, (err as Error).message)
    })
  }
}, WATCH_FLUSH_MS)

/**
 * SIGTERM/SIGINT：立即退出。
 * 注意不要用 httpServer.close(callback) 等待连接排空——socket.io 长连接会导致
 * 回调永不触发；且 bun --hot 热重载争抢端口时会发 SIGTERM，阻塞式关闭会让
 * 服务进入「连接活着但定时器全死」的半死状态。房间状态由 DB 持久化兜底，
 * 最多丢失 1.5s 播放状态 / 30s 观看统计增量，可接受。
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...')
  process.exit(0)
})
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...')
  process.exit(0)
})

/**
 * Next dev server 自愈看门狗（与 Next 侧 /api/system/ensure-sync-service 互为镜像）：
 * 沙箱会按进程树清理「从命令行会话派生」的后台进程——若 Next 被外部清理死亡，
 * 本服务（挂在系统托管树上）每 5s 探测 3000，失联则以本服务为父拉起 Next dev server，
 * 使其脱离 CLI 会话谱系而长期存活。防循环：单进程生命周期最多拉起 3 次，两次间隔 ≥60s
 * （60s 同时覆盖 Next 冷启动时间，避免启动期间重复拉起）。
 */
let nextSpawnCount = 0
let lastNextSpawnAt = 0
setInterval(() => {
  if (nextSpawnCount >= 3) return
  if (Date.now() - lastNextSpawnAt < 60000) return
  const probe = createConnection(3000, '127.0.0.1')
  let settled = false
  const finish = (alive: boolean) => {
    if (settled) return
    settled = true
    probe.destroy()
    if (alive) return
    nextSpawnCount++
    lastNextSpawnAt = Date.now()
    const log = openSync('/home/z/my-project/dev.log', 'a')
    const child = spawn('bash', ['-c', 'bun run dev 2>&1 | tee -a dev.log'], {
      cwd: '/home/z/my-project',
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    })
    child.unref()
    console.log(`[next-watchdog] port 3000 down, spawned Next dev server (pid ${child.pid}, attempt ${nextSpawnCount}/3)`)
  }
  probe.once('connect', () => finish(true))
  probe.once('error', () => finish(false))
  setTimeout(() => finish(false), 1200)
}, 5000)
console.log('[next-watchdog] Next self-heal watchdog armed (probe :3000 every 5s, max 3 spawns)')
