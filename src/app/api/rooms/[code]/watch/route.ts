import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

type RouteParams = { params: Promise<{ code: string }> }

interface WatchDelta {
  uid: string
  name?: string
  seconds: number
}

/**
 * POST /api/rooms/[code]/watch — 观看时长批量上报（同步服务每 30s 刷一次盘）
 * body: { stats: [{ uid, name, seconds }] }，seconds 为增量（秒）
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { code } = await params
    const roomCode = code.toUpperCase()
    const body = await req.json().catch(() => ({}))
    const stats: WatchDelta[] = Array.isArray(body?.stats) ? body.stats : []
    if (stats.length === 0) {
      return NextResponse.json({ ok: true, updated: 0 })
    }

    const room = await db.room.findUnique({ where: { code: roomCode }, select: { id: true } })
    if (!room) {
      return NextResponse.json({ error: '房间不存在' }, { status: 404 })
    }

    // 逐条增量 upsert（SQLite 无 bulk increment；条数 ≤ 成员数，开销可忽略）
    let updated = 0
    for (const s of stats) {
      const uid = String(s?.uid || '').slice(0, 64)
      const seconds = Number(s?.seconds || 0)
      if (!uid || !isFinite(seconds) || seconds <= 0) continue
      const clamped = Math.min(600, seconds) // 单次上报上限 10 分钟，防异常
      await db.watchStat.upsert({
        where: { roomCode_uid: { roomCode, uid } },
        create: { roomCode, uid, name: String(s?.name || '').slice(0, 20), seconds: clamped },
        update: {
          seconds: { increment: clamped },
          ...(s?.name ? { name: String(s.name).slice(0, 20) } : {}),
        },
      })
      updated++
    }

    return NextResponse.json({ ok: true, updated })
  } catch (err) {
    console.error('[watch] persist failed:', err)
    return NextResponse.json({ error: '观看统计写入失败' }, { status: 500 })
  }
}

/** GET /api/rooms/[code]/watch — 查询房间历史观看统计（调试/展示用） */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { code } = await params
    const stats = await db.watchStat.findMany({
      where: { roomCode: code.toUpperCase() },
      orderBy: { seconds: 'desc' },
      take: 100,
    })
    return NextResponse.json({ stats })
  } catch (err) {
    console.error('[watch] query failed:', err)
    return NextResponse.json({ error: '查询失败' }, { status: 500 })
  }
}
