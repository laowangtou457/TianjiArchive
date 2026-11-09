#!/usr/bin/env bash
# =============================================================================
# 构建机脚本：抓取 docker-ce 的 .deb 依赖闭包（变体 A 载荷）
#
# 这是**唯一允许联网**的脚本之一，且只在构建机执行；服务器端安装器代码严禁出网
# （见 docs/INSTALLER-DESIGN.md §5.3）。
#
# 为什么必须用 --download-only + Dir::Cache::archives：
#   `apt download docker-ce` 只下指定包、不含传递依赖，现场 `dpkg -i` 会因缺
#   libseccomp2 等失败；而现场 `apt-get -f install` 会尝试联网（违反硬约束）。
#   只有把「含传递依赖」的完整 .deb 集合离线带过去，现场才能纯 `dpkg -i`。
#
# 用法（在仓库根或任意位置均可）：
#   bash installer/build/fetch-docker-debs.sh --codename jammy
#   bash installer/build/fetch-docker-debs.sh --codename noble  --out /tmp/debs-noble
#   bash installer/build/fetch-docker-debs.sh --codename jammy  --pin-version
#
# 退出码：0 成功；1 前置条件不满足；2 抓取失败；3 产出校验失败
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CODENAME=''
OUT_DIR=''
PIN_VERSION='no'
DOCKER_CHANNEL='stable'

# 需要随闭包一起带走的最小包集合：引擎、CLI、容器运行时、buildx、compose v2 插件。
# compose v2 是硬需求：docker-compose.offline.yml 用了顶层 name: 与
# depends_on.condition，compose v1 不认（见设计 §4.3）。
PACKAGES=(
  docker-ce
  docker-ce-cli
  containerd.io
  docker-buildx-plugin
  docker-compose-plugin
)

log() { printf '[fetch-debs] %s\n' "$*"; }
die() { printf '[fetch-debs] FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: fetch-docker-debs.sh --codename <jammy|noble|bookworm> [选项]

  --codename <c>      必填。目标机 Ubuntu/Debian 的 VERSION_CODENAME，
                      必须与构建机当前系统一致（否则闭包与目标机 glibc 不匹配）。
  --out <dir>         输出目录，默认 installer/build/payload/ubuntu-debian/<c>/debs
  --pin-version       把当前可解析到的 docker-ce 版本写入 DEBS-MANIFEST.txt 的
                      DOCKER_VERSION 行，供 manifest.json 引用（固定版本，避免漂移）
  -h | --help         显示本帮助
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --codename) CODENAME="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --pin-version) PIN_VERSION='yes'; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

[ -n "${CODENAME}" ] || die '必须指定 --codename'

# ---------------------------------------------------------------- 前置条件
command -v apt-get >/dev/null 2>&1 || die '未找到 apt-get：本脚本只能在 Debian 系构建机执行'
command -v dpkg >/dev/null 2>&1 || die '未找到 dpkg'
command -v sha256sum >/dev/null 2>&1 || die '未找到 sha256sum'

# 构建机自身必须就是目标 codename：
# 跨 codename 抓包 = 拿 noble 的 glibc 依赖去 jammy 上 dpkg，必炸。
[ -r /etc/os-release ] || die '读不到 /etc/os-release'
# shellcheck disable=SC1091
. /etc/os-release
HOST_CODENAME="${VERSION_CODENAME:-}"
[ -n "${HOST_CODENAME}" ] || die '构建机 /etc/os-release 无 VERSION_CODENAME，无法判定'
if [ "${HOST_CODENAME}" != "${CODENAME}" ]; then
  die "构建机 codename=${HOST_CODENAME} 与目标 ${CODENAME} 不一致：请在 ${CODENAME} 的机器上跑，或用容器跑"
fi
log "构建机：ID=${ID:-?} VERSION_ID=${VERSION_ID:-?} CODENAME=${HOST_CODENAME}"

[ "$(id -u)" = '0' ] && SUDO='' || SUDO='sudo'
if [ -n "${SUDO}" ]; then
  command -v sudo >/dev/null 2>&1 || die '非 root 且无 sudo'
  log '以 sudo 执行 apt-get'
fi

if [ -z "${OUT_DIR}" ]; then
  OUT_DIR="${REPO_ROOT}/installer/build/payload/ubuntu-debian/${CODENAME}/debs"
fi
mkdir -p "${OUT_DIR}"
OUT_DIR="$(cd "${OUT_DIR}" && pwd)"
log "输出目录：${OUT_DIR}"

# ---------------------------------------------------------------- 抓取
# 注意：--download-only 只下载不安装，系统状态不变；Dir::Cache::archives 让
# 所有 .deb（含传递依赖）落到我们的目录，而不是 /var/cache/apt/archives。
log "apt-get update（构建机联网步骤）"
${SUDO} apt-get update || die 'apt-get update 失败'

log "下载依赖闭包：${PACKAGES[*]}"
set +e
${SUDO} apt-get install --download-only --reinstall -y \
  -o Dir::Cache::archives="${OUT_DIR}" \
  "${PACKAGES[@]}"
RC=$?
set -e
[ "${RC}" -eq 0 ] || die "apt-get install --download-only 失败（退出码 ${RC}）：注意 --download-only 仍会做依赖解析，缺源即失败"

# apt 的 archives 目录是扁平的，partial/ 是临时目录，必须清掉再参与校验
rm -rf "${OUT_DIR}/partial"

DEB_COUNT="$(find "${OUT_DIR}" -maxdepth 1 -name '*.deb' -type f | wc -l | tr -d ' ')"
[ "${DEB_COUNT}" -gt 0 ] || die '没有抓到任何 .deb'
log "抓到 ${DEB_COUNT} 个 .deb"

# ---------------------------------------------------------------- 产出记录
DOCKER_VERSION=''
if [ "${PIN_VERSION}" = 'yes' ]; then
  DOCKER_VERSION="$(apt-cache policy docker-ce 2>/dev/null | awk '/Candidate:/ {print $2; exit}')"
  [ -n "${DOCKER_VERSION}" ] || die 'apt-cache policy 取不到 docker-ce 候选版本'
fi

COMPOSE_VERSION="$(apt-cache policy docker-compose-plugin 2>/dev/null | awk '/Candidate:/ {print $2; exit}')"

MANIFEST="${OUT_DIR}/DEBS-MANIFEST.txt"
{
  echo "# 由 installer/build/fetch-docker-debs.sh 生成，请勿手工编辑"
  echo "# 生成时间(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "OS_ID=${ID:-unknown}"
  echo "OS_VERSION_ID=${VERSION_ID:-unknown}"
  echo "OS_CODENAME=${HOST_CODENAME}"
  echo "ARCH=$(uname -m)"
  echo "DEB_COUNT=${DEB_COUNT}"
  echo "DOCKER_CHANNEL=${DOCKER_CHANNEL}"
  echo "DOCKER_VERSION=${DOCKER_VERSION}"
  echo "COMPOSE_PLUGIN_VERSION=${COMPOSE_VERSION}"
  echo "# --- 以下为逐文件 sha256，格式与离线包 SHA256SUMS 同源 ---"
} > "${MANIFEST}"

( cd "${OUT_DIR}" && sha256sum ./*.deb | sed 's|  \./|  |' ) >> "${MANIFEST}"

# ---------------------------------------------------------------- 自校验
log '自校验：逐文件 sha256sum -c'
( cd "${OUT_DIR}" && grep -E '^[0-9a-f]{64}  .*\.deb$' DEBS-MANIFEST.txt | sha256sum -c - >/dev/null ) \
  || die 'DEBS-MANIFEST.txt 与磁盘文件不一致（抓取过程可能被截断）'

# 关键包存在性检查：compose v2 插件缺失会导致现场 up -d 直接不认文件
for must in docker-ce_ docker-ce-cli_ containerd.io_ docker-compose-plugin_; do
  find "${OUT_DIR}" -maxdepth 1 -name "${must}*.deb" -type f | grep -q . \
    || die "闭包里缺少 ${must}*.deb"
done

TOTAL_BYTES="$(du -sb "${OUT_DIR}" | awk '{print $1}')"
log "完成：${DEB_COUNT} 个 .deb，合计 ${TOTAL_BYTES} 字节"
log "清单：${MANIFEST}"
log "下一步：bash installer/build/build-server-package.sh --variant ubuntu-debian --codename ${CODENAME}"
