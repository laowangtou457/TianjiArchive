# =============================================================================
# 备份 sidecar：cron 每日 02:00 执行 pg_dump 全量 + MinIO 增量镜像
# 备份记录写入 PostgreSQL backup_record 表，供 F-11 界面展示与告警
# =============================================================================
FROM alpine:3.20

RUN set -eux; \
    apk add --no-cache bash postgresql16-client tzdata curl jq; \
    curl -fsSL -o /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/mc; \
    chmod +x /usr/local/bin/mc; \
    mkdir -p /backup /scripts

COPY entrypoint.sh /scripts/entrypoint.sh
COPY backup.sh /scripts/backup.sh
RUN chmod +x /scripts/entrypoint.sh /scripts/backup.sh

ENV TZ=Asia/Shanghai \
    BACKUP_DIR=/backup \
    BACKUP_CRON="0 2 * * *" \
    BACKUP_RETENTION_DAYS=30

ENTRYPOINT ["/scripts/entrypoint.sh"]
