#!/usr/bin/env bash
# =============================================================================
# 构建机脚本：抓取 docker-ce 的 .deb 依赖闭包（变体 A 载荷）
#
# 这是**唯一允许联网**的脚本之一，且只在构建机执行；服务器端安装器代码严禁出网
# （见 docs/安装器总体设计.md §5.3）。
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
# Docker 官方 apt 源的基址。国内构建机常被 TLS 掐断（实测 download.docker.com
# 经宿主代理时 curl 报 "unexpected eof while reading"），可用 --docker-base 换镜像，
# 镜像与官方**同布局**（.../linux/ubuntu），公钥也从同一基址取，仍由 gpg 解析校验。
DOCKER_BASE=''

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
  --docker-base <url> Docker apt 源基址，默认官方
                      https://download.docker.com/linux/{ubuntu|debian}
                      国内可用：https://mirrors.aliyun.com/docker-ce/linux/ubuntu
  -h | --help         显示本帮助
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --codename) CODENAME="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --pin-version) PIN_VERSION='yes'; shift ;;
    --docker-base) DOCKER_BASE="${2:-}"; shift 2 ;;
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

# ---------------------------------------------------------------- docker 官方源
# Ubuntu/Debian 官方源里**没有** docker-ce：不加 Docker 的 apt 源，
# apt-get install docker-ce 会直接 `Unable to locate package`（实测踩到）。
# 设计 §4.2 的「再补 docker 官方 apt 源中的固定版本」就是这一步。
# 幂等：源里已能解析到 docker-ce 就跳过，避免覆盖构建机既有配置。
ensure_docker_repo() {
  local candidate
  candidate="$(apt-cache policy docker-ce 2>/dev/null | awk '/Candidate:/ {print $2}' | sed -n '1p')"
  if [ -n "${candidate}" ] && [ "${candidate}" != '(none)' ]; then
    log "docker-ce 已可解析（Candidate=${candidate}），跳过添加官方源"
    return 0
  fi

  # 加源需要 curl 与 gnupg；精简镜像里通常都没有。
  if ! command -v curl >/dev/null 2>&1 || ! command -v gpg >/dev/null 2>&1; then
    # 必须先 update 再装：容器/精简镜像的 apt 索引是空的，直接 install 会报
    # 「Package 'ca-certificates' has no installation candidate」——实测踩到。
    log 'apt-get update（为空索引打底，随后安装加源所需工具）'
    ${SUDO} apt-get update || die 'apt-get update 失败（检查代理与 /etc/apt/sources.list）'
    log '安装加源所需的 ca-certificates/curl/gnupg（构建机一次性动作）'
    ${SUDO} apt-get install -y --no-install-recommends ca-certificates curl gnupg \
      || die '安装 ca-certificates/curl/gnupg 失败（检查代理与源）'
  fi

  local base
  if [ -n "${DOCKER_BASE}" ]; then
    base="${DOCKER_BASE}"
    log "使用显式指定的 Docker 源基址：${base}"
  else
    case "${ID:-}" in
      ubuntu) base='https://download.docker.com/linux/ubuntu' ;;
      debian) base='https://download.docker.com/linux/debian' ;;
      *) die "不支持的系统 ID=${ID:-unknown}：本脚本只处理 ubuntu/debian" ;;
    esac
  fi

  log "添加 Docker 官方 apt 源：${base} ${CODENAME} stable"
  ${SUDO} install -m 0755 -d /etc/apt/keyrings
  curl -fsSL --retry 3 --retry-delay 2 "${base}/gpg" -o /tmp/docker-gpg.asc \
    || die "下载 ${base}/gpg 失败（代理/网络问题）
  国内构建机可换镜像重跑： --docker-base https://mirrors.aliyun.com/docker-ce/linux/${ID:-ubuntu}"
  # 关键：先验一下拿到的确实是一把 PGP 公钥，而不是代理返回的错误页
  gpg --dearmor < /tmp/docker-gpg.asc > /tmp/docker-gpg.gpg 2>/dev/null \
    || die 'Docker GPG 公钥无法解析（可能拿到的是错误页而非公钥）'
  ${SUDO} install -m 0644 /tmp/docker-gpg.gpg /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] ${base} ${CODENAME} stable" \
    | ${SUDO} tee /etc/apt/sources.list.d/docker.list >/dev/null
  log 'Docker 官方源已写入 /etc/apt/sources.list.d/docker.list'
}

ensure_docker_repo

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

# ---------------------------------------------------------------- 补齐基础依赖
# 实测踩到的坑：构建容器 ubuntu:22.04 自带 libseccomp2（systemd 的依赖），
# apt 认为「依赖已满足」就不会下载它；而现场若是最小化系统，dpkg -i 时缺它就是
# 设计 §4.2 点名的那种失败，且现象是 docker-ce 装完却起不来。
# --reinstall 强制重新下载这些「目标机未必有」的基础包，让闭包与构建机的
# 既有安装状态**无关**——这是闭包能自称「闭」的前提。
ALWAYS_DOWNLOAD=(
  libseccomp2
  libc6
  libsystemd0
  libdevmapper1.02.1
  iptables
  libnftables1
  libmnl0
  libnfnetlink0
)
log "补下载目标机可能缺失的基础依赖：${ALWAYS_DOWNLOAD[*]}"
set +e
${SUDO} apt-get install --download-only --reinstall -y \
  -o Dir::Cache::archives="${OUT_DIR}" "${ALWAYS_DOWNLOAD[@]}" >/dev/null 2>&1
SUPP_RC=$?
set -e
# 个别包在目标源的该 codename 里可能不存在（例如精简源），不因它整体失败，
# 但必须把退出码记进日志，避免「静默少包」。
[ "${SUPP_RC}" -eq 0 ] || log "WARN: 补下载返回 ${SUPP_RC}，个别包可能不在源中（见下一条计数）"
rm -rf "${OUT_DIR}/partial"

DEB_COUNT="$(find "${OUT_DIR}" -maxdepth 1 -name '*.deb' -type f | wc -l | tr -d ' ')"
[ "${DEB_COUNT}" -gt 0 ] || die '没有抓到任何 .deb'
log "抓到 ${DEB_COUNT} 个 .deb"

# ---------------------------------------------------------------- 产出记录
DOCKER_VERSION=''
if [ "${PIN_VERSION}" = 'yes' ]; then
  DOCKER_VERSION="$(apt-cache policy docker-ce 2>/dev/null | awk '/Candidate:/ {print $2}' | sed -n '1p')"
  [ -n "${DOCKER_VERSION}" ] || die 'apt-cache policy 取不到 docker-ce 候选版本'
fi

# 注意（实测踩到，现象是「脚本莫名以退出码 141 静默终止」）：
# 上面这种取值**不能**写成 `awk '... {print $2; exit}'`。本脚本开了 pipefail，
# awk 提前 exit 会让上游 apt-cache 吃到 SIGPIPE（141），pipefail 把整条命令替换
# 判为失败，set -e 随即终止脚本——表现为「刚打印出抓到 N 个 deb 就退出，
# 既不报错也不生成清单」。改成 awk 读完全部输入、再由 sed 取第一行。
COMPOSE_VERSION="$(apt-cache policy docker-compose-plugin 2>/dev/null | awk '/Candidate:/ {print $2}' | sed -n '1p')"

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

# 规范化成「hash␠␠path」：GNU coreutils 的二进制模式（`sha256sum -b` 或 Git Bash
# 默认）输出 `hash *./x.deb`，若原样落进清单，`sha256sum -c` 与安装器的解析都会
# 把路径认成 "*./x.deb"，症状是「哈希明明相同却报文件缺失」。
( cd "${OUT_DIR}" && sha256sum ./*.deb ) \
  | sed -e 's|^\\||' -e 's|^\([0-9a-f]\{64\}\) [ *]|\1  |' \
  | sed -e 's|^\([0-9a-f]\{64\}  \)\./|\1|' >> "${MANIFEST}"

# ---------------------------------------------------------------- 自校验
log '自校验：逐文件 sha256sum -c'
( cd "${OUT_DIR}" && grep -E '^[0-9a-f]{64}  .*\.deb$' DEBS-MANIFEST.txt | sha256sum -c - >/dev/null ) \
  || die 'DEBS-MANIFEST.txt 与磁盘文件不一致（抓取过程可能被截断）'

# 关键包存在性检查：compose v2 插件缺失会导致现场 up -d 直接不认文件；
# libseccomp2 缺失会让 docker-ce 装完起不来（设计 §4.2 点名的失败）。
for must in docker-ce_ docker-ce-cli_ containerd.io_ docker-compose-plugin_ libseccomp2_; do
  # 用 find -print -quit 主动收尾，不要写 `find | grep -q .`：
  # grep -q 命中即退出会让 find 收到 SIGPIPE（141），在 set -o pipefail 下整条判失败，
  # 于是「包明明在」却报「闭包不完整」。本仓库已三次踩到这个组合（见 fetch-docker-static.sh）。
  [ -n "$(find "${OUT_DIR}" -maxdepth 1 -name "${must}*.deb" -type f -print -quit)" ] \
    || die "闭包里缺少 ${must}*.deb（闭包不完整，禁止出包）"
done

TOTAL_BYTES="$(du -sb "${OUT_DIR}" | awk '{print $1}')"
log "完成：${DEB_COUNT} 个 .deb，合计 ${TOTAL_BYTES} 字节"
log "清单：${MANIFEST}"
log "下一步：bash installer/build/build-server-package.sh --variant ubuntu-debian --codename ${CODENAME}"
