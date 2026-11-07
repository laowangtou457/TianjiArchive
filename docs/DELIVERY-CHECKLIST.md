# 交付核对清单（工程师视角）

> 系统：天玑档案管理系统（本地复刻）
> 工程根：`E:\TianjiArchive`
> 本文档由工程师维护，供 team-lead 与 QA 逐条核对。**每条都给出可复现的验证命令或代码位置**。
>
> 文档分两部分：
> - **第一部分（§0）**：整改项逐项追踪表 —— 对照「最初 8 项整改」+「后续追加项」逐条标明状态与证据位置。
> - **第二部分（§1–§12）**：按技术域组织的核对明细。

---

## §0 整改项逐项追踪表

> 状态图例：`✅ 完成` / `✅ 完成（有边界说明）` / `⚪ 不适用（已改判）`

### 0.1 最初 8 项整改

| # | 整改项 | 状态 | 证据位置 | 备注 |
|---|---|---|---|---|
| R1 | `renew()` 并发缺陷 | ✅ | `borrow.service.ts` `renew()`：`withOrderLock` + 锁内重读 + CAS(`renewCount`/`status`) | 见 §4 #22 |
| R2 | `approve()` 并发缺陷 | ✅ | `borrow.service.ts` `approve()`：三道闸门 + CAS(`status`/`currentLevel`) | 见 §4 #23、闸门表 |
| R3 | `cancel()` 并发缺陷 | ✅ | `borrow.service.ts` `cancel()`：`withOrderLock` + CAS | 见 §4 #24 |
| R4 | `lend()` 并发缺陷 | ✅ | `borrow.service.ts` `lend()`：`withOrderLock` + CAS；`borrowDate` 用**本地时区**写当日 | 见 §4 #25 |
| R5 | `giveBack()` 并发缺陷 | ✅ | `borrow.service.ts` `giveBack()`：`withOrderLock` + CAS | 见 §4 #26 |
| R6 | `voidAndReassign()` 取号原子性 | ✅ | `archive.service.ts` `voidAndReassign()`：`withItemLock` + 取号原子 | 见 §4 #27 |
| R7 | `confirmVolume()` / `submitItem()` 并发 | ✅ | `archive.service.ts`：`withItemLock` + CAS | 见 §4 #28–29 |
| R8 | `scanOverdue()` 幂等 | ✅ | `borrow.service.ts` `scanOverdue()`：只更新仍为 LENT 的行 | 见 §4 #30 |

> 除上述 8 项外，`isOverdueOrder()` 的 D-1 结构性保证（只比对 `expectReturn`，完全不读参数）也一并落地，见 §6。

### 0.2 后续追加项（按提出顺序）

| # | 追加项 | 提出方 | 状态 | 证据位置 |
|---|---|---|---|---|
| A1 | `borrow.max_renewal_days` 单次续借上限（QA 缺陷 #5） | QA | ✅ | `borrow.service.ts` `renew()` 单次上限校验 + 可审计 KV 日志；实测 4/4 断言 |
| A2 | `borrowDate` 字段（BR-06-3 校验基准日） | QA/PM | ✅ | `borrow-order.entity.ts`；`lend()` 写入用本地时区；14 条用例通过 |
| A3 | BR-06-6「续借需审批」 | PM 提出 → **改判取消** | ⚪ | 现实现=直接生效且留痕，即改判后的正确行为；接口保留「校验—生效」两段式扩展位 |
| A4 | `PARAM_DEFS` 单一源 + 旧 key 迁移 | 架构 | ✅ | `params.ts` 22 项；migration `1700000000004-MigrateParamKeys`（11 个旧 key） |
| A5 | QD-1 会话超时按签发值固化 | 架构（第 12 条） | ✅ | `auth.service.ts` `issueTokens()` 写 `timeoutMinutes` 入 Redis；见 §5 |
| A6 | 第 13 条：`effectiveMode` 一等公民字段 | 架构 | ✅ | `params.ts` `ParamEffectiveMode` + `EFFECTIVE_MODE_ALLOWED_GROUPS` + `assertParamDefs()`；见 §3 |
| A7 | E 包：权限缓存版本号 + pub/sub 双通道 | PM/team-lead | ✅ | `user.service.ts` `invalidateSnapshot()`；见 §7 |
| A8 | E 包追加：禁裸 `redis.del` 作唯一路径 | team-lead | ✅ | `redis.del` 仅注释为「只清理，不承担生效职责」；`INCR` + `publish` 承担生效 |
| A9 | E 包追加：清 `user.service.ts`「5 分钟内生效」过时注释 | team-lead | ✅ | grep 零命中 |
| A10 | E 包追加：`PERMISSION_MUTATIONS` 迁入 shared + CI 静态自检 | team-lead | ✅ | `packages/shared/src/permission-mutations.ts`（8 条 + 1 排除）；`scripts/ci-check-permission-mutations.cjs` |
| A11 | E 包追加：`borrow.service.ts` 自审拦截**不**补 invalidate | team-lead | ✅ | 内联 `applicantId === user.userId`，代码注释留痕；CI 脚本 R3 反向自证 |
| A12 | D 包：区间 + 跨参数校验层 C-1~C-5 | 架构 | ✅ | `params.ts` `validateCrossParams()`；3 个接入点；见 §8 |
| A13 | `backup.keep_copies` 接入 | 架构 | ✅ | `backup.service.ts` `pruneOldCopies()`，挂 `runLightweight()` |
| A14 | 参数生效验证脚本 | team-lead | ✅ | `apps/api/src/scripts/verify-params.ts`，**107/107 断言通过** |
| A15 | CI 静态自检脚本 | team-lead | ✅ | `scripts/ci-check-permission-mutations.cjs`，R1 正向 / R2 反向 / R3 自证 |
| A16 | `import.batch_max_rows` 消费方边界 | 工程师自查 | ✅ 完成（有边界说明） | `cli-migrator` `--batch-max-rows`；`PARAM_DEFS.consumer` 明写「属有意边界」 |
| A17 | **系统更名：泰坦 → 天玑（规避侵权）** | 用户直接下达 | ✅ | 目录迁移 `E:\TianjiArchive`；全仓 `titan`/`泰坦` **零残留**；9 类命名形态全覆盖；见 §2 |

### 0.3 明确未做 / 已改判（不留悬案）

| 项 | 结论 | 依据 |
|---|---|---|
| BR-06-6「续借需审批」 | **不实施** | PM 改判为「续借直接生效、不产生审批单，但必须留痕」；PRD v1.3-FINAL 已封版 |
| `resolveApproverLevel()` 删除 | **不删** | team-lead 澄清此前为误报；该函数是 `approve()` 闸门②的必要组成 |
| 静态自检「检查 grp 误配」 | **不采用**，改为分类驱动 | PM 论证：静态自检只是「能检查」不是「不能配错」；改用 `effectiveMode` 一等公民字段，使误配在结构上不可能 |
| `borrow.service.ts` 自审拦截补 invalidate | **不加** | PM 论证：补了会因撤管理员自己权限导致其看不到待审单；且该处不读权限快照 |
| `pessimistic_write` 行锁 | **不采用** | QA mock 的 manager 只有 `create/save/update`；且长事务放大死锁面。进程内互斥 + CAS 双层已足 |

---

## §1 构建与质量门禁

| # | 项 | 命令 | 期望 | 状态 |
|---|---|---|---|---|
| 1 | 依赖安装 | `pnpm install --frozen-lockfile` | Done，无 ERR | ✅ |
| 2 | 全量构建 | `pnpm run build` | shared(8 modules) + api/web/cli-migrator/extractor 全 Done | ✅ |
| 3 | 类型检查 | `pnpm run typecheck` | 4/4 Done，0 error | ✅ |
| 4 | 代码规范 | `pnpm run lint` | 0 error **0 warning**（`--max-warnings=0`） | ✅ |
| 5 | 单元/契约测试 | `pnpm run test` | 20 files / **396 passed + 2 skipped** | ✅ |
| 6 | CI 门禁聚合 | `pnpm run ci:check` | 静态自检 + lint 均通过，EXIT=0 | ✅ |

> 2 条 skipped 是既有用例（`user.permission-revoke-effect.spec.ts`），非本次引入。

---

## §2 更名（历史系统名 → 天玑）

> 本节描述"更名已完成"这件事本身，因此保留了旧名的形态说明。这是**有意的留痕**，
> 除此之外全仓不应再出现旧名。

| # | 项 | 命令 / 位置 | 期望 | 状态 |
|---|---|---|---|---|
| 7 | 目录更名 | `ls -d /e/TianjiArchive` | 存在；旧路径不存在 | ✅ |
| 8 | 残留清零 | `grep -rin` 旧名（排除 `node_modules` / `dist` / `.git` / 本文档） | **零命中** | ✅ |
| 9 | 包作用域 | 全部 `package.json` | 均为 `@tianji/*` | ✅ |
| 10 | workspace 链接 | `ls apps/api/node_modules/@tianji/shared` | 软链指向 `packages/shared` | ✅ |
| 11 | DB / MinIO 标识 | `docker-compose.yml` / `.env.example` / `infra/backup/backup.sh` | `tianji` / `tianji_archive` / `tianji_minio` | ✅ |
| 12 | 前端存储 key | `apps/web/src/api/client.ts`、`AppLayout.tsx` | `tianji.accessToken` / `.refreshToken` / `.sidebarCollapsed` | ✅ |
| 13 | 默认口令 | `seed.ts` / `LoginPage.tsx` / `search-bench.ts` | `Tianji@2024`（三处一致） | ✅ |
| 14 | 一次性更名脚本 | `scripts/` | **已删除**（避免留在 grep 里永久误报） | ✅ |

**已覆盖的 9 类命名形态**：包作用域前缀、连字符形态、下划线形态、裸标识符字符串、
`.env` 行尾赋值、shell 参数展开默认值、localStorage key 前缀、英文产品名、中文名。

---

## §3 参数化 · 22 项参数单一源

| # | 项 | 位置 | 状态 |
|---|---|---|---|
| 15 | `PARAM_DEFS` 单一源 | `packages/shared/src/params.ts` | ✅ 22 条 |
| 16 | 三层生效分类 | 同上 | ✅ `read-immediate` 9 / `judgment` 6 / `retention` 7 |
| 17 | 分类 × 分组白名单 | `EFFECTIVE_MODE_ALLOWED_GROUPS` | ✅ borrow **只可能在** `judgment` |
| 18 | 加载期自检 | `assertParamDefs()`（文件末自动执行） | ✅ 7 类误配即 import 抛错 |
| 19 | 后端 key 常量 | `enums.ts` `PARAM_KEY = deriveParamKey()` | ✅ 派生，零手写 |
| 20 | 旧 key 迁移 | `1700000000004-MigrateParamKeys` | ✅ 11 个旧 key，含单位换算（月→年 ÷12） |
| 21 | 前端管理员页 | `apps/web/src/pages/system/ParamsPage.tsx` | ✅ 完全由 `PARAM_DEFS` 驱动，零硬编码分组 |

### 三层分类的设计意图（供 QA 理解为何这样测）

| 分类 | 语义 | 读取路径 | 允许分组 |
|---|---|---|---|
| `read-immediate` | **读取生效**：改完立刻影响下一次读 | 直读 DB，绕过缓存 | security, preview |
| `judgment` | **判定生效**：改完影响新发生的判定，**在途单据不回溯**（D-1） | 60s 缓存 + `param:invalidate` | borrow, search, extract |
| `retention` | **存量失效**：改完只影响之后产生的记录，**已有记录不重算**（D-2） | 缓存 + 主动失效 | recycle, backup, log, file, import |

> **这张表替代了原来靠 `grp` 决定读取路径的做法。** 原因：`grp` 是展示分组，用它决定读取路径意味着"borrow 组可能被配成直读"，一旦配错，借期参数一改会立刻影响在途单据逾期判定，直接违反 D-1。现在 `borrow.*` 在结构上就不可能被配成直读——**从"需要人记得检查"变成"根本配不错"**。

---

## §4 并发缺陷修复（9 处）

| # | 方法 | 防护手段 | 状态 |
|---|---|---|---|
| 22 | `renew()` | `withOrderLock` + 锁内重读 + CAS（`renewCount`/`status`/`expectReturn`） | ✅ |
| 23 | `approve()` | `withOrderLock` + CAS（`status`/`currentLevel`）+ 三道闸门 | ✅ |
| 24 | `cancel()` | `withOrderLock` + CAS（`status`） | ✅ |
| 25 | `lend()` | `withOrderLock` + CAS（`status`） | ✅ |
| 26 | `giveBack()` | `withOrderLock` + CAS（`status`） | ✅ |
| 27 | `voidAndReassign()` | `withItemLock` + 取号原子性 | ✅ |
| 28 | `confirmVolume()` | `withItemLock` + CAS | ✅ |
| 29 | `submitItem()` | `withItemLock` + CAS | ✅ |
| 30 | `scanOverdue()` | 幂等判定 + 只更新仍为 LENT 的行 | ✅ |

### 防护三件套（每一处都完整具备）

1. **进程内按单据互斥**：`withOrderLock(orderId, fn)` / `withItemLock(itemId, fn)` —— Promise 链，同 ID 串行
2. **锁内重读**：加锁后重新 `findOne`，用最新状态做判定（不信入参带来的旧对象）
3. **CAS update**：`UPDATE ... WHERE id=? AND status=? AND currentLevel=?`，`affected === 0` 判为并发冲突并抛业务异常

> **为什么不加 `pessimistic_write`**：一是不想依赖 `manager.getRepository`（QA 的 mock `manager` 只有 `create/save/update`），二是行锁在长事务里会放大死锁面。进程内互斥解决单实例，CAS 兜底多实例——**双层防护，任一层失效另一层仍能拦住**。

### `approve()` 的三道独立闸门（易被误改，特此说明）

| 闸门 | 判据 | 失败表现 |
|---|---|---|
| ① 次序 | `actingLevel !== order.currentLevel` | `BORROW_INVALID_STATE` |
| ② 能力 | `actingLevel > resolveApproverLevel(user)` | `403 您的审批级别为第 N 级，无权办理第 M 级审批` |
| ③ 重复签署 | `signed.some(a => a.approverId === user.userId)` | 拒绝重复签 |

`resolveApproverLevel()` **必须保留**。它刻意用字面量 `'R4'` 而非 `RoleCode.R4` 做比较——vitest threads 池下 `@tianji/shared` 可能出现 src/dist 双实例，用对象引用比较会偶发失效。

---

## §5 QD-1 会话超时按签发值固化

| # | 项 | 位置 | 状态 |
|---|---|---|---|
| 31 | 签发时读参数并落 Redis | `auth.service.ts` `issueTokens()` | ✅ `auth:session:{sid} = { userId, createdAt, timeoutMinutes }` |
| 32 | 校验时读会话记录 | 同上 | ✅ 不回查参数 |
| 33 | 参数读取失败兜底 | `readSessionTimeoutMinutes()` | ✅ 回落 `jwt.accessTtlSeconds / 60`，保证正整数 |
| 34 | 单测 | `auth.session-timeout.spec.ts` | ✅ 11 tests 全启用（原 5 条 skip 已打开 + 新增 3 条实现侧） |

**语义**：参数变更**不强制踢存量会话下线**——已签发 token 按签发时的超时值走完，新登录 / refresh 用新值。

---

## §6 D-1 / D-2 的结构性保证

| # | 保证 | 实现方式 | 为何不可能配错 |
|---|---|---|---|
| 35 | D-1 在途单据不回溯 | `isOverdueOrder()` **只比对 `expectReturn` 与今天，完全不读参数** | 不是"靠人记得不读"，是**代码里根本没有读取动作** |
| 36 | D-2 存量记录不重算 | `recycle` / `log` 清理按记录自身的 `createdAt`/`deletedAt` 判定，参数只决定"现在清理到哪" | 同上 |
| 37 | 单测 | `borrow.param-d1-inflight.spec.ts` | ✅ 4 tests |

---

## §7 E 包 —— 权限缓存主动失效

| # | 验收标准 | 位置 | 状态 |
|---|---|---|---|
| 38 | 版本号通道 | `user.service.ts` `INCR perm_ver:{userId}` | ✅ |
| 39 | pub/sub 通道 | `publish('perm:invalidate')` + `handlePermissionInvalidate` | ✅ |
| 40 | **禁裸 `redis.del` 作为唯一路径** | `redis.del` 仅注释为「只清理，不承担生效职责」 | ✅ 失效效果已由 INCR + publish 保证 |
| 41 | 「5 分钟内生效」过时注释 | `user.service.ts` | ✅ 已不存在（grep 零命中） |
| 42 | `PERMISSION_MUTATIONS` 单一源 | `packages/shared/src/permission-mutations.ts` | ✅ 8 条 + 1 条排除 |
| 43 | CI 静态自检 | `scripts/ci-check-permission-mutations.cjs` | ✅ R1/R2/R3 三条规则 |
| 44 | 自审拦截**不**补 invalidate | `borrow.service.ts` 内联 `applicantId === user.userId` | ✅ 代码注释留痕，R3 反向自证 |

---

## §8 D 包 —— 跨参数校验 C-1~C-5

| 编号 | 约束 | 阻断 |
|---|---|---|
| C-1 | `borrow.default_days ≤ borrow.max_total_days` | ✅ blocking |
| C-2 | `borrow.max_renewal_days ≤ borrow.max_total_days` | ✅ blocking |
| C-3 | `backup.keep_copies × 单份估算 ≤ 容量` | 提示（容量为估算） |
| C-4 | `log.retention_years > 5` 提示复核 | 提示 |
| C-5 | `perm TTL > 0` 必须有主动失效通道 | ✅ blocking |

三个接入点：`upsert()` 单条保存、`upsertMany()` 批量（**先内存模拟最终视图，任一 blocking 则整体不落库**）、`checkCross()` 管理端预检。

---

## §9 参数生效验证脚本

| # | 项 | 命令 | 结果 |
|---|---|---|---|
| 45 | 参数生效验证 | `pnpm --filter @tianji/api verify:params` | ✅ **107 项断言全通过** |

覆盖 22 项参数的消费方行为，全部采用**成对验证**：改值 → 行为变化 → 改回 → 恢复。不是"读到了值就算过"，而是"值真的改变了业务结果"。

---

## §10 已知边界（不是缺陷，是设计取舍）

| # | 边界 | 说明 |
|---|---|---|
| B1 | `import.batch_max_rows` 消费方在 `cli-migrator` | 独立 CLI 进程，无 ParamService。已改为 `--batch-max-rows` 参数承接，并在 `PARAM_DEFS.consumer` 明写此边界 |
| B2 | `@Cron` 无法异步读库 | 心跳每分钟 + 自实现 cron 表达式匹配；非法表达式退化为每小时第 5 分钟并告警 |
| B3 | CAS 层未被单元测试覆盖 | QA 的 mock `manager` 只有 `create/save/update`，无法验证 `affected` 分支。**需集成测试覆盖**，我在上轮已向 QA 说明 |
| B4 | C-3 出厂默认值即触发提示 | 30 份 × 20GB > 500GB 是 `blocking: false` 的容量提示，属**有意保留**（容量为估算值，不应硬拦） |
| B5 | **`packages/shared` 是恢复的副本，非原物** | 目录迁移时该包因硬链接被 robocopy 跳过而丢失，已从 `apps/api/node_modules/@titan/shared` 副本恢复 16 文件（`params.ts` MD5 一致，含全部最新特性）。构建/测试/类型全绿证明可用，但**无 git 基线可 diff**，无法逐字节证明与原物相同。**建议有副本者做一次 diff** |
| B6 | IK 镜像构建依赖网络或离线 zip | `infra/elasticsearch/Dockerfile` 优先读 `infra/elasticsearch/ik/*.zip`，否则联网下载。内网环境须预置 zip，详见 `docs/DEPLOY.md` §3 |

---

## §11 给 QA 的重点测试建议

1. **并发防护的 CAS 分支**：单测只能验证互斥锁。建议用真实 PostgreSQL 并发跑 `renew` / `approve`，断言 `affected=0` 时抛业务异常而非脏写
2. **D-1 跨参数变更**：改 `borrow.max_total_days` 后，检查**在途** LENT 单的逾期判定是否**未**变化
3. **QD-1 会话不踢**：改 `security.session_timeout_min` 后，用旧 token 继续访问应立即仍有效（按签发值走完）
4. **跨参数冲突一次全返**：同时提交违反 C-1 和 C-2 的两个值，前端应**一次显示 2 条**而非逐条试错
5. **CI 门禁**：`pnpm run ci:check` 应作为 PR 必跑项
6. **真实环境压测**（等 Docker 起来后）：`perf:danghao` 并发 200 × 10 轮，验「零重号、零断号」

---

## §12 部署与压测准备（Docker 环境）

> 完整操作手册见 **`docs/DEPLOY.md`**，此处只记核对要点。

| # | 项 | 位置 | 状态 |
|---|---|---|---|
| 46 | Compose 编排（9 服务 + 5 数据卷） | `docker-compose.yml` | ✅ 已备好 |
| 47 | IK 镜像构建定义 | `infra/elasticsearch/Dockerfile` | ✅ 已备好 |
| 48 | **IK 离线包目录（构建缺陷修复）** | `infra/elasticsearch/ik/` | ✅ **新建** —— 原 Dockerfile 有 `COPY ik/` 但目录不存在，会直接构建失败；已补空目录 + `.gitkeep` |
| 49 | 自定义词典 | `infra/elasticsearch/analysis-ik/` | ✅ `custom_dict.dic` / `stopword.dic` 已含档案常用词 |
| 50 | 环境变量样例补全 | `.env.example` | ✅ **新增** `ES_VERSION` / `IK_VERSION` / `ES_JAVA_OPTS` / `ES_EXPOSED_PORT`（原先缺失，构建参数与宿主机端口无法调整） |
| 51 | 启动手册 | `docs/DEPLOY.md` | ✅ **新建** —— 前置检查 / 目录权限 / IK 构建两路径 / 启动 / 迁移种子 / 冒烟 / 压测 / 排查 |
| 52 | 压测前置：seed 数据 | `pnpm seed` | ⏳ 待 Docker 起来后执行 |
| 53 | 压测执行 | `perf:danghao`（并发 200 / 10 轮） | ⏳ 待 Docker 起来后执行 |

### 阻塞点

**WSL2 初始化必须用户手动做一次**：打开 Docker Desktop，等左下角变为 **Engine running**。
在那之前 `docker version` 会报 `error during connect`，无法构建/启动任何服务。这一步命令行无法代劳。

### Docker 起来后我要执行的顺序

```bash
# 1. 建数据卷目录（必须在 up 之前，否则可能被 root 建成空目录）
mkdir -p volumes/{postgres,wal_archive,esdata,minio,redis,backup}

# 2. 配置 .env（改 5 个口令）
cp .env.example .env

# 3. 构建（IK 3~8 分钟 + 4 个应用镜像）
docker compose build

# 4. 启动
docker compose up -d

# 5. 等全部 healthy（ES start_period 60s，别急）
docker compose ps

# 6. 迁移 + 种子
docker compose exec api pnpm migration:run
docker compose exec api pnpm seed

# 7. 验证 IK 分词真生效
curl -s -X POST "http://localhost:9200/_analyze" -H 'Content-Type: application/json' \
  -d '{"analyzer":"ik_max_word","text":"天玑档案管理系统案卷著录"}'

# 8. 冒烟
curl -s http://localhost:3000/api/health

# 9. 档号并发压测（硬性验收要点 1）
docker compose exec -e CONCURRENCY=200 -e ROUNDS=10 api \
  pnpm --filter @tianji/api perf:danghao
# 期望：✓ 全部 10 轮通过：零重号、零断号
```

---

## §13 文件清单（本次工作涉及）

### 新建

```
scripts/ci-check-permission-mutations.cjs          CI 静态自检（R1 正向 / R2 反向 / R3 自证）
docs/DELIVERY-CHECKLIST.md                         本文件
docs/DEPLOY.md                                     部署与压测手册
infra/elasticsearch/ik/.gitkeep                    IK 离线包目录（修构建缺陷）
```

### 修改

```
package.json                                                新增 ci:check / ci:check:perm-mutations
apps/cli-migrator/src/cli.ts                                新增 --batch-max-rows
packages/shared/src/params.ts                              import.batch_max_rows 的 consumer 说明边界
apps/api/__tests__/permission-mutations.consistency.spec.ts 组 4 换成真断言（18→20 tests）
.env.example                                                补 ES_VERSION / IK_VERSION / ES_JAVA_OPTS / ES_EXPOSED_PORT
```

### 更名涉及（151 个文件）

核心改动集中在：`package.json` × 6、`tsconfig.base.json` 的 paths、全部 `import` 语句、
`docker-compose.yml`、`.env.example`、`infra/backup/backup.sh`、UI 文案、文档。
一次性替换脚本已删除（保留会在 grep 里永久误报）。

---

**最后更新**：更名 + D 包 + E 包 + CI 自检 + 边界登记 + 部署准备全部完成。
`pnpm run ci:check` / `build` / `typecheck` / `test` 四项全绿（396 passed + 2 skipped，107/107 参数断言）。
Docker 侧待 WSL2 初始化完成后执行启动与压测。
