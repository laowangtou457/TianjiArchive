#!/bin/sh
# =============================================================================
# SeaweedFS S3 Gateway 启动入口（凭据/桶名运行时注入，绝不入库/入镜像）
#
# 背景：MinIO 开源版归档停服，对象存储改 SeaweedFS S3 Gateway（方案 A）。
# SeaweedFS 的 S3 鉴权配置 s3.json 需要明文 accessKey/secretKey，但：
#   - 不得写死在镜像里（镜像要能进封闭环境、可公开流转）；
#   - 不得提交到 git（.env 才是唯一凭据来源）；
#   - 不得落进持久卷（避免凭据长期驻留 /data）。
# 故此处在容器启动时从环境变量渲染模板到 /tmp（tmpfs/容器可写层，随容器销毁）。
# 模板 infra/seaweedfs/s3.json.tpl 只有占位符，无任何真实凭据/桶名硬编码。
#
# 兼容约束：应用侧沿用 MINIO_* 变量名（configuration.ts / cli-migrator /
# extractor / backup.sh / compose 均不改），因此这里也读同名变量，单点来源。
#
# R-3 关闭自动建桶：3.79 实测 `weed server -s3 -h` 与 `weed s3 -h` 均无
# autoCreateBucket 开关，故改用 s3.json 桶级授权：只按 4 个业务桶 + 探针通配桶
# 授予 Admin/Read/Write/List，不授全局 Admin（实测全局 Admin 会放行任意桶自动建桶）。
#
# R-2/R-6 启动参数（主理人镜像实测 + 本轮容器内复核）：
#   - 委派给镜像内置 /entrypoint.sh 的 `server` 分支，以继承其自带的
#     `-dir=/data -volume.max=0 -master.volumePreallocate -master.volumeSizeLimitMB=1024`
#     （1GB/volume、volume.max=0 自动按磁盘配置；若直接调 `weed server` 会丢掉这些调优，
#     退回到未调优默认值，正是要避免的容量风险）。故此处**不再重复写 -dir**。
#   - `-volume.port=8081`：避开 web 宿主 ${WEB_PORT:-8080}（R-2）。
#   - `-filer`：3.79 的 `weed server` 默认不启动 filer（帮助里 -filer 无 default true），
#     不显式开启时 S3 网关会一直等 filer:18888，8333 迟迟不可用（实测实证）。
#   - 只发布宿主 8333（compose）；9333/8888/8081/gRPC 端口仅在容器网络内。
# =============================================================================
set -eu

: "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY 未设置（请检查 .env / compose 注入）}"
: "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY 未设置（请检查 .env / compose 注入）}"
: "${MINIO_BUCKET_ORIGINAL:=archive-original}"
: "${MINIO_BUCKET_PREVIEW:=archive-preview}"
: "${MINIO_BUCKET_THUMB:=archive-thumb}"
: "${MINIO_BUCKET_BACKUP:=archive-backup}"

# 凭据/桶名会进入 sed 替换串与 JSON 字符串：限制为 URL/JSON/桶名安全字符，
# 防止 | & " \ $ 等破坏渲染结果或注入 JSON（失败即显式退出，不静默降级）。
if printf '%s' "${MINIO_ACCESS_KEY}${MINIO_SECRET_KEY}" | grep -q '[^A-Za-z0-9_+/=-]'; then
  echo '[seaweedfs-entrypoint] ERROR: S3 凭据含非法字符（仅允许 A-Za-z0-9_+/=-），拒绝启动' >&2
  exit 1
fi
for b in "${MINIO_BUCKET_ORIGINAL}" "${MINIO_BUCKET_PREVIEW}" "${MINIO_BUCKET_THUMB}" "${MINIO_BUCKET_BACKUP}"; do
  if printf '%s' "${b}" | grep -q '[^A-Za-z0-9._-]'; then
    echo "[seaweedfs-entrypoint] ERROR: 桶名含非法字符（仅允许 A-Za-z0-9._-）：${b}" >&2
    exit 1
  fi
  if [ -z "${b}" ]; then
    echo '[seaweedfs-entrypoint] ERROR: 桶名为空，拒绝启动' >&2
    exit 1
  fi
done
if [ -z "${MINIO_ACCESS_KEY}" ] || [ -z "${MINIO_SECRET_KEY}" ]; then
  echo '[seaweedfs-entrypoint] ERROR: S3 凭据为空，拒绝启动' >&2
  exit 1
fi

CONFIG=/tmp/seaweedfs-s3.json
sed -e "s|__MINIO_ACCESS_KEY__|${MINIO_ACCESS_KEY}|g" \
    -e "s|__MINIO_SECRET_KEY__|${MINIO_SECRET_KEY}|g" \
    -e "s|__BUCKET_ORIGINAL__|${MINIO_BUCKET_ORIGINAL}|g" \
    -e "s|__BUCKET_PREVIEW__|${MINIO_BUCKET_PREVIEW}|g" \
    -e "s|__BUCKET_THUMB__|${MINIO_BUCKET_THUMB}|g" \
    -e "s|__BUCKET_BACKUP__|${MINIO_BUCKET_BACKUP}|g" \
    /scripts/s3.json.tpl > "${CONFIG}"
chmod 600 "${CONFIG}"

mkdir -p /data
echo '[seaweedfs-entrypoint] s3.json 已由环境变量渲染到 /tmp（不落镜像、不落卷）；桶级授权已生效'

# `server` 分支自带调优参数；此处只追加本方案特有参数（-dir 由内置脚本注入，不重复）。
exec /entrypoint.sh server \
  -filer \
  -s3 \
  -s3.port=8333 \
  -s3.config="${CONFIG}" \
  -volume.port=8081 \
  -ip.bind=0.0.0.0
