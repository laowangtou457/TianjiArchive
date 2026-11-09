#!/usr/bin/env bash
# =============================================================================
# 构建机脚本：组装服务器端安装包（.run）
#
# 产物布局（见 docs/INSTALLER-DESIGN.md §2.2）：
#   tianji-server-setup-<variant>-amd64-<version>.run
#   ├── [自解压头] POSIX sh：自校验 sha256 → 释放到 /opt/tianji-installer → exec
#   └── payload.tar.gz
#       ├── bin/tianji-installer        静态二进制（GOOS=linux CGO_ENABLED=0）
#       ├── docker/debs|static/...      变体 A 的 .deb 闭包 / 变体 B 的静态包
#       ├── common/…                    compose、load-images、smoke、seaweedfs、env.tpl
#       ├── manifest.json
#       └── SHA256SUMS.txt
#
# 三条 fail-closed 闸门（任何一条不过就退出，不产出半成品）：
#   G1 载荷一致性：payload/common/ 下 5 个文件必须与 offline/、infra/ 的源**逐字节相同**
#   G2 安装器二进制：必须存在且是 linux/amd64 ELF（不是脚本、不是 darwin 产物）
#   G3 自解压可用性：产出后立刻用 `sh <run> --verify-only` 自校验 payload sha256
#
# 用法：
#   bash installer/build/build-server-package.sh --variant ubuntu-debian --codename jammy \
#        --installer installer/server/dist/tianji-installer --images-tar offline/tianji-offline-images.tar
#
# 退出码：0 成功；1 参数/前置不满足；2 载荷闸门失败；3 打包失败
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

VARIANT=''
CODENAME=''
VERSION='1.0.0'
INSTALLER_BIN=''
IMAGES_TAR=''
OUT_DIR=''
DO_SIGN='no'
GPG_KEY=''

log() { printf '[package] %s\n' "$*"; }
die() { printf '[package] FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: build-server-package.sh --variant <a|b> [选项]

  --variant <v>       必填。ubuntu-debian | kylin-uos
  --codename <c>      变体 A 必填。jammy | noble | bookworm
  --version <v>       版本号，默认 1.0.0
  --installer <f>     linux/amd64 安装器二进制路径
                      默认 installer/server/dist/tianji-installer
  --images-tar <f>    镜像 tar 路径（用于记录 sha256 并与 offline/SHA256SUMS 同源核对）
  --out <dir>         产物目录，默认 <仓库>/dist/installer
  --sign              给 SHA256SUMS.txt 做 gpg 分离签名
  --gpg-key <id>      指定签名密钥（默认取 gpg 默认密钥；建议显式指定专用构建密钥）
  -h | --help         显示本帮助
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --variant) VARIANT="${2:-}"; shift 2 ;;
    --codename) CODENAME="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --installer) INSTALLER_BIN="${2:-}"; shift 2 ;;
    --images-tar) IMAGES_TAR="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --sign) DO_SIGN='yes'; shift ;;
    --gpg-key) GPG_KEY="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

case "${VARIANT}" in
  ubuntu-debian) ARCH_TAG='amd64'; [ -n "${CODENAME}" ] || die '变体 A 必须给 --codename' ;;
  kylin-uos) ARCH_TAG='amd64' ;;
  *) die "--variant 只能是 ubuntu-debian 或 kylin-uos，收到：${VARIANT}" ;;
esac

[ -n "${INSTALLER_BIN}" ] || INSTALLER_BIN="${REPO_ROOT}/installer/server/dist/tianji-installer"
[ -n "${OUT_DIR}" ] || OUT_DIR="${REPO_ROOT}/dist/installer"
mkdir -p "${OUT_DIR}"
OUT_DIR="$(cd "${OUT_DIR}" && pwd)"

for tool in tar sha256sum awk od; do
  command -v "${tool}" >/dev/null 2>&1 || die "缺少 ${tool}"
done

log "变体=${VARIANT} codename=${CODENAME:-n/a} 版本=${VERSION}"
log "产物目录=${OUT_DIR}"

# =============================================================================
# G1 载荷一致性：与仓库源逐字节比对，防止「安装包载荷 vs 仓库源」漂移
# =============================================================================
PAYLOAD_COMMON="${SCRIPT_DIR}/payload/common"
[ -d "${PAYLOAD_COMMON}" ] || die "载荷目录不存在：${PAYLOAD_COMMON}"

declare -a CMP_PAIRS=(
  "compose/docker-compose.offline.yml|${REPO_ROOT}/offline/docker-compose.offline.yml"
  "scripts/load-images.sh|${REPO_ROOT}/offline/load-images.sh"
  "scripts/smoke.sh|${REPO_ROOT}/offline/smoke.sh"
  "scripts/save-images.sh|${REPO_ROOT}/offline/save-images.sh"
  "scripts/images.txt|${REPO_ROOT}/offline/images.txt"
  "seaweedfs/entrypoint.sh|${REPO_ROOT}/infra/seaweedfs/entrypoint.sh"
  "seaweedfs/s3.json.tpl|${REPO_ROOT}/infra/seaweedfs/s3.json.tpl"
)

log 'G1 载荷一致性校验（cmp 逐字节）'
for pair in "${CMP_PAIRS[@]}"; do
  rel="${pair%%|*}"
  src="${pair#*|}"
  dst="${PAYLOAD_COMMON}/${rel}"
  [ -f "${dst}" ] || die "载荷缺失：${dst}（请先从源处拷贝）"
  [ -f "${src}" ] || die "源文件缺失：${src}"
  if ! cmp -s "${dst}" "${src}"; then
    die "载荷与源不一致：${rel}
  载荷 ${dst}
  源   ${src}
  请用 cp 整体覆盖载荷（不要挑行合并），再重跑本脚本"
  fi
done
log "G1 PASS：${#CMP_PAIRS[@]} 个文件与源逐字节一致"

# =============================================================================
# G2 安装器二进制：必须是 linux/amd64 ELF
# =============================================================================
log 'G2 安装器二进制校验'
[ -f "${INSTALLER_BIN}" ] || die "安装器二进制不存在：${INSTALLER_BIN}
  交叉编译： CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \\
              -ldflags '-s -w' -o installer/server/dist/tianji-installer ./cmd/tianji-installer"

MAGIC="$(od -An -tx1 -N4 "${INSTALLER_BIN}" | tr -d ' \n')"
[ "${MAGIC}" = '7f454c46' ] || die "不是 ELF 文件（首 4 字节 ${MAGIC}）：${INSTALLER_BIN}"

# e_machine 在 ELF 头偏移 18（2 字节小端）：0x3e = x86-64
E_MACHINE="$(od -An -tx1 -j18 -N2 "${INSTALLER_BIN}" | tr -d ' \n')"
[ "${E_MACHINE}" = '3e00' ] || die "不是 x86-64 ELF（e_machine=${E_MACHINE}，期望 3e00）"
BIN_BYTES="$(wc -c < "${INSTALLER_BIN}" | tr -d ' ')"
log "G2 PASS：ELF64/amd64，${BIN_BYTES} 字节"

# =============================================================================
# 组装暂存目录
# =============================================================================
STAGE="$(mktemp -d "${OUT_DIR}/.stage.XXXXXX")"
trap 'rm -rf "${STAGE}"' EXIT INT TERM

mkdir -p "${STAGE}/bin" "${STAGE}/common" "${STAGE}/docker"
cp -p "${INSTALLER_BIN}" "${STAGE}/bin/tianji-installer"
chmod 0755 "${STAGE}/bin/tianji-installer"

cp -a "${PAYLOAD_COMMON}/." "${STAGE}/common/"

# .env.tpl 由 .env.example 现场派生：单一源、不可能漂移。
# 与设计 §2.1 的差异：设计把它列为「提交入库的载荷文件」，这里改为构建期派生；
# 好处是不存在「.env.example 改了、.env.tpl 忘了改」这类静默漂移。
ENV_SRC="${REPO_ROOT}/.env.example"
ENV_TPL="${STAGE}/common/env/.env.tpl"
[ -f "${ENV_SRC}" ] || die "缺少 ${ENV_SRC}"
mkdir -p "${STAGE}/common/env"
cp -p "${ENV_SRC}" "${ENV_TPL}"

# 必须占位化的键：6 项凭据 + 局域网地址 + CORS 白名单（设计 §3.4 第 4 步）
PLACEHOLDER_KEYS=(
  POSTGRES_PASSWORD
  MINIO_ACCESS_KEY
  MINIO_SECRET_KEY
  JWT_ACCESS_SECRET
  JWT_REFRESH_SECRET
  REDIS_PASSWORD
  CORS_ORIGINS
)
for key in "${PLACEHOLDER_KEYS[@]}"; do
  hits="$(grep -c "^${key}=" "${ENV_TPL}" || true)"
  if [ "${hits}" -eq 0 ]; then
    log "WARN: ${ENV_SRC} 里没有 ${key}=，跳过占位化"
    continue
  fi
  [ "${hits}" -eq 1 ] || die "${ENV_SRC} 里 ${key}= 出现 ${hits} 次（应为 1 次）"
  awk -v k="${key}" '
    index($0, k "=") == 1 { print k "=__" k "__"; next }
    { print }
  ' "${ENV_TPL}" > "${ENV_TPL}.tmp" && mv "${ENV_TPL}.tmp" "${ENV_TPL}"
done

# S3_PUBLIC_* 在 .env.example 里是**注释掉的占位符**（源文件刻意不代拍板具体 IP）。
# 但离线栈的 compose 用 ${S3_PUBLIC_ENDPOINT:-127.0.0.1} 兜底，默认回环地址会让
# 局域网浏览器拿到的预签名 URL 指向 127.0.0.1:8333 —— 症状是「能登录、能检索、
# 一上传就失败」（设计风险 R9，红色高风险）。因此安装包里的 .env.tpl 必须把这三项
# **从注释里放出来**，由向导强制填写局域网 IP，不允许静默走回环兜底。
uncomment_key() {
  local key="$1" value="$2"
  local active commented
  active="$(grep -c "^${key}=" "${ENV_TPL}" || true)"
  commented="$(grep -c "^# *${key}=" "${ENV_TPL}" || true)"
  if [ "${active}" -eq 1 ]; then
    awk -v k="${key}" -v v="${value}" '
      index($0, k "=") == 1 { print k "=" v; next }
      { print }
    ' "${ENV_TPL}" > "${ENV_TPL}.tmp" && mv "${ENV_TPL}.tmp" "${ENV_TPL}"
    return 0
  fi
  if [ "${commented}" -eq 1 ]; then
    awk -v k="${key}" -v v="${value}" '
      $0 ~ ("^# *" k "=") { print k "=" v; next }
      { print }
    ' "${ENV_TPL}" > "${ENV_TPL}.tmp" && mv "${ENV_TPL}.tmp" "${ENV_TPL}"
    return 0
  fi
  return 1
}

uncomment_key S3_PUBLIC_ENDPOINT '__S3_PUBLIC_ENDPOINT__' \
  || die '.env.example 里找不到 S3_PUBLIC_ENDPOINT（注释或未注释形式都没有）'
uncomment_key S3_PUBLIC_PORT '8333' \
  || die '.env.example 里找不到 S3_PUBLIC_PORT'
uncomment_key S3_PUBLIC_USE_SSL 'false' \
  || die '.env.example 里找不到 S3_PUBLIC_USE_SSL'

grep -qx 'S3_PUBLIC_ENDPOINT=__S3_PUBLIC_ENDPOINT__' "${ENV_TPL}" \
  || die '.env.tpl 的 S3_PUBLIC_ENDPOINT 未占位化（会导致预签名 URL 指向 127.0.0.1）'

LEFT="$(grep -cE '__(POSTGRES_PASSWORD|MINIO_ACCESS_KEY|MINIO_SECRET_KEY|JWT_ACCESS_SECRET|JWT_REFRESH_SECRET)__' "${ENV_TPL}" || true)"
[ "${LEFT}" -ge 5 ] || die ".env.tpl 占位化不完整（只替换到 ${LEFT} 处，至少应 5 处）"
log "env.tpl 已派生：$(wc -l < "${ENV_TPL}" | tr -d ' ') 行，凭据与 S3 公网端点已占位化"

# 变体专属载荷
if [ "${VARIANT}" = 'ubuntu-debian' ]; then
  SRC_DEBS="${SCRIPT_DIR}/payload/ubuntu-debian/${CODENAME}/debs"
  [ -d "${SRC_DEBS}" ] || die "缺少 deb 载荷：${SRC_DEBS}
  先执行： bash installer/build/fetch-docker-debs.sh --codename ${CODENAME}"
  DEB_COUNT="$(find "${SRC_DEBS}" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' ')"
  [ "${DEB_COUNT}" -gt 0 ] || die "${SRC_DEBS} 里没有 .deb"
  mkdir -p "${STAGE}/docker/debs"
  cp -p "${SRC_DEBS}"/*.deb "${STAGE}/docker/debs/"
  [ -f "${SRC_DEBS}/DEBS-MANIFEST.txt" ] || die "缺少 ${SRC_DEBS}/DEBS-MANIFEST.txt"
  cp -p "${SRC_DEBS}/DEBS-MANIFEST.txt" "${STAGE}/docker/debs/"
  log "deb 载荷：${DEB_COUNT} 个"
else
  SRC_STATIC="${SCRIPT_DIR}/payload/kylin-uos/docker-static"
  [ -d "${SRC_STATIC}" ] || die "缺少 static 载荷：${SRC_STATIC}
  先执行： bash installer/build/fetch-docker-static.sh"
  mkdir -p "${STAGE}/docker/static"
  cp -p "${SRC_STATIC}"/*.tgz "${STAGE}/docker/static/" 2>/dev/null || die "static 目录没有 .tgz"
  cp -p "${SRC_STATIC}"/STATIC-MANIFEST.txt "${STAGE}/docker/static/" 2>/dev/null || true
  if [ -f "${SRC_STATIC}/docker-compose-linux-x86_64" ]; then
    cp -p "${SRC_STATIC}/docker-compose-linux-x86_64" "${STAGE}/docker/static/docker-compose"
    chmod 0755 "${STAGE}/docker/static/docker-compose"
  else
    die "缺少 compose v2 单二进制：${SRC_STATIC}/docker-compose-linux-x86_64"
  fi
  log 'static 载荷已就位（变体 B 安装逻辑本期未实现，仅打包）'
fi

printf '%s\n' "${VERSION}" > "${STAGE}/VERSION"

# =============================================================================
# manifest + SHA256SUMS
# =============================================================================
# 注意：这里必须用 if，不能写成 `[ -n x ] && args+=(...)`——在 set -e 下
# 该写法在条件为假时返回 1，会让脚本直接退出。
MANIFEST_ARGS=( --dir "${STAGE}" --variant "${VARIANT}" --version "${VERSION}" )
if [ -n "${CODENAME}" ]; then
  MANIFEST_ARGS+=( --codename "${CODENAME}" )
fi
if [ -n "${IMAGES_TAR}" ]; then
  MANIFEST_ARGS+=( --images-tar "${IMAGES_TAR}" )
fi
if [ "${DO_SIGN}" = 'yes' ]; then
  MANIFEST_ARGS+=( --sign )
  # 显式指定密钥：构建机上往往还有开发用密钥，靠「默认密钥」会在换机器时静默
  # 签到另一把钥匙上，现场的 public key 就对不上了。
  if [ -n "${GPG_KEY}" ]; then
    MANIFEST_ARGS+=( --gpg-key "${GPG_KEY}" )
  fi
fi
bash "${SCRIPT_DIR}/make-manifest.sh" "${MANIFEST_ARGS[@]}"

# =============================================================================
# payload.tar.gz：确定性打包（同输入同输出，便于对比两次构建）
#
# 必须打到暂存目录**外面**：tgz 落在被扫描的目录里会让 tar 报
# 「file changed as we read it」并中断（已实测）。
# =============================================================================
PAYLOAD_TGZ="${STAGE}.payload.tar.gz"
log '打包 payload.tar.gz（确定性：排序 + 固定 mtime/owner）'
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -czf "${PAYLOAD_TGZ}" -C "${STAGE}" . \
  || die 'tar 打包失败'
PAYLOAD_SHA="$(sha256sum "${PAYLOAD_TGZ}" | awk '{print $1}')"
PAYLOAD_SHA="${PAYLOAD_SHA#\\}"   # 去掉 coreutils 可能加的前导转义反斜杠
log "payload sha256=${PAYLOAD_SHA}"

# =============================================================================
# 生成 .run：头部定长替换，保证 PAYLOAD_OFFSET 精确
# =============================================================================
HEADER_IN="${SCRIPT_DIR}/selfextract/header.sh.in"
HEADER_TMP="${STAGE}/header.sh"
[ -f "${HEADER_IN}" ] || die "缺少自解压头模板：${HEADER_IN}"

# 第一遍：offset 用等长全零占位，量出头部字节数
sed -e "s|__VERSION__|${VERSION}|g" \
    -e "s|__VARIANT__|${VARIANT}|g" \
    -e "s|__ARCH__|${ARCH_TAG}|g" \
    -e "s|__PAYLOAD_SHA256__|${PAYLOAD_SHA}|g" \
    -e "s|__PAYLOAD_OFFSET__|0000000000|g" \
    "${HEADER_IN}" > "${HEADER_TMP}"
HEADER_BYTES="$(wc -c < "${HEADER_TMP}" | tr -d ' ')"
[ "${HEADER_BYTES}" -lt 9999999999 ] || die "头部过大：${HEADER_BYTES} 字节"

# 第二遍：把定长占位换成真实 offset（位宽相同 → 长度不变）
awk -v off="${HEADER_BYTES}" '{
  sub(/PAYLOAD_OFFSET=0000000000/, sprintf("PAYLOAD_OFFSET=%010d", off)); print
}' "${HEADER_TMP}" > "${HEADER_TMP}.2"
mv "${HEADER_TMP}.2" "${HEADER_TMP}"

AFTER_BYTES="$(wc -c < "${HEADER_TMP}" | tr -d ' ')"
[ "${AFTER_BYTES}" = "${HEADER_BYTES}" ] || die "头部长度变化（${HEADER_BYTES} -> ${AFTER_BYTES}），offset 会错位"
grep -q "PAYLOAD_OFFSET=$(printf '%010d' "${HEADER_BYTES}")" "${HEADER_TMP}" \
  || die 'PAYLOAD_OFFSET 未正确写入'

RUN_NAME="tianji-server-setup-${VARIANT}-${ARCH_TAG}-${VERSION}.run"
RUN_PATH="${OUT_DIR}/${RUN_NAME}"
rm -f "${RUN_PATH}"
cat "${HEADER_TMP}" "${PAYLOAD_TGZ}" > "${RUN_PATH}"
chmod 0755 "${RUN_PATH}"

# =============================================================================
# G3 自解压可用性自检（不需要 root）
# =============================================================================
log 'G3 自解压自检：sh <run> --verify-only（构建机只做壳层 sha256，不写 /opt）'
if ! TIANJI_VERIFY_SHELL_ONLY=1 sh "${RUN_PATH}" --verify-only; then
  rm -f "${RUN_PATH}"
  die '自解压自检失败，已删除不完整产物'
fi

RUN_BYTES="$(wc -c < "${RUN_PATH}" | tr -d ' ')"
RUN_SHA="$(sha256sum "${RUN_PATH}" | awk '{print $1}')"
log '---------------------------------------------'
log "产物：${RUN_NAME}"
log "  字节：${RUN_BYTES}"
log "  sha256：${RUN_SHA}"
log '---------------------------------------------'
log '提醒：本包不含镜像 tar（分离分发，设计 §7.1）；交付时须与 tianji-offline-images.tar 同目录。'
