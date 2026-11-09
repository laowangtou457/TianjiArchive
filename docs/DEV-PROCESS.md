# 天玑档案管理系统 · 完整开发过程记录

> **文档性质**：项目全周期工程纪实（需求 → 设计 → 实现 → 测试 → 联调 → 交付）
> **记录范围**：自需求确认至 2026-11-07 联调收官前，含全部决策、缺陷、方法学沉淀与实证数据
> **与其他文档的关系**：本文是**索引与史记**；需求权威源为 `PRD.md`，设计权威源为 `ARCHITECTURE.md`，测试结论权威源为 `QA-REPORT.md`，测试规范权威源为 `TESTING-GUIDELINES.md`，验收清单为 `DELIVERY-CHECKLIST.md`，部署手册为 `DEPLOY.md`。本文不复述其细节，只记录**为什么这样做、发生了什么、留下了什么教训**。
> **命名说明**：为规避侵权风险，系统正式定名「天玑档案管理系统」，交付物中不使用任何参考系统原名；更名完整性核验见 `DELIVERY-CHECKLIST.md §2`。

---

## 一、项目缘起与需求确认

### 1.1 用户原始诉求

用户最初咨询能否本地复刻某商业档案管理系统，随后确认 5 条需求并追加 1 条架构要求：

| # | 需求 | 落地情况 |
|---|---|---|
| 1 | 单位内部实际使用 | P0/P1 功能按真实档案业务流程设计，非演示原型 |
| 2 | 局域网多用户 + 权限分级 | 五级角色 × 数据范围 × 密级 × 操作类型四要素模型 |
| 3 | 范围按主理人划分的 P0（14 项）/ P1（7 项）执行 | P0 全部实现，P1/P2 列入后续迭代 |
| 4 | 兼容档案局标准（DA/T 22、DA/T 18 等） | 17 条标准合规矩阵，著录字段与档号格式对齐 |
| 5 | 无旧数据，后续导入约 100GB 档案数据测试 | 预留批量导入通道与 ES 全文索引容量规划 |
| 追加 | 上百人高并发、大数据量高效检索、后期 RAG / LLM Wiki 架构预留 | 双引擎检索、连接池与行锁设计、`/api/kb/*` 接口预留、`EmbeddingProvider`/`VectorStore` 抽象 |

### 1.2 三项关键前置决策

1. **更名规避侵权**：正式定名「天玑档案管理系统」。更名做了 9 类形态的零残留核验（含 PostgreSQL 用户名、MinIO alias、localStorage key、默认口令 `Tianji@2024`、文档与注释）。
2. **本机 Docker**：用户无多余机器，在本机安装 Docker Desktop Windows 版运行全部服务。
3. **授权**：用户明确「后续所有决策都交由你全权负责」，主理人承担全部技术裁定。

---

## 二、组织与工作流

采用软件开发团队 SOP，团队 `software-titan-archive`（团队名为历史沿用标识），四角色顺序流转、产出经主理人中转：

| 角色 | 代号 | 职责 | 主要产出 |
|---|---|---|---|
| 产品经理 | 许清楚 | 需求与验收标准 | `docs/PRD.md`（v1.3-FINAL·补 2，603 行，11 章，已封版） |
| 架构师 | 高见远 | 系统设计 + 任务分解 | `docs/ARCHITECTURE.md`、类图、时序图 |
| 工程师 | 寇豆码 | 代码实现与全局一致性审查 | pnpm monorepo 全部代码、Docker Compose、迁移与种子 |
| QA 工程师 | 严过关 | 独立验证与智能路由判定 | 21→24 个测试文件、430 条用例、`docs/QA-REPORT.md` |

**质量关卡**：工程师完成全部文件须过全局一致性审查（IS_PASS: YES/NO）；QA 每轮须做智能路由判定（源码 Bug → 工程师 / 测试代码 Bug → QA 自修 / 全绿 → NoOne）。

**协作铁律（过程中形成）**：
- 所有跨成员信息经主理人中转；专业产出不得由主理人代写。
- 事实性分歧靠互查收敛，判断性分歧由主理人拍板；默认「执行方出方案集与代价 → 主管裁定」。
- 任务完成先发一行短消息（「任务X完成，hash=Y」），详细报告随后，避免状态错开导致重复指令。

---

## 三、技术架构决策

| 层 | 选型 | 决策理由 |
|---|---|---|
| 仓库 | pnpm monorepo：`apps/web`、`apps/api`、`apps/extractor`、`apps/cli-migrator`、`packages/shared` | 前后端共享类型与常量，单一定义源 |
| 前端 | Vite + React 18 + MUI + Tailwind | 团队默认栈 |
| 后端 | NestJS (Node 22) + TypeORM | 模块化、DI 装配清晰；隔离方言便于后期迁达梦/人大金仓 |
| 主库 | PostgreSQL 16 | 行锁 `SELECT FOR UPDATE` 支撑档号零重号；复合索引承诺 P95<1s |
| 全文检索 | Elasticsearch 8 + IK 中文分词 | 百万级条目 + 100GB 电子文件抽取文本，P95<2s |
| 对象存储 | MinIO（S3 兼容） | 原设计；**2026-11-07 联调时发现官方归档停服，转为遗留项**，详见 §8.3 |
| 缓存/队列 | Redis + BullMQ | 权限缓存失效双通道、异步任务 |
| 部署 | Docker Compose 9 服务 | 局域网单机/双机部署 |

### 3.1 四个核心设计

1. **权限四要素模型**：角色（R0–R4 五级）× 数据范围（全宗/机构/本人）× 密级（公开/内部/秘密，可比数值）× 操作类型。服务端统一拦截，SQL / ES / KB 三处复用同一过滤器。未知密级一律 **fail-closed**（缺陷 #1 修复）。
2. **档号规则引擎**：模板化可配置，`danghao_sequence` 行锁 + 唯一约束防重号；档号入库不可改、只能作废重编留痕。
3. **参数化体系**：22 项业务参数（🔴8 / 🟡11 / ⚪3），`PARAM_DEFS` 为单一定义源，`effectiveMode` 三层生效分类（读取生效 / 存量失效 / 判定生效）驱动读取路径；跨参数约束 C-1~C-5 保存时校验，blocking 冲突整体不落库。
4. **权限缓存主动失效**（C-5）：版本号 `INCR perm_ver:{userId}` + pub/sub `perm:invalidate` 广播双通道，TTL 300s 仅兜底，多实例实证 skip 清零。

### 3.2 业务口径要点

- 借阅 BR-06-1~7：总借期 ≤90 天（以借出日为基准）、续借 1 次、单次续借 ≤30 天、逾期实时判定（不依赖 status）、续借免审批直接生效。
- D-1~D-7 存量生效口径：安全类立即生效（权限、水印/下载），数据保留类只对增量，会话超时的存量会话按签发时超时值走完（QD-1：会话存签发时 `timeoutMinutes`）。
- 🔴 8 项参数（借期 90 天、续借 1 次/30 天、日志 3 年、会话 30 分钟、水印、下载模式 approval、逾期提醒）需单位档案与保密部门确认。

---

## 四、阶段产出与文档体系

| 文档 | 内容 | 状态 |
|---|---|---|
| `docs/PRD.md` | 24 项需求池（P0 14 / P1 7 / P2 3）、22 项参数表、BR-06-1~7、PR-P1~P8、C-1~C-5、G-1+D-1~D-7、17 条标准合规矩阵 | 已封版，仅接受缺陷类修订 |
| `docs/ARCHITECTURE.md` | 架构决策、§4.3 参数权威清单、§8 权限缓存双通道、存量 key 迁移约定 | 定稿 |
| `docs/QA-REPORT.md` | 终判 PASS（限定范围）、缺陷累计、联调现场实录、终判升级评估框架 | 持续同步 |
| `docs/TESTING-GUIDELINES.md` | 测试规范 6 章 + §6.1 工具静默陷阱 6 条 + 附则 | 定稿 |
| `docs/DELIVERY-CHECKLIST.md` | 46 项核对 + §0 整改追踪 + §10A 升级影响清单 + 仓库完整性/构建上下文条目 | 持续同步 |
| `docs/DEPLOY.md` | 部署手册 8 节 + 第九章回滚（4 级粒度）+ 联调实战排障 3 条 | 持续同步 |
| `docs/perf/PERF-TEMPLATE.md` | 压测报告模板：七项判据、双轨 sha256 锚定、自检清单 | 定稿 |
| `docs/class-diagram.mermaid`、`docs/sequence-diagram.mermaid` | 类图与时序图 | 定稿 |
| `docs/perf/runs/*.log` | 压测原始输出落盘 | 见 §8.6 |

**版本控制**：`E:\TianjiArchive` 于项目早期 `git init` 建立基线 `902f114`；远端 `git@github.com:laowangtou457/TianjiArchive.git`（SSH 直连，用户本机密钥），`main` 为唯一推送分支。

---

## 五、质量体系与方法学沉淀

### 5.1 测试方法学（团队规范核心）

- **检索双词复核**：判定「死代码」前须用两种词形检索（曾因 grep 带括号精确词漏掉 `this.` 调用，误判 `resolveApproverLevel()` 无调用点，主理人紧急叫停删除指令）。
- **断言强度 L1–L5**：下限 = 防线被绕过的业务后果等级，合规红线 L4+。
- **变异测试**：红数须与防线守护用例数**精确匹配**；「变异 0 红排查顺序」：①断言对象是否在生产路径 → ②是否依附措辞 → ③强度。
- **每条用例必须能回答**：如果失败，唯一原因是什么。

### 5.2 「假绿」家族（本项目最重要的经验）

联调与测试过程中反复出现「指标全绿但结论无效」，逐一定性并沉淀为规范：

| 形态 | 实例 | 防线 |
|---|---|---|
| 替身不在生产路径 | 版本号 key 天然失配、mock 返回单层数组而真实 PG 返回双层（缺陷 #12） | 断言必须落在生产路径；探针实测真实返回结构 |
| 静默空转 | `gaps` 计算了但未纳入判据（跳号假通过）、`parseInt` NaN 被 `filter(Number.isFinite)` 吞掉 | 判据第 6 项 `totalGaps === 0`、第 7 项 `totalUnparsable === 0` **fail-closed** |
| 迁移空跑 | `*.js` 通配在 ts-node 下匹配 0 文件，CLI 报「No migrations are pending」而库内零业务表（缺陷 #10） | 静态迁移发现守卫 `756acb5`：发现集非空 + 排除断言姊妹守卫 |
| 反射元数据空转 | vitest/esbuild 不发射 `design:paramtypes`，装配审计扫描 0 注入点全绿 | 改用 ts-node 脚本 + 正向证据断言（扫描 N 模块 M 注入点非零） |
| 工具不喊疼 | 压测挂起 18 分钟无任何输出（缺陷 #11） | 轮级看门狗 `ROUND_WATCHDOG_MS` 默认 5 分钟，超时打印诊断并 exit 2 |
| 假警报 | 并发写文件中间态致 vitest 收集崩溃呈「几乎全红 + 用例数骤降」 | 辨识口诀：**用例数异常比红色本身更能说明问题** |

### 5.3 文档一致性方法学（§6.1 第五条）

「部分更新」事件（QA-REPORT 改了用例总数却漏改同表四行，418 ≠ 396+2）沉淀出 7 条子规则 + 导语 + 防膨胀元规则：

1. 全仓范围复核（`grep -rn "<旧值>" docs/`）；
2. 判别「当前状态描述」必须更新、「历史快照/验收证据」只能加注不能改；
3. 漏检概率排序：表格字段 > 表下注 > 正文叙事；
4. 「grep 到了却目视跳过」反例：**带算术关系的计数（分母/差值/百分比基数）优先级高于裸数字**；
5. 标题带时间锚的历史数据块可免加注；插入式排查是最高效的复核时机；
6. 邻行自洽检查 + 过桥句为首选解法；
7. 文档互证 = 同源污染，矛盾时先查第三方事实源；交叉引用「见 §X」必须真点一次。

**根因层**：「先有结论再找证据」——用 grep 印证已有认定而非证伪它。正确姿势是「假设还有残留、去找它」。

### 5.4 反思纪律（多次自我更正记录在案）

- 工程师先给结论后验证（`parseInt('0001A')` 误判为 NaN），实测证伪后主动更正；
- QA 变异恢复用 `git checkout --` 抹掉工程师未提交实现 → 规则：实现尽快提交（哪怕 WIP）、恢复用定向替换；
- Windows 写文件致行尾翻转 611 行 diff → 规则：提交前必看 `--numstat`，判定标准是**跟随原文件行尾**而非全仓统一 LF；
- 模型服务 500 致工程师会话三次中断；主理人在联调执行阶段直接接手基础设施级操作，保证进度不丢。

---

## 六、缺陷全记录（#1 – #14）

| # | 缺陷 | 严重度 | 根因 | 修复 | 发现阶段 |
|---|---|---|---|---|---|
| 1 | 未知密级 fail-open | 高·安全 | `SECURITY_LEVEL_RANK[level] ?? 0` 把未知密级当 PUBLIC 放行 | 改 fail-closed；连带修复 `access-filter.builder.ts` 空集合拼 `FALSE`/`match_none`、`kb.service.ts` 字符串插值改参数绑定 | QA 首轮 |
| 2 | SECRET 双级审批失效 | 高·合规 | `PENDING→PENDING` 被状态机拒绝 | 仅状态变化时才校验流转，不动权威流转表 | QA 首轮 |
| 3 | shared 构建脚本路径 Bug | 中·工程 | `build.cjs` 路径基准指向 scripts/ 子目录 | 重写为「只覆盖不删除」+ 产物自检 + 独立 clean.cjs；曾误判为环境污染后更正 | QA 首轮 |
| 4 | 并发续借绕过次数上限 | 中·一致性 | 锁外读锁外写 | `pessimistic_write` 行锁；R6 同类 5 处（approve/cancel/lend/giveBack/voidAndReassign）同法修复 | QA 二轮 |
| 5 | 单次续借上限未实现 | 中·业务 | 缺 `max_renewal_days` 校验，续 31 天被放行 | 实现校验 + 4 条回归护栏 | QA 三轮 |
| 6 | AccessModule 未入模块树 | 高·可用性 | `@Global()` 模块从未被 import 进根模块树 → `AccessFilterBuilder` 全局 DI 失效，**容器启动即崩** | `app.module.ts` 加入 import；新增「模块树图守卫」+ 装配冒烟用例（双向变异验证） | **联调现场** |
| 7 | BackupModule 未 import ParamModule | 高·可用性 | 同家族；且暴露 `.gitignore` 无锚点炸弹（`modules/backup/`、`infra/backup/` 自建库从未入库，干净克隆编译不过） | 全量 DI 装配审计（26 模块 / 101 注入点，findings 恰 1 条）；锚定 4 个 gitignore 模式并补录 6 文件；审计脚本入 `ci:check` 三环链 | **联调现场** |
| 8 | 运行层缺 `tsconfig.base.json` | 部署缺陷 | `apps/api/tsconfig.json` 相对继承 `../../tsconfig.base.json`，运行层未拷 → 迁移/seed/压测报 TS5083 | Dockerfile 补拷（`1bada72`） | **联调现场** |
| 9 | `data-source` 双导出 | 代码缺陷 | named + default 双导出，TypeORM CLI 报「only one export of DataSource instance」 | 移除 default（3 个消费方均 named import，零影响，`65760bf`） | **联调现场** |
| 10 | 迁移通配静默空跑 | 代码缺陷 | 以「migrations 目录存在」判定取 `*.js`，ts-node 下匹配 0 文件；收窄后 `seed-data.ts` 又被误纳报 migration name is wrong | `4d44a20` 改按 `__dirname` 是否处于 dist 判定；`1f7b5be` 通配收窄 `[0-9]*`；静态守卫 `756acb5` | **联调现场** |
| 11 | 压测自死锁 | 高·可用性 | 事务持一条池连接后，`resolveRule` 经全局 repository 申请第二条；并发 200 > 池 20 → 全体互等（PG 指纹：20 会话 `idle in transaction` / `ClientRead` / `START TRANSACTION`）。**生产著录路径同隐患** | `a1a0db7`：规则/机构读取全部改经事务 manager 单连接化 + 轮级看门狗 + 6 条防回归（QA 变异：摘 manager 参数恰好红 1 条） | **联调现场** |
| 12 | UPDATE RETURNING 双层返回致取号全失败 | 阻断·生产路径 | `manager.query()` 对 `UPDATE ... RETURNING` 返回 `[rowsArray, rowCount]`，`sequence.service.ts` 当单层数组取 `rows[0].next_value` → NaN → 「档号序列取值异常」；430 条单测全绿因 mock 返回单层（替身形态与生产路径不一致） | `eb44173`：新增 `extractQueryRows<T>(raw)` 归一化双层/单层两种返回形态，`nextInTransaction()` / `reserve()` 共用；`reserve()` 零行改抛 `NO_LOCKED` 不再静默回落 1；防回归改用真实双层 mock（另含单层兼容、零行、peek 单层），基线 430→436 | **联调现场** |
| 13 | 压测夹具漏传目录号 | 中·测试夹具 | seed 档号规则首段为 `CATALOG`，`renderDanghao` strict 模式要求非空；压测脚本未传 `catalogNo` → 2000 次全报「档号段「目录号」取值为空」 | `648540c`：从库中真实 `category.code` 取 `catalogNo` 传入 | **联调现场** |
| 14 | 压测未固定卷号致断号为负 | 中·测试夹具 | 未传 `volumeNo` 时各并发事务另起新卷、件号恒为 1，末段序号全相同，`gaps = max-min+1-count` 算出 -1；小并发 2×2 即暴露 | `648540c`：固定 `volumeNo: 1`，让 200 并发在同一卷内竞争件序列；先以 2×2 验证 `IS_PASS: YES` 再跑正式压测 | **联调现场** |

> **统计**：14 个缺陷中 **9 个（#6–#14）是联调/压测现场才发现的**（#6–#12 处于 430 条单测覆盖不到的装配层、部署层、真实驱动交互层；#13/#14 为压测夹具与生产档号规则不同步所致）。这是「单测全绿 ≠ 系统能跑」最有力的一组实证，也是本次坚持做真实环境联调的核心价值。

---

## 七、联调全过程实录（2026-11-07）

### 7.1 环境准备与三次构建阻断

1. **Docker Desktop**：用户手动双击启动（沙箱黑名单拦截 `wsl.exe`，需人工完成 WSL2 初始化），截图确认 `Engine running`（Engine 29.9.2 / Compose v5.6.1）。
2. **Git Bash PATH**：`docker` 与 `docker-credential-desktop.exe` 均不在 PATH → 前置 `export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"`，否则 build 报 `exec: "docker-credential-desktop": not found`。凭证 helper 输出含账号标识，禁止进入任何日志/报告。
3. **Docker Hub 502 抖动**：`auth.docker.io/token` 返回 Bad Gateway；对照实验证明凭证有效（`docker pull node:22-bookworm-slim` 成功）→ 预拉全部基础镜像命中本地层绕开。
4. **三个外部源实测全通**：Docker Hub、`docker.elastic.co`（ES 8.13.4）、`get.infini.cloud`（IK zip，HTTP 200）。

### 7.2 MinIO 官方归档停服（外部变更，非缺陷）

| 探测 | 结果 |
|---|---|
| Docker Hub `minio/minio`（固定 tag 与 latest）、`minio/mc` | `repository does not exist`（仓库级消失） |
| `bitnami/minio` | not found |
| `quay.io/minio/minio` | 401 需认证 |
| DaoCloud 镜像缓存 | 站点本身通（busybox 成功），minio 上游已删 → `denied` |
| `dl.min.io` 二进制下载 | **HTTP 410 Gone + 官方归档声明**（开源版 Server/Client/KES 停服、不再提供安全更新） |

**处置**：新增 `docker-compose.nominio.override.yml`（`profiles: ["disabled"]` 禁用 minio/minio-init + `!reset null` 摘除 api/extractor/backup 三处 `depends_on`），**主 compose 零改动**，`compose config` 展开校验通过。连带发现 `infra/backup/Dockerfile` 硬编码 `dl.min.io` 下载 `mc` 必然 410 → 全量 build 阻断，立为交付缺陷。精确构建 `api` / `web` / `elasticsearch` 三镜像。

**遗留**：MinIO 归档影响生产对象存储选型（工程师方案集推荐 SeaweedFS，待拍板）；本次联调不覆盖文件入库/下载/四性检测真实链路。

### 7.3 镜像构建与 `.dockerignore` 根因

- ES/IK 镜像**构建成功**（IK 插件走 `get.infini.cloud` 安装通过）。
- api 镜像报 `Cannot find module .../@nestjs/cli/bin/nest.js`，但探针证明镜像内依赖完好 → `--no-cache` 复现**证伪缓存污染假设**。真根因：**仓库无 `.dockerignore`**，宿主 Windows 版 `node_modules`（符号链接指向 `/e/TianjiArchive/...`）整体进入构建上下文，在 `COPY apps/api apps/api` 时覆盖容器内 Linux 版依赖 → 链接全失效。修复 `b26ab71`，api 镜像构建成功。

### 7.4 起栈、迁移、种子、分词、健康（实测数据）

| 步骤 | 结果 |
|---|---|
| 起栈 | api / web / elasticsearch / postgres / redis 五服务全部 healthy（extractor / backup / minio 按裁定不启动） |
| `migration:run` | **5/5 迁移成功**（InitSchema、AddParamMetaColumns、MigrateParamKeys、SeedBaseline、AddBorrowDate）；过程中修复缺陷 #8/#9/#10 |
| `seed` | 成功；档号模板行实输 `[目录号]-[年度(4)]-[保管期限]-[卷号(4)]-[件号(4)]`（`44b9fd7` 人眼证据成立）；`system_param` 写入无列名报错（`a58d1bc` 成立）；管理员 admin / 示例全宗 WS / 示例机构「综合处」 |
| IK 分词 | `_analyze` 实测通过：「中华人民共和国档案管理系统」正确切分为 中华人民共和国 / 中华人民 / 中华 / 华人 / 人民共和国 / … / 档案管理 |
| `health` | `postgres` ✅ `elasticsearch` ✅ `redis` ✅ `minio` ❌（预期，status=degraded，如实记录不掩盖） |
| 双轨锚定 | 容器内源码 sha256 = 宿主 HEAD（镜像新鲜度证实）；压测经 `ts-node` 直接执行 TS 源码，**source 锚才是执行体**，容器内 `dist` 锚为**防御锚**（证镜像内编译产物与源码同源，非本次执行体）；两层锚定强度不同，报告按「判据层 / 被测服务层」分开表述。`4f0a69e` 已把终跑实测锚定值回填 `PERF-TEMPLATE.md` §1.4 并修正旧措辞 |

### 7.5 压测判据（七项 · fail-closed）

`evaluatePass(stats)` 判据演进：五项 → 六项（纳入 `totalGaps === 0`，修「跳号假通过」）→ **七项**（纳入 `totalUnparsable === 0`，修序号解析 NaN 被静默过滤导致第 6 项空转）。第 7 项输出排在第 6 项之前，避免「断号 0」被误读成好消息。序号提取抽为三个零依赖纯函数（`extractSequenceNumber` / `extractSequenceNumbers` / `computeRoundGaps`），实测边界含 `0042A → 42`（`parseInt` 前缀解析，非 NaN）、`1-2024-A → null`。19 条回归 + 双向变异验证闭环。

### 7.6 压测运行记录

| 轮次 | 结果 |
|---|---|
| 首跑 200×10 | **挂起 18 分钟**，日志停在启动横幅；PG 指纹定位缺陷 #11（客户端自死锁，非行锁等待）；进程 SIGTERM 终止后 20 个 idle 事务归零 |
| 修复后重跑 200×10 | 6 秒返回 `IS_PASS: NO`：2000 次取号全失败「档号序列取值异常」；判据正确报警（零重号/零断号/解析失败 0 全部如实，拒绝 2000、落库 0 被判负） |
| 单并发复现 1×2 | **同样失败** → 确认与并发无关的确定性缺陷 #12 |
| 探针定位 #12 | `manager.query('UPDATE ... RETURNING')` → `[[{"next_value":"1"}],1]` 双层；SELECT → `[{"y":2}]` 单层；`rows[0].next_value` 为 undefined → NaN |
| `eb44173` 修复后重跑 200×10 | 取号本身恢复，但 2000 次全报「档号段「目录号」取值为空」→ 定位缺陷 #13（夹具漏传 `catalogNo`） |
| 小并发 2×2 验证 | 暴露「断号 -1」→ 定位缺陷 #14（未固定卷号）；修正夹具后 `IS_PASS: YES` |
| **终跑 200×10**（`danghao-200x10-PASS-20261107-173726.log`） | **全绿**：每轮成功 200/200，10 轮共 2000 次取号，落库 2000 / 去重 2000，重号 0 / 断号 0 / 解析失败 0 / 拒绝 0，单轮 383~735ms，`IS_PASS: YES` |

> **重要**：压测报告的价值在首跑与二跑都得到体现——工具没有假装通过。第 6/7 项判据、轮级看门狗、fail-closed 判 NO 三次都按设计生效。

> **证据可得性补录（收尾发现）**：四份现场日志曾被 `.gitignore` 第 41 行全局 `*.log` 吞掉，而本文与 QA-REPORT 均引用它们——与缺陷 #7 的「gitignore 无锚点炸弹」同属「文档写了、仓库里没有」。`833802e` 为 `docs/perf/runs/*.log` 开白名单并补录四份日志（348K / 4134 行（`wc -l` 实测；`git commit` 报 4139 insertions 含 `.gitignore` 新增 5 行），LF 行尾，扫描确认无口令/密钥/令牌）；`git ls-tree -r --name-only HEAD docs/perf/runs/` 实证干净克隆可取。该条按仓库完整性问题处置，不占用源码缺陷编号。

---

## 八、版本控制、推送与当前状态

### 8.1 提交链（节选关键节点；完整笔数与后续增量以 `git log` 为准）

```
902f114  chore: 建立 git 基线（天玑档案管理系统 v1.0.0）
8166c47  test: 启封多实例 C-5 用例（skip 清零）
f67a60f  fix(perf): 断号 gaps 纳入 IS_PASS 判据
b62bd1f  refactor(perf): 判据提取为纯函数 evaluatePass
c6eb7f3  test: 判据回归 9 条（399→408）
27b6910  fix(perf): 序号解析失败纳入第 7 项（408→417）
e775252  test: 「解析失败+真跳号共存」用例（→418）
a58d1bc  fix(seed): system_param 列名错误
44b9fd7  fix(seed): 档号段注释与日志
54955f4…fc54f34…7d31636…  文档一致性 / 规范 §6.1 七条子规则 / 附则
b26ab71  fix(docker): 补 .dockerignore
3e6c5a6  chore(docker): nominio override
a637a56  docs(deploy): 联调实战排障三条
4118d48  fix(api): AccessModule 入模块树（#6）
3e99257  fix(api): 全量 DI 装配审计入 CI（#7）
784db23 / 42daa28  chore(git): 修正 gitignore 无锚点炸弹
1bada72 / 65760bf / 4d44a20 / 1f7b5be  联调现场 #8/#9/#10
756acb5  test(api): 迁移发现守卫
6d6fed4 / 7fa6cbb / 8955814 / fa3eb04  基线 421/424 同步 + 联调报告
3e733e8  docs: 基线 421→424 + §七缺陷
a1a0db7  fix(api): 压测自死锁 #11（424→430）
1108670 / 5ff5304  docs: 基线 430 同步
301e6c0  docs: 新增完整开发过程记录 DEV-PROCESS.md
eb44173  fix(api): #12 双层返回归一化（430→436）
16504f9  docs(perf): 并发 > 池上限的判读说明
1b1ebe8  docs(delivery): 基线 430→436 同步
648540c  fix(perf): 压测夹具 #13/#14，终跑 200×10 全绿
833802e  fix(repo): 压测现场日志白名单补录
57c8a7a  docs(dev-process): 缺陷全记录 #1–#14 同步
8c1d803  docs(qa): 终判复核裁定 PASS（限定范围）
4f0a69e  docs(perf): PERF-TEMPLATE §1.4 回填实测锚定值
861199e  docs(qa-report): 同步模板回填口径 + 清理三处联调前过时表述
f111a7c  docs: 全仓最终对齐（终判 PASS（限定范围）、双锚防御锚、日志 4134 行）
3bbfdd5  docs(seaweedfs): 实测更正 volume 预分配口径并补录双端点裁定
63f4d69  docs: 样品 demo 验收清单 v1.1（D-1~D-5 裁定下载口径）
377a593  test(qa): 阶段一 P0 文件链路独立验证方案与 fail-closed 脚本
```

> **归属说明（主理人裁定）**：`377a593` 因并发暂存竞态同时带入了 PM 的 `docs/DEMO-ACCEPTANCE.md` v1.2（19 行变更，内容完整、未被改写）。裁定「选 A：保留现状、不 reset」——不动 HEAD、不撤回他人已入库产出，风险远低于修正归属的收益。QA 阶段一的 5 个文件与该文档同批入库，PM 不再重复提交。
> **阶段起点**：自 `3bbfdd5` 起进入「样品 demo / 封闭环境试用」阶段。用户拍板对象存储选型为 **SeaweedFS 方案 A**；8 项高敏参数暂走默认值（由用户与保密部门后续确认）；真实书籍样本后续提供，当前先在模拟环境用模拟书籍样本验证功能；保密相关修改留待封闭试用之后。

### 8.2 推送

`main` 已推送至 `git@github.com:laowangtou457/TianjiArchive.git`（SSH 直连，`Hi laowangtou457! You've successfully authenticated`）。用户先给定 `TianJi`，后更正为 `TianjiArchive`，以更正后为准。收尾推送：`301e6c0..648540c`（4 笔联调修复与文档）、`648540c..833802e`（压测日志补录）、`833802e..861199e`（DEV-PROCESS 同步 + QA 终判复核 + 模板回填与口径清理）。最终全仓对齐提交后 `origin/main..HEAD` 为空，工作区 clean。样品 demo 阶段续推 `63f4d69..377a593  main -> main`（SSH），推送后 `origin/main == HEAD == 377a593`；工作区仅余工程师 SeaweedFS 方案 A 在途改动（未入库）。

### 8.3 终判与升级条件

**当前终判：PASS（限定范围）** —— 2026-11-07 QA 独立复核后由 `PASS_WITH_RISKS` 升级，裁定见 `docs/QA-REPORT.md` §六（commit `8c1d803`）。签字范围在原有业务逻辑、权限模型、状态机、档号引擎、完整性校验、审批并发安全、参数化体系、权限撤权机制（单实例）、更名完整性之上，扩展至**真实 PG 行锁下 200×10 并发发号、ES 容器与 IK 分词、Redis 单机运行时、容器装配层、迁移与 seed 链路**；依据为 436 个通过用例 + 107 项参数行为断言 + CI 静态门禁 + 七项判据全绿的终跑压测日志。

**升级 PASS 的三项必要条件（QA 逐项复核，全部满足）**：
1. 压测原始数据落盘 + 七项判据全绿 + 双轨锚定 —— 满足（QA 以日志统计量实跑 `evaluatePass` 返回 `pass:true`；第 7 项先于第 6 项输出、NaN 逐条计数不静默过滤；`4f0a69e` 已回填实测锚定值并澄清 dist 为防御锚）；
2. 迁移/seed/IK 证据链闭合 —— 满足（静态证据与通报记录交叉一致；IK/health/迁移执行态 QA 未独立重跑，已如实标注复核深度，不作为压测结论唯一支点）；
3. 联调现场缺陷全部有关闭证据 —— 满足（#1–#14 修复 commit + 防回归 + 关键变异验证；436/24/0 全量复跑通过）。

**签字范围外（如实保留，非被忽略风险）**：
- 对象存储文件链路：原 MinIO 官方归档停服后由用户拍板改用 **SeaweedFS 方案 A**；当前处于样品 demo 阶段，QA 阶段二（`--suite core`）尚未放行，故文件链路**仍不可签**（后续由 QA 按方案 §8 三档独立裁定是否「A 部分解除」R1）；
- 多容器 pub/sub 跨进程（`--scale api=2` 未跑，同进程双实例已实证）。

### 8.4 后续迭代

- P1：编研 / 报表设计器 / 移交接收；P2：RAG / LLM 智能问答。
- 100GB 存量迁移前需用户提供约 1000 条样本；真实书籍样本由用户后续提供，当前 `demo:books` 使用确定性生成的模拟数据。
- 8 项 🔴 参数需单位档案与保密部门确认（用户已明确由其本人与保密部门确认；样品 demo 阶段暂走默认值）。
- 上线前闭环项 L2：`approval` 下载审批授权写入链路未实现，业务口径待确认；本轮不修、不绕过，演示结论固定表述「下载放行链路未演示」。

---

## 附录 A：关键命令形态（联调复用）

```bash
# Git Bash 必须前置 PATH
export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"
cd /e/TianjiArchive
DC="docker compose -f docker-compose.yml -f docker-compose.nominio.override.yml"

$DC build api web elasticsearch          # 精确构建，绕开 backup 的 dl.min.io 410
$DC up -d --build api web elasticsearch postgres redis
$DC exec api pnpm migration:run
$DC exec api pnpm seed
curl -s -X POST 'http://localhost:9200/_analyze' -H 'Content-Type: application/json' \
  -d '{"analyzer":"ik_max_word","text":"中华人民共和国档案管理系统"}'
curl -s http://localhost:3000/api/health
$DC exec -e CONCURRENCY=200 -e ROUNDS=10 api pnpm perf:danghao
```

## 附录 B：环境与路径

| 项 | 值 |
|---|---|
| 工程根 | `E:\TianjiArchive` |
| 远端 | `git@github.com:laowangtou457/TianjiArchive.git`（branch `main`） |
| Docker | Engine 29.9.2 / Compose v5.6.1；CLI 绝对路径 `/c/Program Files/Docker/Docker/resources/bin/docker.exe` |
| 服务端口 | api 3000、web 8080、ES 9200、PG 5432、Redis 6379 |
| 临时覆盖 | `docker-compose.nominio.override.yml`（联调用，主 compose 未改） |
| 压测日志 | `docs/perf/runs/danghao-200x10-*.log`（4 份已入库，`833802e` 白名单；含终跑全绿日志 `danghao-200x10-PASS-20261107-173726.log`） |
| 工作区记忆 | `C:\Users\...\WorkBuddy\2026-11-07-09-07-12\.workbuddy\memory\2026-11-07.md` |

---

**记录原则**：本文只写有证据的事实。所有「实测」结论均来自命令输出或容器探针；未验证的推断一律标注为假设或不写入。缺陷描述保留当时的误判与更正过程，因为**过程比结论更能防止后人重蹈覆辙**。
