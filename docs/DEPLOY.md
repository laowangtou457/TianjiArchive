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

> ⚠️ **本压测没有延迟阈值**。`IS_PASS` 是布尔判据（六项全满足），
> 每轮 `elapsedMs` 只是观测值，**不参与判定**。把耗时当通过标准是常见误写。
>
> 判据第 6 项 `totalGaps === 0` 约束**序号连续性**——没有它，序列跳号
> （档号被"吃掉"但总数凑满）也会报 `IS_PASS: YES`。该项已修入脚本。
> 报告模板 `docs/perf/PERF-TEMPLATE.md` 给了完整六项定义与构造反例。

**正式压测请用模板出报告**：复制 `docs/perf/PERF-TEMPLATE.md` 为
`docs/perf/YYYY-MM-DD-danghao-run<N>.md`，环境记录、原始输出、逐轮明细、边界声明缺一不可——
只写「IS_PASS: YES」而无原始输出的结论不可审计。

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

---

## 九、每步失败怎么回滚

> 原则：**先判定「能不能修」，再决定「修还是退」**。
> 能修的问题不要回滚（回滚一次的成本远高于修一次）；
> 但**数据已被写坏**的情况下不要硬修，直接退到干净基线。
>
> 回滚粒度由小到大共 4 级，按需选用，**不要一上来就用最重的那级**：
>
> | 级别 | 动作 | 影响 | 耗时 |
> |---|---|---|---|
> | L1 | 重启单个服务 | 该服务中断，数据不动 | ~30s |
> | L2 | 重建单个镜像 | 该服务中断，数据不动 | 3–8 min（ES）/ 1–2 min（其它） |
> | L3 | 清空指定数据卷重来 | **该服务数据丢失** | 2–5 min |
> | L4 | 全清（`down -v` + 删 volumes） | **全部数据丢失** | 10–15 min |

### 9.1 逐步骤失败处置表

#### 步骤 1：`docker compose build`

| 失败现象 | 判定 | 回滚/处置 | 级别 |
|---|---|---|---|
| `failed to connect to dockerDesktopLinuxEngine` | 引擎未起，不是构建问题 | 打开 Docker Desktop 等 Engine running，无需回滚 | — |
| IK 构建 `plugin install` 失败 / 下载 404 | 网络或版本号错 | 走 §3.2 路径 A（放离线 zip 到 `infra/elasticsearch/ik/`）后重建 | L2（仅 elasticsearch） |
| `COPY ik/ ... not found` | build context 缺目录 | 确认 `infra/elasticsearch/ik/.gitkeep` 存在 | — |
| `no space left on device` | 磁盘满 | `docker system prune -f` 清悬空镜像/构建缓存；**不要** `-a`（会删掉在用镜像） | — |
| `pnpm install` 阶段失败 | 依赖或 registry 问题 | 查构建日志的网络段；必要时在 Dockerfile 里换 registry | L2 |

> **构建失败不影响已运行的旧容器**（build 与 up 是两件事）。
> 若正在跑旧版本而新 build 失败，**旧版本继续可用**，可以从容排查，不必急着 down。

#### 步骤 2：`docker compose up -d`

| 失败现象 | 判定 | 回滚/处置 | 级别 |
|---|---|---|---|
| `port is already allocated` | 宿主机端口被占 | 改 `.env` 里 `*_EXPOSED_PORT` 后 `up -d`；**先 `docker compose down` 再 up**，否则旧容器仍占端口 | L1 |
| `minio-init` 退出码非 0 | 建桶失败 | 正常应为 `exited(0)`。非 0 时看 `docker compose logs minio-init`，多为 MinIO 还没 ready → 单独 `docker compose restart minio-init` | L1 |
| ES 反复重启 | 多为 `volumes/esdata` 权限 | 见 §1 的 chown 命令。**若 chown 无效**，说明 esdata 已损坏 → L3 清空重建 | L1 / L3 |
| api 一直 `unhealthy` | 依赖没全 healthy | `docker compose logs api` 看连不上哪个。**先等 ES（start_period 60s）**，别急着判死 | — |
| api 报 `JWT_ACCESS_SECRET` 长度不足 | 口令没改或太短 | 改 `.env`，`docker compose up -d api` 重建容器（env 变更需重建而非 restart） | L1 |
| 整体起不来且无明确错误 | 状态混乱 | `docker compose down`（**不带 -v**，数据保留）后重新 `up -d` | L1 |

> **关键区别**：`restart` 不重读 `.env`，`up -d` 才会。改环境变量后必须
> `docker compose up -d <service>`（compose 会检测到配置变化并重建容器）。

#### 步骤 3：`docker compose exec api pnpm migration:run`

| 失败现象 | 判定 | 回滚/处置 | 级别 |
|---|---|---|---|
| `relation "xxx" already exists` | 卷里有旧数据但 migration 表为空（如从中途导入） | 先 `SELECT * FROM migrations ORDER BY id;` 核对；**能补记录就补**，不要盲目清库 | — |
| 某条 migration 执行到一半失败 | 表结构已部分变更 | **不要直接重跑**。先 `SELECT * FROM migrations` 看失败那条是否已登记。未登记但结构已改 → 手工把结构改回去（或从 §10A 的备份恢复），再重跑 | L3（最坏） |
| `permission denied for schema public` | DB 用户权限 | `ALTER SCHEMA public OWNER TO tianji;` | — |
| 连接超时 | PG 未 ready | `docker compose exec postgres pg_isready`，等 healthy 再跑 | — |

> **回滚单个 migration 的唯一安全方式是从备份恢复**，因为 TypeORM 的 `down()`
> 在本项目中只对少数 migration 实现了完整逆操作。生产上不要指望 `migration:revert`。
>
> 迁移前务必先备份（§10A 的 C 节有命令）：
> ```bash
> docker compose exec postgres pg_dump -U tianji -Fc tianji_archive \
>   > volumes/backup/pre-migrate-$(date +%Y%m%d-%H%M).dump
> ```

#### 步骤 4：`docker compose exec api pnpm seed`

| 失败现象 | 判定 | 回滚/处置 | 级别 |
|---|---|---|---|
| `duplicate key value violates unique constraint` | 已跑过 seed（非幂等） | **正常现象，说明数据已在**。用 §5.1 的查询确认有数据即可，不必重跑 | — |
| 找不到全宗 → 后续压测失败 | seed 没跑或跑失败 | 补跑；若报冲突说明部分成功，先清 `fonds` 相关表再跑 | L3（谨慎） |
| seed 跑到一半失败 | 数据半成品 | **这是最麻烦的状态**：部分表有数据、部分没有。正确做法是 `docker compose down` + 清 `volumes/postgres` + 重新 migration + seed（L4 的 DB 部分） | L3 |

> **seed 非幂等**是已知设计——它假设空库。因此**不要在已有业务数据的库上重跑 seed**，
> 会污染真实数据。要重置演示数据，走 L3。

#### 步骤 5：IK 验证（`_analyze`）

| 失败现象 | 判定 | 回滚/处置 | 级别 |
|---|---|---|---|
| `analyzer [ik_max_word] not found` | IK 未装上 | `docker compose build --no-cache elasticsearch` 重建 | L2 |
| `_analyze` 返回单字切分（「天」「玑」分开） | IK 装了但词典没生效 | 检查 `custom_dict.dic` 是否挂载/打进镜像；重启 ES 让词典重载 | L1 |
| `_analyze` 返回整串不切 | 用了 `standard` 分析器 | 检查 mapping 是否写了 `analyzer: ik_max_word` | — |
| ES 返回 503 | 尚未 ready | 等 `_cluster/health` 变 green/yellow 再试 | — |

> **IK 是功能性问题，不是数据问题**：装不上不影响已有数据，可以先用
> `standard` 分析器跑通全流程，事后再补 IK。检索质量会差，但系统可用。

#### 步骤 6：`perf:danghao`

| 失败现象 | 判定 | 回滚/处置 | 级别 |
|---|---|---|---|
| `数据库中没有全宗，请先执行 seed` | 前置缺失 | 补跑 seed，**不需要回滚任何东西** | — |
| `IS_PASS: NO` + 有重号 | 序列实现缺陷 | **不是环境问题，是代码问题**。按 §5.4 排查；`perf_danghao_probe` 已被 finally 的 DROP 清掉，需要证据就改脚本保留表 | — |
| `IS_PASS: NO` + 有取号失败 | 锁竞争/超时 | 看 `✖ 取号失败` 的具体异常；多为 `CONCURRENCY` 过高超过 PG `max_connections` | — |
| 连接数耗尽 `too many clients` | PG 连接池上限 | 降 `CONCURRENCY`；或调高 PG `max_connections`（需重建 postgres 容器） | L1 |
| 脚本中途崩溃 | 见 stderr | 脚本 `finally` 会尝试 DROP 探针表并 destroy 数据源；若没跑完，手工 `DROP TABLE IF EXISTS perf_danghao_probe;` | — |

> **压测失败不需要回滚环境**——它是只读+独立探针表的测试，不碰业务数据
> （唯一写入是 `perf_danghao_probe`，脚本自己会清）。
> 唯一副作用是 `danghao_sequence.next_value` 被真实推进了，
> 若要让档号从头开始，需手工 `UPDATE danghao_sequence SET next_value = 1;`
> ——**仅在测试环境这么做，生产环境绝不允许档号回退**。

### 9.2 完整重置（从零开始）

适用于：状态已不可信、或要交付一个干净环境给下一个人。

```bash
cd /e/TianjiArchive

# 1) 先备份（如果数据有任何保留价值）
docker compose exec postgres pg_dump -U tianji -Fc tianji_archive \
  > volumes/backup/before-reset-$(date +%Y%m%d-%H%M).dump

# 2) 停容器（-v 会删 named volume，本项目用 host mount 所以主要靠第 3 步）
docker compose down

# 3) 清数据卷（这步不可逆）
rm -rf volumes/{postgres,wal_archive,esdata,minio,redis}
mkdir -p volumes/{postgres,wal_archive,esdata,minio,redis,backup}

# 4) 重建并启动
docker compose up -d

# 5) 重跑迁移与种子
docker compose exec api pnpm migration:run
docker compose exec api pnpm seed

# 6) 冒烟
curl -s http://localhost:3000/api/health | jq
```

> **备份目录 `volumes/backup` 不要删**——第 3 步刻意没包含它，就是留给备份的。

### 9.3 回滚决策速查

```
出问题
  │
  ├─ 错误信息明确指向某个服务？──是──→ 该服务 L1 restart，不行再 L2 rebuild
  │
  ├─ 数据可能已被写坏？（迁移半途/seed 半途）──是──→ 从备份恢复，或 L3 清该卷
  │     └─ 没有备份？──→ 先尝试只清受影响表；不行再 L4
  │
  ├─ 只是配置问题（端口/口令/变量）？──是──→ 改 .env + up -d（不是 restart）
  │
  └─ 状态完全不可信 ──→ L4 完整重置
```

**三个反模式（不要做）**：

1. **`docker compose restart` 期待环境变量生效** —— 不会生效，必须 `up -d`
2. **`docker compose down -v` 后才发现没备份** —— `-v` 不可逆，先备份再动
3. **在已有业务数据的库上重跑 seed** —— seed 非幂等，会污染真实数据

---
