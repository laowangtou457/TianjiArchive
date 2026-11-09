# =============================================================================
# 备份 sidecar：cron 每日 02:00 执行 pg_dump 全量 + S3 对象存储桶增量同步
# 备份记录写入 PostgreSQL backup_record 表，供 F-11 界面展示与告警
#
# 变更（方案 A）：MinIO 官方 mc 二进制下载地址 dl.min.io 已归档（410 Gone），
# 且封闭环境无公网，故移除 `curl .../mc`，改用 Alpine 官方仓库的 aws-cli
# （S3 协议直连 SeaweedFS S3 Gateway）。镜像内不再依赖任何 MinIO 组件。
# 注意：本镜像在有网构建机上预先 build 好、随 offline 镜像包导入封闭环境，
#       封闭环境现场不执行 build、不联网下载任何东西。
# =============================================================================
FROM alpine:3.20

RUN set -eux; \
    apk add --no-cache bash postgresql16-client tzdata jq aws-cli; \
    mkdir -p /backup /scripts

COPY entrypoint.sh /scripts/entrypoint.sh
COPY backup.sh /scripts/backup.sh
RUN chmod +x /scripts/entrypoint.sh /scripts/backup.sh

ENV TZ=Asia/Shanghai \
    BACKUP_DIR=/backup \
    BACKUP_CRON="0 2 * * *" \
    BACKUP_RETENTION_DAYS=30

ENTRYPOINT ["/scripts/entrypoint.sh"]
