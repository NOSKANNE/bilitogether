import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: ["*.space-z.ai"],
  // 2026-10-05: prisma schema 新增 Room.settings 字段后触碰本文件触发 dev server
  // 受控重启，使运行中的 Next 进程重新加载再生成的 Prisma Client（旧进程 require
  // 缓存中的 client 不认识新列，PATCH settings 会报 Unknown argument）。
};

export default nextConfig;
