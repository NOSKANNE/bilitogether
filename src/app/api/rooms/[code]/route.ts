import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

type RouteParams = { params: Promise<{ code: string }> }

/** GET /api/rooms/[code] — 房间详情 + 播放列表 + 历史观看统计（供同步服务水合 & 前端查询） */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { code } = await params
    const roomCode = code.toUpperCase()
    const room = await db.room.findUnique({
      where: { code: roomCode },
      include: { playlist: { orderBy: { addedAt: 'asc' } } },
    })
    if (!room) {
      return NextResponse.json({ error: '房间不存在' }, { status: 404 })
    }
    // 历史观看统计（uid -> 累计秒数），供同步服务在成员加入时播种
    const watchStats = await db.watchStat.findMany({
      where: { roomCode },
      select: { uid: true, name: true, seconds: true },
    })
    return NextResponse.json({ room, watchStats })
  } catch (err) {
    console.error('[rooms] get failed:', err)
    return NextResponse.json({ error: '获取房间失败' }, { status: 500 })
  }
}

/** PATCH /api/rooms/[code] — 同步服务持久化播放状态（bvid/page/quality/... 或整表替换 playlist） */
export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const { code } = await params
    const body = await req.json().catch(() => ({}))
    const room = await db.room.findUnique({ where: { code: code.toUpperCase() } })
    if (!room) {
      return NextResponse.json({ error: '房间不存在' }, { status: 404 })
    }

    const data: Record<string, unknown> = {}
    for (const key of ['bvid', 'page', 'title', 'cover', 'upName', 'duration', 'quality', 'danmaku', 'loop'] as const) {
      if (key in body) data[key] = body[key]
    }

    // playlist: 全量替换
    let playlistOp: Record<string, unknown> | undefined
    if (Array.isArray(body.playlist)) {
      playlistOp = {
        playlist: {
          deleteMany: {},
          create: body.playlist.slice(0, 50).map((item: Record<string, unknown>, i: number) => ({
            bvid: String(item.bvid || ''),
            page: Number(item.page || 1),
            title: String(item.title || ''),
            cover: (item.cover as string | null) ?? null,
            upName: (item.upName as string | null) ?? null,
            duration: Number(item.duration || 0),
            addedBy: String(item.addedBy || ''),
            addedAt: new Date(Date.now() + i),
          })),
        },
      }
    }

    const updated = await db.room.update({
      where: { code: code.toUpperCase() },
      data: { ...data, ...playlistOp },
      include: { playlist: { orderBy: { addedAt: 'asc' } } },
    })

    return NextResponse.json({ ok: true, room: updated })
  } catch (err) {
    console.error('[rooms] patch failed:', err)
    return NextResponse.json({ error: '更新房间失败' }, { status: 500 })
  }
}
