/**
 * B站服务端登录凭据存储（server-only）
 *
 * 数据流：扫码登录（/api/bili/login/qr/poll）从B站 Set-Cookie 抓取 SESSDATA/bili_jct
 *   → saveBiliCredentials() 落盘到 data/bili-credentials.json（运行时权威源）
 *     并同步 upsert .env 中的 BILI_SESSDATA / BILI_BILI_JCT（持久化镜像，重启后 env 兜底依旧生效）
 *   → 同时清空 playurl 流缓存，让下一次取流立刻用新凭据解锁高画质
 *
 * 读取优先级：data/bili-credentials.json > process.env.BILI_SESSDATA（手工配置兜底）
 *
 * 安全说明：本模块只在服务端运行；JSON 与 .env 均不入库不下发，前端只能拿到脱敏摘要。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { streamCacheClear } from './bili-stream-cache'

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

export interface BiliCredentialFile {
  /** Cookie 原样值（保留 %2C 等转义，发送时原样回传，不要解码/再编码） */
  sessdata: string
  biliJct: string
  mid?: string
  uname?: string
  avatar?: string
  via: 'qr'
  savedAt: number
}

export interface BiliCredentials {
  sessdata: string
  biliJct: string
  mid?: string
  uname?: string
  avatar?: string
  savedAt?: number
  /** file = 扫码写入的 JSON；env = 手工配置的环境变量 */
  source: 'file' | 'env'
}

const DATA_DIR = join(process.cwd(), 'data')
const CRED_FILE = join(DATA_DIR, 'bili-credentials.json')
const ENV_FILE = join(process.cwd(), '.env')

/* ---------- 轻量读取缓存（3s TTL，避免每次取流都打磁盘） ---------- */
let readCache: { ts: number; cred: BiliCredentials | null } | null = null
const READ_TTL = 3000

function readCredFile(): BiliCredentialFile | null {
  try {
    if (!existsSync(CRED_FILE)) return null
    const raw = readFileSync(CRED_FILE, 'utf8')
    const obj = JSON.parse(raw) as Partial<BiliCredentialFile>
    if (!obj || typeof obj.sessdata !== 'string' || !obj.sessdata.trim()) return null
    return {
      sessdata: obj.sessdata.trim(),
      biliJct: typeof obj.biliJct === 'string' ? obj.biliJct.trim() : '',
      mid: typeof obj.mid === 'string' ? obj.mid : undefined,
      uname: typeof obj.uname === 'string' ? obj.uname : undefined,
      avatar: typeof obj.avatar === 'string' ? obj.avatar : undefined,
      via: 'qr',
      savedAt: typeof obj.savedAt === 'number' ? obj.savedAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * 获取当前服务端凭据（带 3s 缓存）。
 * 未配置返回 null；配置了则 sessdata 一定非空。
 */
export async function getBiliCredentials(): Promise<BiliCredentials | null> {
  if (readCache && Date.now() - readCache.ts < READ_TTL) return readCache.cred
  let cred: BiliCredentials | null = null
  const fromFile = readCredFile()
  if (fromFile) {
    cred = {
      sessdata: fromFile.sessdata,
      biliJct: fromFile.biliJct,
      mid: fromFile.mid,
      uname: fromFile.uname,
      avatar: fromFile.avatar,
      savedAt: fromFile.savedAt,
      source: 'file',
    }
  } else {
    const sessdata = (process.env.BILI_SESSDATA || '').trim()
    const biliJct = (process.env.BILI_BILI_JCT || '').trim()
    if (sessdata) {
      cred = { sessdata, biliJct, source: 'env' }
    }
  }
  readCache = { ts: Date.now(), cred }
  return cred
}

/* ---------- .env 行级 upsert / 删除（保留文件其余内容与顺序） ---------- */

function upsertEnvLines(updates: Record<string, string>): void {
  try {
    let text = ''
    try {
      text = readFileSync(ENV_FILE, 'utf8')
    } catch {
      text = ''
    }
    const lines = text.split('\n')
    for (const [key, value] of Object.entries(updates)) {
      const re = new RegExp(`^\\s*${key}\\s*=.*$`)
      const idx = lines.findIndex((l) => re.test(l))
      const line = `${key}=${value}`
      if (idx >= 0) lines[idx] = line
      else lines.push(line)
    }
    writeFileSync(ENV_FILE, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8')
  } catch (err) {
    // .env 镜像写入失败不影响主流程（JSON 才是运行时权威源）
    console.error('[bili-credentials] .env upsert failed:', err)
  }
}

function removeEnvLines(keys: string[]): void {
  try {
    if (!existsSync(ENV_FILE)) return
    const text = readFileSync(ENV_FILE, 'utf8')
    const kept = text
      .split('\n')
      .filter((l) => !keys.some((k) => new RegExp(`^\\s*${k}\\s*=`).test(l)))
    writeFileSync(ENV_FILE, kept.join('\n'), 'utf8')
  } catch (err) {
    console.error('[bili-credentials] .env remove failed:', err)
  }
}

/* ---------- 写入 / 清除 ---------- */

/** 保存扫码登录抓取到的凭据：JSON 落盘 + .env 镜像 + 清空流缓存与读取缓存 */
export async function saveBiliCredentials(cred: {
  sessdata: string
  biliJct: string
  mid?: string
  uname?: string
  avatar?: string
}): Promise<void> {
  const file: BiliCredentialFile = {
    sessdata: cred.sessdata.trim(),
    biliJct: (cred.biliJct || '').trim(),
    mid: cred.mid,
    uname: cred.uname,
    avatar: cred.avatar,
    via: 'qr',
    savedAt: Date.now(),
  }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CRED_FILE, JSON.stringify(file, null, 2), 'utf8')
  // .env 镜像：让凭据在进程重启 / JSON 丢失后依旧生效
  upsertEnvLines({
    BILI_SESSDATA: file.sessdata,
    ...(file.biliJct ? { BILI_BILI_JCT: file.biliJct } : {}),
  })
  invalidateCaches()
}

/** 退出登录：删除 JSON 与 .env 中的凭据行，并清空流缓存 */
export async function clearBiliCredentials(): Promise<void> {
  try {
    rmSync(CRED_FILE, { force: true })
  } catch {
    /* noop */
  }
  removeEnvLines(['BILI_SESSDATA', 'BILI_BILI_JCT'])
  invalidateCaches()
}

function invalidateCaches(): void {
  readCache = null
  streamCacheClear()
}

/* ---------- 工具 ---------- */

/** 脱敏展示：前 4 位 + **** + 后 4 位 */
export function maskSessdata(s: string): string {
  const v = s.trim()
  if (v.length <= 8) return '****'
  return `${v.slice(0, 4)}****${v.slice(-4)}`
}

/** 用凭据调B站 nav 接口拿账号昵称/头像（失败返回 null，不影响主流程） */
export async function fetchBiliAccount(sessdata: string): Promise<{ mid?: string; uname?: string; avatar?: string } | null> {
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent': BROWSER_UA,
        Referer: 'https://www.bilibili.com/',
        Cookie: `SESSDATA=${sessdata}`,
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      code: number
      data?: { mid?: number; uname?: string; face?: string }
    }
    if (json.code !== 0 || !json.data?.mid) return null
    return {
      mid: String(json.data.mid),
      uname: json.data.uname || undefined,
      avatar: json.data.face || undefined,
    }
  } catch {
    return null
  }
}
