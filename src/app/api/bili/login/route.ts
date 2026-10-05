import { NextResponse } from 'next/server'
import { clearBiliCredentials, getBiliCredentials, maskSessdata } from '@/lib/bili-credentials'

/**
 * GET /api/bili/login   — 查询服务端B站凭据状态（脱敏摘要，绝不返回原始 SESSDATA）
 * DELETE /api/bili/login — 退出登录：清除扫码写入的凭据（JSON + .env 行），清空流缓存
 *
 * 注意：手工配置在 .env 的 BILI_SESSDATA 无法通过 DELETE 清除（source='env' 时 DELETE 返回提示）。
 */

export async function GET() {
  try {
    const cred = await getBiliCredentials()
    if (!cred) {
      return NextResponse.json({ ok: true, configured: false, source: null })
    }
    return NextResponse.json({
      ok: true,
      configured: true,
      source: cred.source,
      sessdataMask: maskSessdata(cred.sessdata),
      hasJct: !!cred.biliJct,
      mid: cred.mid || null,
      uname: cred.uname || null,
      avatar: cred.avatar || null,
      savedAt: cred.savedAt || null,
    })
  } catch (err) {
    console.error('[bili/login] status failed:', err)
    return NextResponse.json({ ok: false, error: '查询凭据状态失败' }, { status: 500 })
  }
}

export async function DELETE() {
  try {
    const cred = await getBiliCredentials()
    if (cred?.source === 'env') {
      return NextResponse.json(
        {
          ok: false,
          code: 'ENV_SOURCE',
          error: '当前凭据来自 .env 手工配置，请在服务器上编辑 .env 移除（扫码写入的凭据才能在线退出）',
        },
        { status: 400 }
      )
    }
    await clearBiliCredentials()
    console.log('[bili/login] credentials cleared (logout)')
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[bili/login] logout failed:', err)
    return NextResponse.json({ ok: false, error: '退出登录失败' }, { status: 500 })
  }
}
