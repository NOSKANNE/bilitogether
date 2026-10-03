import { NextResponse } from 'next/server'
import { BROWSER_UA, fetchBiliAccount, saveBiliCredentials } from '@/lib/bili-credentials'

/**
 * GET /api/bili/login/qr/poll?qrcodeKey=xxx
 *
 * 轮询B站扫码登录状态（官方 passport 接口）：
 * - data.code: 86101=未扫描 / 86090=已扫描待确认 / 86038=二维码过期 / 0=登录成功
 * - 登录成功时 Set-Cookie 携带 SESSDATA / bili_jct / DedeUserID：
 *   服务端原样抓取（保留 %2C 等转义）→ 落盘 data/bili-credentials.json + .env 镜像
 *   → 清空 playurl 流缓存（下一次取流即用新凭据解锁高画质）
 * - 成功后顺带调 nav 接口拿账号昵称/头像回显
 */

interface BiliQrPollResp {
  code: number
  message?: string
  data?: {
    url?: string
    refresh_token?: string
    timestamp?: number
    code: number
    message?: string
  }
}

/** 从 Set-Cookie 数组中取某个 cookie 的原样 value（到第一个 ; 为止，不做任何解码） */
function pickCookie(setCookies: string[], name: string): string {
  for (const c of setCookies) {
    const pair = c.split(';')[0] || ''
    const idx = pair.indexOf('=')
    if (idx > 0 && pair.slice(0, idx).trim() === name) {
      return pair.slice(idx + 1).trim()
    }
  }
  return ''
}

export async function GET(req: Request) {
  try {
    const qrcodeKey = (new URL(req.url).searchParams.get('qrcodeKey') || '').trim()
    if (!qrcodeKey || qrcodeKey.length > 128) {
      return NextResponse.json({ ok: false, error: 'qrcodeKey 无效' }, { status: 400 })
    }

    const res = await fetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          Referer: 'https://passport.bilibili.com/',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      }
    )
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `B站轮询接口请求失败（${res.status}）` }, { status: 502 })
    }
    const json = (await res.json()) as BiliQrPollResp
    const stateCode = json.data?.code ?? -1

    if (stateCode === 86101) {
      return NextResponse.json({ ok: true, state: 'waiting' })
    }
    if (stateCode === 86090) {
      return NextResponse.json({ ok: true, state: 'scanned' })
    }
    if (stateCode === 86038) {
      return NextResponse.json({ ok: true, state: 'expired' })
    }

    if (stateCode === 0) {
      // 登录成功：从 Set-Cookie 抓取凭据（getSetCookie 在 Node 18.14+/Bun 均可用）
      let setCookies: string[] = []
      try {
        setCookies = res.headers.getSetCookie?.() ?? []
      } catch {
        setCookies = []
      }
      if (setCookies.length === 0) {
        // 兜底：部分运行时会合并成一个 set-cookie 头（cookie 值内为 URL 编码，无裸逗号，可安全按 ;, 分割）
        const merged = res.headers.get('set-cookie') || ''
        setCookies = merged
          .split(/,(?=[^;]+?=)/)
          .map((s) => s.trim())
          .filter(Boolean)
      }

      const sessdata = pickCookie(setCookies, 'SESSDATA')
      const biliJct = pickCookie(setCookies, 'bili_jct')
      const mid = pickCookie(setCookies, 'DedeUserID')

      if (!sessdata) {
        console.error('[bili/login/qr/poll] success but no SESSDATA cookie:', setCookies.length)
        return NextResponse.json(
          { ok: false, error: '登录成功但未能捕获登录凭据，请重试' },
          { status: 502 }
        )
      }

      // 落盘 JSON + .env 镜像，并清空流缓存
      await saveBiliCredentials({ sessdata, biliJct, mid: mid || undefined })

      // 拿账号昵称/头像回显（失败不影响登录）
      const account = await fetchBiliAccount(sessdata)
      if (account) {
        // 把昵称头像补进凭据文件（重新 save，缓存同步刷新）
        await saveBiliCredentials({ sessdata, biliJct, ...account })
      }

      console.log(
        `[bili/login/qr/poll] QR login success: mid=${account?.mid || mid || '?'} uname=${account?.uname || '?'} sessdata=${sessdata.slice(0, 4)}****`
      )
      return NextResponse.json({
        ok: true,
        state: 'confirmed',
        account: account
          ? { mid: account.mid, uname: account.uname, avatar: account.avatar }
          : mid
            ? { mid, uname: undefined, avatar: undefined }
            : null,
      })
    }

    return NextResponse.json(
      { ok: false, error: `B站返回未知状态：${json.data?.message || stateCode}` },
      { status: 502 }
    )
  } catch (err) {
    console.error('[bili/login/qr/poll] failed:', err)
    return NextResponse.json({ ok: false, error: '轮询登录状态失败' }, { status: 500 })
  }
}
