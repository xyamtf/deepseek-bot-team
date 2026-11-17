#!/usr/bin/env bash
# Deepseek bot / Dsh bot 一键安装（macOS / Linux；Windows 用 scripts/install.ps1）。
#
#   curl -fsSL https://raw.githubusercontent.com/xyamtf/deepseek-bot-team/main/scripts/install.sh | bash
#
# 环境变量：DSBOT_DIR（默认 ~/.deepseek-bot-team）、DSBOT_VERSION（默认 latest）、DSBOT_STANDALONE=1
set -euo pipefail

OWNER="xyamtf"
REPO="deepseek-bot-team"
DIR="${DSBOT_DIR:-$HOME/.deepseek-bot-team}"
WANT="${DSBOT_VERSION:-latest}"

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

echo
cyan '  Deepseek bot —— 一键安装'
echo '  多 Bot 团队，装进 DeepSeek Harness'

cyan "• 检查 Node.js"
command -v node >/dev/null 2>&1 || die '没有找到 node。请先安装 Node.js 20.11+：https://nodejs.org/'
NODE_VERSION="$(node --version | tr -d 'v')"
MAJOR="${NODE_VERSION%%.*}"
REST="${NODE_VERSION#*.}"
MINOR="${REST%%.*}"
if [ "$MAJOR" -lt 20 ] || { [ "$MAJOR" -eq 20 ] && [ "$MINOR" -lt 11 ]; }; then
  die "Node.js 版本过低：$NODE_VERSION（需要 ≥ 20.11）"
fi
ok "node $NODE_VERSION"

cyan "• 解析发布包（$WANT）"
API="https://api.github.com/repos/$OWNER/$REPO/releases"
if [ "$WANT" = "latest" ]; then URL="$API/latest"; else URL="$API/tags/$WANT"; fi
RELEASE="$(curl -fsSL -H 'User-Agent: deepseek-bot-installer' "$URL")" || die '读取发布信息失败'
ASSET_URL="$(printf '%s' "$RELEASE" | grep -o '"browser_download_url": *"[^"]*\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
TAG="$(printf '%s' "$RELEASE" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$ASSET_URL" ] || die "发布 $TAG 里没有 zip 附件"
ok "$TAG · $(basename "$ASSET_URL")"

cyan "• 安装到 $DIR"
if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null || true)" ]; then
  die "目录已存在且非空：$DIR（换一个 DSBOT_DIR）"
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -H 'User-Agent: deepseek-bot-installer' -o "$TMP/release.zip" "$ASSET_URL" || die '下载失败'
command -v unzip >/dev/null 2>&1 || die '缺少 unzip'
unzip -q "$TMP/release.zip" -d "$TMP/unpacked"
# The archive may hold the tree at its root, or inside one wrapper directory.
if [ -f "$TMP/unpacked/service/bin/dsteam.mjs" ]; then
  ROOT="$TMP/unpacked"
else
  ROOT="$(find "$TMP/unpacked" -maxdepth 4 -type f -name dsteam.mjs -path '*/service/bin/*' | head -1 | sed 's#/service/bin/dsteam.mjs$##')"
fi
[ -n "$ROOT" ] && [ -d "$ROOT" ] || die '压缩包结构不对：找不到 service/bin/dsteam.mjs'
mkdir -p "$DIR"
cp -R "$ROOT"/. "$DIR"/
for needed in plugin/index.js service/bin/dsteam.mjs service/miniapp/node/server.mjs LICENSE; do
  [ -e "$DIR/$needed" ] || die "安装不完整：缺少 $needed"
done
ok '文件完整（plugin / service / docs / LICENSE）'

cyan '• 自检：加载团队服务模块'
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const url = pathToFileURL(process.argv[1] + '/service/miniapp/node/server.mjs');
const module = await import(url.href);
if (typeof module.start !== 'function') process.exit(2);
console.log('ok');
" "$DIR" >/dev/null || die '模块加载失败，安装可能不完整'
ok '模块可加载'

echo
printf '  \033[32m安装完成\033[0m\n\n'
cyan '  ① 作为 DSH 插件（推荐）'
echo "     DSH → 插件 → 添加插件 → 选择目录：$DIR/plugin"
echo '     插件会自动起停团队服务，并把 21 个团队工具注册给 Agent。'
echo
cyan '  ② 或直接独立运行'
echo "     node \"$DIR/service/bin/dsteam.mjs\" --port 8790"
echo '     然后打开 http://127.0.0.1:8790/bot'
echo '     （首次运行前：把 service/config.example.json 复制为 config.json 并填 api.apiKey）'
echo

if [ "${DSBOT_STANDALONE:-0}" = "1" ]; then
  cyan '• 以独立模式启动（端口 8790）'
  [ -f "$DIR/service/config.json" ] || { cp "$DIR/service/config.example.json" "$DIR/service/config.json"; warn '已生成 service/config.json，请填入 api.apiKey'; }
  ( cd "$DIR/service" && nohup node bin/dsteam.mjs --port 8790 >"$DIR/service/data/console.log" 2>&1 & echo "  ✓ 已启动 · http://127.0.0.1:8790/bot" )
fi
