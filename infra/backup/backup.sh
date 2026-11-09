#!/usr/bin/env bash
# ============================================================================
# 备份执行脚本（方案 A：S3 兼容对象存储 = SeaweedFS S3 Gateway）
#   1) pg_dump 全量（custom 格式，可 pg_restore）
#   2) 对象桶增量镜像：aws s3 sync（本地暂存两步法，规避跨实现 CopyObject 差异）
#   3) 备份元数据写入 backup_record 表（供 F-11 列表展示）
#   4) 超过保留期的本地备份与备份桶对象清理
# 用法：backup.sh [--purge-only]
#
# 与旧版差异（MinIO 归档停服 / dl.min.io 410）：
#   - mc alias/mirror/cp/rm 全部移除，改用 aws-cli（Alpine 官方包）；
#   - mc mirror → `aws s3 sync`；mc cp → `aws s3 cp`；
#     mc rm --older-than → `aws s3api list-objects-v2` + jq 时间过滤 + delete-object；
#   - DB 列 backup_record.minio_status **保留原名**（不改 schema），值来源变为 S3 同步结果；
#   - 任何对象存储失败都显式 FAILED 并写日志，**不再静默 SKIPPED**。
# ============================================================================
set -euo pipefail

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:=tianji_archive}"
: "${POSTGRES_USER:=tianji}"
: "${POSTGRES_PASSWORD:=}"
# MINIO_* 是 S3 兼容配置名（历史变量名），默认指向 SeaweedFS 8333
: "${MINIO_ENDPOINT:=seaweedfs}"
: "${MINIO_PORT:=8333}"
: "${MINIO_ACCESS_KEY:=tianji_minio}"
: "${MINIO_SECRET_KEY:=tianji_minio_change_me}"
: "${MINIO_BUCKET_ORIGINAL:=archive-original}"
: "${MINIO_BUCKET_BACKUP:=archive-backup}"
: "${BACKUP_DIR:=/backup}"
: "${BACKUP_RETENTION_DAYS:=30}"
: "${BUCKET_WAIT_ATTEMPTS:=12}"
: "${BUCKET_WAIT_INTERVAL_SECONDS:=5}"

# aws-cli 的端点/凭据统一由 MINIO_* 派生（compose 也注入同名 AWS_*，此处兜底）
: "${AWS_ENDPOINT_URL:=http://${MINIO_ENDPOINT}:${MINIO_PORT}}"
: "${AWS_ACCESS_KEY_ID:=${MINIO_ACCESS_KEY}}"
: "${AWS_SECRET_ACCESS_KEY:=${MINIO_SECRET_KEY}}"
: "${AWS_DEFAULT_REGION:=us-east-1}"
: "${AWS_EC2_METADATA_DISABLED:=true}"
export AWS_ENDPOINT_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION AWS_EC2_METADATA_DISABLED

# 自定义 S3 端点必须用 path-style：否则 aws-cli 会拼出 bucket.seaweedfs 虚拟域名，
# 在 compose 网络内无法解析。写入容器内的 aws 配置文件（无密钥，只有寻址方式）。
mkdir -p "${HOME:-/root}/.aws"
cat > "${HOME:-/root}/.aws/config" <<EOF
[default]
s3 =
  addressing_style = path
EOF

TS="$(date +%Y%m%d_%H%M%S)"
MODE="${1:-full}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

aws_s3() { aws --endpoint-url "${AWS_ENDPOINT_URL}" "$@"; }

# ---------------------------------------------------------------- 桶就绪等待（有上限，不静默）
wait_for_bucket() {
  local bucket="$1"
  local i=1
  while [ "${i}" -le "${BUCKET_WAIT_ATTEMPTS}" ]; do
    if aws_s3 s3api head-bucket --bucket "${bucket}" >/dev/null 2>&1; then
      log "bucket ready: ${bucket}（第 ${i} 次探测）"
      return 0
    fi
    log "WARN: bucket ${bucket} 尚未就绪（${i}/${BUCKET_WAIT_ATTEMPTS}），${BUCKET_WAIT_INTERVAL_SECONDS}s 后重试"
    i=$((i + 1))
    sleep "${BUCKET_WAIT_INTERVAL_SECONDS}"
  done
  log "ERROR: bucket ${bucket} 在 $((BUCKET_WAIT_ATTEMPTS * BUCKET_WAIT_INTERVAL_SECONDS))s 内未就绪，放弃本次对象备份（不静默跳过）"
  return 1
}

# ---------------------------------------------------------------- 超期对象清理（mc rm --older-than 等价实现）
purge_remote_old() {
  local cutoff=$(( $(date -u +%s) - BACKUP_RETENTION_DAYS * 86400 ))
  local keys
  keys="$(aws_s3 s3api list-objects-v2 --bucket "${MINIO_BUCKET_BACKUP}" --output json 2>/dev/null \
    | jq -r --argjson cutoff "${cutoff}" \
        '.Contents // [] | .[] | select(((.LastModified[0:19] + "Z") | fromdateiso8601) < $cutoff) | .Key' || true)"
  if [ -z "${keys}" ]; then
    log "purge remote: 无超过 ${BACKUP_RETENTION_DAYS} 天的对象"
    return 0
  fi
  local count=0
  while IFS= read -r key; do
    [ -z "${key}" ] && continue
    aws_s3 s3api delete-object --bucket "${MINIO_BUCKET_BACKUP}" --key "${key}" >/dev/null
    count=$((count + 1))
  done <<< "${keys}"
  log "purge remote: 已删除 ${count} 个超期对象"
}

purge_old() {
  log "purge backups older than ${BACKUP_RETENTION_DAYS} days in ${BACKUP_DIR}"
  find "${BACKUP_DIR}" -maxdepth 2 -type f -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true
  if wait_for_bucket "${MINIO_BUCKET_BACKUP}"; then
    purge_remote_old
  else
    log "ERROR: 备份桶未就绪，远程超期清理本次未完成（下轮 cron 会重试）"
    return 1
  fi
}

if [ "${MODE}" = "--purge-only" ]; then
  purge_old
  exit 0
fi

mkdir -p "${BACKUP_DIR}/pg" "${BACKUP_DIR}/mirror"
export PGPASSWORD="${POSTGRES_PASSWORD}"

# ------------------------------------------------------------------ 1) 数据库全量
DB_FILE="${BACKUP_DIR}/pg/${POSTGRES_DB}_${TS}.dump"
log "pg_dump -> ${DB_FILE}"
if pg_dump -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" \
      -d "${POSTGRES_DB}" -Fc -f "${DB_FILE}"; then
  DB_STATUS="OK"
  DB_SIZE=$(stat -c%s "${DB_FILE}" 2>/dev/null || echo 0)
  DB_SHA=$(sha256sum "${DB_FILE}" | awk '{print $1}')
else
  DB_STATUS="FAILED"
  DB_SIZE=0
  DB_SHA=""
  log "ERROR: pg_dump failed"
fi

# ------------------------------------------------------------------ 2) 对象桶增量镜像（aws s3 sync）
MINIO_STATUS="OK"
if ! command -v aws >/dev/null 2>&1; then
  MINIO_STATUS="FAILED"
  log "ERROR: aws-cli 未安装（镜像构建异常），对象存储备份失败"
elif ! wait_for_bucket "${MINIO_BUCKET_ORIGINAL}" || ! wait_for_bucket "${MINIO_BUCKET_BACKUP}"; then
  MINIO_STATUS="FAILED"
  log "ERROR: 对象存储桶未就绪，对象存储备份失败"
else
  MIRROR_DIR="${BACKUP_DIR}/mirror/original"
  mkdir -p "${MIRROR_DIR}"
  log "sync ${MINIO_BUCKET_ORIGINAL} -> 本地暂存 -> ${MINIO_BUCKET_BACKUP}/original/"
  # 两步法而非 s3://src → s3://dst 直连：不同 S3 实现的 CopyObject 语义有差异，
  # 经本地暂存可保证「只依赖 GET/PUT/DELETE 基础语义」，且与 mc mirror 的增量语义一致。
  if aws_s3 s3 sync "s3://${MINIO_BUCKET_ORIGINAL}" "${MIRROR_DIR}" --no-progress \
     && aws_s3 s3 sync "${MIRROR_DIR}" "s3://${MINIO_BUCKET_BACKUP}/original/" --delete --no-progress; then
    log "sync OK"
  else
    MINIO_STATUS="FAILED"
    log "ERROR: aws s3 sync failed"
  fi
fi

# 备份文件再上传一份到备份桶，实现异盘/异地
if [ "${DB_STATUS}" = "OK" ] && [ "${MINIO_STATUS}" = "OK" ]; then
  if ! aws_s3 s3 cp "${DB_FILE}" "s3://${MINIO_BUCKET_BACKUP}/pg/$(basename "${DB_FILE}")" --no-progress >/dev/null; then
    log "WARN: 上传 dump 到对象存储失败（保留本地 dump，标记对象存储失败）"
    MINIO_STATUS="FAILED"
  fi
fi

# ------------------------------------------------------------------ 3) 写入备份记录
# 注意：列名 minio_status 保持原名（schema 不改），值来源已变为 S3 同步结果。
TOTAL_SIZE=$(( DB_SIZE ))
RECORD_JSON=$(jq -cn \
  --arg file "$(basename "${DB_FILE}")" \
  --arg sha "${DB_SHA}" \
  --arg db "${DB_STATUS}" \
  --arg mo "${MINIO_STATUS}" \
  --argjson size "${TOTAL_SIZE}" \
  --arg ts "${TS}" \
  '{file:$file, sha256:$sha, db_status:$db, minio_status:$mo, size:$size, finished_at:$ts}')

log "write backup_record: ${RECORD_JSON}"
psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  -v ON_ERROR_STOP=0 \
  -c "INSERT INTO backup_record (id, filename, storage_path, size_bytes, sha256, status, db_status, minio_status, started_at, finished_at, detail)
      VALUES (gen_random_uuid(), '$(basename "${DB_FILE}")', '${DB_FILE}', ${TOTAL_SIZE},
              '${DB_SHA}', '${DB_STATUS}', '${DB_STATUS}', '${MINIO_STATUS}', now(), now(), '${RECORD_JSON}'::jsonb)
      ON CONFLICT DO NOTHING;" >/dev/null 2>&1 || log "WARN: cannot write backup_record (table may not exist yet)"

purge_old || true
log "backup finished: db=${DB_STATUS} minio=${MINIO_STATUS} size=${TOTAL_SIZE}B file=${DB_FILE}"
if [ "${DB_STATUS}" != "OK" ] || [ "${MINIO_STATUS}" != "OK" ]; then
  log "ERROR: 本次备份未全部成功（db=${DB_STATUS} / objectStorage=${MINIO_STATUS}），退出码 1"
  exit 1
fi
