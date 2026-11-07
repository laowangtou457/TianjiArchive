#!/usr/bin/env bash
# ============================================================================
# 备份执行脚本
#   1) pg_dump 全量（custom 格式，可 pg_restore）
#   2) mc mirror 增量同步 MinIO 原件桶 → 备份桶
#   3) 备份元数据写入 backup_record 表（供 F-11 列表展示）
#   4) 超过保留期的本地备份清理
# 用法：backup.sh [--purge-only]
# ============================================================================
set -euo pipefail

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:=tianji_archive}"
: "${POSTGRES_USER:=tianji}"
: "${POSTGRES_PASSWORD:=}"
: "${MINIO_ENDPOINT:=minio}"
: "${MINIO_PORT:=9000}"
: "${MINIO_ACCESS_KEY:=tianji_minio}"
: "${MINIO_SECRET_KEY:=}"
: "${MINIO_BUCKET_ORIGINAL:=archive-original}"
: "${MINIO_BUCKET_BACKUP:=archive-backup}"
: "${BACKUP_DIR:=/backup}"
: "${BACKUP_RETENTION_DAYS:=30}"

TS="$(date +%Y%m%d_%H%M%S)"
MODE="${1:-full}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

purge_old() {
  log "purge backups older than ${BACKUP_RETENTION_DAYS} days in ${BACKUP_DIR}"
  find "${BACKUP_DIR}" -maxdepth 2 -type f -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true
  if command -v mc >/dev/null 2>&1; then
    mc alias set tianji "http://${MINIO_ENDPOINT}:${MINIO_PORT}" "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}" >/dev/null 2>&1 || true
    mc rm --recursive --force --older-than "${BACKUP_RETENTION_DAYS}d" "tianji/${MINIO_BUCKET_BACKUP}/" >/dev/null 2>&1 || true
  fi
}

if [ "${MODE}" = "--purge-only" ]; then
  purge_old
  exit 0
fi

mkdir -p "${BACKUP_DIR}/pg" "${BACKUP_DIR}/minio"
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

# ------------------------------------------------------------------ 2) MinIO 增量
MINIO_STATUS="OK"
if command -v mc >/dev/null 2>&1; then
  log "mirror ${MINIO_BUCKET_ORIGINAL} -> ${MINIO_BUCKET_BACKUP}/original-${TS}"
  mc alias set tianji "http://${MINIO_ENDPOINT}:${MINIO_PORT}" "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}" >/dev/null
  if ! mc mirror --overwrite --preserve "tianji/${MINIO_BUCKET_ORIGINAL}" "tianji/${MINIO_BUCKET_BACKUP}/original" >/dev/null; then
    MINIO_STATUS="FAILED"
    log "ERROR: mc mirror failed"
  fi
else
  MINIO_STATUS="SKIPPED"
fi

# 备份文件再上传一份到备份桶，实现异盘/异地
if [ "${DB_STATUS}" = "OK" ] && command -v mc >/dev/null 2>&1; then
  mc cp "${DB_FILE}" "tianji/${MINIO_BUCKET_BACKUP}/pg/" >/dev/null 2>&1 || \
    log "WARN: upload dump to minio failed"
fi

# ------------------------------------------------------------------ 3) 写入备份记录
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

purge_old
log "backup finished: db=${DB_STATUS} minio=${MINIO_STATUS} size=${TOTAL_SIZE}B file=${DB_FILE}"
