#!/usr/bin/env bash
# =============================================================================
# 构建机执行：把离线部署所需镜像导出为单个 tar（封闭环境现场不再联网/build）
#
# 三种模式：
#   bash offline/save-images.sh --record       # 重建 4 个自建镜像【之后】记录锚定清单
#   bash offline/save-images.sh --check-drift  # 只验 cmp 防漂移（与镜像重建状态无关）
#   bash offline/save-images.sh --check        # 全前置校验（cmp + 绑定 + image inspect），不导出
#   bash offline/save-images.sh                # 前置校验全过后再 docker save + sha256sum
#
# 前置（仅构建机，需有网）：
#   docker pull postgres:16-alpine redis:7-alpine chrislusf/seaweedfs:3.79
#   GIT_COMMIT="$(git rev-parse HEAD)" docker compose build elasticsearch api web extractor backup
#   bash offline/save-images.sh --record
# 用法：bash offline/save-images.sh
# 产物：offline/tianji-offline-images.tar + offline/SHA256SUMS
#
# ---------------------------------------------------------------------------
# 镜像 ID ↔ 构建 HEAD 绑定（fail-closed，防止「锚错对象」）：
#   团队实证：tianji-archive-api/web:1.0.0 曾是改动前旧镜像，extractor/backup 本机
#   根本不存在。若直接 save，会把旧镜像甚至缺镜像的包送进封闭环境。
#   故 --record 在【重建镜像之后】把 4 个自建镜像的 Image ID 与当时的 git HEAD
#   写入 BUILD-INFO.txt；save 时逐一比对当前本地镜像 ID 与记录，任一不符/缺失即
#   中止。BUILD-INFO.txt 是构建机产物（含机器相关 ID，类似 SHA256SUMS），不入库。
# ---------------------------------------------------------------------------
# 保留的三层 fail-closed：
#   L1 cmp 防漂移   —— offline/seaweedfs/* 必须与 infra/seaweedfs/* 字节一致
#   L2 image inspect —— images.txt 每个镜像本地必须存在
#   L3 空清单        —— images.txt 未解析出任何镜像即中止
# 新增 L0 绑定校验  —— BUILD-INFO.txt 的 4 个 Image ID 与当前镜像一致
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

BUILD_INFO_FILE='BUILD-INFO.txt'
IMAGES_TXT='images.txt'

# 四个自建应用镜像（导出前必须在构建机重建）；顺序与 images.txt 一致。
SELF_BUILT_IMAGES=(
  'tianji-archive-api:1.0.0'
  'tianji-archive-web:1.0.0'
  'tianji-archive-extractor:1.0.0'
  'tianji-archive-backup:1.0.0'
)

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# 取本地镜像的完整 Image ID；不存在返回空串（不触发 set -e）。
image_id() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || printf ''
}

# 取本地镜像的 repo digest（本地 build 的镜像通常为空）；不存在返回 <none>。
repo_digest() {
  local d
  d="$(docker image inspect --format '{{join .RepoDigests ","}}' "$1" 2>/dev/null || printf '')"
  if [ -z "${d}" ]; then printf '<none>'; else printf '%s' "${d}"; fi
}

# 从 BUILD-INFO.txt 读取 KEY=VALUE（键含 [ ] : . 一律用 grep -F 固定串匹配）。
read_field() {
  grep -F -- "$1=" "${BUILD_INFO_FILE}" | head -n 1 | cut -d= -f2-
}

# git HEAD：save-images.sh 在 offline/ 下执行，仓库根是 ..；无 git 时返回 unknown。
git_head() {
  git -C .. rev-parse HEAD 2>/dev/null || printf 'unknown'
}

# ---------------------------------------------------------------------------
# L1：防漂移。offline/seaweedfs/* 必须与 infra/seaweedfs/* 完全一致，
# 否则离线包里的入口脚本与主 compose 用的不是同一份（静默行为差异）。
# ---------------------------------------------------------------------------
check_no_drift() {
  for f in entrypoint.sh s3.json.tpl; do
    if ! cmp -s "../infra/seaweedfs/${f}" "seaweedfs/${f}"; then
      die "offline/seaweedfs/${f} 与 infra/seaweedfs/${f} 不一致，请先同步再打包"
    fi
  done
  log '[L1] cmp 防漂移：entrypoint.sh / s3.json.tpl 均 SAME'
}

# ---------------------------------------------------------------------------
# --record：重建 4 个自建镜像之后调用，生成 BUILD-INFO.txt 锚定清单。
# 允许个别镜像暂时缺失（如实记 MISSING，RECORD_COMPLETE=no），但这样的清单
# 绝不会让 save 通过；--check / save 会显式拒绝，避免「锚错对象」。
# ---------------------------------------------------------------------------
do_record() {
  local head short branch dirty ts tmp complete='yes' img id digest
  head="$(git_head)"
  short="$(git -C .. rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
  branch="$(git -C .. rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
  if git -C .. diff --quiet 2>/dev/null && git -C .. diff --cached --quiet 2>/dev/null; then
    dirty='no'
  else
    dirty='yes'
  fi
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  tmp="$(mktemp "${BUILD_INFO_FILE}.XXXXXX")"
  {
    printf '# TianjiArchive 离线镜像构建锚定清单（由 save-images.sh --record 生成）\n'
    printf '# 用途：save 时逐一校验当前本地镜像 ID 与本记录一致，防止旧镜像/未重建镜像混入离线包。\n'
    printf '# 本文件含机器相关 Image ID，属构建机产物，不入库（见 .gitignore）。\n'
    printf 'FORMAT_VERSION=1\n'
    printf 'GENERATED_AT_UTC=%s\n' "${ts}"
    printf 'GIT_HEAD=%s\n' "${head}"
    printf 'GIT_HEAD_SHORT=%s\n' "${short}"
    printf 'GIT_BRANCH=%s\n' "${branch}"
    printf 'GIT_WORKTREE_DIRTY=%s\n' "${dirty}"
    printf 'SELF_BUILT_IMAGE_COUNT=%s\n' "${#SELF_BUILT_IMAGES[@]}"
    for img in "${SELF_BUILT_IMAGES[@]}"; do
      id="$(image_id "${img}")"
      if [ -z "${id}" ]; then
        id='MISSING'
        complete='no'
        digest='MISSING'
      else
        digest="$(repo_digest "${img}")"
      fi
      printf 'IMAGE_ID[%s]=%s\n' "${img}" "${id}"
      printf 'REPO_DIGEST[%s]=%s\n' "${img}" "${digest}"
    done
    printf 'RECORD_COMPLETE=%s\n' "${complete}"
  } > "${tmp}"
  mv "${tmp}" "${BUILD_INFO_FILE}"
  chmod 644 "${BUILD_INFO_FILE}"

  log "[record] 已生成 $(pwd)/${BUILD_INFO_FILE}"
  log "[record] GIT_HEAD=${head}  RECORD_COMPLETE=${complete}  GIT_WORKTREE_DIRTY=${dirty}"
  if [ "${complete}" != 'yes' ]; then
    log '[record] WARN: 存在 MISSING 镜像 —— 请先重建全部 4 个自建镜像再 --record；'
    log '[record]       当前清单仅供查看字段，--check / save 会 fail-closed 拒绝。'
  fi
  return 0
}

# ---------------------------------------------------------------------------
# L0：镜像 ID ↔ 构建记录绑定校验（新增层，fail-closed）。
# ---------------------------------------------------------------------------
check_build_binding() {
  [ -f "${BUILD_INFO_FILE}" ] || \
    die "缺 ${BUILD_INFO_FILE} —— 请在重建 4 个自建镜像后先执行：bash offline/save-images.sh --record"

  local complete expected actual img count
  complete="$(read_field 'RECORD_COMPLETE')"
  [ "${complete}" = 'yes' ] || \
    die "${BUILD_INFO_FILE} 标记 RECORD_COMPLETE=${complete:-<空>}（有镜像未构建），拒绝导出；请重建镜像后重新 --record"

  count="$(read_field 'SELF_BUILT_IMAGE_COUNT')"
  [ "${count}" = "${#SELF_BUILT_IMAGES[@]}" ] || \
    die "SELF_BUILT_IMAGE_COUNT=${count} 与脚本期望 ${#SELF_BUILT_IMAGES[@]} 不符，拒绝导出"

  for img in "${SELF_BUILT_IMAGES[@]}"; do
    expected="$(read_field "IMAGE_ID[${img}]")"
    [ -n "${expected}" ] && [ "${expected}" != 'MISSING' ] || \
      die "${BUILD_INFO_FILE} 缺少 ${img} 的有效 Image ID，拒绝导出"
    actual="$(image_id "${img}")"
    [ -n "${actual}" ] || die "本地缺少镜像 ${img}（tag 未重建或被删除），拒绝导出"
    if [ "${actual}" != "${expected}" ]; then
      die "镜像 ID 与构建记录不符：${img} 记录=${expected} 当前=${actual}；说明镜像被替换/重建后未重新 --record，拒绝导出"
    fi
  done

  local recorded_head current_head
  recorded_head="$(read_field 'GIT_HEAD')"
  current_head="$(git_head)"
  log "[L0] 绑定校验通过：4/4 自建镜像 ID 与 ${BUILD_INFO_FILE} 一致"
  log "[L0] 构建时 HEAD=${recorded_head} / 当前 HEAD=${current_head}"
  if [ "${recorded_head}" != "${current_head}" ]; then
    log '[L0] WARN: HEAD 已变化（构建后有新提交）；镜像 ID 未变说明未重建，请确认是否需重新 build + --record'
  fi
  return 0
}

# ---------------------------------------------------------------------------
# L2 + L3：读取 images.txt，逐个 image inspect，空清单即中止。
# ---------------------------------------------------------------------------
collect_images() {
  local line image
  images=()
  while IFS= read -r line || [ -n "${line}" ]; do
    image="$(printf '%s' "${line}" | sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "${image}" ] && continue
    if ! docker image inspect "${image}" >/dev/null 2>&1; then
      die "本地缺少镜像 ${image} —— 请先 pull/build，禁止在封闭环境现场构建"
    fi
    images+=("${image}")
  done < "${IMAGES_TXT}"

  if [ "${#images[@]}" -eq 0 ]; then
    die "${IMAGES_TXT} 未解析出任何镜像"
  fi
  log "[L2/L3] ${IMAGES_TXT} 共 ${#images[@]} 个镜像，全部本地存在"
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
mode="${1:-save}"
case "${mode}" in
  --record)
    do_record
    exit 0
    ;;
  --check-drift)
    check_no_drift
    log 'IS_PASS: YES —— cmp 防漂移通过（仅 L1，未校验镜像绑定/清单）'
    exit 0
    ;;
  --check)
    check_no_drift
    check_build_binding
    collect_images
    log 'IS_PASS: YES —— 前置校验全通过（--check 不导出 tar）'
    exit 0
    ;;
  save)
    check_no_drift
    check_build_binding
    collect_images

    log "导出镜像共 ${#images[@]} 个："
    printf '  %s\n' "${images[@]}"
    docker save -o tianji-offline-images.tar "${images[@]}"
    sha256sum tianji-offline-images.tar > SHA256SUMS
    log "完成：$(pwd)/tianji-offline-images.tar"
    log "校验文件：$(pwd)/SHA256SUMS（现场 load 前先 sha256sum -c）"
    ;;
  *)
    die "未知参数 ${mode}；用法：bash offline/save-images.sh [--record|--check]"
    ;;
esac
