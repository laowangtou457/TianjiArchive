#!/usr/bin/env bash
# cron 驱动入口：将 BACKUP_CRON 写入 crontab 并前台运行 crond
set -euo pipefail

: "${BACKUP_CRON:=0 2 * * *}"

echo "[backup-entrypoint] installing crontab: ${BACKUP_CRON}"
cat > /etc/crontabs/root <<EOF
# 每日全量备份（数据库 + 对象存储），RPO<=24h
${BACKUP_CRON} /scripts/backup.sh >> /backup/backup.log 2>&1
# 每小时清理超期备份
15 * * * * /scripts/backup.sh --purge-only >> /backup/backup.log 2>&1
EOF

chmod 0644 /etc/crontabs/root

# 容器启动即刻执行一次，避免首日空白。
# 失败必须显式报错（不静默、不降级），但容器继续运行以便 cron 下轮重试；
# backup.sh 自身也会以退出码 1 标记失败并写 backup_record.minio_status=FAILED。
if [ "${BACKUP_ON_START:-true}" = "true" ]; then
  echo "[backup-entrypoint] running initial backup"
  if ! /scripts/backup.sh >> /backup/backup.log 2>&1; then
    echo "[backup-entrypoint] ERROR: 首次备份失败（详见 /backup/backup.log，cron 将重试）" >&2
  fi
fi

echo "[backup-entrypoint] starting crond"
exec crond -f -l 8
