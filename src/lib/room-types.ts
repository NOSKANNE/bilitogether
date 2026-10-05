// 房间共享类型定义（前端 + 同步服务共用）

export interface PlaylistItem {
  id: string
  bvid: string
  page: number
  title: string
  cover: string | null
  upName: string | null
  duration: number
  addedBy: string
  addedAt?: string
  /** 待房主审核的成员投稿（仅内存态，不持久化） */
  pending?: boolean
}

/** 服务端权威播放状态 */
export interface PlaybackState {
  bvid: string | null
  page: number
  title: string | null
  cover: string | null
  upName: string | null
  duration: number
  playing: boolean
  /** position 是 updatedAt 时刻的进度（秒） */
  position: number
  qn: number
  /** 播放倍速（房主控制，全员同步；影响进度估算） */
  rate: number
  danmaku: boolean
  /** 循环模式（房主控制）：off 顺序播放 / list 列表循环 / one 单曲循环 */
  loop?: 'off' | 'list' | 'one'
  updatedAt: number
  revision: number
}

/** 房间成员（服务端广播，含观看统计） */
export interface RoomMember {
  uid: string
  /** 基础身份（不含标签页后缀）：观看统计按它归属，同浏览器多标签页共享历史 */
  baseUid?: string
  name: string
  device: 'pc' | 'mobile' | 'tablet'
  joinedAt: number
  isOwner: boolean
  /** 累计观看秒数（真实播放中才累计，由客户端上报、服务端累加） */
  watchSeconds?: number
  /** 本次在线秒数（服务端按 joinedAt 计算） */
  onlineSeconds?: number
}

export interface ChatMessage {
  id: string
  uid: string
  name: string
  text: string
  ts: number
  kind: 'user' | 'system'
}

/** 精彩时刻打点（内存态：切视频清空、重启清空） */
export interface RoomMoment {
  id: string
  /** 相对当前视频的秒数 */
  t: number
  name: string
  uid: string
  bvid: string
  ts: number
  /** 附言（可选，≤40 字；打点者本人或房主可编辑） */
  note?: string
}

/** 房间设置（房主权限开关，服务端强制执行） */
export interface RoomSettings {
  /** 允许成员投稿点播（关闭后成员点播台禁用，仅房主可选片） */
  allowSubmit: boolean
  /** 允许成员打点精彩时刻（关闭后仅房主可打点） */
  allowMoment: boolean
  /** 聊天慢速模式（秒）：成员发言最小间隔，0 = 关闭；房主不受限 */
  slowModeSeconds: number
}

/** 慢速模式可选间隔（服务端白名单） */
export const SLOW_MODE_OPTIONS = [0, 5, 10, 30] as const

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  allowSubmit: true,
  allowMoment: true,
  slowModeSeconds: 0,
}

export interface RoomJoinAck {
  ok: boolean
  error?: string
  roomName?: string
  creatorName?: string
  playback?: PlaybackState
  playlist?: PlaylistItem[]
  members?: RoomMember[]
  /** 精彩时刻（新成员入房可见已有打点） */
  moments?: RoomMoment[]
  /** 房间设置（房主权限开关） */
  settings?: RoomSettings
  youAreOwner?: boolean
  ownerUid?: string
}

export type ControlAction =
  | { action: 'play'; position?: number }
  | { action: 'pause'; position?: number }
  | { action: 'seek'; position: number }
  | { action: 'skip'; delta: number }
  | { action: 'setVideo'; video: Omit<PlaylistItem, 'id'> }
  | { action: 'addPlaylistItem'; video: Omit<PlaylistItem, 'id'> }
  | { action: 'addPlaylistItems'; videos: Omit<PlaylistItem, 'id'>[]; source?: string }
  | { action: 'setQn'; qn: number }
  | { action: 'setRate'; rate: number; position?: number }
  | { action: 'setDanmaku'; danmaku: boolean }
  | { action: 'setLoop'; loop: 'off' | 'list' | 'one' }
  | { action: 'playPlaylistItem'; itemId: string }
  | { action: 'movePlaylistItem'; itemId: string; dir: 'up' | 'down' | 'top' }
  | { action: 'playNextItem' }
  | { action: 'removePlaylistItem'; itemId: string }
  | { action: 'reviewQueueItem'; itemId: string; approve: boolean }
  | { action: 'clearPlaylist' }
  | { action: 'resync' }
  | { action: 'clearMoments' }
  | { action: 'setRoomSettings'; settings: Partial<RoomSettings> }
  | { action: 'setRoomName'; name: string }

/** 当前估算进度（按倍速推进） */
export function estimatePosition(state: PlaybackState, nowMs = Date.now()): number {
  if (!state.playing) return state.position
  const elapsed = (nowMs - state.updatedAt) / 1000
  const rate = state.rate && state.rate > 0 ? state.rate : 1
  const pos = state.position + Math.max(0, elapsed) * rate
  if (state.duration > 0) return Math.min(pos, state.duration)
  return pos
}
