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
DOCKER_MIRROR_BASE='https://mirrors.ustc.edu.cn/docker-ce/linux/static/stable'
COMPOSE_BASE='https://github.com/docker/compose/releases/download'

DOCKER_SHA_OVERRIDE=''
COMPOSE_SHA_OVERRIDE=''

# ---------------------------------------------------------------- 内置摘要
# 为什么不下载官方 .tgz.sha256：
#   2026-11-09 实测，https://download.docker.com/linux/static/stable/x86_64/
#   目录里**只有** docker-<ver>.tgz，请求 docker-<ver>.tgz.sha256 返回 404。
#   compose 的 GitHub Release 确实提供 .sha256，两者行为不同。
# 因此 docker 静态包改为「内置摘要 + 双源比对」：摘要值由构建机分别从
#   download.docker.com 与 mirrors.ustc.edu.cn 下载同一文件、比对 sha256 一致后固化。
#   2026-11-09 实测两源一致：
#     docker-27.5.1.tgz = 4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640
#     compose v2.29.7    = 383ce6698cd5d5bbf958d2c8489ed75094e34a77d340404d9f32c4ae9e12baf0
#      （该值同时与 GitHub Release 发布的 .sha256 文件一致）
# 未内置摘要的版本一律 fail-closed 拒绝，必须显式传 --docker-sha256 / --compose-sha256。
pinned_docker_sha256() {
  case "${DOCKER_VERSION}/${ARCH}" in
    27.5.1/x86_64) echo '4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640' ;;
    *) echo '' ;;
  esac
}

pinned_compose_sha256() {
  case "${COMPOSE_VERSION}/${ARCH}" in
    v2.29.7/x86_64) echo '383ce6698cd5d5bbf958d2c8489ed75094e34a77d340404d9f32c4ae9e12baf0' ;;
    *) echo '' ;;
  esac
}

log() { printf '[fetch-static] %s\n' "$*"; }
die() { printf '[fetch-static] FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: fetch-docker-static.sh [选项]

  --docker-version <v>    docker 静态包版本，默认 27.5.1
  --compose-version <v>   compose v2 版本（带 v 前缀），默认 v2.29.7
  --arch <a>              下载架构，默认 x86_64（首版只承诺 amd64）
  --docker-sha256 <hex>   覆盖内置的 docker 静态包摘要（换版本时必填）
  --compose-sha256 <hex>  覆盖内置的 compose 摘要（换版本时必填）
  --out <dir>             输出目录，默认 installer/build/payload/kylin-uos/docker-static
  -h | --help             显示本帮助
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --docker-version) DOCKER_VERSION="${2:-}"; shift 2 ;;
    --compose-version) COMPOSE_VERSION="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --docker-sha256) DOCKER_SHA_OVERRIDE="${2:-}"; shift 2 ;;
    --compose-sha256) COMPOSE_SHA_OVERRIDE="${2:-}"; shift 2 ;;
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
COMPOSE_BIN="docker-compose-linux-${ARCH}"

EXPECTED_DOCKER_SHA="${DOCKER_SHA_OVERRIDE:-$(pinned_docker_sha256)}"
EXPECTED_COMPOSE_SHA="${COMPOSE_SHA_OVERRIDE:-$(pinned_compose_sha256)}"

if [ -z "${EXPECTED_DOCKER_SHA}" ]; then
  die "docker ${DOCKER_VERSION}/${ARCH} 没有内置摘要：请先在两个独立源下载同一文件比对后，用 --docker-sha256 <hex> 传入"
fi
if [ -z "${EXPECTED_COMPOSE_SHA}" ]; then
  die "compose ${COMPOSE_VERSION}/${ARCH} 没有内置摘要：请先用 --compose-sha256 <hex> 传入"
fi

# 单 URL 三次重试；--http1.1 是因为构建机上遇到过 HTTP/2 下的握手抖动
fetch_retry() {
  local url="$1" dest="$2" i
  for i in 1 2 3; do
    if curl -fsSL --http1.1 --retry 2 --retry-delay 2 -o "${dest}.part" "${url}"; then
      mv "${dest}.part" "${dest}"
      return 0
    fi
    log "  第 ${i} 次失败：${url}"
    sleep 2
  done
  return 1
}

# docker 静态包：官方源 → USTC 镜像（两源内容一致，摘要已内置，故换源不影响安全性）
fetch_static() {
  local rel="$1" dest="$2"
  log "下载 ${rel}"
  if fetch_retry "${DOCKER_BASE}/${ARCH}/${rel}" "${dest}"; then return 0; fi
  log "官方源不可用，切换镜像 ${DOCKER_MIRROR_BASE}"
  if fetch_retry "${DOCKER_MIRROR_BASE}/${ARCH}/${rel}" "${dest}"; then
    log "镜像源命中：${rel}"
    return 0
  fi
  die "下载失败：${rel}（官方源与镜像源均不可用）"
}

fetch_static "${DOCKER_TGZ}" "${OUT_DIR}/${DOCKER_TGZ}"
fetch_retry "${COMPOSE_BASE}/${COMPOSE_VERSION}/${COMPOSE_BIN}" "${OUT_DIR}/${COMPOSE_BIN}" \
  || die "下载失败：${COMPOSE_BIN}"

# ---------------------------------------------------------------- 三层校验
# 第一层：与内置摘要比对（离线可信锚点，不依赖下载期拿到的 .sha256）
verify_expected() {
  local file="$1" expected="$2" actual
  actual="$(sha256sum "${file}" | awk '{print $1}')"
  if [ "${expected}" != "${actual}" ]; then
    die "sha256 不匹配：$(basename "${file}") 期望 ${expected} 实际 ${actual}"
  fi
  log "sha256 OK（内置摘要）：$(basename "${file}")"
}

verify_expected "${OUT_DIR}/${DOCKER_TGZ}" "${EXPECTED_DOCKER_SHA}"
verify_expected "${OUT_DIR}/${COMPOSE_BIN}" "${EXPECTED_COMPOSE_SHA}"

# 第二层：compose 的发布方 .sha256 若能取到，必须与内置摘要一致（防摘要被误改）
COMPOSE_SHA_FILE="${OUT_DIR}/${COMPOSE_BIN}.sha256"
if fetch_retry "${COMPOSE_BASE}/${COMPOSE_VERSION}/${COMPOSE_BIN}.sha256" "${COMPOSE_SHA_FILE}"; then
  PUBLISHED_SHA="$(awk '{print $1; exit}' "${COMPOSE_SHA_FILE}")"
  if [ "${PUBLISHED_SHA}" != "${EXPECTED_COMPOSE_SHA}" ]; then
    die "compose 发布方 .sha256 (${PUBLISHED_SHA}) 与内置摘要 (${EXPECTED_COMPOSE_SHA}) 不一致"
  fi
  log "compose 发布方 .sha256 与内置摘要一致"
else
  log '提示：未取到 compose 发布方 .sha256，仅以内置摘要为准（已足够，摘要为离线可信锚点）'
fi

# tar 可读性预检：损坏的 tgz 到现场才炸是最贵的失败
tar -tzf "${OUT_DIR}/${DOCKER_TGZ}" >/dev/null 2>&1 || die "${DOCKER_TGZ} 不是有效的 gzip tar"

# 关键可执行文件必须在包里：dockerd 与 docker 缺一不可
# 注意：必须先把清单落成变量再 grep，**不能**写 `tar -tzf ... | grep -qx`。
# 在 `set -o pipefail` 下，grep -q 命中即退出会让 tar 收到 SIGPIPE（退出码 141），
# 管道整体判定为失败 → 明明包是好的也会误报「缺少 docker/dockerd」。
# 2026-11-09 实测踩到：76MB 的 docker-27.5.1.tgz 必然触发。
DOCKER_TGZ_LIST="$(tar -tzf "${OUT_DIR}/${DOCKER_TGZ}")" || die "${DOCKER_TGZ} 目录无法读取"
grep -qx 'docker/dockerd' <<<"${DOCKER_TGZ_LIST}" || die "${DOCKER_TGZ} 内缺少 docker/dockerd"
grep -qx 'docker/docker' <<<"${DOCKER_TGZ_LIST}" || die "${DOCKER_TGZ} 内缺少 docker/docker"
grep -qx 'docker/containerd' <<<"${DOCKER_TGZ_LIST}" || die "${DOCKER_TGZ} 内缺少 docker/containerd"
grep -qx 'docker/runc' <<<"${DOCKER_TGZ_LIST}" || die "${DOCKER_TGZ} 内缺少 docker/runc"
grep -qx 'docker/containerd-shim-runc-v2' <<<"${DOCKER_TGZ_LIST}" || die "${DOCKER_TGZ} 内缺少 containerd-shim-runc-v2"

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
  echo "EXPECTED_DOCKER_SHA256=${EXPECTED_DOCKER_SHA}"
  echo "EXPECTED_COMPOSE_SHA256=${EXPECTED_COMPOSE_SHA}"
  echo "# --- 以下为逐文件 sha256 ---"
} > "${STATIC_MANIFEST}"
( cd "${OUT_DIR}" && sha256sum "${DOCKER_TGZ}" "${COMPOSE_BIN}" ) >> "${STATIC_MANIFEST}"

TOTAL_BYTES="$(du -sb "${OUT_DIR}" | awk '{print $1}')"
log "完成，合计 ${TOTAL_BYTES} 字节"
log "清单：${STATIC_MANIFEST}"
log '提醒：变体 B 的安装逻辑本期未实现（team-lead 裁定），载荷先就位。'
