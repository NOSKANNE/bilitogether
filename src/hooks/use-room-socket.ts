'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type {
  ChatMessage,
  PlaybackState,
  PlaylistItem,
  RoomJoinAck,
  RoomMember,
  RoomMoment,
  RoomSettings,
  ControlAction,
} from '@/lib/room-types'
import { DEFAULT_ROOM_SETTINGS } from '@/lib/room-types'

interface UseRoomSocketArgs {
  code: string
  uid: string
  /** 基础身份（不含标签页后缀）：观看统计按它归属，跨标签页/跨天累计不丢 */
  baseUid?: string
  nickname: string
  device: 'pc' | 'mobile' | 'tablet'
  enabled: boolean
}

export interface MilestoneEvent {
  id: string
  name: string
  label: string
}

/** 控制动作 ack（批量导入时携带 added/skipped/dropped 统计） */
export interface ControlAck {
  ok: boolean
  error?: string
  itemId?: string
  duplicated?: boolean
  added?: number
  skipped?: number
  dropped?: number
}

export interface RoomSocketState {
  connected: boolean
  joined: boolean
  joinError: string | null
  roomName: string
  creatorName: string
  playback: PlaybackState | null
  playlist: PlaylistItem[]
  members: RoomMember[]
  ownerUid: string | null
  isOwner: boolean
  /** 房间设置（房主权限开关，服务端强制执行） */
  settings: RoomSettings
  sendControl: (payload: ControlAction) => Promise<ControlAck>
  /** 成员投稿点播（房主调用则直接入列，成员投稿需房主审核） */
  sendSubmit: (video: Omit<PlaylistItem, 'id'>) => Promise<{ ok: boolean; error?: string; pending?: boolean; duplicated?: boolean }>
  sendChat: (text: string, onError?: (msg: string) => void) => void
  transferOwner: (targetUid: string) => void
  sendTick: (position: number, playing: boolean) => void
  sendWatch: (deltaSeconds: number) => void
  messages: ChatMessage[]
  connectedAt: number
  /** 精彩时刻列表（全员可打点，切视频自动清空） */
  moments: RoomMoment[]
  /** 打点（记录当前进度并广播全房间，可选附言） */
  sendMoment: (t: number, note?: string) => Promise<{ ok: boolean; error?: string }>
  /** 补写/修改/清除时刻附言（打点者本人或房主；note 传空串为清除） */
  sendMomentNote: (momentId: string, note: string) => Promise<{ ok: boolean; error?: string }>
  /** 正在其他成员打字的昵称列表（4s 无更新自动过期） */
  typingPeers: { uid: string; name: string }[]
  /** 上报本端正在输入状态（fire-and-forget，不发给自己） */
  sendTyping: (typing: boolean) => void
  /** 最近一次观看里程碑事件（供庆祝动效展示，id 每次不同以重触发动画） */
  milestone: MilestoneEvent | null
  clearMilestone: () => void
}

export function useRoomSocket({ code, uid, baseUid, nickname, device, enabled }: UseRoomSocketArgs): RoomSocketState {
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [joined, setJoined] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [roomName, setRoomName] = useState('')
  const [creatorName, setCreatorName] = useState('')
  const [playback, setPlayback] = useState<PlaybackState | null>(null)
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([])
  const [members, setMembers] = useState<RoomMember[]>([])
  const [ownerUid, setOwnerUid] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [connectedAt, setConnectedAt] = useState(0)
  const [milestone, setMilestone] = useState<MilestoneEvent | null>(null)
  const [moments, setMoments] = useState<RoomMoment[]>([])
  const [settings, setSettings] = useState<RoomSettings>(DEFAULT_ROOM_SETTINGS)
  const [typingPeers, setTypingPeers] = useState<{ uid: string; name: string; at: number }[]>([])

  // 稳定的 uid/nickname 快照，避免重连风暴
  const uidRef = useRef(uid)
  const baseUidRef = useRef(baseUid)
  const nameRef = useRef(nickname)
  const deviceRef = useRef(device)
  // joined 的镜像（连接超时提示定时器内读取，避免闭包过期）
  const joinedRef = useRef(false)
  useEffect(() => {
    uidRef.current = uid
    baseUidRef.current = baseUid
    nameRef.current = nickname
    deviceRef.current = device
  }, [uid, baseUid, nickname, device])
  useEffect(() => {
    joinedRef.current = joined
  }, [joined])

  const pushMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev.slice(-200), msg])
  }, [])

  useEffect(() => {
    if (!enabled || !code || !uidRef.current) return

    // 自愈加速：connect 失败大概率是同步服务进程不在（沙箱清理/崩溃）。
    // 节流调用 ensure-sync-service（幂等：端口在则直接返回），避免重连风暴期打爆该接口。
    let lastEnsureAt = 0
    const ensureSyncService = () => {
      const now = Date.now()
      if (now - lastEnsureAt < 8000) return
      lastEnsureAt = now
      void fetch('/api/system/ensure-sync-service').catch(() => undefined)
    }

    /* 连接死锁修复：旧配置 reconnectionAttempts: 12 —— 重连窗口约 50s，
       若服务端进程尚未拉起（ensure 异步竞态）则 12 次全部撞死后永久沉默，
       room:join 永远发不出去 → joinError 永远为 null → 页面永久转圈无重试入口。
       改为无限重连 + 5s 间隔上限：服务端自愈完成后（通常几秒）下一轮重连即接上，
       connect 成功会自动重新 room:join，掉线用户无需刷新即可自动回房。 */
    /* 同步服务连接地址（NEXT_PUBLIC_SYNC_URL，构建时注入）：
       - 默认：Caddy 网关转发（XTransformPort），适合网关式部署（沙箱开箱即用）；
       - 同源反代自托管：NEXT_PUBLIC_SYNC_URL=/ （nginx/caddy 把 /socket.io/ 反代到 127.0.0.1:3003）；
       - 直连自托管：NEXT_PUBLIC_SYNC_URL=http://host:3003 （同步服务 CORS 已放开，适合局域网）。 */
    const SYNC_URL = process.env.NEXT_PUBLIC_SYNC_URL || '/?XTransformPort=3003'
    const socket = io(SYNC_URL, {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    })
    socketRef.current = socket
    const startedAt = Date.now()
    let everConnected = false

    // 连接中超时提示：从未连上且超过 15s → 给出错误态（带重试按钮）；
    // 后台重连继续，一旦连上并 join 成功，UI 自动切回房间（joined=true）
    const connectHintTimer = setInterval(() => {
      if (!everConnected && !joinedRef.current && Date.now() - startedAt > 15000) {
        setJoinError('连接同步服务器超时（服务可能正在自愈，稍候自动重试或点击重试）')
      }
    }, 3000)

    socket.on('connect', () => {
      everConnected = true
      setConnected(true)
      setConnectedAt(Date.now())
      setJoinError(null)
      socket.emit('room:join', { code, uid: uidRef.current, baseUid: baseUidRef.current, name: nameRef.current || '访客', device: deviceRef.current }, (res: RoomJoinAck) => {
        if (res?.ok) {
          setJoined(true)
          setJoinError(null)
          setRoomName(res.roomName || '')
          setCreatorName(res.creatorName || '')
          setPlayback(res.playback || null)
          setPlaylist(res.playlist || [])
          setMembers(res.members || [])
          setOwnerUid(res.ownerUid || null)
          setMoments(res.moments || [])
          setSettings(res.settings || DEFAULT_ROOM_SETTINGS)
          setTypingPeers([])
        } else {
          setJoined(false)
          setJoinError(res?.error || '加入房间失败')
        }
      })
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on('connect_error', (err: Error) => {
      console.warn('[socket] connect_error:', err.message)
      ensureSyncService()
      if (!everConnected && Date.now() - startedAt > 15000) {
        setJoinError('连接同步服务器超时（服务可能正在自愈，稍候自动重试或点击重试）')
      }
    })

    socket.on('playback:state', (data: { playback: PlaybackState }) => {
      if (data?.playback) setPlayback(data.playback)
    })

    socket.on('playback:tick', (data: { position: number; playing: boolean; updatedAt: number }) => {
      setPlayback((prev) =>
        prev
          ? { ...prev, position: data.position, playing: data.playing, updatedAt: data.updatedAt }
          : prev
      )
    })

    socket.on('room:members', (data: { members: RoomMember[]; ownerUid: string | null }) => {
      setMembers(data.members || [])
      setOwnerUid(data.ownerUid)
    })

    socket.on('room:owner', (data: { ownerUid: string; message: ChatMessage }) => {
      setOwnerUid(data.ownerUid)
      if (data.message) pushMessage(data.message)
    })

    socket.on('playlist:state', (data: { playlist: PlaylistItem[] }) => {
      setPlaylist(data.playlist || [])
    })

    socket.on('room:milestone', (data: { uid: string; name: string; label: string }) => {
      if (data?.name && data?.label) {
        setMilestone({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: data.name, label: data.label })
      }
    })

    socket.on('room:moments', (data: { moments: RoomMoment[] }) => {
      setMoments(Array.isArray(data?.moments) ? data.moments : [])
    })

    socket.on('room:settings', (data: { settings: RoomSettings }) => {
      if (data?.settings) setSettings({ ...DEFAULT_ROOM_SETTINGS, ...data.settings })
    })

    socket.on('room:renamed', (data: { name: string; message: ChatMessage }) => {
      if (data?.name) setRoomName(data.name)
      if (data.message) pushMessage(data.message)
    })

    socket.on('room:typing', (data: { uid: string; name: string; typing: boolean }) => {
      if (!data?.uid || data.uid === uidRef.current) return
      setTypingPeers((prev) => {
        const others = prev.filter((p) => p.uid !== data.uid)
        return data.typing ? [...others, { uid: data.uid, name: data.name || '有人', at: Date.now() }].slice(-6) : others
      })
    })

    // 「正在输入」过期清理（4s 无更新自动消失）
    const typingPrune = setInterval(() => {
      setTypingPeers((prev) => (prev.length === 0 ? prev : prev.filter((p) => Date.now() - p.at < 4000)))
    }, 1200)

    socket.on('room:chat', (msg: ChatMessage) => {
      pushMessage(msg)
    })

    return () => {
      clearInterval(typingPrune)
      clearInterval(connectHintTimer)
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
  }, [code, enabled, pushMessage])

  const sendControl = useCallback(
    (payload: ControlAction): Promise<ControlAck> => {
      return new Promise((resolve) => {
        const socket = socketRef.current
        if (!socket || !connected) {
          resolve({ ok: false, error: '未连接到同步服务器' })
          return
        }
        socket
          .timeout(6000)
          .emit('room:control', { code, uid: uidRef.current, payload }, (err: unknown, res?: ControlAck) => {
            if (err) resolve({ ok: false, error: '同步服务器超时' })
            else resolve(res || { ok: false, error: '无响应' })
          })
      })
    },
    [code, connected]
  )

  const sendChat = useCallback(
    (text: string, onError?: (msg: string) => void) => {
      const socket = socketRef.current
      if (socket && connected && text.trim()) {
        // 慢速模式等服务端拒绝时通过 ack 回传（旧服务端不回 ack 则静默，向后兼容）
        socket.emit('room:chat', { code, uid: uidRef.current, text: text.trim() }, (res?: { ok: boolean; error?: string }) => {
          if (res && !res.ok && onError) onError(res.error || '发送失败')
        })
      }
    },
    [code, connected]
  )

  const sendSubmit = useCallback(
    (video: Omit<PlaylistItem, 'id'>): Promise<{ ok: boolean; error?: string; pending?: boolean; duplicated?: boolean }> => {
      return new Promise((resolve) => {
        const socket = socketRef.current
        if (!socket || !connected) {
          resolve({ ok: false, error: '未连接到同步服务器' })
          return
        }
        socket
          .timeout(6000)
          .emit(
            'room:submit',
            { code, uid: uidRef.current, video },
            (err: unknown, res?: { ok: boolean; error?: string; pending?: boolean; duplicated?: boolean }) => {
              if (err) resolve({ ok: false, error: '同步服务器超时' })
              else resolve(res || { ok: false, error: '无响应' })
            }
          )
      })
    },
    [code, connected]
  )

  const clearMilestone = useCallback(() => setMilestone(null), [])

  const transferOwner = useCallback(
    (targetUid: string) => {
      const socket = socketRef.current
      if (socket && connected) {
        socket.emit('room:transfer-owner', { code, uid: uidRef.current, targetUid })
      }
    },
    [code, connected]
  )

  const sendTick = useCallback(
    (position: number, playing: boolean) => {
      const socket = socketRef.current
      if (socket && connected) {
        socket.emit('room:tick', { code, uid: uidRef.current, position, playing })
      }
    },
    [code, connected]
  )

  const sendWatch = useCallback(
    (deltaSeconds: number) => {
      const socket = socketRef.current
      if (socket && connected && deltaSeconds > 0) {
        socket.emit('room:watch', { code, uid: uidRef.current, baseUid: baseUidRef.current, delta: Math.round(deltaSeconds) })
      }
    },
    [code, connected]
  )

  /** 精彩时刻打点：记录当前进度并广播全房间（可选附言） */
  const sendMoment = useCallback(
    (t: number, note?: string): Promise<{ ok: boolean; error?: string }> => {
      return new Promise((resolve) => {
        const socket = socketRef.current
        if (!socket || !connected) {
          resolve({ ok: false, error: '未连接到同步服务器' })
          return
        }
        socket
          .timeout(6000)
          .emit('room:moment', { code, uid: uidRef.current, t, note: note?.trim() || undefined }, (err: unknown, res?: { ok: boolean; error?: string }) => {
            if (err) resolve({ ok: false, error: '同步服务器超时' })
            else resolve(res || { ok: false, error: '无响应' })
          })
      })
    },
    [code, connected]
  )

  /** 补写/修改/清除时刻附言（打点者本人或房主；note 传空串为清除） */
  const sendMomentNote = useCallback(
    (momentId: string, note: string): Promise<{ ok: boolean; error?: string }> => {
      return new Promise((resolve) => {
        const socket = socketRef.current
        if (!socket || !connected) {
          resolve({ ok: false, error: '未连接到同步服务器' })
          return
        }
        socket
          .timeout(6000)
          .emit('room:momentNote', { code, uid: uidRef.current, momentId, note }, (err: unknown, res?: { ok: boolean; error?: string }) => {
            if (err) resolve({ ok: false, error: '同步服务器超时' })
            else resolve(res || { ok: false, error: '无响应' })
          })
      })
    },
    [code, connected]
  )

  /** 上报正在输入状态（fire-and-forget） */
  const sendTyping = useCallback(
    (typing: boolean) => {
      const socket = socketRef.current
      if (socket && connected) {
        socket.emit('room:typing', { code, uid: uidRef.current, typing })
      }
    },
    [code, connected]
  )

  return {
    connected,
    joined,
    joinError,
    roomName,
    creatorName,
    playback,
    playlist,
    members,
    ownerUid,
    isOwner: !!ownerUid && ownerUid === uid,
    settings,
    sendControl,
    sendSubmit,
    sendChat,
    transferOwner,
    sendTick,
    sendWatch,
    messages,
    connectedAt,
    moments,
    sendMoment,
    sendMomentNote,
    typingPeers: typingPeers.map(({ uid, name }) => ({ uid, name })),
    sendTyping,
    milestone,
    clearMilestone,
  }
}
