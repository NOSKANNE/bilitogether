/**
 * Node.js 运行时专用的 instrumentation 逻辑（由 instrumentation.ts 在
 * NEXT_RUNTIME === 'nodejs' 分支动态加载）。
 *
 * 作用：把 socket.io 同步服务（mini-services/bili-sync-service，端口 3003）
 * 作为 Next 进程树的子进程拉起。这样它的生命周期与 Next dev server 一致：
 * - 沙箱/cron 会话结束时按进程树清理「从命令行会话派生」的后代，
 *   而挂在 Next（系统托管进程树）下的子进程不受影响；
 * - Next 重启（db:push 后受控重启等）时 socket 服务随之重启，行为可预期。
 *
 * 防重复：spawn 前先探测 3003 是否已有服务监听（人工/上一次拉起的实例），有则跳过。
 */
export async function registerNode() {
  try {
    const net = await import('node:net')
    const { spawn } = await import('node:child_process')
    const fs = await import('node:fs')

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
    if (portAlive) return

    const cwd = process.cwd()
    const log = fs.openSync('/tmp/bili-sync.log', 'a')
    const child = spawn('bun', ['run', 'dev'], {
      cwd: `${cwd}/mini-services/bili-sync-service`,
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    })
    child.unref()
    console.log(`[instrumentation] bili-sync-service spawned bili-sync (pid ${child.pid})`)
  } catch (err) {
    console.error('[instrumentation] failed to spawn bili-sync-service:', (err as Error).message)
  }
}
