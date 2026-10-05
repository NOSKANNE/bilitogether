/**
 * B站 DASH（fMP4）流辅助库（server-only）
 *
 * 背景：B站 `platform=html5&fnval=0` 的渐进式 MP4（durl）流上限只有 720P，
 * 1080P 及以上必须走 DASH（fnval=4048）。DASH 的 video/audio 是分离的 fMP4 全文件，
 * 浏览器需通过 MSE 播放（dash.js）。
 *
 * 本库负责：
 * 1. 解析 B站 m4s 文件头部的 box 结构（ftyp→moov→sidx），**完整解析 sidx 引用表**，
 *    得到每个媒体分片的字节区间与时长；
 * 2. 生成 `<SegmentList>` 型 MPD（显式 mediaRange + 精确 SegmentTimeline）。
 *    注：不使用 SegmentBase@indexRange —— dash.js v5 对该属性解析存在 NaN 怪癖
 *    （实测 indexRange 未被读取，分片请求 Range: bytes=NaN-NaN），
 *    而 SegmentList + 显式 mediaRange 是 dash.js 最稳的路径；
 * 3. 媒体地址指向本站 /api/bili/media 代理（浏览器直连B站 CDN 存在
 *    Referer/CORS 混合策略问题 + 间歇性 403 抖动，服务端代理是唯一稳定路径）；
 * 4. 媒体代理的域名白名单校验（防 SSRF）。
 */

/** B站媒体 CDN 白名单后缀（严格 https + 后缀匹配，防 SSRF） */
const ALLOWED_HOST_SUFFIXES = ['.bilivideo.com', '.akamaized.net', '.szbdyd.com']

export function isAllowedMediaHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const host = u.hostname.toLowerCase()
    return ALLOWED_HOST_SUFFIXES.some((sfx) => host === sfx.slice(1) || host.endsWith(sfx))
  } catch {
    return false
  }
}

export interface SidxParsed {
  /** ftyp+moov 初始化区：`0-{initEnd}` */
  initRange: string
  /** 媒体 timescale（sidx 内） */
  timescale: number
  /** 每个分片：字节区间 + 以 timescale 计的时长 */
  segments: { mediaRange: string; duration: number }[]
}

/**
 * 下载 m4s 头部（ftyp→moov→sidx），完整解析 sidx 引用表。
 * B站 DASH 文件布局实测：ftyp → free*(可选) → moov → sidx → moof/mdat...
 * sidx entry：reference(4B: 1bit 引用类型 + 31bit 分片大小) + subsegment_duration(4B) + sap(4B)
 */
export async function parseSidxSegments(url: string, referer: string, ua: string): Promise<SidxParsed | null> {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-131071', Referer: referer, 'User-Agent': ua },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const head = new Uint8Array(await res.arrayBuffer())
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)

    /* ---- 第一遍：box walk 定位 sidx ---- */
    let off = 0
    let sidxStart = -1
    let sidxSize = 0
    while (off + 8 <= head.byteLength) {
      let size = dv.getUint32(off)
      const type = String.fromCharCode(head[off + 4], head[off + 5], head[off + 6], head[off + 7])
      if (size === 1) size = dv.getUint32(off + 8) * 2 ** 32 + dv.getUint32(off + 12)
      else if (size === 0) break
      if (size < 8) return null
      if (type === 'sidx') {
        sidxStart = off
        sidxSize = size
        break
      }
      if (type === 'moof') return null // 无全局索引
      off += size
    }
    if (sidxStart < 0) return null
    const initRange = `0-${sidxStart - 1}`
    const sidxEnd = sidxStart + sidxSize - 1

    /* ---- 第二遍：解析 sidx 内容 ----
     * 布局（ISO 14496-12）：
     *   +0 size(4) +4 type(4) +8 version(1) +9 flags(3)
     *   +12 reference_ID(4) +16 timescale(4)
     *   v0: +20 earliest_presentation_time(4) +24 first_offset(4) +28 reserved(2) +30 reference_count(2) +32 entries(12B each)
     *   v1: +20 earliest(8) +28 first_offset(8) +36 reserved(2) +38 reference_count(2) +40 entries
     */
    const version = dv.getUint8(sidxStart + 8)
    const timescale = dv.getUint32(sidxStart + 16) || 1000
    const entryBase = sidxStart + 12 + 4 + 4 + (version === 0 ? 8 : 16) + 4
    const firstOffset = version === 0 ? dv.getUint32(sidxStart + 24) : 0
    const refCount = dv.getUint16(entryBase - 2)
    if (refCount === 0 || refCount > 5000) return null

    // 首个媒体分片起始 = sidx 结束 + first_offset
    let offset = sidxEnd + 1 + firstOffset
    const segments: { mediaRange: string; duration: number }[] = []
    for (let i = 0; i < refCount; i++) {
      const p = entryBase + i * 12
      if (p + 12 > head.byteLength) return null // 超出预取头部（异常大 moov）
      const refWord = dv.getUint32(p)
      const referencedSize = refWord & 0x7fffffff
      const duration = dv.getUint32(p + 4)
      if (referencedSize === 0) return null
      segments.push({ mediaRange: `${offset}-${offset + referencedSize - 1}`, duration })
      offset += referencedSize
    }
    return { initRange, timescale, segments }
  } catch {
    return null
  }
}

export interface DashStreamRepr {
  /** 上游真实流地址（主） */
  url: string
  /** 上游备用地址 */
  backups: string[]
  codecs: string
  bandwidth: number
  /** sidx 完整解析结果（选流后异步解析填充；生成 MPD 前必非空） */
  sidx: SidxParsed | null
}

export interface DashMpdVideoInput extends DashStreamRepr {
  width: number
  height: number
  frameRate?: string
}

export interface DashMpdAudioInput extends DashStreamRepr {
  audioSamplingRate?: number
}

/** 生成经本站代理的媒体 URL（主 + 备用轮换列表） */
export function buildProxyMediaUrl(stream: { url: string; backups: string[] }): string {
  const q = new URLSearchParams()
  q.set('u', stream.url)
  const validBackups = stream.backups.filter(isAllowedMediaHost)
  if (validBackups.length > 0) q.set('b', validBackups.join(','))
  return `/api/bili/media?${q.toString()}`
}

const xmlEsc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/**
 * 生成 MPD（SegmentList 模式，单视频 + 单音频 Representation）。
 * - 每个分片显式 mediaRange（来自 sidx 引用表）→ dash.js 零索引请求、任意 seek
 * - SegmentTimeline 提供每段精确时长（变长 GOP 下时间轴不漂移）
 */
/** sidx 已解析就绪的输入（生成 MPD 的前置条件） */
type DashMpdReady<T> = Omit<T, 'sidx'> & { sidx: SidxParsed }

export function buildDashMpd(opts: {
  durationSec: number
  video: DashMpdReady<DashMpdVideoInput>
  audio: DashMpdReady<DashMpdAudioInput>
}): string {
  const dur = `PT${Math.max(1, Math.round(opts.durationSec))}S`
  const repr = (r: DashMpdReady<DashMpdVideoInput> | DashMpdReady<DashMpdAudioInput>, isVideo: boolean): string => {
    const timeline = r.sidx.segments.map((s) => `<S d="${s.duration}"/>`).join('')
    const urls = r.sidx.segments.map((s) => `<SegmentURL mediaRange="${s.mediaRange}"/>`).join('')
    const attrs = isVideo
      ? ` width="${(r as DashMpdVideoInput).width}" height="${(r as DashMpdVideoInput).height}"${(r as DashMpdVideoInput).frameRate ? ` frameRate="${(r as DashMpdVideoInput).frameRate}"` : ''}`
      : `${(r as DashMpdAudioInput).audioSamplingRate ? ` audioSamplingRate="${(r as DashMpdAudioInput).audioSamplingRate}"` : ''}`
    return `    <AdaptationSet id="${isVideo ? 0 : 1}" contentType="${isVideo ? 'video' : 'audio'}" mimeType="${isVideo ? 'video' : 'audio'}/mp4" segmentAlignment="true" startWithSAP="1">
      <Representation id="${isVideo ? 'v0' : 'a0'}" codecs="${xmlEsc(r.codecs)}" bandwidth="${Math.max(1, Math.round(r.bandwidth))}"${attrs}>
        <BaseURL>${xmlEsc(buildProxyMediaUrl(r))}</BaseURL>
        <SegmentList timescale="${r.sidx.timescale}" duration="${r.sidx.segments[0]?.duration || 1}">
          <Initialization range="${r.sidx.initRange}"/>
          <SegmentTimeline>${timeline}</SegmentTimeline>
          ${urls}
        </SegmentList>
      </Representation>
    </AdaptationSet>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" profiles="urn:mpeg:dash:profile:isoff-main:2011" type="static" mediaPresentationDuration="${dur}" minBufferTime="1.5">
  <Period>
${repr(opts.video, true)}
${repr(opts.audio, false)}
  </Period>
</MPD>`
}
