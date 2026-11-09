{
  "_comment": [
    "SeaweedFS S3 Gateway 鉴权模板（方案 A）。本文件只有占位符、无真实凭据、无桶名硬编码。",
    "真实凭据与桶名在容器启动时由 infra/seaweedfs/entrypoint.sh 从环境变量渲染到 /tmp（不入库/不落镜像/不进持久卷）。",
    "R-3 关闭自动建桶：3.79 实测 weed server -s3 -h 无 autoCreateBucket flag（server/s3 帮助均无该开关）。",
    "  故用 s3.json 权限控制替代：identity 不授予全局 Admin，只按桶授予 Admin/Read/Write/List。",
    "  效果（容器内实测）：对未声明桶的 putObject 自动建桶与 makeBucket 均返回 AccessDenied；",
    "  API 的 MinioService.ensureBuckets() 仍是 4 个业务桶的唯一建桶入口。",
    "  若授予全局 Admin，实测会重新放行任意桶自动创建，故此处严禁出现裸 Admin/Read/Write/List。",
    "tianji-s3-probe-* 是兼容性探针的隔离桶通配授权（脚本运行完即删），不触及 4 个业务桶。",
    "actions 语法见 weed s3 -h：Action 或 Action:Bucket，支持桶名后缀通配。"
  ],
  "identities": [
    {
      "name": "tianji",
      "credentials": [
        {
          "accessKey": "__MINIO_ACCESS_KEY__",
          "secretKey": "__MINIO_SECRET_KEY__"
        }
      ],
      "actions": [
        "Admin:__BUCKET_ORIGINAL__", "Read:__BUCKET_ORIGINAL__", "Write:__BUCKET_ORIGINAL__", "List:__BUCKET_ORIGINAL__",
        "Admin:__BUCKET_PREVIEW__",  "Read:__BUCKET_PREVIEW__",  "Write:__BUCKET_PREVIEW__",  "List:__BUCKET_PREVIEW__",
        "Admin:__BUCKET_THUMB__",    "Read:__BUCKET_THUMB__",    "Write:__BUCKET_THUMB__",    "List:__BUCKET_THUMB__",
        "Admin:__BUCKET_BACKUP__",   "Read:__BUCKET_BACKUP__",   "Write:__BUCKET_BACKUP__",   "List:__BUCKET_BACKUP__",
        "Admin:tianji-s3-probe-*", "Read:tianji-s3-probe-*", "Write:tianji-s3-probe-*", "List:tianji-s3-probe-*"
      ]
    }
  ]
}
