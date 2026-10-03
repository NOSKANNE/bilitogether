/**
 * Next.js instrumentation：服务器启动时注册。
 *
 * Node 专属逻辑拆分到 instrumentation-node.ts 并仅在 nodejs 运行时分支加载——
 * 这是 Next 官方推荐模式；避免 Turbopack 为 edge 目标编译 node: 内建模块时
 * 输出「not supported in the Edge Runtime」警告（功能无碍但污染日志）。
 *
 * 注意：必须显式调用 registerNode()，仅 import 模块不会执行任何逻辑。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node')
    await registerNode()
  }
}
