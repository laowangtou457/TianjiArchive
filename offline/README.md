# 天玑档案管理系统 · 封闭环境离线部署包（方案 A / SeaweedFS）

> 目标：**全过程无公网**。现场不 `build`、不 `pull`、不下载任何二进制
> （含 `dl.min.io`、`minio/mc`、npm/apk 包），只做「导入镜像 → 起容器 → 初始化数据 → 冒烟」。
> 对象存储为 SeaweedFS 3.79 S3 Gateway；应用侧沿用 `minio` npm SDK 走标准 S3 协议，
> `MINIO_*` 环境变量名保留（历史兼容），业务代码无需改动。

---

## 〇、现场必读（演示前必看）

> 本节为现场部署与演示前的**强制勾验清单**，来源于 PM 的 `docs/DEMO-ACCEPTANCE.md` §1.4 / §2 / §4.3
> 与架构规格 §1.2 / §7。**8 条 S0 未勾验不得开始演示**；未勾验导致的失败按「前置未就绪」记录，
> 不计产品功能缺陷。

### 0.1 局域网 IP：封闭环境现场必改项（本机 demo 不用改）

| 场景 | 动作 |
|---|---|
| 浏览器与 Docker 同机 | 保持默认 `127.0.0.1:8333`，无需修改 |
| 应用在服务器、浏览器在局域网其他机器（封闭环境常见） | 在 `.env` 把 `S3_PUBLIC_ENDPOINT` 改为**宿主机局域网 IP**（如 `192.168.10.50`），并确认 `S3_PUBLIC_PORT=8333` 与 `SEAWEEDFS_S3_EXPOSED_PORT` 一致、`S3_PUBLIC_USE_SSL=false` |

- 依据：`.env.example` 的 R-1 注释、`docs/ARCHITECTURE-SEAWEEDFS.md` §1.2 双端点裁定。**具体 IP 属 R-10 现场确认项，包内只放占位符，不代拍板**。
- **不改的后果**：预签名 URL 的 host 仍是 `127.0.0.1`，浏览器无法解析 → 上传 / 预览直连失败，S0-3 前置不通过；启动检查亦会告警（`apps/api/src/config/configuration.ts` 的回环地址告警）。
- **前置依赖（交付前必须确认）**：`S3_PUBLIC_*` 三项必须由 compose 注入 `api` 容器才生效。已核实两份 compose 原先均无该项注入，且镜像内不含 `.env`、`ConfigModule.envFilePath` 在容器内无对应文件；该项已列入本次交付的收口清单。**现场起栈后必须执行** `docker compose -f docker-compose.offline.yml exec api printenv | grep S3_PUBLIC`，三项均有输出才算生效；否则改 `.env` 不产生任何效果。
- **改完必须重建容器**：`docker compose -f docker-compose.offline.yml up -d`；`restart` 不重读 `.env`。
- **两处 CORS 不要混为一谈**：
  - **API 层 `CORS_ORIGINS`**：origin 白名单，解决以 `http://<局域网IP>:8080` 访问时 `/api` 跨域；默认值仅 `http://localhost:5173` 与 `http://localhost:8080`，需要时追加现场 origin。
  - **S3 层 `Access-Control-Expose-Headers: ETag`**：SeaweedFS 预签名分片直传，浏览器必须读到 ETag 才能完成分片合并。**配了前者不解决后者**；后者由 SeaweedFS 侧配置承接，是本次交付的头号验证项，结论以 QA 阶段二独立复核为准。缺该项的典型表现是「分片 PUT 成功、completeMultipart 失败」，排障时勿误归因到 SigV4 签名或对象存储兼容性（见 §七）。

### 0.2 凭据：demo 阶段用默认值，正式启用前必须全部轮换

本包 `.env` 中以下均为**占位默认值**，封闭网内试用可用，**不构成本单位凭据**：
`POSTGRES_PASSWORD`、`MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`（S3 唯一凭据源，api / extractor / cli-migrator / backup / seaweedfs 共用）、`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`。

- 字符集限 `A-Za-z0-9_+/=-`；含特殊字符会**显式拒绝启动**（见 §六）。
- 轮换动作：改 `.env` → 重新渲染 `s3.json` → 重启 / SIGHUP SeaweedFS → 同步五个消费方凭据 → `up -d` 重建容器；须在维护窗口执行，旧密钥签发的未过期预签名 URL 会失效。
- **交付前待确认（当前未定，不得写成已定）**：**凭据轮换责任人与时间窗尚未指定到具体岗位 / 人**。`docs/ARCHITECTURE-SEAWEEDFS.md` §7 与 `docs/DEMO-ACCEPTANCE.md` 均只写「封闭试用收尾」，未落实到岗。**未落实不得转入正式启用**。本项不阻塞封闭试用（demo 用默认值），但交付时必须由用户侧明确回答；此处不写「由管理员处理」这类泛称。

### 0.3 演示前勾验 8 条（S0，来源 `docs/DEMO-ACCEPTANCE.md` §1.4）

| # | 勾验项 | 现场判据 |
|---|---|---|
| S0-1 | 全服务 healthy | `docker compose ps` 无 degraded；`/api/health` 的 `objectStorage.ok = true`（**degraded 是 MinIO 时代旧预期，不接受**） |
| S0-2 | 4 桶建好 | 原始 / 预览 / 缩略图 / 备份桶均可 HeadBucket |
| S0-3 | 预签名 URL 浏览器可达 | 浏览器直传完成一次 PUT（方案 A 最高优先实测项，见 §0.1） |
| S0-4 | 迁移 + seed 幂等 | `migration:run` 5/5；重复 seed 不产生重复全宗 / 角色 |
| S0-5 | **多角色账号已建** | 至少 R1（著录 / 审批）、R3（借阅申请）、R0（日志 / 备份 / 参数）；演秘密级双级审批再加 R4 |
| S0-6 | 模拟样本导入幂等 | 重复导入后条目数、档号集合、sha256 完全一致 |
| S0-7 | 8 项高敏参数为出厂默认值**并截图留证** | 参数页显示值 = `docs/DEMO-ACCEPTANCE.md` §4 表，无一条被改 |
| S0-8 | 构建门禁全绿 | `build` / `typecheck` / `lint` / `test` / `ci:check` 通过 |

### 0.4 三条防误读口径（随包必附）

1. 本次为**封闭环境样品 demo 功能验证**；8 项高敏参数走产品建议默认值、未经本单位及保密部门确认，**不构成管理制度口径，也不构成保密合规结论**；演示数据为模拟书籍，非真实档案。
2. **试用账号必须多角色**：`seed` 只建 `admin`(R0)，而 R0 在案卷级 / 件级著录、电子文件、在线预览、借阅申请等功能域均为 `✖`。用 admin 单账号走全流程会在 S2 直接 403 —— 这是权限矩阵生效，**不是功能缺陷**（`docs/PRD.md` §3.1 / §3.2）。
3. **下载放行链路未演示**。`approval` 模式授权写入链路未实现（上线前闭环项 L2），本次仅验预览可用与下载 fail-closed 拒绝正确，**不构成下载功能已验证的结论**。`demo-books-seed.ts` 输出的 `PRESIGNED_DOWNLOADS_OK` / `PREVIEW_DOWNLOADS_OK` 为 **S3 wire 层自检，非业务放行验证**（既不能当下载可用证据，也不能当违规证据）。

---

## 一、离线包内容

| 文件 | 用途 |
|---|---|
| `docker-compose.offline.yml` | 全服务编排，**所有服务只有 `image:`、没有任何 `build:`** |
| `images.txt` | 镜像清单（8 个） |
| `save-images.sh` | 构建机导出 `tianji-offline-images.tar` + `SHA256SUMS` |
| `load-images.sh` | 现场校验并 `docker load` 导入 |
| `tianji-offline-images.tar` | 镜像包（由 `save-images.sh` 生成，**不入库**，随介质交付） |
| `SHA256SUMS` | 镜像包完整性校验 |
| `seaweedfs/entrypoint.sh` | S3 凭据运行时注入入口（与主仓 `infra/seaweedfs` 字节一致） |
| `seaweedfs/s3.json.tpl` | S3 鉴权模板（**只有占位符，无真实凭据**） |
| `README.md` | 本文件 |

镜像清单（`images.txt`）：`postgres:16-alpine`、`redis:7-alpine`、
`tianji-elasticsearch-ik:8.13.4`、`chrislusf/seaweedfs:3.79`、
`tianji-archive-api:1.0.0`、`tianji-archive-web:1.0.0`、
`tianji-archive-extractor:1.0.0`、`tianji-archive-backup:1.0.0`。

> 说明：`extractor` 与 `backup` 两个自建镜像此前因 `dl.min.io` 归档 410 从未成功构建；
> 本次已把 `mc` 依赖移除（改用 Alpine 官方 `aws-cli`），**构建机必须先重建这两个镜像**，
> 否则 `save-images.sh` 会因缺少镜像明确报错退出（不静默跳过）。

---

## 二、构建机准备（有网，只做一次）

```bash
cd /path/to/TianjiArchive

# 1) 拉取公共镜像（SeaweedFS 镜像已实拉验证 chrislusf/seaweedfs:3.79）
docker pull postgres:16-alpine
docker pull redis:7-alpine
docker pull chrislusf/seaweedfs:3.79

# 2) 构建四个自建镜像 + IK 镜像（主 compose 里 elasticsearch 仍带 build，仅构建机使用）
docker compose build elasticsearch api web extractor backup

# 3) 导出镜像包
bash offline/save-images.sh
```

把整个 `offline/` 目录（含 `.tar`、`SHA256SUMS`、脚本、compose、seaweedfs 模板、
以及 `.env.example` 的一份副本）拷入封闭环境介质。

---

## 三、现场部署步骤（无公网）

以下命令均在**离线包目录 `offline/`** 下执行。

```bash
# 0) 环境检查：Docker Engine 可用；确认本机没有同名旧栈占用端口
docker version
docker compose version

# 1) 导入镜像（纯本地 docker load，不联网）
bash load-images.sh

# 2) 准备 .env（凭据与端口的唯一来源）
cp ../.env.example .env        # 若离线包是独立目录，则使用随包附带的 .env.example
#   按单位实情修改口令；8 项高敏参数本轮暂走默认值，封闭试用后再调整。
#   必须确认：MINIO_ENDPOINT=seaweedfs、MINIO_PORT=8333。
#   必做：按 §0.1 取消 S3_PUBLIC_ENDPOINT / S3_PUBLIC_PORT / S3_PUBLIC_USE_SSL
#   三项注释，填写宿主机局域网 IP（浏览器与 Docker 同机时保持 127.0.0.1）。
#   若以 http://<局域网IP>:8080 访问且 /api 报跨域，把该 origin 追加进 CORS_ORIGINS。

# 3) 起栈（-d，不带 --build，compose 内也没有 build 段）
docker compose -f docker-compose.offline.yml up -d
#   改过 .env 后必须重新 up -d 重建容器；restart 不重读 .env。
#   起栈后必核「三项注入确实进了 api 容器」（三项都要有输出，详见 §0.1 前置依赖）：
docker compose -f docker-compose.offline.yml exec api printenv | grep S3_PUBLIC

# 4) 迁移 + 初始化（幂等，可重复执行）
docker compose -f docker-compose.offline.yml exec api pnpm --filter @tianji/api migration:run
docker compose -f docker-compose.offline.yml exec api pnpm --filter @tianji/api seed

# 5) 离线样品数据（模拟书籍档案，幂等；真实书籍样本后续提供后替换）
docker compose -f docker-compose.offline.yml exec api pnpm --filter @tianji/api demo:books

# 6) 冒烟
bash smoke.sh   # 或按下列命令逐项手动执行
```

### 冒烟项（逐项都要有输出，不允许"没报错就算过"）

```bash
# 6.1 健康：status 必须为 ok，且 deps 里 objectStorage.ok = true（不再 degraded）
curl -fsS http://localhost:3000/api/health

# 6.2 S3 兼容性 9 项操作（bucketExists/makeBucket/putObject/getObject/statObject/
#     presignedUrl/presignedGetObject/initiateNewMultipartUpload/listParts/completeMultipartUpload）
docker compose -f docker-compose.offline.yml exec api pnpm --filter @tianji/api s3:probe

# 6.3 样品全链路（上传挂接 → 真实 extractor 全文抽取 → 综合检索命中 →
#     预览/下载 → sha256 完整性），输出必须含 IS_PASS: YES
docker compose -f docker-compose.offline.yml exec api pnpm --filter @tianji/api demo:books

# 6.4 IK 分词（中文切分）
curl -fsS -X POST 'http://localhost:9200/_analyze' -H 'Content-Type: application/json' \
  -d '{"analyzer":"ik_max_word","text":"中华人民共和国档案管理系统"}'
```

> 原始输出建议落盘到 `docs/perf/runs/`（主仓 `.gitignore` 已为该目录 `*.log` 开白名单），
> 便于封闭环境回传后复核。

---

## 四、端口与卷

| 服务 | 容器内端口 | 宿主默认 | 环境变量 | 卷（相对 offline/） |
|---|---|---|---|---|
| web | 80 | 8080 | `WEB_PORT` | — |
| api | 3000 | 3000 | `API_EXPOSED_PORT` | — |
| postgres | 5432 | 5432 | `POSTGRES_EXPOSED_PORT` | `./volumes/postgres`、`./volumes/wal_archive` |
| elasticsearch | 9200 | 9200 | `ES_EXPOSED_PORT` | `./volumes/esdata` |
| seaweedfs S3 | 8333 | 8333（**唯一发布到宿主的 seaweedfs 端口**） | `SEAWEEDFS_S3_EXPOSED_PORT` | `./volumes/seaweedfs` |
| seaweedfs master | 9333 | 不发布（仅 compose 内网） | — | 同上 |
| seaweedfs filer | 8888 | 不发布（仅 compose 内网） | — | 同上 |
| seaweedfs volume | 8080 或 8081（依 `entrypoint.sh` 的 `-volume.port`） | 不发布（仅 compose 内网） | — | 同上 |
| redis | 6379 | 6379 | `REDIS_EXPOSED_PORT` | `./volumes/redis` |
| backup | — | — | — | `./volumes/backup` |

封闭环境可只暴露 `WEB_PORT`（8080）；其余端口靠 compose 内部网络 `tianji-net` 互通，
把 `*_EXPOSED_PORT` 行删掉或改成 `127.0.0.1:端口:端口` 即可进一步收紧。
R-2 裁定：**seaweedfs 只发布 8333**，master / filer / volume 均不占宿主端口，因此 volume 的容器内端口与 web 的宿主 8080 不冲突；浏览器直连预签名 URL 走宿主 8333，不经 nginx 反代。

**卷说明**：`./volumes/seaweedfs:/data` 只存对象数据；S3 鉴权配置由
`seaweedfs/entrypoint.sh` 在容器启动时把 `s3.json.tpl` 用
`MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` 渲染到 `/tmp/seaweedfs-s3.json`，
**不写入镜像、不写入持久卷、不写入 git**。模板文件本身只有占位符。

---

## 五、为什么能做到全程无公网

1. `docker-compose.offline.yml` 中所有服务只有 `image:`，没有 `build:`；
2. 镜像由构建机 `docker save` 导出、现场 `docker load` 导入；
3. 备份镜像内是 Alpine 官方仓库预装的 `aws-cli`，不再 `curl dl.min.io/.../mc`（该地址已 410）；
4. 桶由 API 的 `MinioService.onModuleInit → ensureBuckets()` 幂等创建，不需要 `minio/mc` sidecar；
5. 迁移/seed/demo 脚本都随 api 镜像内的 `node_modules` 一起交付，现场不执行 `pnpm install`；
6. SeaweedFS 的 s3.json 由本地模板渲染，不访问任何外部服务。

> 启动竞争处理：桶由 API 创建。`extractor` 与 `backup` 在 compose 里
> `depends_on: api: condition: service_healthy`（API 健康即桶就绪）；
> `backup.sh` 另有有上限的 `head-bucket` 重试，超时显式 `FAILED` 并写日志/备份记录，
> **不静默 SKIPPED**。`entrypoint.sh` 首次备份失败也会显式报错，cron 下轮重试。

---

## 六、凭据与高敏参数

- `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` 是 S3 凭据唯一来源（.env），
  同时被 API / extractor / cli-migrator / backup.sh / seaweedfs 读取；
  封闭试用阶段使用 `.env.example` 默认值，正式启用前必须在 .env 中替换。
- 8 项高敏参数（JWT 密钥、数据库口令、S3 凭据、密码策略、下载开关、预览水印等）
  本轮**暂走默认值**，保密相关设置留到封闭试用后按单位要求再改。
- 凭据字符集限制为 `A-Za-z0-9_+/=-`（见 `seaweedfs/entrypoint.sh`），
  含特殊字符会**显式拒绝启动**而非静默渲染出错误配置。

---

## 七、排障速查

| 现象 | 检查 |
|---|---|
| `docker compose up` 报镜像不存在 | `bash load-images.sh` 未执行或 tar 不完整（看 `SHA256SUMS`） |
| health `objectStorage.ok=false` | `docker compose logs seaweedfs`（首次启动 S3 网关约需 10~30s 等 filer）；`docker compose ps` 看 healthcheck |
| health 仍 `degraded` | `curl /api/health` 看哪个 deps 为 false；逐一查 pg/es/redis/seaweedfs |
| S3 403 但业务正常 | 匿名 GET / 返回 403 是预期（鉴权生效）；healthcheck 把 200/403 都视为健康 |
| `demo:books` 抽取超时 | `docker compose logs extractor`；确认 extractor 容器健康、Redis 可达、S3 可读 |
| 备份记录 `minio_status=FAILED` | `docker compose logs backup` 与 `/backup/backup.log`；确认桶已建、aws-cli 可用 |
| 检索命中数不足 | 确认 ES 索引 `archive_items` 已建且 IK 插件可用；重跑 `demo:books` |
| 分片 PUT 成功、但 `completeMultipart` 失败 | 先查 S3 层 `Access-Control-Expose-Headers: ETag` 是否生效（浏览器读不到 ETag 就无法汇总分片），用原生 OPTIONS + 真实 PUT 看响应头原值；**勿误判为 SigV4 签名或对象存储兼容性问题**，也不要据此改签名逻辑 |

---

## 八、已知边界

- 本离线包为**单实例**部署，未验证多容器 `pub/sub` 跨进程与多实例并发取号；
- 真实书籍样本尚未提供，当前 `demo:books` 使用确定性生成的模拟数据（可重复执行、不污染正式数据）；
- `docs/ARCHITECTURE-SEAWEEDFS.md`（架构师）与 `docs/DEMO-ACCEPTANCE.md`（PM）为配套验收文档；
- 主仓 `docs/DEPLOY.md` / `DELIVERY-CHECKLIST.md` / `DEV-PROCESS.md` / `QA-REPORT.md` 由主理人/QA 后续同步，本包不改。
- **凭据轮换责任人与时间窗尚未指定到具体岗位 / 人**（见 §0.2）；未落实不得转入正式启用。本项不阻塞封闭试用。
- S3 层 `Access-Control-Expose-Headers: ETag` 由 SeaweedFS 侧配置承接，与 API 层 `CORS_ORIGINS` 是两回事（见 §0.1）；其结论以 QA 阶段二独立复核为准，`s3:probe` 全绿不等同于该项已验证。
