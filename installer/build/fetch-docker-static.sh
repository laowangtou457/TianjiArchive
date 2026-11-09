#!/usr/bin/env bash
# =============================================================================
# 构建机脚本：抓取 docker 静态二进制 + compose v2 插件（变体 B 载荷）
#
# 变体 B 面向麒麟 V10 / 统信 UOS：无法穷举这些系统的 deb 依赖闭包（glibc 版本、
# 包名、仓库裁剪均不可控），静态二进制只依赖内核，是「版本未知」前提下唯一不猜的
# 方案（见 docs/INSTALLER-DESIGN.md §4.3）。
#
# 本期状态：载荷目录结构就位、脚本可执行，但**变体 B 的安装逻辑本期不做**
# （team-lead 裁定）。本脚本仍要能跑，以便后续补做时不返工。
#
# 用法：
#   bash installer/build/fetch-docker-static.sh
#   bash installer/build/fetch-docker-static.sh --docker-version 27.5.1 --compose-version v2.29.7
#
# 退出码：0 成功；1 前置条件不满足；2 下载失败；3 校验失败
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DOCKER_VERSION='27.5.1'
COMPOSE_VERSION='v2.29.7'
ARCH='x86_64'
OUT_DIR=''

DOCKER_BASE='https://download.docker.com/linux/static/stable'
COMPOSE_BASE='https://github.com/docker/compose/releases/download'

log() { printf '[fetch-static] %s\n' "$*"; }
die() { printf '[fetch-static] FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: fetch-docker-static.sh [选项]

  --docker-version <v>    docker 静态包版本，默认 27.5.1
  --compose-version <v>   compose v2 版本（带 v 前缀），默认 v2.29.7
  --arch <a>              下载架构，默认 x86_64（首版只承诺 amd64）
  --out <dir>             输出目录，默认 installer/build/payload/kylin-uos/docker-static
  -h | --help             显示本帮助
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --docker-version) DOCKER_VERSION="${2:-}"; shift 2 ;;
    --compose-version) COMPOSE_VERSION="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

command -v curl >/dev/null 2>&1 || die '未找到 curl：本脚本只能在联网构建机执行'
command -v sha256sum >/dev/null 2>&1 || die '未找到 sha256sum'
command -v tar >/dev/null 2>&1 || die '未找到 tar'

if [ -z "${OUT_DIR}" ]; then
  OUT_DIR="${REPO_ROOT}/installer/build/payload/kylin-uos/docker-static"
fi
mkdir -p "${OUT_DIR}"
OUT_DIR="$(cd "${OUT_DIR}" && pwd)"
log "输出目录：${OUT_DIR}"

DOCKER_TGZ="docker-${DOCKER_VERSION}.tgz"
DOCKER_URL="${DOCKER_BASE}/${ARCH}/${DOCKER_TGZ}"
DOCKER_SHA_URL="${DOCKER_URL}.sha256"

COMPOSE_BIN="docker-compose-linux-${ARCH}"
COMPOSE_URL="${COMPOSE_BASE}/${COMPOSE_VERSION}/${COMPOSE_BIN}"
COMPOSE_SHA_URL="${COMPOSE_URL}.sha256"

fetch() {
  local url="$1" dest="$2"
  log "下载 $(basename "${dest}")"
  curl -fsSL --retry 3 --retry-delay 2 -o "${dest}.part" "${url}" || die "下载失败：${url}"
  mv "${dest}.part" "${dest}"
}

fetch "${DOCKER_URL}" "${OUT_DIR}/${DOCKER_TGZ}"
fetch "${DOCKER_SHA_URL}" "${OUT_DIR}/${DOCKER_TGZ}.sha256"
fetch "${COMPOSE_URL}" "${OUT_DIR}/${COMPOSE_BIN}"
fetch "${COMPOSE_SHA_URL}" "${OUT_DIR}/${COMPOSE_BIN}.sha256"

# ---------------------------------------------------------------- 三层校验
# 官方随包 sha256 文件形状可能是 "<hash>  <file>" 或只有 "<hash>"，两种都接受。
verify_sha() {
  local file="$1" shafile="$2"
  local expected actual
  expected="$(awk '{print $1; exit}' "${shafile}")"
  [ -n "${expected}" ] || die "sha256 文件为空：${shafile}"
  actual="$(sha256sum "${file}" | awk '{print $1}')"
  if [ "${expected}" != "${actual}" ]; then
    die "sha256 不匹配：$(basename "${file}") 期望 ${expected} 实际 ${actual}"
  fi
  log "sha256 OK：$(basename "${file}")"
}

verify_sha "${OUT_DIR}/${DOCKER_TGZ}" "${OUT_DIR}/${DOCKER_TGZ}.sha256"
verify_sha "${OUT_DIR}/${COMPOSE_BIN}" "${OUT_DIR}/${COMPOSE_BIN}.sha256"

# tar 可读性预检：损坏的 tgz 到现场才炸是最贵的失败
tar -tzf "${OUT_DIR}/${DOCKER_TGZ}" >/dev/null 2>&1 || die "${DOCKER_TGZ} 不是有效的 gzip tar"

# 关键可执行文件必须在包里：dockerd 与 docker 缺一不可
tar -tzf "${OUT_DIR}/${DOCKER_TGZ}" | grep -qx 'docker/dockerd' || die "${DOCKER_TGZ} 内缺少 docker/dockerd"
tar -tzf "${OUT_DIR}/${DOCKER_TGZ}" | grep -qx 'docker/docker' || die "${DOCKER_TGZ} 内缺少 docker/docker"

STATIC_MANIFEST="${OUT_DIR}/STATIC-MANIFEST.txt"
{
  echo "# 由 installer/build/fetch-docker-static.sh 生成，请勿手工编辑"
  echo "# 生成时间(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "DOCKER_CHANNEL=static"
  echo "DOCKER_VERSION=${DOCKER_VERSION}"
  echo "COMPOSE_VERSION=${COMPOSE_VERSION}"
  echo "ARCH=${ARCH}"
  echo "DOCKER_TGZ=${DOCKER_TGZ}"
  echo "COMPOSE_BIN=${COMPOSE_BIN}"
  echo "# --- 以下为逐文件 sha256 ---"
} > "${STATIC_MANIFEST}"
( cd "${OUT_DIR}" && sha256sum "${DOCKER_TGZ}" "${COMPOSE_BIN}" ) >> "${STATIC_MANIFEST}"

TOTAL_BYTES="$(du -sb "${OUT_DIR}" | awk '{print $1}')"
log "完成，合计 ${TOTAL_BYTES} 字节"
log "清单：${STATIC_MANIFEST}"
log '提醒：变体 B 的安装逻辑本期未实现（team-lead 裁定），载荷先就位。'
