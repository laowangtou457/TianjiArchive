# 天玑档案管理系统 · 封闭环境离线部署包（方案 A / SeaweedFS）

> 目标：**全过程无公网**。现场不 `build`、不 `pull`、不下载任何二进制
> （含 `dl.min.io`、`minio/mc`、npm/apk 包），只做「导入镜像 → 起容器 → 初始化数据 → 冒烟」。
> 对象存储为 SeaweedFS 3.79 S3 Gateway；应用侧沿用 `minio` npm SDK 走标准 S3 协议，
> `MINIO_*` 环境变量名保留（历史兼容），业务代码无需改动。

---

## 〇、现场必读（演示前必看）

> 本节为现场部署与演示前的**强制勾验清单**，来源于 PM 的 `docs/样品Demo验收清单.md` §1.4 / §2 / §4.3
> 与架构规格 §1.2 / §7。**8 条 S0 未勾验不得开始演示**；未勾验导致的失败按「前置未就绪」记录，
> 不计产品功能缺陷。

### 0.1 局域网 IP：封闭环境现场必改项（本机 demo 不用改）

| 场景 | 动作 |
|---|---|
| 浏览器与 Docker 同机 | 保持默认 `127.0.0.1:8333`，无需修改 |
| 应用在服务器、浏览器在局域网其他机器（封闭环境常见） | 在 `.env` 把 `S3_PUBLIC_ENDPOINT` 改为**宿主机局域网 IP**（如 `192.168.10.50`），并确认 `S3_PUBLIC_PORT=8333` 与 `SEAWEEDFS_S3_EXPOSED_PORT` 一致、`S3_PUBLIC_USE_SSL=false` |

- 依据：`.env.example` 的 R-1 注释、`docs/SeaweedFS架构规格.md` §1.2 双端点裁定。**具体 IP 属 R-10 现场确认项，包内只放占位符，不代拍板**。
- **不改的后果**：预签名 URL 的 host 仍是 `127.0.0.1`，浏览器无法解析 → 上传 / 预览直连失败，S0-3 前置不通过；启动检查亦会告警（`apps/api/src/config/configuration.ts` 的回环地址告警）。
- **前置依赖（交付前必须确认，可机械核对）**：`S3_PUBLIC_*` 三项必须由 compose 注入 `api` 容器才生效。已核实两份 compose 原先均无该项注入，且镜像内不含 `.env`、`ConfigModule.envFilePath` 在容器内无对应文件；该项已列入本次交付的收口清单。现场起栈后执行 `docker compose -f docker-compose.offline.yml exec api env | grep S3_PUBLIC`，**预期**：三项齐全（`S3_PUBLIC_ENDPOINT` / `S3_PUBLIC_PORT` / `S3_PUBLIC_USE_SSL`）、取值与 `.env` 一致；`S3_PUBLIC_ENDPOINT` 在**封闭环境多机访问**时必须是宿主机局域网 IP（**非 `127.0.0.1`、非容器 DNS `seaweedfs`**），在**浏览器与 Docker 同机的本机 demo** 时可保持 `127.0.0.1`。不满足时按 `docs/样品Demo验收清单.md` §1.4 / §5.1「前置未就绪」记录，**不计产品功能缺陷**；只改 compose 文件而不实测容器内取值，不构成闭环。
- **默认值陷阱（证据强度边界，必须如实登记）**：`apps/api/src/config/configuration.ts` 给 `S3_PUBLIC_*` 带代码默认值 `127.0.0.1` / `8333` / `false`，compose 又用 `${S3_PUBLIC_ENDPOINT:-127.0.0.1}` 兜底 ⇒ **本机 demo 场景下「预签名 URL host 正确」与「配置注入生效」不可区分**：即便三项完全没注入，API 也会签出 `127.0.0.1:8333`，看起来全绿。故：
  - env 勾验**不能只查「三项齐全」**，必须逐项与现场实际生效的 `.env` 原值比对；「容器内 env 原值 + `.env` 原值 + 预签名 URL host」三者须并列留痕，缺一不可；
  - 最强对照（起栈自验必做）：临时把 `.env` 的 `S3_PUBLIC_ENDPOINT` 改为局域网 IP → 重建 / 重启 `api` → 复验 `PRESIGN_HOST` 随之变化 → 改回；**临时值不得留在正式 `.env` / `.env.example`**；
  - **封闭环境多机场景**因 endpoint 本就必须是局域网 IP，默认值不可能碰巧命中，对照自然成立；**本机 demo** 若未做对照，报告须登记为「已知证据强度边界」，且不得把 `IS_PASS: YES` 写成「配置注入已验证」。
  - **【2026-11-09 已解除】**本机 demo 场景的对照实验已完成（证据 `docs/perf/runs/lead-stage-c2-host-control-*.log`）：`S3_PUBLIC_ENDPOINT` 按 `127.0.0.1` → `192.168.20.51` → `127.0.0.1` 依次修改并重建 api，预签名 URL host **精确跟随** `.env` 变化（`127.0.0.1:8333` → `192.168.20.51:8333` → `127.0.0.1:8333`），且走的是 NestJS 真实签发路径（`POST /api/files/presign` → R1 用户 → `putUrl`）。**「默认值陷阱」证据强度边界正式解除，本项可写「配置注入已验证」**。
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
- **交付前待确认（当前未定，不得写成已定）**：**凭据轮换责任人与时间窗尚未指定到具体岗位 / 人**。`docs/SeaweedFS架构规格.md` §7 与 `docs/样品Demo验收清单.md` 均只写「封闭试用收尾」，未落实到岗。**未落实不得转入正式启用**。本项不阻塞封闭试用（demo 用默认值），但交付时必须由用户侧明确回答；此处不写「由管理员处理」这类泛称。

### 0.3 演示前勾验 8 条（S0，来源 `docs/样品Demo验收清单.md` §1.4）

| # | 勾验项 | 现场判据 |
|---|---|---|
| S0-1 | 全服务 healthy | `docker compose ps` 无 degraded；`/api/health` 的 `objectStorage.ok = true`（**degraded 是 MinIO 时代旧预期，不接受**） |
| S0-2 | 4 桶建好 | 原始 / 预览 / 缩略图 / 备份桶均可 HeadBucket |
| S0-3 | 预签名 URL 浏览器可达 | 浏览器直传完成一次 PUT（方案 A 最高优先实测项，见 §0.1） |
| S0-4 | 迁移 + seed 幂等 | `migration:run` 5/5；重复 seed 不产生重复全宗 / 角色 |
| S0-5 | **多角色账号已建** | 至少 R1（著录 / 审批）、R3（借阅申请）、R0（日志 / 备份 / 参数）；演秘密级双级审批再加 R4 |
| S0-6 | 模拟样本导入幂等 | 重复导入后条目数、档号集合、sha256 完全一致 |
| S0-7 | 8 项高敏参数为出厂默认值**并截图留证** | 参数页显示值 = `docs/样品Demo验收清单.md` §4 表，无一条被改 |
| S0-8 | 构建门禁全绿 | `build` / `typecheck` / `lint` / `test` / `ci:check` 通过 |

### 0.4 三条防误读口径（随包必附）

1. 本次为**封闭环境样品 demo 功能验证**；8 项高敏参数走产品建议默认值、未经本单位及保密部门确认，**不构成管理制度口径，也不构成保密合规结论**；演示数据为模拟书籍，非真实档案。
2. **试用账号必须多角色**：`seed` 只建 `admin`(R0)，而 R0 在案卷级 / 件级著录、电子文件、在线预览、借阅申请等功能域均为 `✖`。用 admin 单账号走全流程会在 S2 直接 403 —— 这是权限矩阵生效，**不是功能缺陷**（`docs/产品需求文档.md` §3.1 / §3.2）。
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
| `dpkg: error: could not read package info file in /var/lib/dpkg/status` | `/var/lib/dpkg/status` 被做成了**目录**（不是文件）。见 **§8.1**（含安全边界：正常文件绝不能删） |
| `E: Could not fetch ./.deb from file:/debs ./` | 本地源三件事没同时成立：目录没挂进容器 / `file:/` 少两个斜杠 / 源行缺末尾 `./`。见 **§8.2** |
| `--storage-opt size=1G` 加了却一点没限住 | **该参数在 Docker Desktop 的 overlayfs 驱动上被静默忽略**（命令成功、`df` 仍显示整盘）。判断标准是进去 `df`，不是看命令报错。见 **§8.3** |
| ES 起不来：`failed to obtain node locks … AccessDeniedException: node.lock` | 九成是宿主卷目录属主不对（ES 以 uid=1000 跑、entrypoint 不 chown）。报错文案完全不提属主。见 **§8.4** |

---

## 八、现场必踩的四个坑（dpkg / apt / 磁盘限额 / 卷属主）

这四条都是「手工补包 / 在容器里装 deb / 给嵌套 dockerd 限额」时撞的，**报错文案都不指向真正的原因**。
§8.1 / §8.2 直接影响 `installer/build/fetch-docker-debs.sh` 与安装器的 `S3_DOCKER`（都是「一堆 .deb + 本地源」的路子）；
§8.3 / §8.4 是给「在容器里跑 dockerd」「手工 compose up」的人看的。

### 8.1 `dpkg: error: could not read package info file in /var/lib/dpkg/status`

**现象**

```text
dpkg: error: could not read package info file in /var/lib/dpkg/status
```

`dpkg -i` / `dpkg -l` / `apt-get install` 全部失效，后续一切都报成
「包未安装」「依赖不满足」，看起来像闭包缺包，实际与包无关。

**根因**

dpkg 的已装包数据库是**文件** `/var/lib/dpkg/status`（`/var/lib/dpkg/updates/` 才是目录，
且应为空）。当镜像/解包/挂载把它做成了**目录**——典型来源是 `cp -a` 目标已存在同名目录、
或解包时 `status` 先被创建成空目录——dpkg 就会去 `open()` 一个目录，于是报这句。
**它不表示任何 .deb 损坏**，纯粹是数据库路径形态不对。

**修法**（只在确认它们是「空目录」时动手）

```sh
# 安全边界：status 是正常文件且有内容时，绝不能删——那是全机的已装包数据库
[ -d /var/lib/dpkg/status ]  && [ -z "$(ls -A /var/lib/dpkg/status)" ]  && rm -rf /var/lib/dpkg/status
[ -d /var/lib/dpkg/updates ] && [ -z "$(ls -A /var/lib/dpkg/updates)" ] && rm -rf /var/lib/dpkg/updates
dpkg --configure -a || true     # dpkg 会自行重建 status 文件与 updates 目录
dpkg -l | head -1               # 能打印表头即已自愈
```

害怕误删就先留底：`cp -a /var/lib/dpkg/status /root/status.bak.$(date +%s)`（对文件时）。

**复现（一条命令）**

```sh
docker run --rm ubuntu:22.04 sh -c 'mkdir -p /var/lib/dpkg/status && dpkg -l 2>&1 | head -2'
```

### 8.2 `E: Could not fetch ./.deb from file:/debs ./`

**现象**

```text
E: Could not fetch ./.deb from file:/debs ./
```

或 `W: Failed to fetch file:/debs/./xxx.deb  Could not open file - open (2: No such file or directory)`。
注意路径里那个 **`./`**：它是 `Packages` 索引里的**相对** `Filename:` 字段原样拼出来的。

**根因**

用 `apt-ftparchive packages .` 生成本地仓库时，`Packages` 里的 `Filename:` 是相对的
`./xxx.deb`，apt 会把它拼在源行的 base URI 后面。下面三件事任一不成立就报这句：

1. 宿主目录**没挂进容器**，或挂到了与源行不一致的路径（最常见：`$PWD` 不是预期的那个目录）；
2. 源行写成 `file:/debs`（**一个**斜杠）而不是 `file:///debs`（**三个**斜杠）——URI 被解析成
   「file 协议 + 主机名 debs」，路径变成 `/`，于是去找 `/.deb`；
3. 源行漏了末尾的 `./` 组件（`deb [trusted=yes] file:///debs`），而 `Filename:` 是 `./x.deb`。

这条报错**不区分**「文件真不存在」与「URI 拼错」，所以先核对 URI 形态，再去怀疑包。

**修法**（三者必须同时成立）

```sh
docker run --rm -v "$PWD":/debs:ro ubuntu:22.04 sh -c '
  echo "deb [trusted=yes] file:///debs ./" > /etc/apt/sources.list
  apt-get update && apt-get install -y --no-install-recommends <包名>'
```

- `-v "$PWD":/debs:ro`：宿主当前目录（放着 `Packages` 与 `.deb`）挂到 `/debs`；
- `file:///debs`：三斜杠；
- 末尾 `./`：与 `Filename: ./x.deb` 的组件对齐；
- `[trusted=yes]`：本地目录没有签名，不加会先被 `NO_PUBKEY` 拦住。

**复现（一条命令）**

```sh
cd "$(mktemp -d)" && apt-get download hello && apt-ftparchive packages . > Packages \
 && docker run --rm ubuntu:22.04 sh -c 'echo "deb [trusted=yes] file:/debs ./" > /etc/apt/sources.list; apt-get update >/dev/null 2>&1; apt-get install -y hello 2>&1 | tail -2'
```

（故意用单斜杠 `file:/debs` 且不挂载 → 必现上面那句。）

### 8.3 `--storage-opt size=1G` 被静默忽略（限额是假的）

**现象**

```text
$ docker run --rm --storage-opt size=1G alpine:3.20 df -h /
Filesystem      Size  Used Avail Use% Mounted on
overlay        1006.9G  8.1G  998G   1% /
```

命令**成功**、退出码 0、没有任何警告；`docker inspect` 里也能看到 `size=1G`。
但容器里 `df -h /` 显示的是**整个数据盘**——限额根本没生效。

**根因**

`--storage-opt size=` 只有对支持配额的后端才有意义（xfs + `pquota`、devicemapper、
btrfs qgroup）。构建机上是 **Docker Desktop（LinuxKit VM + overlayfs 驱动）**，
overlayfs 驱动**接受这个参数但不实现它**——参数被解析、被存进容器配置、然后被忽略。
所以「命令没报错」和「限额生效」是两件毫不相干的事。

**判断标准**

> **进去 `df` 看，不是看命令有没有报错。**
> 正确的形态是「`df` 里 `/` 的 Size 等于你设的值」；
> 若 `df` 仍显示整盘容量，限额就是假的，别在此基础上跑会写满盘的东西。

**修法（要真限额只有这几条路）**

| 方案 | 前提 | 备注 |
| --- | --- | --- |
| xfs + `pquota` 挂载 | 宿主要有独立的 xfs 分区 | 最正统，`--storage-opt size=` 才真生效 |
| devicemapper + loop | 老方案 | 慢、已 deprecated |
| **loop + ext4 固定大小文件** | 只要 `losetup` + `mkfs.ext4` | 本轮采用，见下 |
| 不用容器限额，改限「容器内数据目录」 | 应用支持改数据目录 | 例如 `du` 监控 + 定时告警，不是硬限额 |

本轮实测可用的硬限额做法（在特权容器里让 dockerd 的数据根落在一个 80GiB 的 ext4 上）：

```sh
truncate -s 80G /root/nested-docker.img          # 稀疏文件，80GiB
mkfs.ext4 -q -F -m 1 -L tj-nested /root/nested-docker.img
mount -o loop /root/nested-docker.img /var/lib/docker
df -hT /var/lib/docker                            # 必须显示 79G ext4 /dev/loopX
```

**怎么证明这个限额是真的**（不要只配上去就信）

```sh
# ① 文件系统几何必须是固定块数（80GiB = 20971520 × 4096），不是整盘
dumpe2fs -h /dev/loop2 | grep -Ei 'block count|block size'
# ② 一次「故意超额分配」必须立刻 ENOSPC（fallocate 不落数据，秒级、不占盘）
fallocate -l 200G /var/lib/docker/.probe   # 期望: fallocate failed: No space left on device
rm -f /var/lib/docker/.probe
```

本轮实测：`fallocate -l 200G` → `No space left on device`；`Block count 20971520 × Block size 4096`
= 85,899,345,920 = 80GiB；后备文件 `ls -l` = 85,899,345,920 字节。

**顺带一条同一类陷阱**：`rm -rf /var/lib/docker` 前**先自证在容器里**
（`hostname` / `[ -f /.dockerenv ]` / `readlink -f /var/lib/docker` 三样都打出来）。
宿主 daemon 的数据根**也叫 `/var/lib/docker`**，在宿主上敲这条命令等于删掉全机镜像与容器。
本轮构建机就因为数据盘被写爆停过 40 分钟。

### 8.4 ES 报 `failed to obtain node locks` —— 其实是宿主机目录属主不对

**现象**

```text
java.lang.IllegalStateException: failed to obtain node locks, tried [/usr/share/elasticsearch/data];
  maybe these locations are not writable or multiple nodes were started on the same data path?
Caused by: java.io.IOException: failed to obtain lock on /usr/share/elasticsearch/data
Caused by: java.nio.file.NoSuchFileException: /usr/share/elasticsearch/data/node.lock
  Suppressed: java.nio.file.AccessDeniedException: /usr/share/elasticsearch/data/node.lock
```

同一句里 `NoSuchFileException` 和 `AccessDeniedException` 一起出现，最容易往错误方向查：
去查磁盘满、并发起了两个节点、上次残留锁文件——**都不是**。

**根因**

bind mount（`./volumes/esdata:/usr/share/elasticsearch/data`）**不会**改宿主目录的属主，
容器里看到的 uid 就是宿主上的数字 uid。`elasticsearch:8.x` 镜像的 `USER` 是
`elasticsearch`（**uid=1000**），且 entrypoint **不做 chown**；如果宿主目录是
`root:root 0750`，它就只有 `r-x`、写不了 `node.lock`。
（对比 `postgres:16-alpine` / `redis:7-alpine`：它们以 root 启动、entrypoint 自己 chown 成
70 / 999，所以同样的 `0:0 0750` 也能跑——这更让人以为是 ES 的问题。）

**修法**

```sh
# 一次性
chown 1000:1000 /opt/tianji/volumes/esdata && chmod 0750 /opt/tianji/volumes/esdata
docker restart tianji-elasticsearch
```

安装器 **v1.2 起已自动处理**（`prepareDeployRoot` 里按 `volumeOwners` 表 chown：
`esdata → 1000:1000`、`wal_archive → 70:70`，后者是 postgres 的 `archive_command` 要写）。
若是手工 compose up 起的栈，就得自己 chown。

**顺带**：`wal_archive` 属主错**不会**让 postgres 起不来，只会让 WAL 归档在日志里静默失败——
所以「容器 healthy」不等于「归档正常」，检查 `docker compose logs postgres | grep -i archive`。

---

> 诚实边界：§8.1 / §8.2 是**现场实录整理**，本轮构建机 Docker 停机期间没有在容器里重新复跑，
> 复现命令按最小可复现路径给出，操作前请先确认 `status` 不是正常文件（§8.1 安全边界）。
> §8.3 / §8.4 是**本轮 ③ 实测**（`--storage-opt` 的无效 `df` 输出、`fallocate` 的 ENOSPC、
> ES 修属主前后 `Restarting` → `healthy` 均有原始输出留存）。


---

## 九、已知边界

- 本离线包为**单实例**部署，未验证多容器 `pub/sub` 跨进程与多实例并发取号；
- 真实书籍样本尚未提供，当前 `demo:books` 使用确定性生成的模拟数据（可重复执行、不污染正式数据）；
- `docs/SeaweedFS架构规格.md`（架构师）与 `docs/样品Demo验收清单.md`（PM）为配套验收文档；
- 主仓 `docs/部署与压测启动手册.md` / `交付核对清单.md` / `开发过程记录.md` / `QA验收报告.md` 由主理人/QA 后续同步，本包不改。
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
- **离线包镜像尚未导出：构建机网络侧阻断（非产品缺陷、非离线包设计问题）**。2026-11-09 阶段 A 重建 `tianji-archive-extractor:1.0.0` 时，构建机经代理访问 `deb.debian.org` 持续 502（上游 IP 恒为 `146.75.46.132:80`）：3 轮 `apt-get install` 的 ~320MB 中随机 1~7 个 `.deb` 502（坏包集合 7→7→1、互不相同），加 `Acquire::Retries=5 --fix-missing`（`19d9db4`，构建鲁棒性改进、非功能变更、fail-closed 不变）后全量重建，**失败点又上移到 `apt-get update` 的 `bookworm/InRelease` 502**。判定为构建机公网链路不稳，非代码/配置/离线包设计缺陷，故停止加码、不再换源。现场 `BUILD-INFO.txt` 保持 `RECORD_COMPLETE=no`，`save-images.sh` 的 L0 会正确拦住导出，**不会把缺镜像的包送进封闭环境**。恢复条件：构建机能稳定访问 Debian 源后，按阶段 A→B→C 全流程重跑。**【已于 2026-11-09 闭环】**：用户切换代理节点后，构建容器显式传 `--build-arg HTTP_PROXY/HTTPS_PROXY=http://host.docker.internal:52066` 绕开 daemon 固化的 `http.docker.internal:3128`，apt 层完整通过（rebuild6 日志）；extractor 镜像最终构建成功，阶段 A 三步（`--record` / `--check` IS_PASS:YES / L0 变异复验）全部完成，见下条。
- **buildkit 构建网络与宿主/容器是三条不同链路，Node 22 corepack 不认代理 env**【2026-11-09 实测，构建期偏差已登记】：宿主直连/代理、`docker run` 默认 bridge、buildkit 构建网络三者连通性互不相同——宿主 npmjs 200、默认 bridge node fetch 200、buildkit 内 apt 502 / node fetch 失败。两级对策：①apt 走显式代理 build-arg（预定义 ARG，免声明）；②corepack 下载 pnpm 无代理可用（Node 22 fetch 不读代理 env），故在 `apps/extractor/Dockerfile` runtime 阶段声明**可选** `ARG COREPACK_NPM_REGISTRY`（默认空 = 官方源，行为不变；`56505b1`），本次构建传 `https://registry.npmmirror.com`。**供应链口径：pnpm@9.12.0 tarball 本次经 npmmirror 获取，integrity 校验仍按 registry 元数据 sha512 执行**；deps 阶段 pnpm install 未受影响（层缓存命中，来源为历史官方源构建）。Docker 自定义 build-arg 不在 Dockerfile 里 `ARG` 声明会被**静默忽略**（rebuild8 实证），不得仅凭 CLI 传参就认定生效。
- **镜像 ID 每次 export 都会变，不能用 `created` 时间戳推断是否重建**【实测】：buildx 每次导出都重新生成 provenance/attestation manifest list，故即使所有层 `CACHED`、源码未变，重新 export 后 4 个自建镜像 ID 仍全部变化。⇒ `save-images.sh --record` **必须在最后一次 build 之后**执行；`BUILD-INFO.txt` 的 4 个 Image ID 才是唯一有效锚，`GIT_HEAD` 仅作追溯字段（构建后文档/证据提交推进 HEAD 属正常，脚本只 WARN 不 die）。这是 #35 绑定校验价值的实证。
- **凭据纪律**（2026-11-09 起）：诊断命令禁止 `env | grep -i <宽泛关键词>`（曾把含 Bearer token / JWT 的整段环境变量 JSON 带进日志）；必须精确枚举变量名。任何日志入库前必须跑凭据扫描并留 `LEAK_FOUND=0` 证据。该次事件中仓库与 git 历史经独立核实**从未含该凭据**。
- **【已修复】JWT 用户快照从未挂载，登录后所有 @RequirePerm 业务端点一律 401**（2026-11-09 阶段 C「API 实际签发路径」实证发现，修复 `aa7a248`）：passport 默认把用户挂到 `request.user`，而权限守卫（`permission.guard.ts`）与 `@CurrentUser` 装饰器读取的是 `request.currentUser`（`CTX_KEY.USER`），`JwtAuthGuard.handleRequest` 此前未挂载、静态 `attach()` 无调用点 ⇒ **业务 HTTP 链路整体不可用**（`s3:probe`/`demo:books` 走 S3 wire 层自检，不经过该路径，故此前全绿未暴露）。修复后 HTTP 级全链路验证：admin 建号/授权/登录/R1 签发 presign 均通。**设计确认**：R0 系统管理员无 FILE 权限属设计（原则上不接触档案内容），其 presign 403 非缺陷；上传须 R1+ 角色并被授予对应全宗数据范围。
- **【已修复】同一条目多文件 fulltext 互相覆盖（last-write-wins）**（2026-11-09 离线 demo 实证发现，修复 `b0ae0d8`）：extractor 各文件独立 `updateFulltext`，PDF 后完成会把 TXT 已回写的正文整段覆盖，综合检索漏检且命中数随调度波动（实测 3~5/6）。修复为以 `document_text`（PG）为唯一权威源、按条目聚合重建 fulltext 整体回写，与完成顺序无关、幂等；修复后连续 3 次 `demo:books` 全绿（`SEARCH_HITS=6` 稳定）。附带观察：demo 用 `buildMinimalPdf` 生成的 PDF 偶发 `bad XRef entry` 文本层抽取失败（仅丢 PDF 正文，TXT 正常，不影响判据），未复现规律，登记备查。
- **观察（未复现、非阻断）**：容器全量重建后的启动窗口内（迁移执行前后约 1 分钟），api 曾报 `relation "audit_log"/"system_param" does not exist` 审计写入失败；随后核对 PG 表与 `audit_log_2026_11/12` 分区**均存在**，之后未再复现。判定为容器重建时序的瞬时现象；QA 阶段二若复现，按「启动顺序依赖迁移」排查，不得先改代码。另：宿主 `docker compose run` 挂载环境下 tsc 对 `@elastic/transport` 报 TS1192（`node:https` 无默认导出），buildkit 干净构建同口径通过——疑似宿主 node_modules 挂载污染，待查，不阻塞。
