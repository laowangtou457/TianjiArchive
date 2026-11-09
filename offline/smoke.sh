#!/usr/bin/env bash
# =============================================================================
# 离线部署冒烟（人工复核用）：逐项真跑，任一失败即退出码 1（不静默、不降级）
#
# 用法：
#   仓库内：      bash offline/smoke.sh
#   包内/部署后： bash <安装器目录>/common/scripts/smoke.sh
#                 （也可直接 `sudo bash smoke.sh`，脚本自己找 compose 与 .env）
#   可覆盖：      TIANJI_DEPLOY_ROOT=/opt/tianji bash smoke.sh
#
# 定位顺序（不再依赖「脚本与 compose 同级」这种巧合）：
#   compose：$TIANJI_DEPLOY_ROOT → 脚本同级（仓库 offline/ 布局）→ /opt/tianji（部署后）
#            → 脚本的 ../compose（包内 common/compose，最后兜底）
#   .env   ：compose 同级 → compose 的上一级 → /opt/tianji
#
# 为什么把 /opt/tianji 排在 ../compose 前面：compose 里的卷/脚本路径是 **相对 compose
# 文件所在目录** 解析的（`./volumes/esdata` 等）。包内 payload 里那份 compose 是**模板**，
# 拿它跑 compose 会把卷指到 /opt/tianji-installer/common/volumes —— 一套根本不存在的栈，
# 现象是「compose 能起但全是新卷、数据看起来丢了」。所以部署后必须用部署根那份。
#
# 端口：从 .env 读 API_EXPOSED_PORT / ES_EXPOSED_PORT，**与 compose 用同一份来源**，
#       缺省才回落 3000 / 9200；脚本里不再写第二套默认值。
#
# 权威顺序：验收判据以**安装器内置的 Go 冒烟**（S9_SMOKE，不依赖 curl/compose，
# 目标机不必装这两个工具）为准。本脚本是「安装器出问题时的人工独立复核手段」。
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_NAME='docker-compose.offline.yml'

log() { echo "[smoke] $*"; }
fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }

# --- 找 compose ---------------------------------------------------------------
COMPOSE_FILE=''
for dir in "${TIANJI_DEPLOY_ROOT:-}" "${SELF_DIR}" '/opt/tianji' "${SELF_DIR}/../compose"; do
  [ -n "${dir}" ] || continue
  if [ -f "${dir}/${COMPOSE_NAME}" ]; then
    COMPOSE_FILE="$(cd "${dir}" && pwd)/${COMPOSE_NAME}"
    break
  fi
done
[ -n "${COMPOSE_FILE}" ] || fail "找不到 ${COMPOSE_NAME}（查过 TIANJI_DEPLOY_ROOT、${SELF_DIR}、/opt/tianji、${SELF_DIR}/../compose）"
COMPOSE_DIR="$(dirname "${COMPOSE_FILE}")"
log "compose: ${COMPOSE_FILE}"

# --- 找 .env（安装器渲染产物）---------------------------------------------------
ENV_FILE=''
for cand in "${COMPOSE_DIR}/.env" "${COMPOSE_DIR}/../.env" '/opt/tianji/.env'; do
  if [ -f "${cand}" ]; then
    ENV_FILE="$(cd "$(dirname "${cand}")" && pwd)/$(basename "${cand}")"
    break
  fi
done
if [ -n "${ENV_FILE}" ]; then
  log ".env   : ${ENV_FILE}"
else
  log '.env   : 未找到（端口按 3000/9200 处理；现场改过端口时用 TIANJI_DEPLOY_ROOT 指向部署根）'
fi

# env_get KEY DEFAULT —— 先看当前环境变量，再看 .env，最后默认值。只取第一个匹配行。
env_get() {
  local key="$1" def="$2" val=''
  val="${!key:-}"
  if [ -z "${val}" ] && [ -n "${ENV_FILE}" ]; then
    val="$(grep -m1 -E "^[[:space:]]*${key}=" "${ENV_FILE}" | cut -d= -f2- || true)"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    val="$(printf '%s' "${val}" | tr -d '\r' | sed -e 's/[[:space:]]*$//')"
  fi
  printf '%s' "${val:-${def}}"
}

API_PORT="$(env_get API_EXPOSED_PORT 3000)"
ES_PORT="$(env_get ES_EXPOSED_PORT 9200)"
API_BASE="http://127.0.0.1:${API_PORT}"
ES_BASE="http://127.0.0.1:${ES_PORT}"
log "API ${API_BASE} / ES ${ES_BASE}"

# 日志写临时目录：包内 scripts 目录可能是 root 0700，不该往里写文件
LOG_DIR="${SMOKE_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/tianji-smoke.XXXXXX")}"
log "日志目录: ${LOG_DIR}"

# --- compose 命令（compose 与 .env 同源，不用两套默认值）------------------------
COMPOSE=(docker compose -f "${COMPOSE_FILE}")
[ -n "${ENV_FILE}" ] && COMPOSE+=(--env-file "${ENV_FILE}")

log '1/4 健康检查：/api/health 必须 status=ok 且 objectStorage.ok=true'
HEALTH="$(curl -fsS "${API_BASE}/api/health")" || fail "health 接口不可达（${API_BASE}/api/health）"
echo "${HEALTH}"
echo "${HEALTH}" | grep -q '"status":"ok"' || fail 'status 不是 ok（仍 degraded）'
echo "${HEALTH}" | grep -q '"name":"objectStorage","ok":true' || fail 'objectStorage 未就绪'

log '2/4 S3 兼容性 9 项探针'
"${COMPOSE[@]}" exec -T api pnpm --filter @tianji/api s3:probe | tee "${LOG_DIR}/s3-probe.log"
grep -q 'IS_PASS: YES' "${LOG_DIR}/s3-probe.log" || fail 'S3 探针存在不兼容操作'

log '3/4 模拟书籍样品全链路'
"${COMPOSE[@]}" exec -T api pnpm --filter @tianji/api demo:books | tee "${LOG_DIR}/demo-books.log"
grep -q 'IS_PASS: YES' "${LOG_DIR}/demo-books.log" || fail '样品全链路未通过'

log '4/4 IK 中文分词'
IK="$(curl -fsS -X POST "${ES_BASE}/_analyze" -H 'Content-Type: application/json' \
  -d '{"analyzer":"ik_max_word","text":"中华人民共和国档案管理系统"}')" || fail "ES _analyze 不可达（${ES_BASE}/_analyze）"
echo "${IK}" | grep -q '中华人民共和国' || fail 'IK 未切出预期词条'

log "IS_PASS: YES —— 离线冒烟四项全通过（日志：${LOG_DIR}/s3-probe.log 与 demo-books.log）"
