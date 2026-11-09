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
- **前置依赖（交付前必须确认，可机械核对）**：`S3_PUBLIC_*` 三项必须由 compose 注入 `api` 容器才生效。已核实两份 compose 原先均无该项注入，且镜像内不含 `.env`、`ConfigModule.envFilePath` 在容器内无对应文件；该项已列入本次交付的收口清单。现场起栈后执行 `docker compose -f docker-compose.offline.yml exec api env | grep S3_PUBLIC`，**预期**：三项齐全（`S3_PUBLIC_ENDPOINT` / `S3_PUBLIC_PORT` / `S3_PUBLIC_USE_SSL`）、取值与 `.env` 一致；`S3_PUBLIC_ENDPOINT` 在**封闭环境多机访问**时必须是宿主机局域网 IP（**非 `127.0.0.1`、非容器 DNS `seaweedfs`**），在**浏览器与 Docker 同机的本机 demo** 时可保持 `127.0.0.1`。不满足时按 `docs/DEMO-ACCEPTANCE.md` §1.4 / §5.1「前置未就绪」记录，**不计产品功能缺陷**；只改 compose 文件而不实测容器内取值，不构成闭环。
- **默认值陷阱（证据强度边界，必须如实登记）**：`apps/api/src/config/configuration.ts` 给 `S3_PUBLIC_*` 带代码默认值 `127.0.0.1` / `8333` / `false`，compose 又用 `${S3_PUBLIC_ENDPOINT:-127.0.0.1}` 兜底 ⇒ **本机 demo 场景下「预签名 URL host 正确」与「配置注入生效」不可区分**：即便三项完全没注入，API 也会签出 `127.0.0.1:8333`，看起来全绿。故：
  - env 勾验**不能只查「三项齐全」**，必须逐项与现场实际生效的 `.env` 原值比对；「容器内 env 原值 + `.env` 原值 + 预签名 URL host」三者须并列留痕，缺一不可；
  - 最强对照（起栈自验必做）：临时把 `.env` 的 `S3_PUBLIC_ENDPOINT` 改为局域网 IP → 重建 / 重启 `api` → 复验 `PRESIGN_HOST` 随之变化 → 改回；**临时值不得留在正式 `.env` / `.env.example`**；
  - **封闭环境多机场景**因 endpoint 本就必须是局域网 IP，默认值不可能碰巧命中，对照自然成立；**本机 demo** 若未做对照，报告须登记为「已知证据强度边界」，且不得把 `IS_PASS: YES` 写成「配置注入已验证」。
- **改完必须重建容器**：`docker compose -f docker-compose.offline.yml up -d`；`restart` 不重读 `.env`。
- **两处 CORS 不要混为一谈**：
  - **API 层 `CORS_ORIGINS`**：origin 白名单，解决以 `http://<局域网IP>:8080` 访问时 `/api` 跨域；默认值仅 `http://localhost:5173` 与 `http://localhost:8080`，需要时追加现场 origin。
  - **S3 层 `Access-Control-Expose-Headers`**：SeaweedFS 预签名分片直传，浏览器必须读到 ETag 才能完成分片合并。**配了前者不解决后者**。
    **2026-11-09 实测更正**：3.79 内置全局 CORS middleware，**零配置**即返回 `Access-Control-Expose-Headers: *`（**`*` 通配覆盖 `ETag`，不是 `ETag` 字面值**）、`Allow-Origin: *`、`Allow-Credentials: true`，且 PUT / UploadPart 返回 `ETag`；`PutBucketCors` 实测 501、`s3.json` 加 cors 段被忽略、无任何 exposeHeaders flag。**不需要、也不允许做 CORS 配置改造**，更不要把响应头改成字面 `ETag`（3.79 配不出来）。
    但 CORS 头是**条件性的**：不带 `Origin` 就不返回。故「浏览器直连宿主 8333、不经反代」是 CORS 生效的**前提** —— 若把 8333 收敛到与 Web 同域，浏览器不带 Origin，ETag 读不到。前端须保持 `axios.put` 默认 `withCredentials=false`；`Expose-Headers: *` 只在 credentials mode = omit 时作为通配生效。
    仍需**交付栈证据**：用真实预签名 partUrl 打一次 PUT，断言 `HTTP 200 + ETag + Expose-Headers: *`，结论以 QA 阶段二独立复核为准。缺 `Origin` 的典型表现是「分片 PUT 成功、completeMultipart 失败」，排障时勿误归因到 SigV4 或对象存储兼容性（见 §七）。

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
#   起栈后必核注入（判据见 §0.1：三项齐全、值与 .env 一致、endpoint 按场景为局域网 IP 或 127.0.0.1）：
docker compose -f docker-compose.offline.yml exec api env | grep S3_PUBLIC

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
| seaweedfs volume | 8081（`-volume.port=8081`，避开 web 宿主 8080） | 不发布（仅 compose 内网） | — | 同上 |
| redis | 6379 | 6379 | `REDIS_EXPOSED_PORT` | `./volumes/redis` |
| backup | — | — | — | `./volumes/backup` |

封闭环境可只暴露 `WEB_PORT`（8080）；其余端口靠 compose 内部网络 `tianji-net` 互通，
把 `*_EXPOSED_PORT` 行删掉或改成 `127.0.0.1:端口:端口` 即可进一步收紧。
R-2 裁定：**seaweedfs 只发布 8333**，master / filer / volume 均不占宿主端口，因此 volume 的容器内端口 8081 与 web 的宿主 8080 不冲突；浏览器直连预签名 URL 走宿主 8333，不经 nginx 反代。交付前请核对**主 compose 与 offline compose 的 `seaweedfs.ports` 均只有 `8333:8333` 一条**；任何 `9333:9333` 之类的额外映射都是应摘除项。

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
| 分片 PUT 成功、但 `completeMultipart` 失败 | 浏览器读不到 ETag 就无法汇总分片。3.79 零配置即返回 `Access-Control-Expose-Headers: *`，故**优先查三件事**：①请求是否带了 `Origin`（不带则无任何 CORS 头）；②8333 是否被反代收敛到与 Web 同域（同域浏览器不带 Origin）；③是否设了 `withCredentials=true` / `credentials: include`（此时 `*` 被当字面量）。用原生 OPTIONS + 真实 PUT 看响应头原值；**勿误判为 SigV4 签名或对象存储兼容性问题**，也不要据此改签名逻辑或去配 CORS |

---

## 八、已知边界

- 本离线包为**单实例**部署，未验证多容器 `pub/sub` 跨进程与多实例并发取号；
- 真实书籍样本尚未提供，当前 `demo:books` 使用确定性生成的模拟数据（可重复执行、不污染正式数据）；
- `docs/ARCHITECTURE-SEAWEEDFS.md`（架构师）与 `docs/DEMO-ACCEPTANCE.md`（PM）为配套验收文档；
- 主仓 `docs/DEPLOY.md` / `DELIVERY-CHECKLIST.md` / `DEV-PROCESS.md` / `QA-REPORT.md` 由主理人/QA 后续同步，本包不改。
- **凭据轮换责任人与时间窗尚未指定到具体岗位 / 人**（见 §0.2）；未落实不得转入正式启用。本项不阻塞封闭试用。
- S3 层 CORS 与 API 层 `CORS_ORIGINS` 是两回事（见 §0.1）：3.79 内置且**零配置**返回 `Allow-Origin: *` / `Allow-Credentials: true` / `Expose-Headers: *`（`*` 通配覆盖 `ETag`）；其结论以 QA 阶段二独立复核为准，`s3:probe` 全绿不等同于该项已验证。
- **`Allow-Origin: *` 与 `Expose-Headers: *` 在 3.79 上无法收紧**（flag 无效、`PutBucketCors` 501、`s3.json` cors 段被忽略），会向浏览器暴露 `X-Amz-Request-Id`、`Server` 等全部响应头。样品 demo 封闭内网阶段接受并如实登记；正式启用前若单位要求收紧到具体 origin 或精确暴露头，只有三条替代路径：①前置反代改写响应头（与「浏览器直连 8333」冲突，且同域后无 Origin 连 `*` 也会消失）；②服务端 `listParts` / HEAD 回传 part ETag（改契约、每分片多一次往返）；③分片改走 API 代理（2GB 全量过 API，性能不可接受）。**三条代价都高，本轮不启用，须重新裁定架构**。
- **CSP 当前未在 SPA 页面生效，属潜伏风险而非本次 demo 阻断项**（2026-11-09 两次实测合并结论，保留反转过程）：
  - 【两次结论的关系】两次实测是**串联而非冲突**：nginx `add_header` 继承规则决定「CSP 头有没有下发到 HTML 文档」（更靠前的一层事实），头下发之后才轮到「`connect-src 'self'` 拦不拦跨端口请求」。架构师的实验装置显式下发 CSP 且 CDP `Network.responseReceived` 回显确认（`pageCspHeaderConfirmed`），故「拦截」成立；交付栈主文档未下发该头，故当前不拦。**差异只在头是否下发，不在 CSP 策略本身**。因果链：当前 SPA 文档无 CSP 头 ⇒ 上传链路当前不被拦（潜伏风险，非现网阻断）；若正式启用前补齐安全头使其下发到 HTML 文档 ⇒ `connect-src 'self'` 立即生效、跨端口 8333 会在 CORS 之前被拦（原始报错见下）⇒ 届时必须同步放宽 `connect-src` 并做浏览器级复验。
  - 【交付栈实测】运行中的 `tianji-web`（nginx/1.25.5；镜像内 `add_header` 行与 `apps/web/nginx.conf` **逐字一致**，故重建后行为相同）：主文档 `/`、`/index.html`、`/assets/*` 的响应头均**无 `Content-Security-Policy`**，也无 `X-Frame-Options` 等 server 级头，只有 `Cache-Control`。原因是 `location /`（:61）与 `location /assets/`（:54）各有同级 `add_header Cache-Control`，按 nginx 继承规则 server 级 `add_header` 不被继承；仅 `/api/`（无同级 `add_header`）的反代响应带 CSP，而 JSON 响应不构成浏览器文档上下文。⇒ **当前 SPA 页面不受 CSP 约束**，浏览器直连 `:8333` 的分片 PUT 不会被 CSP 拦。
  - 【能力证据】架构师浏览器级实测（Chrome/156.0.8078.80 headless + CDP；最小策略与 `nginx.conf:19` 逐字一致完整策略各两轮）：**若 HTML 文档确实收到 `connect-src 'self'`**，跨端口 `:8333` 请求在 CORS 之前被拦，Console 原始报错 `Connecting to 'http://127.0.0.1:8333/probe' violates the following Content Security Policy directive: "connect-src 'self'". The action has been blocked.`，`Network.requestWillBeSent` 为空、8333 服务端**零请求**；对照 `connect-src 'self' http://*:8333` 放行（`*` 通配 host 对 `127.0.0.1` 实测有效）。该结论**适用范围仅限「CSP 头确实下发给 HTML 文档」**，不得外推为「本离线包上传链路被阻断」。
  - 【裁定】本轮**不改 `apps/web/nginx.conf`**：既不为一个当前未下发的头放宽策略，也不顺手修 `add_header` 继承——后者会让 `script-src 'self' 'unsafe-inline' 'unsafe-eval'` 等指令真正生效，引入白屏风险。**正式启用前若要补齐安全头，必须同时把 `connect-src` 放宽到允许 `:8333`（或等效方案）并做浏览器级复验**，否则分片直传会在 CORS 之前断链。
  - 【现场必核】DevTools Console 不得出现 `Refused to connect ... connect-src` 类报错；主文档响应头应无 CSP（当前形态）。若出现该报错，属**独立于 CORS 的阻断项**，先报裁定，**不得**归因 SigV4 签名或 SeaweedFS 不兼容、不得据此改签名逻辑或去配 CORS；在 §七「分片 PUT 成功但 completeMultipart 失败」三查之外加查此第 ④ 项。
  - 【未实测边界】`http://*:8333` 的 `*` 仅在 `127.0.0.1` 验证，对现场局域网 IP / 主机名未测；实验用 `fetch`，交付代码 `FileUploader.tsx:104` 用 `axios.put`（XHR），XHR 未单独实测；实验用等价端口对 `18080 → 8333`（宿主 8080 被占用），未在真实 8080 复跑。三项均如实登记，不写成结论。
- **离线包镜像尚未导出：构建机网络侧阻断（非产品缺陷、非离线包设计问题）**。2026-11-09 阶段 A 重建 `tianji-archive-extractor:1.0.0` 时，构建机经代理访问 `deb.debian.org` 持续 502（上游 IP 恒为 `146.75.46.132:80`）：3 轮 `apt-get install` 的 ~320MB 中随机 1~7 个 `.deb` 502（坏包集合 7→7→1、互不相同），加 `Acquire::Retries=5 --fix-missing`（`19d9db4`，构建鲁棒性改进、非功能变更、fail-closed 不变）后全量重建，**失败点又上移到 `apt-get update` 的 `bookworm/InRelease` 502**。判定为构建机公网链路不稳，非代码/配置/离线包设计缺陷，故停止加码、不再换源。现场 `BUILD-INFO.txt` 保持 `RECORD_COMPLETE=no`，`save-images.sh` 的 L0 会正确拦住导出，**不会把缺镜像的包送进封闭环境**。恢复条件：构建机能稳定访问 Debian 源后，按阶段 A→B→C 全流程重跑。
- **镜像 ID 每次 export 都会变，不能用 `created` 时间戳推断是否重建**【实测】：buildx 每次导出都重新生成 provenance/attestation manifest list，故即使所有层 `CACHED`、源码未变，重新 export 后 4 个自建镜像 ID 仍全部变化。⇒ `save-images.sh --record` **必须在最后一次 build 之后**执行；`BUILD-INFO.txt` 的 4 个 Image ID 才是唯一有效锚，`GIT_HEAD` 仅作追溯字段（构建后文档/证据提交推进 HEAD 属正常，脚本只 WARN 不 die）。这是 #35 绑定校验价值的实证。
- **凭据纪律**（2026-11-09 起）：诊断命令禁止 `env | grep -i <宽泛关键词>`（曾把含 Bearer token / JWT 的整段环境变量 JSON 带进日志）；必须精确枚举变量名。任何日志入库前必须跑凭据扫描并留 `LEAK_FOUND=0` 证据。该次事件中仓库与 git 历史经独立核实**从未含该凭据**。
