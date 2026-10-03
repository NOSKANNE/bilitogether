import { NextResponse } from 'next/server'
import { BROWSER_UA, isBvid, resolveCid } from '@/lib/bili-server'
import { getBiliCredentials } from '@/lib/bili-credentials'

/**
 * POST /api/bili/danmaku/send
 *
 * 发送B站弹幕（原生模式播放器顶部发送条）：
 * - 需要服务端B站登录凭据：扫码登录自动写入（SESSDATA + bili_jct 一起抓取），
 *   或手工配置 BILI_SESSDATA + BILI_BILI_JCT 环境变量（发送弹幕必须携带 CSRF token）
 * - 弹幕以服务端配置的B站账号身份发出（全员共用）
 * - 轻量防刷：同一 uid 5 秒内只能发一条；文本 1~100 字
 * - 未配置凭据时优雅降级：返回 403 + code，前端展示友好提示
 */

const SEND_COOLDOWN_MS = 5000
const lastSendAt = new Map<string, number>()

interface BiliPostResp {
  code: number
  message?: string
  data?: { dmid?: number }
}

export async function POST(req: Request) {
  try {
    const cred = await getBiliCredentials()
    const sessdata = cred?.sessdata || ''
    const biliJct = cred?.biliJct || ''

    if (!sessdata) {
      return NextResponse.json(
        { ok: false, code: 'NO_SESSDATA', error: '服务器未登录B站账号（可用右上角 Cookie 图标扫码登录），无法发送弹幕' },
        { status: 403 }
      )
    }
    if (!biliJct) {
      return NextResponse.json(
        { ok: false, code: 'NO_JCT', error: '服务器缺少 bili_jct（发送弹幕需要 CSRF token），请重新扫码登录' },
        { status: 403 }
      )
    }

    const body = (await req.json().catch(() => null)) as { bvid?: string; page?: number; text?: string; uid?: string } | null
    const bvid = (body?.bvid || '').trim()
    const page = Math.max(1, parseInt(String(body?.page || '1'), 10) || 1)
    const text = (body?.text || '').trim().slice(0, 100)
    const uid = (body?.uid || 'anon').slice(0, 64)

    if (!isBvid(bvid)) {
      return NextResponse.json({ ok: false, error: 'bvid 格式不正确' }, { status: 400 })
    }
    if (!text) {
      return NextResponse.json({ ok: false, error: '弹幕内容不能为空' }, { status: 400 })
    }

    // 防刷：同 uid 冷却 5s
    const now = Date.now()
    const last = lastSendAt.get(uid) || 0
    if (now - last < SEND_COOLDOWN_MS) {
      return NextResponse.json(
        { ok: false, code: 'TOO_FAST', error: '发送太频繁，休息一下吧' },
        { status: 429 }
      )
    }

    const resolved = await resolveCid(bvid, page)
    if (!resolved) {
      return NextResponse.json({ ok: false, error: '无法解析视频 cid' }, { status: 404 })
    }
    const { cid } = resolved

    // B站 web 端发送弹幕接口（与官方网页播放器同源）
    const form = new URLSearchParams({
      type: '1',
      oid: String(cid),
      msg: text,
      bmid: '',
      progress: '0',
      color: '16777215',
      fontsize: '25',
      pool: '0',
      mode: '1',
      rnd: String(Math.floor(now / 1000)),
      plat: '1',
      csrf: biliJct,
      csrf_token: biliJct,
    })

    const res = await fetch('https://api.bilibili.com/x/v2/dm/web/post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // 凭据是 Cookie 原样值（已含 %2C 等转义），必须原样回传；
        // 不可再 encodeURIComponent（会把 %2C 变成 %252C 导致B站 -101）
        Cookie: `SESSDATA=${sessdata}; bili_jct=${biliJct}`,
        Referer: `https://www.bilibili.com/video/${bvid}/`,
        Origin: 'https://www.bilibili.com',
        'User-Agent': BROWSER_UA,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    })

    const json = (await res.json().catch(() => null)) as BiliPostResp | null
    if (!json) {
      // B站 WAF 对异常请求返回非 JSON（如 412 HTML），真实凭据下不应出现
      return NextResponse.json(
        { ok: false, error: `B站接口响应异常（HTTP ${res.status}），若持续出现请重新扫码登录` },
        { status: 502 }
      )
    }
    if (json.code !== 0) {
      // -101 未登录（SESSDATA 失效）、-111 csrf 校验失败、352 风控拦截、364 需要答题等
      const hint =
        json.code === -101
          ? '服务端B站登录凭据已失效，请重新扫码登录（右上角 Cookie 图标）'
          : json.code === -111
            ? 'bili_jct 与 SESSDATA 不匹配，请重新扫码登录'
            : json.code === 352
              ? '弹幕被B站风控拦截（敏感词或账号风控）'
              : json.code === 364
                ? '该账号需要先通过B站答题才能发弹幕'
                : json.message || `B站返回 ${json.code}`
      return NextResponse.json({ ok: false, code: `BILI_${json.code}`, error: hint }, { status: 502 })
    }

    lastSendAt.set(uid, now)
    if (lastSendAt.size > 1000) lastSendAt.clear()
    return NextResponse.json({ ok: true, dmid: json.data?.dmid ?? null })
  } catch (err) {
    console.error('[bili/danmaku/send] failed:', err)
    return NextResponse.json({ ok: false, error: '发送弹幕失败' }, { status: 500 })
  }
}
