# 📺 BiliTogether · B站视频一起看

> 和朋友「同一间放映厅」实时观看 B站视频 —— 房主控制播放，全员帧级同步，PC / 手机无缝互通。

[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-38bdf8)](https://tailwindcss.com)
[![socket.io](https://img.shields.io/badge/socket.io-4-white)](https://socket.io)
[![Prisma](https://img.shields.io/badge/Prisma-SQLite-16a34a)](https://www.prisma.io)

---

## ✨ 功能特性

### 🎬 同步观影
- **房主主导同步**：房主的 播放 / 暂停 / 跳转 / 进度拖拽 / 画质切换 / 倍速调节 实时同步到所有成员
- **原生视频流模式**：服务端解析 B站真实播放地址（`playurl` API），前端 `<video>` 直播流播放，画质切换真实生效，配合自绘弹幕层
- **iframe 兼容模式**：一键降级到 B站官方外链播放器（自带弹幕），网络受限环境的保底方案
- **音画追平**：成员端自动估算播放位置，偏差时提示「回到同步点」一键追平；弱网卡顿自动检测提示
- **自动连播**：播放列表顺序播完自动切下一集

### 💬 实时互动
- **房间聊天**：socket.io 实时消息、表情面板、颜文字快捷栏、「正在输入」状态提示
- **慢速模式**：房主可开启发言冷却，防止刷屏
- **精彩时刻 ⭐**：看到高能画面随时打点（快捷键 `M`），支持补一句附言；房主点击时刻 = **带全员跳转回看**；成员点击 = 一键向房主喊话「想回看这一刻」
- **观看里程碑 🎉**：累计观看时长达标触发全房间庆祝动效，观看时长榜实时展示

### 📃 播放列表 & 选片
- **房主选片**：粘贴 BV 号 / av 号 / 完整链接 / `b23.tv` 短链即刻开场
- **批量导入**：多行粘贴批量解析（自动去重、容量上限、失败标记），收藏夹 / 合集链接一键抓取（B站风控时自动降级为手动粘贴引导）
- **队列管理**：拖拽排序、置顶播放、单条移除、一键清空（二次确认）
- **成员投稿**：成员可投稿视频，房主审核后入队

### 🏠 房间治理
- **邀请体系**：房间码 / 邀请链接 / 二维码扫码，三通道入房
- **房主移交**、房间改名、成员权限开关（投稿 / 打点）
- **快捷键**：空格播放暂停、`←→` 快进快退、`↑↓` 音量、`M` 打点、`?` 呼出帮助面板

### 🎨 体验细节
- **白天 / 黑夜双主题**：全站真实切换，观影房「亮厅银幕 ↔ 沉浸暗厅」两种氛围
- **移动端完整适配**：手机入房、触屏呼出控制条、扫码即看
- **封面主色氛围光**：视频画面颜色晕染到播放器周边，随播放呼吸
- 入场上流动画、打字机光标、星空氛围首页

---

## 🏗️ 技术架构

```
┌────────────────────────────┐      ┌─────────────────────────────┐
│  Next.js 16 (:3000)        │      │  bili-sync-service (:3003)  │
│  ├─ App Router + React 19  │◄────►│  socket.io 实时同步服务      │
│  ├─ B站 API 代理(Wbi签名)   │ REST │  ├─ 房间/成员/播放状态       │
│  ├─ Prisma + SQLite        │ 回访 │  ├─ 聊天/打点/队列广播       │
│  └─ Tailwind 4 + shadcn/ui │      │  └─ 观看统计刷盘             │
└────────────────────────────┘      └─────────────────────────────┘
        ▲ 由 instrumentation 启动时自动拉起，端口占用检测防重复
```

- **前端**：Next.js 16（App Router）· React 19 · TypeScript 5 · Tailwind CSS 4 · shadcn/ui · framer-motion · socket.io-client
- **后端**：Next Route Handlers（B站 API 代理 + Wbi 签名 + 凭据管理）· socket.io（独立 mini service）· Prisma ORM + SQLite
- **运行时**：Bun

---

## 🚀 快速开始

```bash
# 1. 安装依赖（根目录 + 同步服务）
bun install
cd mini-services/bili-sync-service && bun install && cd ../..

# 2. 配置环境变量
cp .env.example .env

# 3. 初始化数据库
bun run db:generate && bun run db:push

# 4. 启动开发服务器（:3000，同步服务 :3003 会自动拉起）
bun run dev
```

打开 `http://localhost:3000`，输入昵称创建房间，把房间码或二维码分享给朋友即可开看。

### 环境变量说明（`.env`）

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | SQLite 文件路径，如 `file:./db/custom.db` |
| `NEXT_API_URL` | — | 同步服务回访 Next 的地址，默认 `http://127.0.0.1:3000` |
| `BILI_SESSDATA` | — | B站凭据（见下节，推荐用扫码登录代替手工填写） |
| `BILI_BILI_JCT` | — | B站凭据（同上） |

### 🔐 B站凭据（解锁高画质）

原生模式需要 B站登录凭据才能解析高画质播放地址，两种方式：

1. **扫码登录（推荐）**：应用内入口直接扫码，凭据自动落盘 `data/bili-credentials.json`（不入库、不下发前端，仅服务端读取）
2. **环境变量兜底**：在 `.env` 填写 `BILI_SESSDATA` / `BILI_BILI_JCT`

> ⚠️ B站对数据中心 IP 有风控策略：收藏夹 / 合集批量抓取在部分服务器 IP 上会被限流（应用会自动降级并引导手动粘贴 BV 号，核心观影链路不受影响）。

---

## 📁 目录结构

```
src/
├── app/                  # Next.js App Router（页面 + API 路由）
│   ├── api/bili/         # B站 API 代理（Wbi 签名 / 解析 / 取流 / 登录）
│   └── api/rooms/        # 房间数据 / 观看统计
├── components/
│   ├── room/             # 观影房组件（播放器舞台 / 控制条 / 侧栏 / 选片器…）
│   └── ui/               # shadcn/ui 基础组件
├── hooks/                # use-room-socket / use-sync-player / use-danmaku…
├── lib/                  # B站签名 / 工具 / 类型
└── store/                # Zustand 客户端状态
mini-services/
└── bili-sync-service/    # socket.io 实时同步服务（独立进程 :3003）
prisma/schema.prisma      # 数据模型（Room / Member / Message / PlaylistItem…）
```

---

## 📄 License

[MIT](LICENSE)
