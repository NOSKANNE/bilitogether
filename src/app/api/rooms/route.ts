import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generateRoomCode } from '@/lib/bili'

/** POST /api/rooms — 创建房间 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const name = (body?.name || '').toString().trim().slice(0, 30) || '我的观影房'
    const creatorName = (body?.creatorName || '').toString().trim().slice(0, 20) || '房主'

    // 生成不重复的 6 位房间码
    let code = ''
    for (let i = 0; i < 10; i++) {
      const candidate = generateRoomCode()
      const exists = await db.room.findUnique({ where: { code: candidate } })
      if (!exists) {
        code = candidate
        break
      }
    }
    if (!code) {
      return NextResponse.json({ error: '房间码生成失败，请重试' }, { status: 500 })
    }

    const room = await db.room.create({
      data: { code, name, creatorName },
    })

    return NextResponse.json({ room })
  } catch (err) {
    console.error('[rooms] create failed:', err)
    return NextResponse.json({ error: '创建房间失败' }, { status: 500 })
  }
}
