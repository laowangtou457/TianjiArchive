#!/usr/bin/env bash
# =============================================================================
# 离线部署冒烟：逐项真跑，任一失败即退出码 1（不静默、不降级）
# 用法（在 offline/ 目录）：bash smoke.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.offline.yml"
log() { echo "[smoke] $*"; }
fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }

log '1/4 健康检查：/api/health 必须 status=ok 且 objectStorage.ok=true'
HEALTH="$(curl -fsS http://localhost:3000/api/health)" || fail 'health 接口不可达'
echo "${HEALTH}"
echo "${HEALTH}" | grep -q '"status":"ok"' || fail 'status 不是 ok（仍 degraded）'
echo "${HEALTH}" | grep -q '"name":"objectStorage","ok":true' || fail 'objectStorage 未就绪'

log '2/4 S3 兼容性 9 项探针'
${COMPOSE} exec -T api pnpm --filter @tianji/api s3:probe | tee s3-probe.log
grep -q 'IS_PASS: YES' s3-probe.log || fail 'S3 探针存在不兼容操作'

log '3/4 模拟书籍样品全链路'
${COMPOSE} exec -T api pnpm --filter @tianji/api demo:books | tee demo-books.log
grep -q 'IS_PASS: YES' demo-books.log || fail '样品全链路未通过'

log '4/4 IK 中文分词'
IK="$(curl -fsS -X POST 'http://localhost:9200/_analyze' -H 'Content-Type: application/json' \
  -d '{"analyzer":"ik_max_word","text":"中华人民共和国档案管理系统"}')" || fail 'ES _analyze 不可达'
echo "${IK}" | grep -q '中华人民共和国' || fail 'IK 未切出预期词条'

log 'IS_PASS: YES —— 离线冒烟四项全通过（日志：s3-probe.log / demo-books.log）'
