#!/usr/bin/env bash
# =============================================================================
# 构建机脚本：生成 manifest.json + SHA256SUMS.txt（可签名）
#
# 这是安装包「可信起点」的落点：
#   - manifest.json 记录变体/版本/期望内核/文件清单与每文件 sha256，
#     以及 images.tar 的 sha256（必须与 offline/SHA256SUMS 同源，§2.2 关键约定）
#   - SHA256SUMS.txt 供现场 --verify-only 逐文件校验
#   - --sign 时用 gpg 分离签名出 SHA256SUMS.asc（公钥内置于安装器二进制）
#
# 用法：
#   bash installer/build/make-manifest.sh --dir dist/installer/staging \
#        --variant ubuntu-debian --version 1.0.0 --images-tar offline/tianji-offline-images.tar
#   bash installer/build/make-manifest.sh --dir ... --sign
#
# 退出码：0 成功；1 参数或前置不满足；2 生成失败；3 签名失败
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

STAGE_DIR=''
VARIANT=''
VERSION='1.0.0'
CODENAME=''
IMAGES_TAR=''
DO_SIGN='no'
GPG_KEY=''

log() { printf '[manifest] %s\n' "$*"; }
die() { printf '[manifest] FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: make-manifest.sh --dir <staging> --variant <a|b> [选项]

  --dir <dir>         必填。已组装好的 payload 暂存目录（内含 bin/ common/ docker/ 等）
  --variant <v>       必填。ubuntu-debian | kylin-uos
  --version <v>       版本号，默认 1.0.0
  --codename <c>      变体 A 的目标 codename（jammy/noble/bookworm）
  --images-tar <f>    镜像 tar 路径；给了就记录其 sha256，没给则 manifest 里留空并 WARN
  --sign              用 gpg 分离签名生成 SHA256SUMS.asc
  --gpg-key <id>      签名用密钥 ID（默认取 gpg 默认密钥）
  -h | --help         显示本帮助
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) STAGE_DIR="${2:-}"; shift 2 ;;
    --variant) VARIANT="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --codename) CODENAME="${2:-}"; shift 2 ;;
    --images-tar) IMAGES_TAR="${2:-}"; shift 2 ;;
    --sign) DO_SIGN='yes'; shift ;;
    --gpg-key) GPG_KEY="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

[ -n "${STAGE_DIR}" ] || die '必须指定 --dir'
[ -d "${STAGE_DIR}" ] || die "目录不存在：${STAGE_DIR}"
STAGE_DIR="$(cd "${STAGE_DIR}" && pwd)"

case "${VARIANT}" in
  ubuntu-debian|kylin-uos) : ;;
  *) die "--variant 只能是 ubuntu-debian 或 kylin-uos，收到：${VARIANT}" ;;
esac
if [ "${VARIANT}" = 'ubuntu-debian' ]; then
  [ -n "${CODENAME}" ] || die '变体 A 必须给 --codename（安装器按现场 os-release 精确匹配，不匹配即 fail-closed）'
fi

command -v sha256sum >/dev/null 2>&1 || die '缺少 sha256sum'

# ---------------------------------------------------------------- images tar
IMAGES_NAME='tianji-offline-images.tar'
IMAGES_SHA=''
IMAGES_COUNT='0'
if [ -n "${IMAGES_TAR}" ]; then
  [ -f "${IMAGES_TAR}" ] || die "镜像 tar 不存在：${IMAGES_TAR}"
  IMAGES_NAME="$(basename "${IMAGES_TAR}")"
  log '计算镜像 tar 的 sha256（约 1.5GB，需要等待）'
  IMAGES_SHA="$(sha256sum "${IMAGES_TAR}" | awk '{print $1}')"
  # 与 offline/SHA256SUMS 同源：若该文件存在，必须逐字一致，不允许各算各的
  SUMS="${REPO_ROOT}/offline/SHA256SUMS"
  if [ -f "${SUMS}" ]; then
    RECORDED="$(awk -v n="${IMAGES_NAME}" '$2 == n || $2 == "./" n {print $1; exit}' "${SUMS}")"
    if [ -n "${RECORDED}" ] && [ "${RECORDED}" != "${IMAGES_SHA}" ]; then
      die "镜像 tar 的 sha256 与 offline/SHA256SUMS 记录不一致：记录 ${RECORDED} 实际 ${IMAGES_SHA}"
    fi
    if [ -n "${RECORDED}" ]; then
      log '与 offline/SHA256SUMS 记录一致'
    fi
  else
    log 'WARN: 未找到 offline/SHA256SUMS，无法做同源交叉核对'
  fi
else
  log 'WARN: 未指定 --images-tar，manifest.images_tar.sha256 将为空'
fi

# image_count 从载荷自带的 images.txt 数出来（忽略注释与空行），
# 供安装器做「清单条数 vs manifest」交叉核对——两边不一致说明包被人换过。
IMG_LIST="${STAGE_DIR}/common/scripts/images.txt"
if [ -f "${IMG_LIST}" ]; then
  IMAGES_COUNT="$(grep -vcE '^[[:space:]]*(#|$)' "${IMG_LIST}" || true)"
  [ -n "${IMAGES_COUNT}" ] || IMAGES_COUNT='0'
else
  log 'WARN: 载荷缺少 common/scripts/images.txt，image_count 记为 0'
  IMAGES_COUNT='0'
fi
log "镜像清单条数：${IMAGES_COUNT}"
[ "${IMAGES_COUNT}" -gt 0 ] || die 'payload/common/scripts/images.txt 为空或缺失（安装器会因此拒绝安装）'

# ---------------------------------------------------------------- 文件清单
SUMS_FILE="${STAGE_DIR}/SHA256SUMS.txt"
: > "${SUMS_FILE}"
FILE_COUNT=0
# 用相对路径、按字典序，保证同样输入产出同样清单（可复现）
while IFS= read -r rel; do
  [ -n "${rel}" ] || continue
  ( cd "${STAGE_DIR}" && sha256sum "${rel}" ) \
    | sed -e 's/^\\//' -e 's/^\([0-9a-f]\{64\}\) [ *]/\1  /' >> "${SUMS_FILE}"
  FILE_COUNT=$((FILE_COUNT + 1))
done < <( cd "${STAGE_DIR}" && find . -type f \
            ! -name 'SHA256SUMS.txt' ! -name 'SHA256SUMS.asc' ! -name 'SHA256SUMS.asc.tmp' \
            ! -name 'manifest.json' \
            -printf '%P\n' | LC_ALL=C sort )
[ "${FILE_COUNT}" -gt 0 ] || die '暂存目录里没有任何文件'
log "文件清单：${FILE_COUNT} 个"

# ---------------------------------------------------------------- manifest.json
GIT_HEAD='unknown'
if command -v git >/dev/null 2>&1 && [ -d "${REPO_ROOT}/.git" ]; then
  GIT_HEAD="$(cd "${REPO_ROOT}" && git rev-parse HEAD 2>/dev/null || echo unknown)"
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BUILDER="$(id -un 2>/dev/null || echo unknown)@$(hostname 2>/dev/null || echo unknown)"

JSON="${STAGE_DIR}/manifest.json"
{
  printf '{\n'
  printf '  "format_version": 1,\n'
  printf '  "product": "tianji-archive",\n'
  printf '  "version": "%s",\n' "${VERSION}"
  printf '  "variant": "%s",\n' "${VARIANT}"
  printf '  "arch": "amd64",\n'
  printf '  "min_kernel": "4.19",\n'
  if [ -n "${CODENAME}" ]; then
    printf '  "os_codename": "%s",\n' "${CODENAME}"
  fi
  if [ "${VARIANT}" = 'ubuntu-debian' ]; then
    printf '  "docker": { "channel": "deb", "version": "from DEBS-MANIFEST.txt" },\n'
  else
    printf '  "docker": { "channel": "static", "version": "from STATIC-MANIFEST.txt" },\n'
  fi
  printf '  "images_tar": { "filename": "%s", "sha256": "%s", "image_count": %d },\n' \
    "${IMAGES_NAME}" "${IMAGES_SHA}" "${IMAGES_COUNT}"
  printf '  "file_count": %d,\n' "${FILE_COUNT}"
  # files[] 是安装器逐文件深度校验（设计 §4.4 L-a）的唯一依据，必须逐个列出。
  printf '  "files": [\n'
  awk -v total="${FILE_COUNT}" '{ printf "    { \"path\": \"%s\", \"sha256\": \"%s\" }%s\n", $2, $1, (NR==total ? "" : ",") }' "${SUMS_FILE}"
  printf '  ],\n'
  printf '  "build": { "git_head": "%s", "built_at_utc": "%s", "builder": "%s" }\n' \
    "${GIT_HEAD}" "${BUILT_AT}" "${BUILDER}"
  printf '}\n'
} > "${JSON}"

# JSON 合法性自校验。
# 分三种情况处理，关键是别把「工具缺失」误报成「JSON 坏了」——实测踩到过：
# 只在容器里装了 python3-minimal 时 import json 直接 ModuleNotFoundError，
# 报错却写着「manifest.json 不是合法 JSON」，会把人引到完全错误的方向。
if command -v python3 >/dev/null 2>&1 && python3 -c 'import json' >/dev/null 2>&1; then
  python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "${JSON}" \
    || die "manifest.json 不是合法 JSON：${JSON}（这是生成逻辑的 bug，不是环境问题）"
  log 'manifest.json 解析 OK'
elif command -v python3 >/dev/null 2>&1; then
  log 'WARN: python3 存在但缺 json 模块（精简安装？），跳过解析自校验——建议装完整 python3 后再出包'
else
  log 'WARN: 无 python3，跳过 JSON 解析自校验'
fi

# ---------------------------------------------------------------- 签名
if [ "${DO_SIGN}" = 'yes' ]; then
  command -v gpg >/dev/null 2>&1 || die '--sign 需要 gpg，但未安装'
  SIG="${SUMS_FILE%.txt}.asc"
  # 先签临时文件、成功后再 mv：签失败时不会把上一次的有效签名删掉。
  # （现场最常见的补救动作就是「重跑一次打包」，如果那次签名失败，旧签名不该跟着没。）
  TMP_SIG="${SIG}.tmp"
  rm -f "${TMP_SIG}"
  # --batch/--no-tty：构建机没有 TTY；不加时 pinentry 可能一直等输入，
  #   表现为脚本卡死而不是报错。--yes 允许覆盖已有 .asc。
  # 另注：gpg 会在 GNUPGHOME 里创建/删除 *.lock。**同一 GNUPGHOME 上的 gpg 调用要串行**，
  #   并发跑两个打包任务会偶发 `gpg: waiting for lock`（不是失败，但会让构建超时）。
  sign_detach() {
    # 用函数而不是把参数拼进变量：避免未加引号的变量展开被 shellcheck/维护者误改。
    if [ -n "${GPG_KEY}" ]; then
      gpg --batch --no-tty --yes --local-user "${GPG_KEY}" --detach-sign --armor \
        -o "${TMP_SIG}" "${SUMS_FILE}"
    else
      gpg --batch --no-tty --yes --detach-sign --armor -o "${TMP_SIG}" "${SUMS_FILE}"
    fi
  }
  if ! sign_detach; then
    if [ -n "${GPG_KEY}" ]; then
      die "gpg 签名失败（用了 --gpg-key ${GPG_KEY}）"
    fi
    die 'gpg 签名失败（未指定 --gpg-key，用的是默认密钥）'
  fi
  [ -s "${TMP_SIG}" ] || die '签名文件为空'
  mv -f "${TMP_SIG}" "${SIG}"
  log "已签名：${SIG}"
else
  log 'WARN: 未签名（--sign 未开启）。正式交付必须签名，见设计 §4.4 L-b'
fi

log "完成：${JSON}"
log "      ${SUMS_FILE}"
