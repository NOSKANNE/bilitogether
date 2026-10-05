import { NextResponse } from 'next/server'
import { BROWSER_UA, MOBILE_UA, isBvid, resolveCid } from '@/lib/bili-server'
import { getBiliCredentials } from '@/lib/bili-credentials'
import { streamCacheGet, streamCacheSet } from '@/lib/bili-stream-cache'
import { buildDashMpd, parseSidxSegments, type DashMpdAudioInput, type DashMpdVideoInput } from '@/lib/bili-dash'

/**
 * GET /api/bili/playurl?bvid=&page=&qn=&fmt=dash|mp4
 *
 * 真实视频流解析（原生播放器模式的核心）：
 *
 * 【fmt=dash（默认，浏览器支持 MSE 时）】
 * - 服务端以 fnval=4048 + fourk=1 调用 B站 playurl（DASH：音视频分离的 fMP4 全文件）
 * - **这是 1080P 及以上画质的唯一路径**：platform=html5 的渐进式 MP4 流上限只有 720P
 * - 解析所选 m4s 的 sidx 索引 → 生成单 Representation MPD（媒体经 /api/bili/media 代理）
 * - 前端 dash.js（MSE）播放；登录凭据（扫码写入 data/bili-credentials.json 或 .env）
 *   可解锁 1080P/1080P+/4K（取决于账号权益）
 *
 * 【fmt=mp4（回退：不支持 MSE 的老浏览器 / DASH 解析失败）】
 * - platform=html5 渐进式 MP4，<video> 直接播（上限 720P）
 *
 * 共通：
 * - 返回 B站实际授予的画质（quality）+ 可选画质列表（accept_quality/description）
 * - 抗风控：识别"15s 其他视频预览片段"响应并用 pagelist 真实时长交叉校验，轮换指纹重试
 * - 扫码登录/退出会自动清空本路由缓存
 */

interface DashRepr {
  id: number
  codecs?: string
  bandwidth?: number
  width?: number
  height?: number
  frameRate?: string
  audioSamplingRate?: number
  baseUrl?: string
  backupUrl?: string[]
}

interface PlayurlApiResponse {
  code: number
  message?: string
  data?: {
    quality?: number
    timelength?: number
    accept_quality?: number[]
    accept_description?: string[]
    dash?: {
      video?: DashRepr[]
      audio?: DashRepr[]
      dolby?: unknown
      flac?: unknown
    }
    durl?: {
      length?: number
      size?: number
      url?: string
      backup_url?: string[]
    }[]
  }
}

export interface StreamSegment {
  url: string
  backups: string[]
  /** 分片时长（秒） */
  length: number
  size: number
}

export interface PlayurlResult {
  type: 'dash' | 'mp4'
  quality: number
  qualities: { qn: number; desc: string }[]
  segments: StreamSegment[]
  /** dash 模式下的 MPD 清单（XML 文本，媒体地址指向本站代理） */
  mpd?: string
  totalLength: number
  logged: boolean
}

const streamCacheTtl = 10 * 60 * 1000

function toHttps(u: string): string {
  return u.startsWith('http://') ? `https://${u.slice(7)}` : u
}

/** 请求 playurl（单次，variant 用于轮换指纹对抗风控） */
async function fetchPlayurl(
  bvid: string,
  cid: number,
  qn: number,
  sessdata: string,
  fmt: 'dash' | 'mp4',
  variant = 0
): Promise<PlayurlApiResponse | null> {
  const params = new URLSearchParams({
    bvid,
    cid: String(cid),
    qn: String(qn),
    type: '',
    otype: 'json',
    fnver: '0',
  })
  if (fmt === 'dash') {
    // DASH 全特性：16(DASH)+64(HDR)+128(4K)+256(杜比音效)+512(杜比视界)+1024(8K)+2048(AV1)
    params.set('fnval', '4048')
    params.set('fourk', '1')
    params.set('platform', 'pc')
  } else {
    // 渐进式 MP4（上限 720P，仅作为 MSE 不可用时的回退）
    params.set('fnval', '0')
    params.set('platform', 'html5')
    params.set('high_quality', '1')
  }
  const headers: Record<string, string> = {
    'User-Agent': variant === 2 ? MOBILE_UA : BROWSER_UA,
    Referer: 'https://www.bilibili.com/',
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  const cookies: string[] = []
  if (sessdata) cookies.push(`SESSDATA=${sessdata}`)
  // 随机 buvid3：B站 WAF 用 buvid3 识别机器人，携带随机值可显著降低风控概率
  cookies.push(`buvid3=${crypto.randomUUID()}infoc`)
  headers.Cookie = cookies.join('; ')
  try {
    const res = await fetch(`https://api.bilibili.com/x/player/playurl?${params.toString()}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    return (await res.json()) as PlayurlApiResponse
  } catch {
    return null
  }
}

/** 风控检测：B站对可疑客户端会返回一段 15s 的其他视频预览片段，用真实时长交叉校验 */
function isRiskControlled(json: PlayurlApiResponse, expectedDur: number): boolean {
  if (!json.data) return false
  const d = json.data
  if (!expectedDur || expectedDur < 30) return false // 无法校验
  const tl = (d.timelength || 0) / 1000
  if (tl > 0 && tl < expectedDur * 0.9) return true
  const segLenMs = d.durl?.reduce((acc, s) => acc + (s.length || 0), 0) || 0
  if (segLenMs > 0 && segLenMs / 1000 < expectedDur * 0.9) return true
  return false
}

/** 从 DASH 响应中选择要播放的视频/音频 Representation（优先 avc1 编码保证通用兼容） */
function pickDashRepresentations(d: NonNullable<PlayurlApiResponse['data']>): {
  video: DashMpdVideoInput | null
  audio: DashMpdAudioInput | null
} {
  const vids = (d.dash?.video || []).filter((v) => v.baseUrl)
  const auds = (d.dash?.audio || []).filter((v) => v.baseUrl)
  if (vids.length === 0 || auds.length === 0) return { video: null, audio: null }

  const granted = d.quality || 0
  const avcPool = vids.filter((v) => (v.codecs || '').startsWith('avc1'))
  const pool = avcPool.length > 0 ? avcPool : vids
  // 命中授予画质的优先，其次取池内最高画质（B站返回已按 id 降序）
  const chosen = pool.find((v) => v.id === granted) || pool[0]

  const pickToRepr = (r: DashRepr): DashMpdVideoInput & DashMpdAudioInput => ({
    url: toHttps(r.baseUrl!),
    backups: (r.backupUrl || []).filter(Boolean).map(toHttps),
    codecs: r.codecs || 'avc1.640028',
    bandwidth: r.bandwidth || Math.max(200000, ((r.width || 1280) * (r.height || 720) * 8) / 6),
    width: r.width || 1280,
    height: r.height || 720,
    frameRate: /^\d+(\/\d+)?$/.test(r.frameRate || '') ? r.frameRate : undefined,
    audioSamplingRate: r.audioSamplingRate,
    sidx: null,
  })

  const audio = auds.slice().sort((x, y) => (y.bandwidth || 0) - (x.bandwidth || 0))[0]
  return { video: pickToRepr(chosen), audio: pickToRepr(audio) }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    // 注意：BV 号大小写敏感，绝不能 toUpperCase（BV1GJ411x7h7 ≠ BV1GJ411X7H7）
    const bvid = (searchParams.get('bvid') || '').trim()
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const qn = parseInt(searchParams.get('qn') || '64', 10) || 64
    const fmt = searchParams.get('fmt') === 'mp4' ? 'mp4' : 'dash'

    if (!isBvid(bvid)) {
      return NextResponse.json({ error: 'bvid 格式不正确' }, { status: 400 })
    }

    const cacheKey = `${bvid}|${page}|${qn}|${fmt}`
    const cached = streamCacheGet<PlayurlResult>(cacheKey, streamCacheTtl)
    if (cached) {
      return NextResponse.json({ ok: true, cached: true, requestedQn: qn, ...cached })
    }

    const { sessdata } = (await getBiliCredentials()) ?? { sessdata: '' }

    const resolved = await resolveCid(bvid, page)
    if (!resolved) {
      return NextResponse.json({ error: '无法获取视频 cid（B站接口受限或视频不存在）', code: 'NO_CID' }, { status: 404 })
    }
    const { cid, durations } = resolved
    const expectedDur = durations[page] || durations[1] || 0

    /** 请求单次指纹（多指纹轮换在调用处展开），并用真实时长校验（对抗B站「15s 预览片」风控） */
    const resolveWithVariants = async (f: 'dash' | 'mp4'): Promise<{ json: PlayurlApiResponse | null; riskControlled: boolean }> => {
      let json: PlayurlApiResponse | null = null
      let riskControlled = false
      for (const variant of [0, 1, 2]) {
        const j = await fetchPlayurl(bvid, cid, qn, sessdata, f, variant)
        if (!j) continue
        if (j.code !== 0 || !j.data) {
          json = j
          continue
        }
        if (isRiskControlled(j, expectedDur)) {
          riskControlled = true
          continue
        }
        json = j
        riskControlled = false
        break
      }
      return { json, riskControlled }
    }

    /** mp4（渐进式）流组装 */
    const buildMp4Result = (j: PlayurlApiResponse | null, riskControlled: boolean): NextResponse | { result: PlayurlResult } => {
      if (!j) {
        return NextResponse.json({ error: 'B站播放地址接口请求失败', code: 'UPSTREAM_FAIL' }, { status: 502 })
      }
      if (j.code !== 0 || !j.data) {
        return NextResponse.json(
          { error: `B站接口返回错误：${j.message || j.code}`, code: 'BILI_ERR' },
          { status: 502 }
        )
      }
      if (riskControlled || isRiskControlled(j, expectedDur)) {
        return NextResponse.json(
          { error: 'B站风控：返回的是预览片段而非正片，请稍后重试或切换兼容模式', code: 'RISK_CONTROL' },
          { status: 502 }
        )
      }
      const d = j.data
      const segments: StreamSegment[] = []
      for (const seg of d.durl || []) {
        if (!seg.url) continue
        segments.push({
          url: toHttps(seg.url),
          backups: (seg.backup_url || []).filter(Boolean).map(toHttps),
          length: (seg.length || 0) / 1000,
          size: seg.size || 0,
        })
      }
      if (segments.length === 0) {
        return NextResponse.json(
          { error: '未获取到可播放的流地址（可能该视频不支持网页直链播放）', code: 'NO_DURL' },
          { status: 502 }
        )
      }
      return {
        result: {
          type: 'mp4',
          quality: d.quality || qn,
          qualities: (d.accept_quality || [])
            .map((q, i) => ({ qn: q, desc: d.accept_description?.[i] || `${q}P` }))
            .filter((x) => x.qn > 0),
          segments,
          totalLength: (d.timelength || 0) / 1000,
          logged: !!sessdata,
        },
      }
    }

    /* ---------------- 主路径：DASH（1080P+ 唯一来源） ---------------- */
    if (fmt === 'dash') {
      const { json, riskControlled } = await resolveWithVariants('dash')
      if (json && json.code === 0 && json.data && !riskControlled && !isRiskControlled(json, expectedDur) && json.data.dash?.video?.length) {
        const d = json.data
        const { video, audio } = pickDashRepresentations(d)
        if (video && audio) {
          // 完整解析两个流的 sidx 引用表（每个分片字节区间 + 时长），SegmentList 型 MPD 必需
          const [vSidx, aSidx] = await Promise.all([
            parseSidxSegments(video.url, 'https://www.bilibili.com/', BROWSER_UA),
            parseSidxSegments(audio.url, 'https://www.bilibili.com/', BROWSER_UA),
          ])
          if (vSidx && aSidx) {
            const totalLength = (d.timelength || 0) / 1000
            const mpd = buildDashMpd({
              durationSec: totalLength > 1 ? totalLength : expectedDur,
              video: { ...video, sidx: vSidx },
              audio: { ...audio, sidx: aSidx },
            })
            const result: PlayurlResult = {
              type: 'dash',
              quality: d.quality || qn,
              qualities: (d.accept_quality || [])
                .map((q, i) => ({ qn: q, desc: d.accept_description?.[i] || `${q}P` }))
                .filter((x) => x.qn > 0),
              segments: [],
              mpd,
              totalLength,
              logged: !!sessdata,
            }
            streamCacheSet(cacheKey, result)
            return NextResponse.json({ ok: true, requestedQn: qn, ...result })
          }
          // sidx 解析失败（异常文件/网络抖动）→ 落入 mp4 回退
        }
      }
      // DASH 不可用（无 dash 字段 / 风控 / 选流失败）→ 回退 mp4
    }

    /* ---------------- 回退路径：渐进式 MP4 ---------------- */
    const { json, riskControlled } = await resolveWithVariants('mp4')
    const out = buildMp4Result(json, riskControlled)
    if (out instanceof NextResponse) return out
    streamCacheSet(cacheKey, out.result)
    return NextResponse.json({ ok: true, requestedQn: qn, ...out.result })
  } catch (err) {
    console.error('[bili/playurl] failed:', err)
    return NextResponse.json({ error: '解析播放地址失败，请稍后重试' }, { status: 500 })
  }
}
