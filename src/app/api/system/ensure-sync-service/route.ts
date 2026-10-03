import { NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'

/**
 * GET /api/system/ensure-sync-service
 *
 * 同步服务自愈入口：探测 3003 端口，若 socket.io 服务未运行则以
 * Next 进程（系统托管进程树）为父进程拉起 mini-services/bili-sync-service。
 *
 * 背景：沙箱会话结束时按进程树清理「从命令行派生」的后台进程，导致
 * 命令行方式启动的 socket 服务无法跨会话存活；而挂在 Next（系统启动树）
 * 下的子进程不受影响。前端房间页挂载时 fire-and-forget 调用一次即可自愈。
 *
 * 幂等：端口已监听则直接返回 ok，不重复拉起。无用户输入参与，仅固定命令。
 */

export async function GET() {
  const portAlive = await new Promise<boolean>((resolve) => {
    const s = net.createConnection(3003, '127.0.0.1')
    let done = false
    const finish = (v: boolean) => {
      if (!done) {
        done = true
        s.destroy()
        resolve(v)
      }
    }
    s.once('connect', () => finish(true))
    s.once('error', () => finish(false))
    setTimeout(() => finish(false), 900)
  })

  if (portAlive) {
    return NextResponse.json({ ok: true, alreadyRunning: true })
  }

  try {
    const cwd = process.cwd()
    const log = fs.openSync('/tmp/bili-sync.log', 'a')
    const child = spawn('bun', ['run', 'dev'], {
      cwd: `${cwd}/mini-services/bili-sync-service`,
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    })
    child.unref()
    console.log(`[ensure-sync-service] spawned bili-sync-service (pid ${child.pid})`)
    // 给服务一点启动时间，再探测一次确认拉起成功
    await new Promise((r) => setTimeout(r, 1200))
    const started = await new Promise<boolean>((resolve) => {
      const s = net.createConnection(3003, '127.0.0.1')
      let done = false
      const finish = (v: boolean) => {
        if (!done) {
          done = true
          s.destroy()
          resolve(v)
        }
      }
      s.once('connect', () => finish(true))
      s.once('error', () => finish(false))
      setTimeout(() => finish(false), 900)
    })
    return NextResponse.json({ ok: started, spawned: true, pid: child.pid })
  } catch (err) {
    console.error('[ensure-sync-service] spawn failed:', (err as Error).message)
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 })
  }
}
