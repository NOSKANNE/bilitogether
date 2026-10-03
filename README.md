<div align="center">

# 🎬 BiliTogether · B站视频多人同步观影

**和好朋友一起「云观影」：房主掌控播放，多端实时同步，扫码解锁高清画质，弹幕聊天一起嗨**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-149ECA?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![socket.io](https://img.shields.io/badge/socket.io-4-white?logo=socket.io&logoColor=black)](https://socket.io)
[![Bun](https://img.shields.io/badge/Bun-运行时-F9F1E1?logo=bun&logoColor=black)](https://bun.sh)
[![GitHub Stars](https://img.shields.io/github/stars/NOSKANNE/bilitogether?style=social&label=Star)](https://github.com/NOSKANNE/bilitogether/stargazers)

Next.js 16 · React 19 · socket.io · dash.js · Prisma (SQLite) · Tailwind CSS 4 · shadcn/ui

</div>

---

## ✨ 这是什么

BiliTogether 是一个自托管的 **B站视频多人同步观影网站**。创建一个房间，把 6 位房间码分享给朋友（手机/电脑都行），房主点播放，所有人的播放进度、暂停、拖动、画质、倍速全部实时同步——就像坐在同一张沙发上一起看视频。

不依赖任何第三方观影服务，一个 Node 进程 + 一个 socket.io 进程即可跑起来。

## 🌟 功能特性

### 同步观影核心
- 🎥 **多端实时同步**：房主播放/暂停/拖进度/切分P，全员毫秒级跟随；房主每 2s 心跳广播，观看端自动做漂移校正（偏差过大自动硬对齐）
- 👑 **房主权威模型**：只有房主能控制播放，房主掉线自动转移房主权限，支持抢房主
- 📶 **画质统一掌控**：房主切画质，全员跟随（480P ~ 1080P+，详见下方「画质解锁」）
- 🔁 **连播播放列表**：成员投稿 → 房主审批 → 自动连播；支持列表循环/单曲循环、房主「下一首」、拖拽排序、一键清空
- 📡 **断线自愈**：socket 无限重连 + 服务进程自动拉起，服务重启后掉线用户无需刷新自动回房，进度精确落位

### 高画质解锁（DASH 自托管播放器）
- 🔓 **站内扫码登录B站**：弹出B站官方二维码 → App 确认 → 服务端自动捕获凭据 → 全员当前视频**无缝升级画质**（进度不丢、无需刷新）
- 🚀 **dash.js (MSE) 自托管播放器**：服务端解析 DASH 流（sidx 分片索引）生成 MPD，绕开 html5 渐进式流的 720P 天花板——普通账号稳定 **1080P**，大会员账号可达 **1080P+/4K**
- 🛡️ **媒体安全代理**：视频/音频分片经服务端 Range 代理转发（Referer 伪装 + 主备 CDN 轮换 + 403 抖动退避重试 + 分片级 LRU 缓存 + 并发合并），同房多观众上游流量 N→1，并附 SSRF 域名白名单

### 互动体验
- 💬 **实时聊天**：侧栏聊天、正在输入提示、系统消息
- 🎊 **弹幕**：本地弹幕层随播放滚动，可一键开关；已登录B站账号可直接**以登录身份发送真实弹幕**到B站视频（含表情选择、关键词屏蔽）
- ⭐ **精彩时刻打点**：任何成员可一键打点当前画面时刻，全员可见、可跳转，气氛拉满时自动弹出庆祝横幅
- 🏆 **观看时长榜**：按成员累计真实观看时长排行（持久化存储，重启不丢失），在线/离线状态一目了然
- 📱 **移动端完整适配**：触屏手势 UI、响应式布局、PWA（可添加到主屏幕）

### 细节
- 🌗 **明暗双主题**（B站粉品牌色）、深色氛围光效
- ⌨️ **快捷键**：空格播放暂停、←/→ 快进退、↑/↓ 本机音量（仅自己听到）、F 全屏、D 弹幕开关……内含快捷键说明面板
- 🔊 **本机音量无级调节**：滑块/键盘精确控制，本地持久化，互不影响他人
- 🔗 **邀请方便**：房间码、邀请二维码、观看卡片分享一应俱全；最近房间一键重入
- 🩹 **错误友好**：房间不存在 / 服务自愈中的精确分流提示，告别误导性报错

## 🧱 技术架构

```
┌────────────┐   HTTP/WebSocket (同源或网关)   ┌─────────────────────────┐
│   浏览器    │ ────────────────────────────► │  Caddy / Nginx（可选网关）│
│ PC/手机/PWA │ ◄──────────────────────────── │                         │
└────────────┘                                └───────────┬─────────────┘
        │  页面 / REST API                                │ 按路由转发
        ▼                                                 ▼
┌──────────────────────────┐                   ┌──────────────────────┐
│  Next.js 16 (App Router) │ ◄── REST 回写 ──  │  bili-sync-service    │
│  - React 19 + shadcn/ui  │  (127.0.0.1:3000) │  socket.io (:3003)    │
│  - B站 API 代理路由       │                   │  房间运行时状态权威源   │
│  - DASH MPD 生成         │                   │  (内存) + 断线自愈     │
│  - 媒体 Range 代理       │                   └──────────────────────┘
│  - Prisma (SQLite 持久化) │
└───────────┬──────────────┘
            │ 伪 Referer / Range / 重试
            ▼
     B站 API & CDN（upos / akamai / szbdyd）
```

- **房间状态**：socket.io 服务（内存）为运行时权威源，房间/播放列表/观看统计经 Next.js REST 持久化到 SQLite，重启自动水合
- **同步协议**：`playback:state`（动作广播，revision 递增防乱序）+ `playback:tick`（2s 心跳 + 漂移校正）
- **高画质链路**：B站 playurl(DASH) → 服务端解析 m4s 的 sidx 分片表 → 生成 SegmentList MPD → dash.js MSE 播放 → 媒体字节经服务端代理

## 🚀 快速开始

### 环境要求

| 依赖 | 说明 |
| --- | --- |
| [Bun](https://bun.sh) ≥ 1.1 | 运行时（Next.js、同步服务、依赖安装都用它） |
| 端口 3000 / 3003 | Next 主服务与同步服务（3003 自动拉起，无需手工管理） |

> 同步服务由 Next.js 启动时**自动作为子进程拉起**（instrumentation 钩子），掉线还会自动自愈——你只需要管好一个 Next 进程。

### 三步跑起来

```bash
# 1. 安装依赖（主项目 + 同步服务）
bun install
cd mini-services/bili-sync-service && bun install && cd ../..

# 2. 配置环境变量并初始化数据库
cp .env.example .env        # 按需修改 DATABASE_URL
bun run db:push             # 创建 SQLite 表结构

# 3. 启动开发服务（同步服务会自动拉起）
bun run dev
```

打开 `http://localhost:3000` → 创建房间 → 粘贴一个B站视频链接（支持 BV/av 号、完整链接、b23.tv 短链、分P）→ 把房间码告诉朋友，开看！

### 生产构建

```bash
bun run build
bun run start
```

## ⚙️ 环境变量

完整说明见 [.env.example](.env.example)：

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | `file:./db/custom.db` | SQLite 数据库文件位置 |
| `NEXT_PUBLIC_SYNC_URL` | ❌ | `/?XTransformPort=3003` | 前端连接同步服务的地址（见下节） |
| `NEXT_API_URL` | ❌ | `http://127.0.0.1:3000` | 同步服务回访 Next REST API 的地址 |
| `BILI_SESSDATA` / `BILI_BILI_JCT` | ❌ | 无 | B站凭据（**推荐用站内扫码登录**，会自动写入并热生效） |

## 🔌 同步服务连接模式（重要）

前端默认通过 `/?XTransformPort=3003` 的网关查询参数连接 socket.io（Caddy 网关按查询参数转发端口）。自托管时按你的部署形态选择一种：

### 模式 A：网关式（默认，零配置）
使用本仓库附带的 [Caddyfile](Caddyfile) 模式：Caddy 监听 80/443，`XTransformPort=3003` 查询参数的请求转发到 3003，其余转发到 3000。**无需设置任何环境变量。**

### 模式 B：同源反向代理（推荐生产使用）
```bash
# .env
NEXT_PUBLIC_SYNC_URL=/
```
```nginx
# nginx：把 socket.io 反代到同步服务
location /socket.io/ {
    proxy_pass http://127.0.0.1:3003;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
location / {
    proxy_pass http://127.0.0.1:3000;
}
```
Caddy 等价配置：
```caddyfile
example.com {
    handle /socket.io/* {
        reverse_proxy 127.0.0.1:3003
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

### 模式 C：直连（局域网最简单）
```bash
# .env（注意是构建时变量，修改后需重新 build/dev）
NEXT_PUBLIC_SYNC_URL=http://192.168.1.10:3003
```
无需任何反代，浏览器直接连同步服务（服务端 CORS 已放开）。

## 🔓 B站画质解锁说明

| 状态 | 可用画质 | 弹幕发送 |
| --- | --- | --- |
| 未登录 | 720P 及以下 | ❌ |
| 扫码登录（普通账号） | **1080P** | ✅ |
| 扫码登录（大会员） | 1080P / 1080P+ / 4K | ✅ |

- 在房间内点击 **Cookie 图标** 或画质下拉中的「扫码解锁」入口即可弹出B站官方扫码登录，确认后全员当前视频**无缝**升级画质
- 凭据仅保存在服务器本地 `data/bili-credentials.json`（接口只回脱敏摘要，原始 SESSDATA 绝不下发前端）
- SESSDATA 有效期由B站侧决定，过期后画质自动回落 720P，重新扫码即可
- 服务端凭据为**全员共享**模型：后扫码者覆盖先扫码者（房间内指引有提示）

## 📁 项目结构

```
├── src/
│   ├── app/
│   │   ├── api/bili/          # B站相关：playurl(DASH/MP4)、resolve、弹幕、扫码登录、媒体Range代理
│   │   ├── api/rooms/         # 房间/播放列表持久化 REST
│   │   └── api/system/        # 同步服务自愈接口
│   ├── components/
│   │   ├── home-view.tsx      # 首页：创建/加入房间、最近房间
│   │   ├── room-view.tsx      # 房间页骨架
│   │   └── room/              # 播放器、控制条、弹幕层、侧栏、扫码登录弹窗等
│   ├── hooks/                 # socket 同步、dash 播放器、弹幕、流获取
│   ├── lib/                   # B站 API、DASH 解析、凭据管理、流缓存
│   └── store/                 # zustand 客户端状态
├── mini-services/
│   └── bili-sync-service/     # socket.io 同步服务（房间状态权威源，端口 3003）
├── prisma/schema.prisma       # Room / PlaylistItem / WatchStat
├── db/                        # SQLite 数据库文件（运行时生成）
├── data/                      # B站凭据缓存（运行时生成，已 gitignore）
└── Caddyfile                  # 网关模式参考配置
```

## ❓ 常见问题

**Q: 为什么需要自托管媒体代理，而不是浏览器直连B站 CDN？**
B站 CDN 对 Referer 的策略相互矛盾（主 CDN 要求带、备用 CDN 禁止），且存在间歇性 403，浏览器直连不可行。经服务端代理是唯一稳定路径，顺带获得了缓存合并、主备轮换与 SSRF 防护。

**Q: 播放会经过我的服务器，带宽要求是多少？**
1080P 约需 2.6 Mbps/观众。同房观众进度接近，服务端分片缓存会把「服务器→B站」的上游流量合并为 N→1；但「服务器→观众」的下行带宽仍是主要瓶颈，建议自托管服务器出口带宽 ≥ 观众数 × 2.6 Mbps。

**Q: 服务器重启后房间会丢吗？**
房间、播放列表、观看统计持久化在 SQLite，重启自动恢复；弹幕开关/精彩时刻/待审投稿为内存态，重启后清空。

**Q: 手机端画质低一些？**
不支持 MSE 的老设备（如旧 iOS）会自动回退 720P 渐进式 MP4 流，其余路径与桌面端一致。

**Q: 端口能改吗？**
Next 端口改 `package.json` 的 `dev`/`start` 脚本并设置 `NEXT_API_URL`；同步服务固定 3003（前端 `NEXT_PUBLIC_SYNC_URL` 配合任意反代即可灵活暴露）。

## ⚠️ 已知限制

- 媒体流量经服务器转发，自托管服务器的出口带宽是全房间画质/流畅度的上限
- 画质由房主统一指定（单 Representation MPD），弱网观众不会自动降码率（受控 ABR 在 Roadmap 中）
- B站风控或 WAF 拦截时，弹幕发送可能被拒绝（界面会提示重新扫码登录）
- 仅支持B站视频源（项目定位即「B站云观影」）

## 🗺️ Roadmap

- [ ] 弱网提示与手动降画质引导
- [ ] 多 Representation MPD + 受控 ABR（观看端自动降档）
- [ ] MediaSession 系统媒体键支持
- [ ] SESSDATA 失效探活与房间内提示条
- [ ] 房间码失效时一键重建同名房间并通知成员

## 📜 免责声明

本项目仅供学习交流与个人使用，不存储、不分发任何视频内容，所有视频均来自B站官方接口并遵循其原有版权归属。使用本项目即表示你同意遵守 [B站用户协议](https://www.bilibili.com/blackboard/agreement.html)，请勿用于任何商业或非法用途。视频内容版权归原作者及B站所有。

<div align="center">

**用 ♥ 和 Bun 构建 · 如果这个项目对你有帮助，欢迎点个 Star ⭐**

</div>
