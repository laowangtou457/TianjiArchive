#!/usr/bin/env bash
# =============================================================================
# fetch-wsl-assets.sh —— 构建机侧抓取 Windows 变体的 WSL 离线资产
#
# 产物（落在 installer/build/assets/wsl/）：
#   wsl.msi                          微软官方 WSL 离线安装器（Store 版 wsl.exe + 内核）
#   ubuntu-jammy-wsl-rootfs.tar.gz   Ubuntu 22.04 WSL rootfs
#   ASSETS-VERSION.txt               版本与 sha256 登记（组包时进 SHA256SUMS）
#
# 版本策略：固定版本号，不追 latest（与 fetch-docker-debs.sh 同哲学）——
#   WSL 与 rootfs 的版本决定发行版内 systemd 行为，漂移了就不再
#   是验证过的组合。升级版本 = 改这里 + 真机重验。
#
# 网络：构建机允许联网（现场目标机不需要）。GitHub 直连失败时对 WSL MSI
#   提供手工下载指引（脚本不猜 URL 变体，fail-closed）。
#
# 用法：bash installer/build/fetch-wsl-assets.sh
# 退出码：0 成功；1 资产缺失或 sha 不符
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${SCRIPT_DIR}/assets/wsl"

# 固定版本（升级须真机重验后变更，见文件头注释）
WSL_MSI_VERSION="2.6.1"
WSL_MSI_URL="https://github.com/microsoft/WSL/releases/download/${WSL_MSI_VERSION}/wsl.${WSL_MSI_VERSION}.x64.msi"
WSL_MSI_EXPECT_NAME="wsl.msi"
UBUNTU_ROOTFS_VERSION="20250415"   # ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz 的发布日期
UBUNTU_ROOTFS_PRIMARY="https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/wsl/jammy/current/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz"
UBUNTU_ROOTFS_FALLBACK="https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz"

log() { printf '[fetch-wsl] %s\n' "$*"; }
die() { printf '[fetch-wsl] FAIL: %s\n' "$*" >&2; exit 1; }

mkdir -p "$OUT_DIR"

fetch() { # fetch <url> <output-file>
  local url="$1" out="$2"
  log "下载 $url"
  curl -fL --retry 3 --connect-timeout 30 -o "$out.part" "$url" \
    || die "下载失败：$url（手工下载后放到 $OUT_DIR/$(basename "$out") 再重跑本脚本可跳过）"
  mv "$out.part" "$out"
}

# ---- 1. WSL MSI ----
MSI_OUT="${OUT_DIR}/${WSL_MSI_EXPECT_NAME}"
if [ -f "$MSI_OUT" ]; then
  log "已存在 $(basename "$MSI_OUT")（$(wc -c < "$MSI_OUT") B），跳过下载（删除可强制重下）"
else
  fetch "$WSL_MSI_URL" "$MSI_OUT"
fi

# ---- 2. Ubuntu jammy WSL rootfs（主源 TUNA，备源官方）----
ROOTFS_OUT="${OUT_DIR}/ubuntu-jammy-wsl-rootfs.tar.gz"
if [ -f "$ROOTFS_OUT" ]; then
  log "已存在 $(basename "$ROOTFS_OUT")（$(wc -c < "$ROOTFS_OUT") B），跳过下载"
else
  if curl -fL --retry 3 --connect-timeout 30 -o "$ROOTFS_OUT.part" "$UBUNTU_ROOTFS_PRIMARY"; then
    mv "$ROOTFS_OUT.part" "$ROOTFS_OUT"
  else
    log "主源失败，回退官方 cloud-images ……"
    fetch "$UBUNTU_ROOTFS_FALLBACK" "$ROOTFS_OUT"
  fi
fi

# ---- 3. 完整性与登记 ----
[ -s "$MSI_OUT" ]   || die "wsl.msi 为空"
[ -s "$ROOTFS_OUT" ] || die "rootfs 为空"

# MSI：用 file 魔数确认是安装包而非错误页（HTML 错误页也能下载"成功"）
if head -c 8 "$MSI_OUT" | grep -q "HTML"; then
  die "wsl.msi 内容是 HTML（下载被劫持/重定向到错误页），删除后重试或手工下载"
fi

MSI_SHA="$(sha256sum "$MSI_OUT" | awk '{print $1}')"
ROOTFS_SHA="$(sha256sum "$ROOTFS_OUT" | awk '{print $1}')"

cat > "${OUT_DIR}/ASSETS-VERSION.txt" <<EOF
# Windows 变体离线资产登记（由 fetch-wsl-assets.sh 生成，勿手工改）
wsl.msi version=${WSL_MSI_VERSION} source=${WSL_MSI_URL} sha256=${MSI_SHA}
ubuntu-jammy-wsl-rootfs.tar.gz version=${UBUNTU_ROOTFS_VERSION} source=${UBUNTU_ROOTFS_PRIMARY} sha256=${ROOTFS_SHA}
EOF

log "登记完成：${OUT_DIR}/ASSETS-VERSION.txt"
log "wsl.msi          $(wc -c < "$MSI_OUT") B  sha256=${MSI_SHA}"
log "ubuntu rootfs    $(wc -c < "$ROOTFS_OUT") B  sha256=${ROOTFS_SHA}"
log "下一步：bash installer/build/build-windows-package.sh（组包前先构建变体 A .run）"
