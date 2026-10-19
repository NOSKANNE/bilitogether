#!/usr/bin/env bash
#
# BiliTogether 本机部署一键启停脚本（Tailscale Funnel 方案）
#
# 拓扑：Tailscale Funnel(443) → Caddy(:8080) → Next(:3000) / bili-sync(:3003)
#
# 用法：
#   ./deploy/local/bilitogether.sh start   # 启动全部 + 开启 Funnel
#   ./deploy/local/bilitogether.sh stop    # 停止全部 + 关闭 Funnel
#   ./deploy/local/bilitogether.sh status  # 查看运行状态
#   ./deploy/local/bilitogether.sh logs    # 实时查看日志（Ctrl+C 退出）
#   ./deploy/local/bilitogether.sh url     # 打印当前 Funnel 公网地址
#
# 不做开机自启 / 常驻：只在脚本 start 时拉起，stop 时全部关闭。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="$ROOT/.run"
LOG_DIR="$RUN_DIR/logs"
mkdir -p "$LOG_DIR"

# 颜色
G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[90m'; B=$'\033[1m'; N=$'\033[0m'

log()  { echo "${G}[bilitogether]${N} $*"; }
warn() { echo "${Y}[bilitogether]${N} $*" >&2; }
err()  { echo "${R}[bilitogether]${N} $*" >&2; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    err "缺少依赖：$1"
    case "$1" in
      bun)      err "  安装：curl -fsSL https://bun.sh/install | bash" ;;
      caddy)    err "  安装：https://caddyserver.com/docs/install" ;;
      tailscale) err "  安装：https://tailscale.com/download" ;;
    esac
    exit 1
  }
}

# 进程是否存活
alive() { local pid="$1"; [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; }

# 等待端口就绪
wait_port() {
  local port="$1" timeout="${2:-30}"
  for ((i=0; i<timeout; i++)); do
    if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then exec 3>&- 3<&-; return 0; fi
    sleep 1
  done
  return 1
}

# 获取本机局域网 IP（跨平台兜底）
lan_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"              # Linux
  [[ -z "$ip" ]] && ip="$(ipconfig getifaddr en0 2>/dev/null)"     # macOS Wi-Fi
  [[ -z "$ip" ]] && ip="$(ipconfig getifaddr en1 2>/dev/null)"     # macOS 以太网
  [[ -z "$ip" ]] && ip="<本机IP>"
  echo "$ip"
}

# ─── start ──────────────────────────────────────────────────────────────
cmd_start() {
  need_cmd bun
  need_cmd caddy
  need_cmd tailscale

  # 检查是否已运行
  if [[ -f "$RUN_DIR/web.pid" ]] && alive "$(cat "$RUN_DIR/web.pid" 2>/dev/null)"; then
    warn "BiliTogether 已在运行，先执行 $0 stop 再启动"
    exit 0
  fi

  # 检查 Tailscale 登录状态
  if ! tailscale status >/dev/null 2>&1; then
    err "Tailscale 未登录，请先执行：tailscale up"
    exit 1
  fi
  # 检查 Funnel 是否已启用（需要先 tailscale funnel on 一次）
  if ! tailscale funnel status >/dev/null 2>&1; then
    warn "首次使用 Funnel，需要先执行一次：tailscale funnel on"
    tailscale funnel on 2>/dev/null || true
  fi

  echo ""
  log "${B}启动 BiliTogether${N}"

  # 1. bili-sync-service (:3003)
  log "启动 bili-sync-service (:3003)..."
  ( cd "$ROOT/mini-services/bili-sync-service" && exec bun index.ts ) \
    >"$LOG_DIR/sync.log" 2>&1 &
  echo $! > "$RUN_DIR/sync.pid"

  # 2. Next.js (:3000)
  log "启动 Next.js (:3000)..."
  ( cd "$ROOT" && exec bun run dev ) >"$LOG_DIR/web.log" 2>&1 &
  echo $! > "$RUN_DIR/web.pid"

  log "等待服务就绪..."
  if ! wait_port 3003 15; then
    err "bili-sync-service 启动超时，查看 $LOG_DIR/sync.log"
    exit 1
  fi
  if ! wait_port 3000 45; then
    err "Next.js 启动超时，查看 $LOG_DIR/web.log"
    exit 1
  fi

  # 3. Caddy (:8080)
  log "启动 Caddy (:8080)..."
  ( cd "$ROOT/deploy/local" && exec caddy run --config Caddyfile ) \
    >"$LOG_DIR/caddy.log" 2>&1 &
  echo $! > "$RUN_DIR/caddy.pid"
  if ! wait_port 8080 10; then
    err "Caddy 启动超时，查看 $LOG_DIR/caddy.log"
    exit 1
  fi

  # 4. Tailscale Funnel (443 → :8080)
  log "开启 Tailscale Funnel (443 → localhost:8080)..."
  if ! tailscale funnel --bg 8080 >/dev/null 2>&1; then
    err "Funnel 启动失败。请确认："
    err "  1. 已 tailscale up 登录"
    err "  2. 已 tailscale funnel on 启用功能"
    err "  3. 当前账号 Funnel 配额未满（每节点最多 3 个）"
    # 清理已启动的服务
    cmd_stop >/dev/null 2>&1 || true
    exit 1
  fi

  # 获取公网地址
  sleep 2
  local url
  url="$(tailscale funnel status 2>/dev/null | grep -oE 'https://[a-z0-9.-]+\.ts\.net' | head -1)"

  echo ""
  echo "${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo "${G}✓ BiliTogether 已启动${N}"
  echo ""
  echo "  ${B}本机访问${N}    http://localhost:3000"
  echo "  ${B}局域网访问${N}  http://$(lan_ip):3000"
  if [[ -n "$url" ]]; then
    echo "  ${B}公网访问${N}    $url"
    echo ""
    echo "  ${D}把这个公网地址发给朋友，他们浏览器打开即可加入房间${N}"
  else
    echo ""
    echo "  ${Y}Funnel 地址获取失败${N}，执行 $0 url 重试，或 tailscale funnel status 查看"
  fi
  echo ""
  echo "  ${D}日志:  $0 logs${N}"
  echo "  ${D}停止:  $0 stop${N}"
  echo "${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo ""
}

# ─── stop ───────────────────────────────────────────────────────────────
cmd_stop() {
  echo ""
  log "停止 BiliTogether..."

  # 关闭 Funnel
  if command -v tailscale >/dev/null 2>&1; then
    log "关闭 Tailscale Funnel..."
    tailscale funnel reset 2>/dev/null || true
  fi

  # 按依赖逆序停止：caddy → web → sync
  for name in caddy web sync; do
    local pidfile="$RUN_DIR/$name.pid"
    if [[ -f "$pidfile" ]]; then
      local pid; pid="$(cat "$pidfile" 2>/dev/null || echo '')"
      if alive "$pid"; then
        log "停止 $name (pid $pid)..."
        kill "$pid" 2>/dev/null || true
        # 优雅等待 3s
        for ((i=0; i<3; i++)); do alive "$pid" || break; sleep 1; done
        alive "$pid" && { warn "$name 未响应 SIGTERM，强制 kill"; kill -9 "$pid" 2>/dev/null || true; }
      fi
      rm -f "$pidfile"
    fi
  done

  log "${G}已全部停止，无残留进程${N}"
  echo ""
}

# ─── status ─────────────────────────────────────────────────────────────
cmd_status() {
  echo ""
  echo "${B}BiliTogether 运行状态${N}"
  echo "───────────────────────────────────"
  for name in sync web caddy; do
    local pidfile="$RUN_DIR/$name.pid"
    local port=""
    case "$name" in sync) port=3003;; web) port=3000;; caddy) port=8080;; esac
    if [[ -f "$pidfile" ]] && alive "$(cat "$pidfile" 2>/dev/null)"; then
      printf "  ${G}● %-8s${N} pid=%-7s :%s\n" "$name" "$(cat "$pidfile")" "$port"
    else
      printf "  ${R}○ %-8s${N} 未运行        :%s\n" "$name" "$port"
    fi
  done

  echo ""
  echo "${B}Tailscale Funnel${N}"
  echo "───────────────────────────────────"
  if command -v tailscale >/dev/null 2>&1; then
    tailscale funnel status 2>/dev/null || echo "  未配置"
  else
    echo "  ${R}tailscale 未安装${N}"
  fi
  echo ""
}

# ─── logs ───────────────────────────────────────────────────────────────
cmd_logs() {
  local target="${1:-all}"
  echo "${D}实时日志（Ctrl+C 退出）${N}"
  echo "───────────────────────────────────"
  if [[ "$target" == "all" ]]; then
    # tail 多文件：macOS/Linux 的 tail 都支持多文件
    tail -f "$LOG_DIR"/sync.log "$LOG_DIR"/web.log "$LOG_DIR"/caddy.log 2>/dev/null || {
      err "无日志文件，先执行 $0 start"
    }
  else
    case "$target" in sync|web|caddy) ;;
      *) err "未知日志：$target（可选 sync|web|caddy）"; exit 1 ;;
    esac
    tail -f "$LOG_DIR/$target.log" 2>/dev/null || err "无 $target 日志，先执行 $0 start"
  fi
}

# ─── url ────────────────────────────────────────────────────────────────
cmd_url() {
  local url
  url="$(tailscale funnel status 2>/dev/null | grep -oE 'https://[a-z0-9.-]+\.ts\.net' | head -1)"
  if [[ -n "$url" ]]; then
    echo "$url"
  else
    warn "Funnel 未运行或未配置，先执行 $0 start"
    exit 1
  fi
}

# ─── main ───────────────────────────────────────────────────────────────
case "${1:-}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  logs)   shift; cmd_logs "${1:-all}" ;;
  url)    cmd_url ;;
  restart) cmd_stop >/dev/null 2>&1 || true; sleep 1; cmd_start ;;
  *)
    cat <<EOF
${B}BiliTogether 本机部署控制脚本${N}

${B}用法:${N}
  $0 start      启动全部服务 + 开启 Funnel
  $0 stop       停止全部服务 + 关闭 Funnel
  $0 restart    重启（stop + start）
  $0 status     查看运行状态
  $0 logs       实时日志（all / sync / web / caddy）
  $0 url        打印 Funnel 公网地址

${B}拓扑:${N}  Funnel(443) → Caddy(:8080) → Next(:3000) / bili-sync(:3003)
${B}依赖:${N}  bun, caddy, tailscale

${D}不会常驻、不开机自启：仅在你 start 时运行，stop 后无残留。${N}
EOF
    exit 1 ;;
esac
