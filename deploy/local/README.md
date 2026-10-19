# BiliTogether 本机部署 · Tailscale Funnel 方案

把 BiliTogether 跑在你自己电脑上，通过 Tailscale Funnel 暴露到公网，朋友用浏览器就能加入房间一起看片。**不买服务器、不要公网 IP、不开机自启**——只在你需要时手动启动。

## 拓扑

```
朋友的浏览器
    │  https://your-mac.ts.net  (443, HTTPS)
    ▼
Tailscale Funnel  ──→  Caddy (:8080)  ──→  Next.js (:3000)   页面 / B站 API 代理
                                       └─→  bili-sync (:3003)  socket.io 实时同步
```

- **Next.js :3000**：页面 + B站 API 代理（Wbi 签名、playurl 解析、凭据管理）
- **bili-sync :3003**：socket.io 同步服务（房间状态权威源）
- **Caddy :8080**：前置反代，把 `?XTransformPort=3003` 的 socket.io 请求转给 :3003，其余转给 :3000
- **Tailscale Funnel :443**：把本机 :8080 暴露到公网，自动 HTTPS

## 前置依赖

需要在本机装好三样东西：

### 1. Bun（运行时）

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
# Windows: 用 WSL2，或从 https://bun.sh 下载
```

### 2. Caddy（反代）

```bash
# macOS
brew install caddy
# Linux (Debian/Ubuntu)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
# Windows: https://caddyserver.com/docs/install
```

### 3. Tailscale（穿透）

```bash
# macOS
brew install tailscale
# 或从 https://tailscale.com/download 下载官方客户端
# Linux
curl -fsSL https://tailscale.com/install.sh | sh
```

装完后登录并启用 Funnel：

```bash
tailscale up          # 登录（会开浏览器授权）
tailscale funnel on    # 首次启用 Funnel 功能（只需一次）
```

## 安装项目依赖

```bash
cd bilitogether
bun install
cd mini-services/bili-sync-service && bun install && cd ..
cp .env.example .env
bun run db:generate && bun run db:push
```

## 使用

所有操作都通过一个脚本：

```bash
# 启动全部服务 + 开启 Funnel
./deploy/local/bilitogether.sh start

# 查看状态
./deploy/local/bilitogether.sh status

# 看实时日志（Ctrl+C 退出）
./deploy/local/bilitogether.sh logs
./deploy/local/bilitogether.sh logs web    # 只看 Next.js 日志

# 打印 Funnel 公网地址
./deploy/local/bilitogether.sh url

# 停止全部 + 关闭 Funnel（无残留进程）
./deploy/local/bilitogether.sh stop
```

启动后脚本会打印三个地址：

- **本机访问**：`http://localhost:3000`
- **局域网访问**：`http://192.168.x.x:3000`（同 WiFi 的朋友）
- **公网访问**：`https://your-machine.ts.net`（远程朋友，把这个发给Ta）

**看完片执行 `stop`，所有进程和 Funnel 全部关闭，不留任何常驻服务。下次要用再 `start`。**

## 常见问题

### Q: start 报 "Funnel 启动失败"？

确认三步：
1. `tailscale up` 已登录（`tailscale status` 能输出设备列表）
2. `tailscale funnel on` 已执行过（首次启用，只需一次）
3. 当前账号 Funnel 配额未满（每节点最多 3 个，`tailscale funnel status` 查看）

### Q: 朋友访问公网地址但 socket 一直"连接中"？

socket.io 需要经 Caddy 转发到 :3003。确认 `.env` 里 `NEXT_PUBLIC_SYNC_URL` 保持默认（不设置或设为 `/?XTransformPort=3003`）。**不要**设成 `http://localhost:3003`——朋友浏览器访问不到你的 localhost。

### Q: 视频流卡 / 画质低？

- 国内访问 Tailscale DERP 中继延迟偏高（100-300ms），同步观影仍可用（漂移校正容忍 2.5s 内偏差）
- 画质与 B站登录态相关：在应用内扫码登录（凭据落盘 `data/bili-credentials.json`），普通账号 1080P，大会员 1080P+/4K
- 如果朋友电脑也装了 Tailscale，两端可走 P2P 直连，延迟骤降

### Q: 电脑休眠了怎么办？

休眠会断开所有连接。启动前调一次：
```bash
# macOS
caffeinate -d ./deploy/local/bilitogether.sh start
# 或在系统设置里关掉"自动睡眠"
```

### Q: 想用自家域名而不是 *.ts.net？

Funnel 免费版只支持 `*.ts.net` 子域名。要自定义域名请改用 Cloudflare Tunnel（但注意 CF 免费版 ToS 限制视频流代理，建议配合 iframe 兼容模式）。

## 文件说明

```
deploy/local/
├── Caddyfile          Caddy 反代配置（:8080）
├── bilitogether.sh    一键启停脚本
└── README.md          本文档
.run/                  运行时目录（PID 文件 + 日志，stop 后可删）
  └── logs/
      ├── sync.log     bili-sync-service 日志
      ├── web.log      Next.js 日志
      └── caddy.log    Caddy 日志
```

## 关于稳定性

本方案已去掉 `bun --hot` 热重载（避免 socket 误断）。但房间运行时状态仍在同步服务内存中——**如果 bili-sync 进程崩溃，房间状态会丢失**（房间元数据/播放列表/观看统计在 SQLite，不丢）。长时间观影建议偶尔确认 `./bilitogether.sh status` 正常。
