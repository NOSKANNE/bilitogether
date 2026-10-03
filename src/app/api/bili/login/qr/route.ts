import { NextResponse } from 'next/server'
import { BROWSER_UA } from '@/lib/bili-credentials'

/**
 * GET /api/bili/login/qr
 *
 * 生成B站扫码登录二维码：
 * - 服务端代理 passport.bilibili.com 的官方 QR 登录接口（generate）
 * - 返回 qrcodeKey（轮询凭证）+ qrUrl（前端渲染成二维码，B站 App 扫一扫即可登录）
 * - 二维码有效期 180 秒（B站约定），过期后前端重新生成
 */

interface BiliQrGenerateResp {
  code: number
  message?: string
  data?: { qrcode_key: string; url: string }
}

export async function GET() {
  try {
    const res = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      headers: {
        'User-Agent': BROWSER_UA,
        Referer: 'https://passport.bilibili.com/',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `B站登录接口请求失败（${res.status}）` }, { status: 502 })
    }
    const json = (await res.json()) as BiliQrGenerateResp
    if (json.code !== 0 || !json.data?.qrcode_key || !json.data?.url) {
      return NextResponse.json(
        { ok: false, error: `B站返回错误：${json.message || json.code}` },
        { status: 502 }
      )
    }
    return NextResponse.json({
      ok: true,
      qrcodeKey: json.data.qrcode_key,
      qrUrl: json.data.url,
      expiresIn: 180,
    })
  } catch (err) {
    console.error('[bili/login/qr] failed:', err)
    return NextResponse.json({ ok: false, error: '生成登录二维码失败，请稍后重试' }, { status: 500 })
  }
}
