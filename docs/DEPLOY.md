# 部署与压测启动手册

> 系统：天玑档案管理系统（本地复刻）
> 工程根：`E:\TianjiArchive`
> 适用：Docker Desktop（WSL2 后端）单机试点部署

---

## 〇、前置条件检查（每次启动前先跑）

```bash
# 1. Docker 引擎可用？（WSL2 初始化完成前会报 cannot connect）
docker version
docker compose version

# 2. WSL2 状态
wsl --status
wsl --list --verbose        # docker-desktop 应为 Running

# 3. 端口占用检查（Windows 侧）
netstat -ano | findstr ":9200 :9000 :5432 :6379 :3000 :8080"
```

**如果 `docker version` 报 `error during connect`** → Docker Desktop 尚未完成 WSL2 初始化。
打开 Docker Desktop 图形界面，等左下角状态变为 **Engine running**（首次约 2–5 分钟）。这一步必须用户手动做一次，命令行无法代劳。

---

## 一、目录与数据卷

Compose 使用**宿主机目录挂载**（不是 named volume），便于拷到 NAS：

```
E:\TianjiArchive\volumes\
├── postgres\        PostgreSQL 数据
├── wal_archive\     PostgreSQL WAL 归档（PITR 用）
├── esdata\          Elasticsearch 数据
├── minio\           MinIO 对象
├── redis\           Redis AOF
└── backup\          备份产物（pg dump + 对象快照）
```

> 以上路径与 `docker-compose.yml` 的 `volumes:` 段**逐一对应**，改一处必须同步另一处。

首次启动前**必须先创建**这些目录，否则 Docker 可能以 root 权限自动建成空目录，之后宿主机无权写入：

```bash
cd /e/TianjiArchive
mkdir -p volumes/{postgres,wal_archive,esdata,minio,redis,backup}
```

> ⚠️ **ES 目录权限**：ES 容器内以 uid 1000 运行，`volumes/esdata` 需可写。
> Windows 上的 Docker Desktop 通过 9p/drvfs 挂载通常自动放行；若 ES 启动报
> `AccessDeniedException: .../nodes`，执行：
> ```bash
> docker compose run --rm --user root elasticsearch chown -R 1000:0 /usr/share/elasticsearch/data
> ```

---

## 二、环境变量

```bash
cd /e/TianjiArchive
cp .env.example .env
```

**上生产前必须改的 5 个值**（全部含 `change_me` 或 `please_change`）：

| 变量 | 样例值 | 说明 |
|---|---|---|
| `POSTGRES_PASSWORD` | `tianji_pwd_change_me` | 数据库口令 |
| `MINIO_SECRET_KEY` | `tianji_minio_change_me` | 对象存储口令 |
| `JWT_ACCESS_SECRET` | `please_change_this_access_secret_32chars` | **至少 32 字符**，否则启动即报错 |
| `JWT_REFRESH_SECRET` | `please_change_this_refresh_secret_32chars` | 同上，且须与 access 不同 |
| `REDIS_PASSWORD` | 空 | 本机试点可空；对公网暴露时必须设 |

其余按需：`ES_EXPOSED_PORT`（本机已有 ES 时改 `9201`）、`WEB_PORT`、`API_PORT`。

---

## 三、IK 镜像构建（关键步骤，容易卡住）

官方 Elasticsearch 镜像**不含中文分词**，必须构建带 IK 插件的自定义镜像。
本项目的构建定义在 `infra/elasticsearch/Dockerfile`。

### 3.1 构建命令

```bash
cd /e/TianjiArchive
docker compose build elasticsearch
```

首次构建约 **3–8 分钟**（取决于网络）。成功后镜像名：`tianji-elasticsearch-ik:8.13.4`。

### 3.2 IK 插件来源（两条路径，Dockerfile 已自动降级）

`Dockerfile` 的 `RUN` 段先看 **build context 内是否有离线 zip**，没有才联网下载：

```
路径 A（推荐·内网/弱网）：把 zip 放到 infra/elasticsearch/ik/ 下
    infra/elasticsearch/ik/elasticsearch-analysis-ik-8.13.4.zip

路径 B（有外网）：自动从以下两个源依次尝试
    1) https://get.infini.cloud/elasticsearch/analysis-ik/8.13.4
    2) https://github.com/infinilabs/analysis-ik/releases/download/v8.13.4/...
```

**离线包获取方式**（任一）：
- 从已装 IK 的环境拷出：`<ES_HOME>/plugins/analysis-ik/` 打包成 zip（需保持 zip 内结构为根下直接是 `plugin-descriptor.properties`）
- 从 `https://release.infinilabs.com/analysis-ik/stable/` 下载对应版本

### 3.3 验证 IK 已装好

```bash
# 容器起来后执行
docker compose exec elasticsearch \
  bin/elasticsearch-plugin list
# 期望输出：analysis-ik

# 更硬的验证：建一个用 ik_max_word 的临时索引
curl -s -X PUT "http://localhost:9200/ik-smoke" -H 'Content-Type: application/json' -d '{
  "mappings":{"properties":{"t":{"type":"text","analyzer":"ik_max_word"}}}
}'
curl -s -X POST "http://localhost:9200/ik-smoke/_analyze" -H 'Content-Type: application/json' -d '{
  "analyzer":"ik_max_word","text":"天玑档案管理系统案卷著录"
}'
# 期望：tokens 里出现 "天玑" "档案" "案卷" "著录" 等切分，而不是整串或单字
curl -s -X DELETE "http://localhost:9200/ik-smoke"
```

> 若 `_analyze` 返回 `analyzer [ik_max_word] not found` → 说明上一步构建时 IK 没装上，回看构建日志。

### 3.4 自定义词典

`infra/elasticsearch/Dockerfile` 会把以下两个文件打进镜像：
- `infra/elasticsearch/analysis-ik/custom_dict.dic` —— 单位主题词表（已含 天玑/案卷/全宗/档号/保管期限/著录/归档/借阅/卷内目录/文书档案/科技档案/会计档案）
- `infra/elasticsearch/analysis-ik/stopword.dic` —— 停用词

**改了词典不必重建镜像**，运行时挂载覆盖即可（在 `docker-compose.yml` 的 `elasticsearch.volumes` 里加）：

```yaml
- ./infra/elasticsearch/analysis-ik/custom_dict.dic:/usr/share/elasticsearch/config/analysis-ik/custom_dict.dic:ro
```

改完需 `POST /_analyze` 走一次或重启 ES 让词典重载。

---

## 四、一键启动

```bash
cd /e/TianjiArchive

# 1. 构建镜像（IK 构建 + 4 个应用镜像）
docker compose build

# 2. 启动（-d 后台）
docker compose up -d

# 3. 观察启动过程（ES 与 PG 首次初始化最慢，约 60–120 秒）
docker compose ps
docker compose logs -f api
```

### 期望的服务状态

| 服务 | 期望状态 | 端口 | 说明 |
|---|---|---|---|
| `tianji-postgres` | healthy | 5432 | |
| `tianji-elasticsearch` | healthy | 9200 | start_period 60s，别急着判死 |
| `tianji-redis` | healthy | 6379 | |
| `tianji-minio` | healthy | 9000 / 9001(console) | |
| `tianji-minio-init` | exited(0) | — | 一次性建桶，退出 0 是**正常** |
| `tianji-api` | healthy | 3000 | 依赖 PG+ES+Redis+MinIO 全 healthy |
| `tianji-extractor` | running | — | |
| `tianji-web` | running | 8080 | |
| `tianji-backup` | running | — | sidecar，按 `BACKUP_CRON` 触发 |

### 首次启动后必做：迁移 + 种子

```bash
docker compose exec api pnpm migration:run
docker compose exec api pnpm seed
```

种子会创建默认管理员：**`admin` / `Tianji@2024`**（首次登录后立即改密）。

### 冒烟检查

```bash
curl -s http://localhost:3000/api/health | jq       # {"status":"ok", ...}
curl -s http://localhost:9200/_cluster/health | jq   # status: green 或 yellow（单节点 yellow 正常）
curl -s -I http://localhost:8080                    # 200，nginx
```

浏览器打开 <http://localhost:8080>，用 `admin` / `Tianji@2024` 登录。

---

## 五、档号并发压测（`perf:danghao`）

### 5.1 前置：必须有 seed 数据

压测脚本会取 `fonds` 表第一条记录、`category`、`org_node`、`danghao_rule`。
**没跑过 `pnpm seed` 会直接报「找不到全宗」**。

```bash
docker compose exec api pnpm --filter @tianji/api seed
```

验证：

```bash
docker compose exec postgres psql -U tianji -d tianji_archive \
  -c "SELECT count(*) FROM fonds; SELECT count(*) FROM danghao_rule;"
```

### 5.2 跑压测

```bash
# 默认：并发 100，轮数 5
docker compose exec api pnpm --filter @tianji/api perf:danghao

# 加量：并发 200，轮数 10（硬性验收要点 1 的推荐参数）
docker compose exec -e CONCURRENCY=200 -e ROUNDS=10 api \
  pnpm --filter @tianji/api perf:danghao
```

参数说明：

| 环境变量 | 缺省 | 含义 |
|---|---|---|
| `CONCURRENCY` | 100 | 同时申请档号的协程数 |
| `ROUNDS` | 5 | 重复轮数（每轮 TRUNCATE 探针表重来） |

### 5.3 期望结果

```
✓ 全部 10 轮通过：零重号、零断号
```

判定依据（脚本内部双重校验）：
1. **零重号**：内存去重后 distinct == success；且写入 `perf_danghao_probe`（`danghao` 唯一索引）时无 `23505` 冲突
2. **零断号**：`MAX(序号) - MIN(序号) + 1 == COUNT(*)`，序列连续

**任何一轮出现 `duplicates: [...]` 或 `gaps > 0` 即失败**，脚本会打印具体档号。

### 5.4 压测不通过时的排查顺序

1. 看 `danghao_rule` 的 `next_value` 是否被别的进程也改（多实例并发时无法保证）
2. 确认走的是 `DanghaoSequenceService` 的 `UPDATE ... RETURNING next_value - 1` 原子自增路径，而不是 `SELECT MAX(danghao)+1`
3. 有没有外部直接 INSERT `archive_item` 绕过服务层
4. ES 慢不应影响档号生成（档号走 PG，ES 是旁路索引）——若受影响说明同步路径写错了

### 5.5 压测对 ES 的影响

`perf:danghao` 直接调 `generateItemDanghao`，**不写 ES**（探针表是独立表）。
所以 `ES_JAVA_OPTS` 保持 1g 也能跑。若要同时压检索，另需 `perf:search`：

```bash
docker compose exec -e PERF_USER=admin -e PERF_PASS=Tianji@2024 api \
  pnpm --filter @tianji/api perf:search
```

---

## 六、常用运维命令

```bash
# 看日志
docker compose logs -f api
docker compose logs -f elasticsearch

# 进容器
docker compose exec api sh
docker compose exec postgres psql -U tianji -d tianji_archive

# 重建单个服务（改了代码后）
docker compose build api && docker compose up -d api

# 只重建 IK 镜像（改了 Dockerfile 或换了 IK 版本）
docker compose build --no-cache elasticsearch
docker compose up -d elasticsearch

# 完全停止（保留数据）
docker compose down

# 连数据一起清掉（危险）
docker compose down
rm -rf volumes/{postgres,wal_archive,esdata,minio,redis}
```

---

## 七、常见问题

| 症状 | 原因 | 处置 |
|---|---|---|
| `docker version` 报 `error during connect` | WSL2 未初始化 | 打开 Docker Desktop 等 Engine running |
| `port is already allocated` | 宿主机端口被占 | 改 `.env` 里 `ES_EXPOSED_PORT` / `WEB_PORT` / `API_PORT` |
| ES 反复重启，日志 `AccessDeniedException` | `volumes/esdata` 权限 | 见第一节的 chown 命令 |
| ES healthy 但 `_analyze` 报 `unknown analyzer` | IK 未装上 | `docker compose build --no-cache elasticsearch`，看构建日志里 plugin install 是否成功 |
| api 一直 `unhealthy` | 依赖服务没全 healthy | `docker compose logs api`，通常是连不上 ES/PG |
| `perf:danghao` 报找不到全宗 | 没跑 seed | `docker compose exec api pnpm --filter @tianji/api seed` |
| 登录后立刻被踢 | localStorage key 从 `titan.*` 改成了 `tianji.*` | 正常现象，清缓存重新登录即可 |
| 迁移报「表已存在」 | `volumes/postgres` 有旧数据 | 要么 `migration:run` 接着跑（幂等），要么清空 volumes/postgres 重来 |

---

## 八、本机试点建议配置

| 项 | 建议 | 理由 |
|---|---|---|
| Docker Desktop 内存 | ≥ 6 GB | ES 1g + PG + Redis + 4 个 Node 容器 |
| `ES_JAVA_OPTS` | `-Xms1g -Xmx1g` | 试点数据量小；压测档号不经 ES |
| `ES_EXPOSED_PORT` | `9200`（若冲突改 9201） | |
| 磁盘 | ≥ 20 GB 空闲 | 镜像约 6 GB + 数据卷 |
| 首次 `docker compose build` | 留 15 分钟 | IK 构建 + 4 个应用镜像 |
