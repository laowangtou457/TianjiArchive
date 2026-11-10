# QA 验收报告 —— 天玑档案管理系统本地复刻

- **测试人**：严过关（QA 工程师）
- **被测版本**：`E:\TianjiArchive`（工程师交付 T01–T05 后，含三轮缺陷修复）
- **报告时间**：2026-11-07
- **最终结论**：**PASS（限定范围）**（联调轮实测通过：五服务 healthy、迁移 5/5、seed、IK 分词、200×10 档号压测七项判据全绿；MinIO 文件链路与多容器 pub/sub 跨进程两项如实排除在签字范围外，见 §六/§五）

---

## 一、核心结论（先看这里）

工程师声称 `IS_PASS: YES`。我的独立验证结论是：**业务逻辑层真的能用**，不是"文件存在"。

三轮共发现 **5 个真实源码缺陷（三轮口径；联调轮新增 #6/#7，见 §七） + 2 个待接入项**，其中 5 个源码缺陷**均已修复并经我回归验证**：

| # | 缺陷 | 严重级 | 影响面 | 状态 |
|---|------|--------|--------|------|
| 1 | 未知密级值被当作 `PUBLIC` 放行，权限放大 | **高（安全）** | 越权读取涉密档案 | 已修复 · 回归通过 |
| 2 | SECRET 双级审批第 1 级通过后被错误推进为 `APPROVED` | **高（合规）** | 涉密借阅绕过二级审批 | 已修复 · 回归通过 |
| 3 | `@tianji/shared` 构建脚本路径基准错误，`-p` 指向不存在的 `scripts/tsconfig.json` | 中（工程） | 全仓库 `pnpm run build` 直接失败 | 已修复 · 回归通过 |
| 4 | 续借并发可绕过次数上限（read-then-write 无锁） | 中（一致性） | 用户双击即可续借两次 | 已修复 · 回归通过 |
| 5 | 单次续借上限 `max_renewal_days` 缺失 | 中（业务规则） | 可一次续借至总借期上限 | **已修复** · 回归通过（本轮） |
| R6 | `approve()`/`cancel()` 读-判-写并发窗口 | 中（合规） | 涉密双级审批可被并发绕过 | **已修复** · 回归通过（本轮） |

其余验证（档号引擎、档号不可变、SHA-256 校验、ES 权限过滤、并发唯一性、权限缓存）**全部通过**。

**本轮（Round 3）新增结果**：
- **缺陷 #5、R6 双双修复并回归通过**，至此 **5 个源码缺陷全部关闭**（三轮当轮口径；后续联调/压测现场新增 #6~#14，最终见 §七）
- **C-5 权限撤权「版本号 + pub/sub」多实例双通道已实证**（E 包落地 + T 类 3 条用例：T1 版本号通道独立兜底 / T2 广播通道副作用 / T3 端到端，同进程双实例共享 FakeRedis，QA 独立变异验证「禁用广播处理恰好红 T2 一条」）
- **全套 436 用例：436 通过 / 0 跳过 / 0 失败**（上一基线 291 条 → 436 条。2 条多实例 skip 已启封转真，**skip 清零**；压测判据单测 19 条新增）
- **全部历史 skip 已清零**：`overdue_remind_days`（5 占位 → 9 真实用例）、QD-1 会话超时（5 skip → 11 全真）、C-5 多实例（2 skip → T 类 3 条真实用例）

**残余风险不在代码逻辑，而在验证范围**：联调轮已完成真实 PG 行锁与 200×10 并发发号、ES 容器与 IK 分词、Redis 单机运行时的实证；**仍不可签两项**：MinIO 文件存储链路（官方镜像归档停服、替代选型待拍板）、多容器 pub/sub 跨进程投递（`--scale api=2` 未跑）；另 IK/health/迁移执行态未独立重跑（本地无容器内执行权限，如实标注复核深度）。逐条见 §五 R1 与 §六联调现场实录。【2026-11-09 阶段二结案更新：MinIO 行已由 SeaweedFS 方案 A 实证升级为「**A 部分解除（限定范围）**」——文件入库/挂接/预览/SHA-256 完整性与 S3 wire 层解除，「下载业务放行」仍不可签（L2）；多容器 pub/sub 仍保留。详见 §五 R1 结案更新段。】

---

## 二、构建与静态检查独立复跑

全部由我本人从干净状态独立执行，非引用工程师结论。

| 项目 | 命令 | 结果 | 耗时 |
|------|------|------|------|
| 依赖安装 | `pnpm install --frozen-lockfile` | ✅ 通过（lockfile 一致） | 1m49s |
| 类型检查 | `pnpm run typecheck` | ✅ **4/4 Done**（api / web / extractor / cli-migrator） | — |
| Lint | `pnpm run lint`（`--max-warnings=0`） | ✅ 零告警零错误 | — |
| 构建 | `pnpm run build` | ✅ **4/4 Done**（web 1641 modules） | 15–34s |

### 2.1 构建脚本缺陷（**缺陷 #3，已由工程师修复**）

修复 #1/#2 后首轮 `pnpm run build` 失败：

```
error TS5058: The specified path does not exist: 'E:\TianjiArchive\packages\shared\scripts\tsconfig.json'.
Error: Command failed: tsc -p E:\TianjiArchive\packages\shared\scripts\tsconfig.json --outDir E:\TianjiArchive\packages\shared\scripts\.build\cjs
```

**根因（更正）**：我最初误判为"中断构建遗留的 `.build` 目录污染"，**这是错的**。经排查，`packages/shared/scripts/tsconfig.json` **从来就不存在**，也从未被创建。真实原因是旧版 `build.cjs` 的路径基准算错——`-p` 参数指向了 `scripts/` 子目录，而非包根目录。**这是脚本自身的路径 Bug，不是环境残留。**

**工程师的修复方式**（10:43 重写整个构建策略，比补路径更彻底）：

| 项 | 旧版（有 Bug） | 新版 |
|----|----------------|------|
| 输出策略 | 临时目录编译 → 原子替换 `dist` | 直接编译到 `dist`，**只覆盖、不删除** |
| 批量删除 | `rmrf()` 递归删除 | **完全移除**（规避 safe-delete shim 的 50 项阈值拦截） |
| `.build` 临时目录 | 使用 | **废弃** |
| 构建后自检 | 无 | **有**：校验 4 个关键产物（`index.js`/`index.d.ts`/`esm/index.js`/`esm/permission.js`），缺一即抛错 |
| clean 脚本 | `node -e rmSync` | 独立 `clean.cjs`，**逐文件 unlink + 自底向上 rmdir** 规避批量删除阈值 |

> 新版额外修掉了一个我没测到的真实风险：受限环境下 `fs.rmSync` 会被 safe-delete shim 拦截并抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，旧脚本单次删 50+ 项即中断构建。这属于**工程师主动加固**，值得记一笔。

**我的复验**：`rm -rf packages/shared/dist` 后从零构建 → **4/4 Done**，shared 自检通过；dist 双份产物（CJS + `esm/` 含 `type:module` 标记）完整；`scripts/build.cjs` 与 `clean.cjs` 均落盘，`package.json` 的 `clean` 已同步指向 `clean.cjs`；`pnpm test` 10 文件全绿不受影响。

---

## 三、测试覆盖与结果

### 3.1 总体（Round 3 最终基线）

| 指标 | 数值 |
|------|------|
| 测试文件 | **24**（全部通过） |
| **测试用例总数** | **436** |
| **通过** | **436** |
| 失败 | **0** |
| 跳过 | **0**（C-5 已启封转真，见 §3.4） |
| 通过率 | **100%** |
| 执行耗时 | 约 4.5s |
| 与上一基线对比 | 291 → 436（含更名验收工程师新增 7 条 + 多实例启封净增 1 条 + 压测判据单测 19 条 + 联调/压测现场缺陷防回归用例〔#6~#12 等〕，QA 均已核验） |

> **「0 失败」不等于「全部可信」**。skip 已清零（§3.4）；另有 §3.5「疑似假绿 / 断言不充分用例」，说明哪些绿证据强度不足。**判定看这节，不看通过率。**

> **本轮已启封的历史 skip**：`overdue_remind_days` 5 条占位 → 重写为 **9 条真实用例**（参数接入已完成，含 0 值不回落）；`auth.session-timeout` 5 条 skip → **11 条全部转真**（QD-1 已落地，`auth:session:{sid}` 写入 `timeoutMinutes`）。**C-5 多实例 2 条也已启封（T 类 3 条），skip 清零**。

### 3.2 分模块覆盖率（v8 provider，Round 2b 采集）

| 模块 | 行覆盖 | 分支覆盖 | 说明 |
|------|--------|----------|------|
| `packages/shared/src` | **95.17%** | 82.30% | 档号引擎/权限/枚举/错误码，核心同源层 |
| ├ `danghao.ts` | 96.55% | 81.02% | 档号模板解析器 |
| ├ `permission.ts` | 97.59% | 93.84% | 四要素权限判定 |
| ├ `dto.ts` / `index.ts` | 100% | 100% | — |
| `common/access/access-filter.builder.ts` | **97.76%** | 94.93% | SQL/ES/KB 同一快照派生 |
| `modules/danghao/sequence.service.ts` | 75.32% | 86.20% | 序列发号 |
| `modules/file/file.service.ts` | 74.75% | 81.94% | 文件入库与四性检测 |
| `modules/borrow/borrow.service.ts` | 66.85% | 79.54% | 借阅状态机（Round 3 后实际更高，未重采） |
| `modules/search/search.service.ts` | 59.31% | 47.50% | ES 检索 |
| `modules/archive/archive.service.ts` | 42.83% | 66.27% | 档案 CRUD（未覆盖多为导出/统计等非核心分支） |
| `modules/user/user.service.ts` | 24.06% | 100.00% | 权限缓存核心路径已覆盖，其余 CRUD 未覆盖 |

> 覆盖率不是目标本身。**关键路径已全部覆盖**：档号生成、权限判定、借阅流转、档号不可变、哈希校验、ES 过滤注入。`user.service` 24% 是刻意取舍——其权限快照路径已覆盖，剩余为用户管理 CRUD，非本轮验收重点。

### 3.3 测试文件清单（最终基线 · 24 文件 / 436 用例）

| 测试文件 | 用例数 | 覆盖目标 |
|----------|--------|----------|
| `packages/shared/__tests__/danghao.spec.ts` | 44 | 档号模板解析/补零/分隔符/重置周期/非法模板/前后端同源 |
| `packages/shared/__tests__/permission.spec.ts` | 28 | 四要素权限矩阵（角色×数据范围×密级×操作） |
| `packages/shared/__tests__/param-defs.spec.ts` | 16 | **PARAM_DEFS 单一源**：key 唯一、默认值在区间内、派生 `PARAM_KEY` 一致、`isDirectReadParam` 分组正确 |
| `apps/api/__tests__/access-filter.builder.spec.ts` | 32 | SQL/ES/KB/内存四路过滤一致性 + 缺陷#1加固回归 |
| `apps/api/__tests__/borrow.state-machine.spec.ts` | 35 | 7 状态合法/非法流转、禁止自审、SECRET 双级审批 |
| `apps/api/__tests__/file.sha256-integrity.spec.ts` | 27 | SHA-256 不一致拒绝+清理脏对象、魔数嗅探、2GB/5MB 边界、下载策略参数化 |
| `apps/api/__tests__/borrow.param-d1-inflight.spec.ts` | **4** | **D-1 反向守卫**：在途单逾期判定**不读参数**；新续借按读取当次参数 |
| `apps/api/__tests__/archive.danghao-immutable.spec.ts` | 20 | 档号不可变（2004）、`voidAndReassign` 留痕、忽略客户端档号 |
| `apps/api/__tests__/search.es-filter.spec.ts` | 16 | ES 过滤体注入、超密级静默剥离、全拒时短路、字段白名单 |
| `apps/api/__tests__/danghao.concurrency.spec.ts` | 19（含 #12 +6） | 200 并发×10 轮零重号零断号、40001/40P01 重试语义；**新增 6 条缺陷 #12 防回归**：`extractQueryRows` 四形态、双层主用例（夹具自身双层正向证据）、单层兼容、双层零行 `NO_LOCKED`、`reserve` 双层成功+零行抛错、`peek` 单层回归（工程师自做变异 8 红 11 绿，QA 复核形态） |
| `apps/api/__tests__/storage.minio-contract.spec.ts` | 11 | MinIO 方法契约、桶名、错误吞掉、SHA-256 空串基准 |
| `apps/api/__tests__/user.permission-cache.spec.ts` | **12** | **A 类机制**：版本号 key、TTL 兜底、命中免查库、TTL 不滑动、精确/全量失效、广播发出 |
| `apps/api/__tests__/user.permission-revoke-effect.spec.ts` | **17** | **A/B/T/R 四类**：撤权→403 请求级、密级下调、角色收敛、连续撤权、**多实例双通道 T1/T2/T3（已启封，QA 变异验证通过）**、风险实证 |
| `apps/api/__tests__/user.permission-request-level.spec.ts` | **9** | **C-5 请求级硬用例**：Guard + JwtStrategy 真实链路、撤权后同 token 下一次请求 403、耗时 < 100ms |
| `apps/api/__tests__/borrow.renewal-boundary.spec.ts` | **33** | BR-06-1~7 续借边界 + **缺陷 #5 回归护栏（4 条）** |
| `apps/api/__tests__/borrow.borrow-date.spec.ts` | 14 | `borrowDate` 字段：lend 写入、总借期按借出日算、历史单据弱校验+WARN、脏值拒绝 |
| `apps/api/__tests__/borrow.approve-concurrency.spec.ts` | **23** | **R6 回归**（11）+ **能力校验回归**（12）：双人同级并发、旧快照拒绝、双级链路、同人不得办两级、撤销互斥、**终审仅 R4 可签（含变异验证）** |
| `apps/api/__tests__/borrow.overdue-remind.spec.ts` | **9** | `overdue_remind_days` 全参数化：7/3/30/0/缺失/显式传参 + **0 值不回落假值陷阱** |
| `apps/api/__tests__/auth.session-timeout.spec.ts` | **11** | D-3 会话超时：新值仅对新签发会话生效、存量不踢出、**QD-1 落库 `timeoutMinutes` 实现侧验证** |
| `apps/api/__tests__/permission-mutations.consistency.spec.ts` | **20** | **C-5 栏 B 规则执行体**：清单↔源码一致、排除清单被真正读取、self-check 排除理由成立、CI 静态脚本存在/可执行/已注册（已变异验证） |
| `apps/api/__tests__/danghao-bench-judge.spec.ts` | **19** | **压测通过判据回归**：f67a60f 跳号反例、七项判据各自独立失败模式、**第 7 项解析失败判据（含「解析全失败+gaps=0」空转原型）**、负 gaps 防御、extractSequenceNumber/computeRoundGaps 正反例（变异验证：拆第 6/7 项 → 各恰好 3 红） |
| `apps/api/__tests__/app.module-tree.spec.ts` | **3** | **DI 装配层守卫**（联调现场缺陷 `4118d48` 防回归）：`@Global()` 模块必须在 AppModule imports 闭包内（4118d48 之前精确红）、装配冒烟（AccessFilterBuilder 可解析）、装配审计 runner 用例（spawn 真脚本+正向证据非空转；探针证伪：design:paramtypes 仅 tsc 发射，esbuild 链 vitest 内扫 0 注入点空转 → 全量审计独立为 ts-node 脚本） |
| `apps/api/__tests__/data-source.migrations.spec.ts` | **3** | **迁移发现守卫**（缺陷 #10 静默空跑家族）：selector 双分支（dist→.js / 源码→.ts，纯函数 `migrationGlobFor` 入参化可测）、源码树发现集非空 + 不含 seed-data.ts + 目录确实含 seed-data.ts（防排除断言漂移空转）、buildDataSourceOptions.migrations 非空（QA 已核，含分隔符可移植性隐患捕获） |
| `apps/api/__tests__/danghao-bench-deadlock.spec.ts` | **6** | **压测自死锁防回归**（缺陷 #11）：全局 repo 探测针一碰即炸下生成路径仍通过（generateItem/Volume 规则+机构读全经事务 manager，单连接化）+ manager 侧正向证据 + preview 向后兼容 + 看门狗三语义（到点恰一次/撤防不触发/幂等）（QA 变异验证：摘 generateItemDanghao 的 manager 参数 → 恰好红 1 条探测针用例） |

### 3.4 skip 缺口：**已清零** ✅

原 2 条 C-5 多实例 skip（`user.permission-revoke-effect.spec.ts`）已启封并重写为 **T 类 3 条真实用例**（`8166c47`）：

| 用例 | 所测闸门 | 断言形态 |
|---|---|---|
| T1 | 版本号通道（`INCR perm_ver`） | 广播全丢（无订阅者）时 B 仍读到新权限 |
| T2 | 广播通道（`publish perm:invalidate`） | **断言副作用**：B 的 `localSnapshotCache` 被清空（含 v0 存在的前置断言，防空转） |
| T3 | 组合正确性 | 双通道并存时 B 立即看到新权限（端到端） |

**QA 独立变异验证**：禁用 `handlePermissionInvalidate` → **恰好红 T2 一条**（16 过 1 红）；恢复后 17/17 全绿、MUTANT 零残留。工程师侧另做「禁用版本号 INCR → 红 3 条（A 类 1 + B 类 1 + T1）」反向夹逼，两通道失败模式互不遮蔽。

> 关键设计修正（工程师发现，QA 复核成立）：不能断言「B 读到新值」——`getSnapshot` 每次实时读版本号算 key，v0/v1 天然失配，版本号通道会让该断言无条件变绿，掩护广播通道整体失效（搭便车假绿）。T2 改断「缓存被清空」这个广播独有副作用。

> **全部历史 skip 转真轨迹**：`overdue_remind_days` 5 → 9 真实用例、`auth.session-timeout` 5 → 11 全真、C-5 多实例 2 → T 类 3 条。**「skip 占位 + 完整断言」的契约前置写法被证明有效——没有一条变成永久 TODO。**

### 3.5 疑似假绿 / 断言不充分用例（PM 要求专列）

「绿」分三种，混在一起会让读者误判证据强度。逐条标注：

| 用例 / 分组 | 绿的性质 | 证据强度 | 说明 |
|-------------|----------|----------|------|
| `permission-cache` 全部 12 条 | **真绿** | 强 | 断言具体 key、TTL 数值、调用次数，失败原因唯一 |
| `revoke-effect` A 类 8 条 | **真绿** | 强 | 同上；版本号与旧 key 清除均有精确断言 |
| `revoke-effect` B 类 5 条 | **单实例真绿** | 中 | 单实例语义已证；**多实例未证**（2 条 skip 占位） |
| `revoke-effect` R 类 1 条 | **真绿但语义特殊** | 强 | 它证明「风险存在」，**不是合规项**；绿 = 风险仍在，见 §4.4 |
| `permission-request-level` 9 条 | **真绿（链路级）** | **强** | 唯一一处让 `JwtStrategy.validate` + `PermissionGuard` 两段真实源码同框的用例；前置自检专门防「漏挂 `@RequirePerm` 导致全组假绿」 |
| `permission-mutations.consistency` 18 条 | **真绿（含变异验证）** | **强** | 判定"是否调用 invalidate"时先剥注释再匹配，避免 `borrow.service.ts:234` 注释里的「故意不调用 invalidateSnapshot」被判成已调用 |
| `renewal-boundary` 单次上限组 4 条 | **真绿（含前置守卫）** | 强 | 已加 `Number.isFinite(maxRenewalDays)` 守卫，杜绝字段丢失导致 NaN 假绿 |
| `approve-concurrency` R6 组 11 条 | **真绿** | 强 | 显式传 `level` 隔离「并发」与「按当前级别办理」；`approvals.length` 断言失败方不留痕 |
| `approve-concurrency` 能力校验组 12 条 | **真绿（含变异验证）** | **强** | 断言 `code=1003` 而非仅「抛错」，锁死拒绝来源；已用 `return 2` / `return 1` 双向变异证明可抓 |
| `overdue-remind` 9 条 | **真绿** | 强 | 直打 `dueSoon()`，关键断言是「0 值不查库」——若实现写 `\|\| 3` 必红 |
| `auth.session-timeout` 11 条 | **真绿（含实现侧）** | 强 | 6 条纯逻辑 + 3 条打穿 `issueTokens` 真实落库 + 2 条口径边界；纯逻辑若实现回归仍会绿，故补实现侧 |
| `param-defs` 16 条 | **真绿** | 强 | 直接校验 `PARAM_DEFS` 单一源，不含运行时分支 |
| `state-machine` 审批留痕 1 条 | **真绿（断言已校正）** | 中强 | 源码改走 `approvalRepo.save`，断言同步改；若源码改回 `manager.save` 会变红（正确） |
| `danghao.concurrency` 19 条（含 #12 +6） | **模拟绿（仅单测层）** | 中 | 单测用串行队列/双层桩模拟，证据强度仅描述单测层；**真实 PG 行锁行为已由终跑 200×10 压测独立佐证**（§六/§五 R1），二者不可互相替代、也不互相抵消 |
| `storage.minio-contract` 11 条 | **契约绿** | 中 | 只证方法存在与签名，未发真实请求（见 R1） |
| `file.sha256-integrity` 2GB 边界 1 条 | **逻辑绿** | 中弱 | 仅构造 size 数值，未真实写 2GB（见 R5） |

> **读法**：`真绿` = 失败原因唯一、证据链闭合；`模拟绿 / 契约绿 / 逻辑绿` = 通过但依赖替代手段，需结合对应 R 项风险阅读。**「436 通过」里约有 25 条属后三类**，不应当作与真绿等价的证据。

---

## 四、两轮缺陷追踪与路由决策

### Round 1：发现 2 个真实源码缺陷 → 路由至 **Engineer**

**判定依据**：断言符合 PRD/架构设计预期，实际输出错误 → 源码 Bug，非测试 Bug。

---

#### 缺陷 #1：未知密级 fail-open（安全）

- **位置**：`packages/shared/src/permission.ts`
- **复现**：
  ```ts
  const s = snapshot({ maxSecurityLevel: SecurityLevel.PUBLIC });
  canAccessLevel(s, 'TOP_SECRET' as SecurityLevel);  // 期望 false，实际 true
  ```
- **预期**：未知密级值应拒绝（fail-closed）
- **实际**：`SECURITY_LEVEL_RANK['TOP_SECRET']` 返回 `undefined`，`undefined <= 0` 为 `false` 之外的回退路径导致按 `PUBLIC`（rank 0）比较，权限被放大
- **影响**：若数据库存在脏密级值（历史迁移/手工改库），用户可越权读取涉密档案。**安全红线**
- **修复**（工程师）：查不到 rank 即拒绝
  ```ts
  const userRank = SECURITY_LEVEL_RANK[snapshot.maxSecurityLevel];
  const itemRank = SECURITY_LEVEL_RANK[level];
  // 未知密级 fail-closed：查不到 rank 即拒绝
  if (userRank === undefined || itemRank === undefined) return false;
  return itemRank <= userRank;
  ```
- **连带加固**（工程师）：`access-filter.builder.ts` 的 `levelsAtMost` 未知密级返回 `[]`；`buildSql` 在空集时输出 `FALSE` 而非非法 `IN ()`
- **我的回归**：新增 2 条回归用例（见下），均通过

---

#### 缺陷 #2：SECRET 双级审批被跳过（合规）

- **位置**：`apps/api/src/modules/borrow/borrow.service.ts`
- **复现**：
  ```ts
  h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }));
  await h.service.approve('o-1', { action: APPROVE, opinion: '一级同意' }, makeUser({ roles: ['R1'] }));
  // 期望 status = PENDING 且 currentLevel = 2
  // 实际 status = APPROVED
  ```
- **预期**：涉密（SECRET）借阅需两级审批，第 1 级通过后应停在 `PENDING`、`currentLevel` 递增到 2
- **实际**：第 1 级通过即直接置为 `APPROVED`，第二级审批形同虚设
- **影响**：**涉密档案借阅越权放行**，违反 DA/T 22-2015 与等保对涉密流程的要求。**合规红线**
- **根因**：状态机流转校验把"同状态续审"当成非法流转，或审批计数逻辑未区分 `currentLevel < requiredLevel`
- **修复**（工程师）：
  ```ts
  // 仅在状态真正发生变化时校验流转。
  if (nextStatus !== order.status) {
    this.assertTransition(order.status, nextStatus);
  }
  ```
- **我的评审意见**：**明确建议不要**把 `PENDING → PENDING` 加进 `BORROW_TRANSITIONS.PENDING` 白名单。原因是那样会把"合法的多级续审"和"非法的原地空转"混为一谈，污染状态机单一事实源。工程师采纳了 `nextStatus !== order.status` 的写法，判断正确。

---

### Round 2：回归验证 → 路由至 **NoOne**

- 执行 `pnpm test` → **236/236 全部通过**（在 Round 1 的 234 条基础上，新增 2 条针对缺陷 #1 的加固回归用例）
- 复跑 `typecheck` 4/4、`lint` 干净
- `build` 首轮失败 → **发现缺陷 #3**（构建脚本路径 Bug），工程师修复后 `rm -rf dist` 从零重建 **4/4 Done**
- 修复 #3 后再次复跑 `pnpm test` → **10 文件全绿**，构建改动未影响任何用例

> **过程自省**：缺陷 #3 我一开始误判为"中断构建遗留污染，非仓库缺陷"，差点放过一个真实的工程 Bug。是历史后台任务日志里的完整堆栈让我推翻了这个判断。教训：**构建失败必须先看完整堆栈再下结论，不能凭"重跑一次就过了"就认定是环境问题**——重跑能过往往只是因为上次的失败产物被清了，而根因还在。

两条新增回归用例（属于我的测试产物，验证修复不会回退）：

```ts
it('【回归·缺陷#1 加固】未知密级 → 返回空数组（fail-closed，不回落 PUBLIC）', () => {
  expect(builder.levelsAtMost('TOP_SECRET' as SecurityLevel)).toEqual([]);
});

it('未知密级用户生成的 SQL 退化为永假条件（不产生非法空 IN）', () => {
  const { clause, params } = builder.buildSql(snap({ maxSecurityLevel: 'TOP_SECRET' as SecurityLevel }));
  expect(params).not.toContain('TOP_SECRET');
  expect(clause).not.toContain('IN ()');
  expect(clause).toContain('FALSE');
});
```

---

### Round 2b：PRD v1.2 续借规则参数化 + 权限撤权生效 → **发现缺陷 #4**

产品经理裁定续借为「总借期 ≤ 90 天」（PRD v1.1 §5.4 BR-06-1~7）后，新增两组用例：

#### 缺陷 #4：续借并发可绕过次数上限（中 · 数据一致性）

- **位置**：`apps/api/src/modules/borrow/borrow.service.ts` `renew()`
- **复现**：
  ```ts
  await Promise.allSettled([renew('o-1', user, 1), renew('o-1', user, 1)]);
  // 期望：仅 1 个成功；实际：2 个都成功
  ```
- **根因**：典型 read-then-write 且读不加锁——`loadOrder()` 走 `findOne`，两个请求都读到 `renewCount=0`，都通过 `>= MAX_RENEW` 检查，都写入
- **影响**：**用户双击提交即可触发**，BR-06-1（总借期上限）与 BR-06-2（续借次数）同时失效
- **修复**（工程师采纳建议）：
  ```ts
  await this.dataSource.transaction(async (manager) => {
    const repo = manager.getRepository(BorrowOrder);
    const order = await repo.findOne({
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' },   // SELECT ... FOR UPDATE
    });
    // ...全部前置校验与写入均在锁内
  });
  ```
- **我的回归**：并发用例转绿。测试侧需适配 `manager.getRepository()`（原 mock 缺该方法导致 13 条 `TypeError`），已补 `txRepo` + 串行队列模拟 `FOR UPDATE` 互斥
- **连带提醒**：`approve()` 的 `order` 在事务外读取（锁内用的是旧快照），双人同时审批理论上可双通过。已提示工程师，**当前未修复，列入 R6**

#### P0-1 撤权即时生效 —— **验证通过**

新增 `user.permission-revoke-effect.spec.ts`（9 用例），验证产品经理标为最高优先级的安全项：

| 用例 | 结论 |
|------|------|
| 撤权 + `invalidateSnapshot` → 下一次请求立即 403 | ✅ 通过 |
| 【风险实证】撤权但不失效 → 仍可越权 | ✅ 通过（**证明 300s 窗口真实存在**，必须靠主动失效堵住） |
| 密级下调 SECRET→INTERNAL 即时生效 | ✅ 通过 |
| 角色移除后 `grants` 立即收敛 | ✅ 通过 |
| 批量失效覆盖多用户 / 精确失效不误踢 | ✅ 通过 |
| Redis 读失败时降级行为 | ✅ 通过 |

**结论**：主动失效机制**有效且必要**。若某处调用漏了 `invalidateSnapshot`，就会出现最长 5 分钟越权窗口——这条已成为回归必跑项。

#### Round 2b 结果

**12 文件 / 275 用例：274 通过、1 skip、0 失败。** typecheck 4/4、lint 零告警。

---

### Round 3（本轮）：缺陷 #5 + R6 双修复 + C-5 多实例方案 → **路由 NoOne**

**本轮输入**：工程师回报 5 处同类并发缺陷（approve/cancel/lend/giveBack/voidAndReassign）全部按缺陷 #4 同法整改；`maxRenewalDays` 补入 `BorrowRules`；C-5 升级为版本号 + pub/sub 多实例方案。

#### 缺陷 #5 修复验证（单次续借上限）

**源码变更**（`packages/shared/src/enums.ts` + `borrow.service.ts`）：
```ts
// shared：BORROW_RULES 改为结构类型 BorrowRules + BORROW_RULES_FALLBACK，新增 maxRenewalDays
export interface BorrowRules {
  readonly maxTotalDays: number;
  readonly minBorrowDays?: never; // 实际为 minDays
  readonly maxRenewalCount: number;
  readonly maxRenewalDays: number;   // ← 新增字段
  readonly defaultDays: number;
}
// service：锁内新增单次上限校验
if (days > rules.maxRenewalDays) {
  throw new BizException(ErrorCode.BORROW_RULE_VIOLATION,
    `单次续借不得超过 ${rules.maxRenewalDays} 天（本次申请 ${days} 天）`);
}
```

**我的测试改造**：
- 原 2 条「期望失败」的缺陷用例 → 改为 **4 条回归护栏**（恰好上限放行 / 上限+1 拒绝 / 总借期合规不豁免单次上限 / 前置守卫）
- **新增前置守卫**：`expect(Number.isFinite(MAX_SINGLE_RENEW_DAYS)).toBe(true)` —— 专门防 §8.2 那类「字段丢失 → `undefined + 1 = NaN` → 假绿」复发
- 取值改回**从共享常量读**（`BORROW_RULES_FALLBACK.maxRenewalDays`），不再硬编码 30

**回归结果：33/33 通过**，缺陷 #5 关闭。

#### R6 修复验证（approve/cancel 并发）

**源码变更**：`approve()` 整个「读取 → 校验 → 写入」移入 `withOrderLock(orderId, ...)`（进程内按单据串行），外加 `orderRepo.update` 的 `WHERE status + currentLevel` 做 CAS 多实例兜底。同时新增「同一审批人不得重复签署」合规校验。

**我的测试改造（三处关键修正）**：

| 问题 | 我的错判 | 修正 |
|------|----------|------|
| 并发用例显式省略 `level` | 源码 `actingLevel = input.level ?? order.currentLevel`，串行后第二人自动变成第 2 级并成功 → 被误读为「双通过」 | **显式传 `level: 1`**，隔离「并发同请求」与「按当前级别办理」两种语义 |
| 断言 `manager.save` 被调用 | 源码已改走 `approvalRepo.save`（状态推进成功后才写留痕） | 断言改 `approvalRepo.save` + `state.approvals.length` |
| 夹具 `grants: {}` | `canDo` → `checkPermission` 因空 grants 直接 403，测不到并发 | 夹具补 `BORROW_APPROVE: { mode: FULL, ops: ['READ','APPROVE'] }` 与真实角色码 |

**回归结果：11/11 通过**，含 5 条 R6 核心回归（双人同级并发仅一人成功 / 旧快照被拒 / 双级链路 / 同一人不得办两级 / 撤销与审批互斥）。R6 关闭。

> **⚠️ 此处我曾做出错误结论，已更正**：我一度判定 `resolveApproverLevel()` 是**死代码**（"全仓无调用点"），并建议工程师清理。
>
> **这是误报。** 产品经理复核后指出 `borrow.service.ts:269` 确有调用，实测确认实现为 `roles.includes(R4) ? 2 : 1`，**是有效防线**。我当时的 grep 结果来自一份尚未包含该调用的中间快照，且没有二次核验就写进了报告。
>
> 真正的问题不是死代码，而是**这条防线没有任何回归用例**：现有的「越级审批」用例失败来自**次序校验**（`currentLevel` 不符），「同人办两级」用例失败来自**重复签署校验**——`approve()` 里第 269 行的能力校验**从未被单独触发**。若有人把它改成 `return 2`（人人可签终审），当时 11 条用例**全部不会红**。
>
> 已补 **12 条**专属用例（详见下文「能力校验回归」），并用变异测试双向验证有效（见 §4.5）。

#### C-5 多实例撤权方案验证

> **最终轮注记**：本节为 Round 3 历史记录。表中「多实例待补 / 2 条 skip」已于最终轮启封——E 包实装后重写为 T 类 3 条（T1/T2/T3），QA 独立变异验证通过，见 §3.4。下文保留当时口径以呈现演进过程。

**源码变更**：`getSnapshot` 改为版本号 key（`perm:{userId}:v{n}`），`invalidateSnapshot` 走 `INCR perm_ver:{userId}` + `publish perm:invalidate` + 删旧 key 三步；新增 `onModuleInit` 订阅广播清进程内缓存。

**测试改造 —— 按 PM 要求分 A/B/R 三类重构**（原 9 条 → 16 条）：

| 类别 | 条数 | 标注口径 |
|------|------|----------|
| **A 类·机制** | 8 | 测缓存构造本身（版本号 key、TTL 兜底、命中免查库、TTL 不滑动、精确/全量失效、广播发出）。**不标「多实例待补」**——多实例不影响其结论 |
| **B 类·生效** | 5 | 撤权→403（请求级）、密级下调、角色收敛、连续撤权（v0→v1→v2）。**标注「单实例验证通过，多实例待补」** |
| **R 类·风险实证** | 1 | 未调 `invalidate` → 旧权限仍在。**语义已变：证明风险存在，非合规项** |
| B 类 skip | 2 | 多实例双通道语义（版本号 INCR 后旧 key 失配 + pub/sub 清进程缓存），断言已写死 |

**关键断言写法（PM 定死，我照此实现）**：
```ts
// 请求级，不是 TTL 等待级
const t0 = Date.now();
const after = await h.service.getSnapshot('u-1');
const elapsed = Date.now() - t0;
expect(canReadSecret(after)).toBe(false);
expect(elapsed, '不得通过 sleep/等待 TTL 实现失效').toBeLessThan(100);
```

**测试改造中我修掉的 2 处自身 Bug**（非源码问题）：
1. `FakeRedis.delByPrefix` 只扫数据键、没扫计数键 → 全量失效清 `perm_ver:*` 被夹具吞掉 → 假绿。已改为跨两 Map 操作并加注释说明「真实 Redis SCAN 不区分两类键」。
2. `buildSnapshot` mock 签名假设为 `(userId: string)`，实际调用是 `buildSnapshot(user)` → `again.userId` 断言取到 `{id:'u-1'}` 对象。已归一化入参。

**C-5 结论**：单实例撤权即时生效**已验证**（含请求级 403、无等待）；多实例语义**待 E 包完整后按已写死断言启用**。按主理人裁定，**单实例不构成 C-5 达标**，故本轮不计入「C-5 已达标」。

#### C-5 补强：请求级硬用例（本轮新增 9 条，直接对齐主理人口径）

> **触发原因**：主理人验收口径原文是「撤权后当前会话**下一次请求**立即 403（**请求级断言**）」。
> 我上一轮虽然在 B 类里写了 `expect(elapsed).toBeLessThan(100)`，但断言对象是
> `UserService.getSnapshot()` 的返回值——严格说这是 **service 层**，不是请求级。
> 两者不等价，中间还有两个可能出错的环节：**Guard 会不会读这份快照**、**Controller 有没有挂 `@RequirePerm`**。

**新文件**：`apps/api/__tests__/user.permission-request-level.spec.ts`（9 条全绿）

它把链路拉全，中间**没有一处手抄的替身**：

```
PermissionGuard.canActivate        ← 真实源码
    ↑ request[CTX_KEY.USER]
JwtStrategy.validate               ← 真实源码（含 assertUserUsable、getSnapshot）
    ↑
UserService.getSnapshot            ← 真实源码（FakeRedis 模拟共享 Redis）
    ↑
@RequirePerm 元数据                 ← 从 ArchiveController 真身读，不手抄
```

只有 PG/TypeORM（`findOne`/`find` 返回内存对象）与 Redis（FakeRedis）是替身。

| # | 用例 | 断言要点 |
|---|------|----------|
| 1 | 前置自检：`listItems` 确挂 `@RequirePerm` | 从真身读元数据；**漏挂会让全部请求级用例假绿** |
| 2 | 前置自检：无版本号旧 key 不被写入 | 防止后续版本号断言失效 |
| 3 | **【核心】撤 ITEM 权限 → 同一 token 下一次请求被拒** | 不重新登录、不换 token、不重签 |
| 4 | **【核心】生效耗时 < 100ms** | 若实现退化为「等 TTL」→ 变红 |
| 5 | 只移除 `READ` 操作 → 403 且文案含 `ITEM`/`READ` | 越权拦截可追溯 |
| 6 | 撤权后再授权 → 立即恢复放行 | 失效不是单向破坏 |
| 7 | 降密级 SECRET→PUBLIC → 请求 SECRET 资源被拦 | 用 `itemDetail`（`checkScope:true`） |
| 8 | 撤权不影响其他用户 | u-2 照常放行（失效范围精确） |
| 9 | 边界声明：本文件**不覆盖多实例** | 文档化断言，防止把本文件绿当 C-5 达标 |

**写这一组时我踩了 3 个坑（全部是我的测试代码问题，非源码缺陷，已修正）**：

| 坑 | 现象 | 真因 | 处置 |
|----|------|------|------|
| 1 | 前置自检 `expected undefined to be defined` | `SetMetadata` 挂在 **prototype 方法**上，`Reflector.get(key, [handler, class])` 只查 **owned** metadata → 取不到。Guard 内部用的是 `getAllAndOverride`（会沿原型链） | 改用 `getAllAndOverride`，并在注释里写明原因 |
| 2 | 6 条 `expected 1003 to be { code: 1003, ... }` | `ErrorCode.FORBIDDEN` 是 **ErrorCodeDef 对象**（`{code, httpStatus, message}`），不是数字；`.toBe()` 拿对象比数字必然失败 | 改 `.toBe(ErrorCode.FORBIDDEN.code)` / `.httpStatus` |
| 3 | 降密级用例 `expected function to throw, but didn't` | 我起初用 `listItems`，它的 `@RequirePerm` 是 `checkScope: false`；Guard 在 `checkScope === false` 时**提前 return true**，密级整段跳过（`permission.guard.ts:67`）。**这不是缺陷**——列表类接口按设计把密级交给 `AccessFilterBuilder` 行级过滤 | 换成 `itemDetail`（`checkScope: true`），并在注释里写明为什么不能用列表接口 |

> **坑 3 值得强调**：如果我当时直接判定「降密级不生效 → 源码 Bug」并报给工程师，
> 就是一次**误报**。`checkScope:false` 是有意的架构取舍，不是漏检。这类误报对工程师的
> 时间损耗比对漏报更隐蔽——漏报会被线上发现，误报只会消耗信任。

**升级后的口径**：C-5 的「单实例栏」现在有了 **service 级 + 请求级双证据**（16 + 9 条）。但**达标线仍是多实例**，本轮判定不变：**未达标**。

#### Round 3 附带发现：构造签名漂移导致 2 条用例误红（**测试侧问题，非源码缺陷**）

工程师给 `FileService` 插入 `DictService`（第 5 参）与 `ParamService`（第 7 参）后，我的夹具仍按旧顺序传参 → `dict` 落到 `accessBuilder` 位置 → 报 `this.dict.getDownloadMode is not a function`，另有 1 条「自动入抽取队列」因 `paramService` 缺失静默失败。

**我的处置**：补齐 `dict.getDownloadMode` / `getWatermarkTemplate` 与完整 8 参构造。

**为什么记这一笔**：这类「构造参数顺序变更」在强类型语言里本应由编译器拦住，但夹具用 `as never` 强转后**类型系统失效**——这是**测试夹具的固有风险**。缓解办法：夹具构造集中在一个 `makeHarness()`，签名变更只需改一处（本文件已如此，故只花 1 次修复）。**若夹具分散在各 `it()` 里，这次会是 27 条全红。**



### 4.5 能力校验回归：从「裸奔」到「双向变异验证」（本轮新增，**更正一处误报**）

**背景（PM 复核纠正）**：我曾判定 `resolveApproverLevel()` 是死代码并建议删除。**这是误报** —— 该方法在 `borrow.service.ts:269` 有真实调用，是「终审仅 R4 可签」的合规防线。详见 §8.4。

**但 PM 同时指出了一个「真」缺口**，我核实后确认成立：

`approve()` 里有**三道互相独立**的拒绝闸门，当时 11 条用例只打到了 ① 和 ③：

| 闸门 | 判定条件 | 抛出 | 当时覆盖 |
|------|----------|------|----------|
| ① 次序校验 | `actingLevel !== order.currentLevel` | `BORROW_INVALID_STATE` | ✅ 「越级审批」「重复提交」 |
| **② 能力校验** | **`actingLevel > resolveApproverLevel(user)`** | **`FORBIDDEN`** | ❌ **从未被单独触发** |
| ③ 重复签署 | 该审批人已在本单留痕 | `BORROW_INVALID_STATE` | ✅ 「同人不得办两级」 |

**风险量化**：若 `resolveApproverLevel` 被改成 `return 2`（人人可签终审），当时 11 条**全部保持绿** —— 一条合规防线在测试层面完全裸奔。

**新增 12 条用例**（`borrow.approve-concurrency.spec.ts`，11 → 23 条）：

| 分组 | 条数 | 关键断言 |
|------|------|----------|
| 能力校验·接线正确 | 5 | R1 在 `currentLevel=2` 传 `level=2` → **code=1003 + 文案含「无权办理/第 2 级」**；R4 终审放行（正向对照）；R1 初审不受影响；空角色被拒；R4 可办初审 |
| `resolveApproverLevel` 本体 | 7 | R4→2 / R1→1 / 兼任→2 / 空角色→1 / `roles` 缺失→1 且不抛 / 方法存在性前置守卫 / 反假绿元断言 |

**关键设计：断言「拒绝来源」，不只断言「抛了错」。**

只写 `rejects.toThrow()` 的话，①②③ 任一先命中都会让它绿 —— **那还是假绿**。所以：

```ts
expect(err?.code, '拒因必须是 FORBIDDEN（能力校验），而非次序校验').toBe(1003);
expect(err?.message).toContain('无权办理');
expect(err?.message).toContain('第 2 级');
```

次序校验抛 `BORROW_INVALID_STATE`（3005 系），能力校验抛 `FORBIDDEN`（1003） —— **code 不同，所以能区分**。这是本组用例成立的唯一依据，已写入注释。

**变异测试双向验证**（不靠「我觉得它能抓」）：

| 注入变异 | 被抓住的用例 | 结果 |
|----------|--------------|------|
| `return 2`（人人可签终审） | R1 冒充终审 / 空角色被拒 / R1→1 / 空角色→1 / roles 缺失→1 / 反假绿元断言 | **6 红** ✅ |
| `return 1`（无人可终审） | 双级完整链路 / R4 终审放行 / R4→2 / 兼任→2 / 反假绿元断言 | **5 红** ✅ |

两个方向都被抓住 → 用例不是摆设。源码已恢复原状（`grep` 确认 `borrow.service.ts:845` 为 `roles.includes(RoleCode.R4) ? 2 : 1`）。

> **为什么单独记一节**：这是本轮唯一一次「**误报 + 真缺口**」同时出现在同一处代码。
> 我错在「以为它是死的」，PM 对在「它其实是活的但没人测」。
> 若两边都没核实：**要么工程师删掉一条合规防线，要么它坏掉时没有任何用例报警。**
> 交叉复核在这里救了两次。


---

## 五、残留风险清单（无法签字担保的部分）

### R1｜集成环境受限 —— **联调轮已解除三项、保留两项（2026-11-07 终判复核）**

**终判状态**：PG 行锁/真实发号（200×10 压测七项判据全绿）、ES 容器与 IK 分词（实测通过）、Redis 单机运行时（healthy）三项已由联调实证解除；**MinIO 文件链路与多容器 pub/sub 跨进程两项仍保留**（见下表与 §六「MinIO 归档遗留项」）。

**逐项复核（原「只在 mock 层验证」的四项 → 终判残余风险）**：

| 依赖 | 未验证的真实行为 | 我的替代验证 | 残余风险 |
|------|------------------|--------------|----------|
| PostgreSQL 行锁 | `SELECT ... FOR UPDATE` 真实锁语义、事务隔离级别、死锁自动解除 | 200 并发 × 10 轮 `Promise.all` + 按 scope 串行队列模拟，零重号零断号 | ✅ **已解除**：终跑 200×10 全绿（2000/2000、零重号零断号），真实 PG 行锁下序列原子性实证；现场还抓出并修复 #11 客户端自死锁（真实并发 > 池上限） |
| Elasticsearch | 真实 DSL 是否被 ES 8 接受、`keyword` 与 `text` 映射差异、分片下过滤一致性 | 捕获实际请求体，断言 `query.bool.filter` 含 `securityLevel` terms / `deleted` / `fondsId` | ✅ **已部分解除**：ES 容器 healthy、IK 分词 `_analyze` 实测通过；完整 DSL 端到端执行未列入本轮范围，残余风险降为低 |
| MinIO | 真实分片上传、`composeObject` 合并、大文件断点续传 | 校验 `minio@8.0.7` SDK 14 个方法存在 + `MinioService` 方法契约 + SHA-256 空串基准 `e3b0c442…` | ❌ **中·保留（不可签）**：官方镜像归档停服（Docker Hub 仓库消失、dl.min.io 410 Gone），`docker-compose.nominio.override.yml` 仅联调摘除、主 compose 未改；替代对象存储选型待拍板，P0 文件链路未验证 **【2026-11-09 阶段二 A 档部分解除：替代选型已定 SeaweedFS 方案 A 并实证，本行升级为「部分解除（限定范围）」，见下方 R1 结案更新段；「文件入库/挂接/预览/SHA-256 完整性 + S3 wire 层」解除，「下载业务放行」仍不可签（L2）】** |
| Redis | 真实 TTL 过期、集群模式下 `delByPrefix` 的 SCAN 实现 | `FakeRedis` 模拟 get/set/del，断言 `CACHE_TTL.PERMISSION === 300` | ⚠️ **单机已解除、跨进程保留**：单机 Redis healthy；**多容器 `--scale api=2` 下 pub/sub 跨进程投递未跑**，仅同进程双实例实证（版本号 INCR + publish） |

---

### R1 结案更新（2026-11-09 · 阶段二独立验证完成 · MinIO 行升级为「**A 部分解除（限定范围）**」）

> **裁定**：主理人采纳 QA §8 三档 **A 档**意见（`docs/QA-文件链路验证方案.md` §8）。判据演进 v1.2→v1.3 全程经主理人逐项裁定授权并留痕（`a83437d`→`4f5b1eb`），无静默、fail-closed 未破；self-test `PASS (30/30)`；core **20/20 `IS_PASS: YES`**（`SCOPE: CORE`）。

**证据绑定与三链路依据**（全部可追溯）：
- **测试对象与栈**：HEAD `5a0fbc2` + 离线栈 `docker-compose.offline.yml` 8/8 healthy（api `objectStorage.ok=true`）+ 镜像包 `offline/tianji-offline-images.tar`（SHA256SUMS sha256 `50fde9a8…`，SAVE_EXIT=0，L0 锚 4/4，BUILD-INFO HEAD `aa7a248`）；
- **链路① QA 脚本 wire 全链**：门禁 G0/G1/G2 + C01~C16 + C18（真实 S3 网关 + minio@8 SDK 调用序列 + 原生 SigV4/HTTP），core 20/20，日志 `qa-file-pipeline-stage2-core-v13-20261109090025825.log`；判据引擎自证 `qa-file-pipeline-stage2-selftest-v13-20261109090006172.log`；阶段二首跑 3 FAIL（17/20）经归因均为判据/裁定层，按主理人四项裁定修正后闭环（提交 `eb58a02` / `4f5b1eb`）；
- **链路② 业务链路实测**（stagec1，D-1 合规不制造授权）：预览放行 `GET /api/files/:id/preview` 真实取回，sha256 与 DB `electronic_file.sha256` **全等**；下载 fail-closed 403/`code=4007` 拒绝正确；强制留痕 `DOWNLOAD … DENIED` / `PREVIEW … SUCCESS`；日志 `qa-stage2-download-20261109164940.log`；
- **链路③ C4 CORS 独立复核**：OPTIONS 预检四头对照 `lead-stage-c4-cors-headers-20261109153324.log` 原值逐头一致；**带签名真实 PUT 200 + 非空 ETag**（架构师【不确定】项 13 闭环）；负向对照不带 Origin = 0 个 CORS 头；日志 `qa-stage2-cors-20261109165117.log`。

**A 档解除范围（限定）**：仅解除上表 MinIO 行中「**文件入库 / 挂接 / 预览 / SHA-256 完整性**」与「**S3 wire 层（含 `presignGet` 下载技术链路）**」的不可签；判据演进依据：C01 收权正验证（s3.json identity 收权，业务身份建桶应被拒）、C02 meta 双形态等效（SeaweedFS 剥前缀，生产零消费面已查证）、C08 三头效果判据（`*` 通配 + `credentials=omit` 守卫）——均为主理人裁定授权的语义更正，**不是放宽**。

**技术层**：「**S3 协议下载技术链路已验证**」——服务端 `presignGet` 生成预签名 GET URL → 浏览器可达 host `127.0.0.1:8333` 实际 GET → 内容与源文件 SHA-256 一致（含 Range）。
**业务层（另起一句）**：「**下载业务放行链路未验证**」——`approval` 模式授权写入链路未实现（属 L2 上线前**功能补全项**，借阅审批与 FILE DOWNLOAD 授权打通，非缺陷）。

**逐字固定表述**（方案 §2.5）：
> 「**下载放行链路未演示**。`approval` 模式的下载授权写入链路未实现（上线前闭环项 L2），本次 demo 仅验证预览可用与下载 fail-closed 拒绝正确；QA 技术层另行验证 SeaweedFS `presignGet` 下载 wire 链路。**不构成下载功能已验证的结论。**」

**未实测项（如实登记，不默认成立）**：`credentials=omit` 前端**运行时**配置（静态守卫 CLEAN 只证明源码没写，浏览器 `fetch(credentials:'omit')` 读 etag 闭环未执行）；CSP `connect-src 'self'`（`apps/web/nginx.conf:19`）的浏览器级实测（架构师进行中，结论前不下修复指令）；浏览器真实同源策略行为（脚本证据为原生 HTTP wire 层）；full 套件（2GB/410 片边界）未跑；「四性检测」按 S8 纪律只认完整性 SHA-256，真实性/安全性 `UNKNOWN`。

**例外条件 2 条（本结论绑定以下条件，超出须按归因三查重新验证，不自动延续）**：
1. **镜像源**：本次交付镜像构建期 `COREPACK_NPM_REGISTRY=https://registry.npmmirror.com`（`offline/README.md:263` 实测口径），pnpm@9.12.0 tarball 经 npmmirror 获取、integrity 仍按 registry 元数据 sha512 校验；QA 证据绑定该镜像包（SHA256SUMS `50fde9a8…`）。**换源重建或更换镜像 → 须重跑 QA `--suite core` 重新出具意见。**
2. **Node fetch 与三链路形态**：buildkit 构建网络、宿主直连、`docker run` 默认 bridge 三条链路连通性互不相同，Node 22 fetch 不读代理 env（`offline/README.md:263`）；本结论 wire 证据全部绑定「宿主机直连栈（`127.0.0.1:8333` / `localhost:8080`）」。**跨机部署（`S3_PUBLIC_ENDPOINT` 改局域网 IP）、反代收敛同域、或经代理访问 → CORS/可达性结论不自动延续**，须按归因三查（Origin / 同域反代 / credentials）重验。

**禁用措辞**（D-4 / §8）：不写「下载已验证」「下载受控通过」「文件链路已完整闭环」「R1 全部关闭」「四性全通过」。

---

### R2｜权限缓存 300s 窗口（**口径已更新：不再是「设计可接受」**）

- **旧表述（作废）**：「TTL 300s，最长 5 分钟生效，属设计取舍」
- **新口径（v1.3 C-5 裁定）**：生效靠**版本号 INCR + pub/sub 广播**，TTL 仅兜底。`user.service.ts` 中「保证 5 分钟内生效」的注释**已清除**（我在 Round 3 核对确认）。
- **因此**：300s 窗口**不是设计意图**，而是「`invalidate` 调用链漏一处」时的**故障后果**。
  - `user.permission-cache.spec.ts` 的「R【风险窗口】」用例语义已从「描述现状」改为「**断言一个不允许存在的状态**」。它绿 = 风险仍在，**不是合规通过**。
  - C-5 达标要求：`PERMISSION_MUTATIONS` 10 处入口 `invalidate` 调用链 100% 覆盖 + 多实例双通道有效。
- **判定**：见 R6-1。**当前 C-5 未达标**。

---

### R3｜借阅续期语义（**已由 PM 裁定，非缺陷**）

- 测试最初现象：对剩余 10 天的借阅续期，期望成功；实际抛 `3004 借期不得超过 90 天`
- 我初判为"需求语义未明"（从今日起算 vs 累计借期），未作为缺陷上报
- **产品经理裁定（PRD v1.1 §5.4 新增 BR-06-1 ~ BR-06-7）**：采用「**借期总长 ≤ 90 天**」语义，上述拒绝为**正确行为**
- **处置**：该用例已改写为正向断言保留；新增 `borrow.renewal-boundary.spec.ts`（33 用例）完整覆盖裁定后的 7 条规则
- **结论**：本条关闭，不再列为歧义项

> 附带确认：`maxTotalDays=90` / `maxRenewalCount=1` / `maxRenewalDays=30` 现由 `sys_param` 运行期下发，`BORROW_RULES_FALLBACK` 仅容错兜底。用例统一从共享常量取值，口径调整无需重写用例。

---

### R4｜未覆盖模块

- `archive.service.ts` 仅 42.83%：导出、批量归档、统计分析等分支未测
- `user.service.ts` 仅 24.06%：用户 CRUD、角色分配未测
- `search.service.ts` 分支覆盖 47.5%：中文分词、检索降级路径未充分测试
- **影响**：这些模块若存在缺陷，我**没有证据说它们是对的**。它们不在本轮 T01–T05 验收的核心链路内，但上线前建议补测。

---

### R5｜2GB 边界为逻辑边界而非真实大文件

- `file.sha256-integrity.spec.ts` 中 2GB 边界通过构造 size 数值验证，**未真实写入 2GB 数据**
- 真实场景下 Node 内存、MinIO 分片数、流式计算哈希的稳定性未经压测

---

### R6｜`approve()` / `cancel()` 并发窗口（**Round 3 已修复并回归通过**）

发现缺陷 #4 时顺带识别，Round 3 由工程师整改、我回归验证：

- **修复前**：`approve()` 的 `order` 在事务外 `loadOrder()` 读取，事务内用旧快照。两名审批人同时审批时都能通过级别校验。
- **修复后**：
  1. 整个「读取 → 校验 → 写入」移入 `withOrderLock(orderId, ...)`（进程内按单据串行）
  2. `orderRepo.update` 的 WHERE 携带 `status + currentLevel`，做 CAS 多实例兜底
  3. 新增「同一审批人不得重复签署」合规校验（一人不能独立完成两级审批）
- **同类 5 处**：`approve` / `cancel` / `lend` / `giveBack` / `voidAndReassign` 全部纳入整改（工程师确认）
- **我的回归**：`borrow.approve-concurrency.spec.ts` **23/23 通过**（R6 并发安全 11 条 + 能力校验 12 条），含双人同级并发仅一人成功、旧快照被拒、双级链路、同人不得办两级、撤销与审批互斥、终审仅 R4 可签

**残余**：`withOrderLock` 是**进程内**互斥，多实例部署下依赖 DB CAS 兜底。CAS 在单测中只能模拟 `affected: 0`，**真实 PG 下 `WHERE` 命中语义未经联调验证**（见 R1）。

#### R6-2｜审批人级别能力校验曾「零回归」（**本轮新增用例后关闭**）

| 项 | 内容 |
|----|------|
| **防线** | `borrow.service.ts:269` `actingLevel > resolveApproverLevel(user)` → 终审（第 2 级）仅 R4 可签 |
| **PRD 依据** | §3.2 借阅审批行 `R1 ✔ / R4 ○（重要件）`，「○」即二级终审限 R4 |
| **发现前的状态** | 该判定**从未被任何用例单独触发**。现有「越级审批」被次序校验先拦、「同人办两级」被重复签署先拦 |
| **风险** | 若实现被改为 `return 2`（人人可签终审），当时 11 条用例**全部不会红** —— 涉密终审权限可被任意审批人取得而不被发现 |
| **处置** | 新增 12 条用例（5 条接线 + 7 条本体），断言 `code=1003` 锁死拒绝来源 |
| **验证强度** | **双向变异证明**：注入 `return 2` → 6 条红；注入 `return 1` → 5 条红。两个方向都抓得住 |
| **状态** | ✅ **已关闭**（不再列为待办） |

> **发现过程值得记**：这条是我误报「死代码」后，由 PM 复核纠出来的。
> 我给出的结论错了（"死代码"），但顺带暴露的观察（"这条线没人测"）方向是对的 —— 只是我当时归因错了。
> 交叉复核的价值在这里体现：**PM 纠正了我的错误结论，同时把我的半对观察坐实成了可执行项。**

---

### R6-1｜C-5 权限撤权：覆盖矩阵与调用链（**最终轮更新：两栏均已达标，见文末注记**）

主理人裁定：C-5 达标线是**多实例部署下撤权后下一次请求即 403**。据此，两栏分开记：

#### 栏 A：多实例语义（**最终轮更新：已实证达标** —— T 类 T1/T2/T3 用例启封，同进程双实例共享 FakeRedis 复现跨实例语义；QA 独立变异验证「禁用广播处理恰好红 T2」、工程师反向「禁用 INCR 恰好红 3 条」，两通道互不遮蔽。见 §3.4）

| 通道 | 实现 | 验证状态 |
|------|------|----------|
| 版本号 INCR | `perm_ver:{userId}` 自增 → 旧 key `perm:{id}:v{n-1}` 天然失配 | 单实例已证；多实例 2 条 skip 待补（*注：Round 3 当轮口径，skip 已于 `8166c47` 清零，见 §3.4*） |
| pub/sub 广播 | `perm:invalidate` → 各实例清 `localSnapshotCache` | 单实例已证「广播已发出」；跨实例投递 2 条 skip 待补（*注：Round 3 当轮口径，skip 已于 `8166c47` 清零，见 §3.4*） |

> 两通道**都必须有用例**：只测广播，无法发现「版本号计数键被误删」；只测版本号，无法发现「进程内缓存未清」。已按此写好 2 条 skip 的断言。

#### 栏 B：调用链覆盖（**最终轮更新：已达标** —— 测试级一致性守卫 20 条 + 独立 CI 静态脚本 `scripts/ci-check-permission-mutations.cjs` 已落地并注册 `ci:check`，R1/R2/R3 三规则，反向变异可抓漏）

- **漏法差异**：栏 A 的漏 = 广播没发出去；栏 B 的漏 = `invalidate` 压根没被调用。两者独立，都要守。
- **清单已单源**：`PERMISSION_MUTATIONS` 已迁 `packages/shared/src/permission-mutations.ts`，共 **8 条入口 + 1 条显式排除**（`borrow.approve.self-check`）。
- **规则已落地（测试级）**：新增 `apps/api/__tests__/permission-mutations.consistency.spec.ts` **18 条**，
  从 shared 取清单、反射扫源码方法体，逐条核对「该方法体内是否调用 `invalidateSnapshot`」，
  且验证排除清单**被真正读取**（详见下方「回应 PM 的疑问」）。
- **显式排除**：`borrow.service.ts:232-234` 的**自审拦截**不读权限快照、不经过缓存，
  已在 `PERMISSION_MUTATION_EXCLUSIONS` 声明；测试里同时验证**排除理由本身成立**
  （`approve()` 确实不调 invalidate、且依据是 `applicantId === user.userId` 字段比对）。
- **仍缺**（*注：Round 3 当轮口径，该 CI 脚本已于 D 包落地为 `scripts/ci-check-permission-mutations.cjs` 并注册 `ci:check`，见节标题注记*）：仓库内**没有 CI 静态自检脚本**（`package.json` 无相关 script，也无校验脚本文件）。
  当前规则靠 `pnpm test` 执行——覆盖本地与跑测试的 CI，但**不是独立的静态检查**。
  独立 CI 脚本落地后，本测试应保留为补充（测试能即时反馈，CI 脚本通常只在 PR 跑）。

##### 回应 PM 的疑问：CI 规则会不会「扫到 self-check」？

> PM 原话：「如果 CI 规则是简单的『调用这些方法必须有 invalidate』，而没有『排除列表』的加载逻辑，self-check 这条依然会被当成疑似遗漏。」

**这个担心是对的，而且不能靠口头保证。** 我的处置是把它写成**可执行断言**，并做了变异验证：

| 场景 | 用例 | 结果 |
|---|---|---|
| 正常状态：清单 8 条 + 排除 1 条 | 逐条核对方法体含 invalidate | 18/18 绿 |
| **变异①**：删掉 `updateUserScopes` 的 invalidate 调用 | 对应条目变红（其余 17 条绿） | ✅ 抓住 |
| **变异②**：把 self-check 强行塞进正清单（模拟不读排除列表） | `borrow.approve.self-check` 条目变红 | ✅ 抓住 |

变异② 正是 PM 担心的场景——**如果检查器不读排除列表，这条会红，逼人去看排除清单**。
也就是说：**本文件不是"验证排除列表存在"，而是"验证排除列表被使用"**。

另加一条防滥用断言：排除集合**只允许含 self-check 一条**。若将来有人为了消红把真入口塞进排除列表，会立刻红并要求在报告中说明理由。

**当前判定**（最终轮更新）：**C-5 已达标** —— 栏 A 已启封为 T 类 3 条（`8166c47`），栏 B 独立 CI 静态脚本 `scripts/ci-check-permission-mutations.cjs` 已落地并注册 `ci:check`（R1/R2/R3，反向变异可抓漏，QA 独立实跑验证）。*注：下方 642/643 两栏保留 Round 3 当轮表述以呈现演进，缺口此后均已关闭。*
- 栏 A（多实例）：**未达标**（2 条 skip 待 E 包）（*注：Round 3 当轮口径，8166c47 已启封为 T 类 3 条，栏 A 已达标*）
- 栏 B（调用链）：**测试级已达标**（18 条 + 双向变异验证），**独立 CI 静态脚本仍缺**（*注：Round 3 当轮口径，CI 脚本已于 D 包落地，见节标题注记*）

单实例证据链现为 **19 + 9 + 18 = 46 条**（缓存机制 / 请求级链路 / 调用链规则）。

**本轮补强（部分收窄未达标范围）**：

- 栏 A 的「把守拦截环节」这一环已补硬证据 —— `user.permission-request-level.spec.ts` 打通
  `JwtStrategy.validate → PermissionGuard.canActivate → @RequirePerm` 全链路，证明**撤权后
  同一 token 的下一次请求确实被 403 拦下**，且耗时 < 100ms。
  这排除了「service 层失效了但 Guard 读了旧数据」这一具体漏法；
- 但**多实例广播（跨实例投递）仍未证**，栏 A 判定**不变**；
- 栏 B **未动**：`PERMISSION_MUTATIONS` 迁 shared + CI 静态自检仍是工程师侧待落地项。

> 一句话：**「单实例不留 300 秒窗口」已是请求级硬证据；「多实例不留窗口」仍是推断。**

---

### R7｜参数管理「基础设施完整、业务侧已基本接入」（**D-1 大幅推进；D-2 已关闭**）

> **口径更正说明**：本节初版误判为"参数系统未实现"。经产品经理指出、我逐处复核后更正。
> 错误原因：检索时用 `grep system-param|SystemParam`，只命中实体文件便下结论；正确查法是 `grep getNumberParam|getBoolParam`。
> **定性差异很重要**：「未实现」意味着要重做模块、影响排期；「未接入」只需改 22 处调用点 + 补校验层，工作量小得多。

**已存在（基础设施完整）**：

| 组件 | 状态 |
|------|------|
| `SystemParam` 实体 | ✅ `infra/database/entities/system-param.entity.ts` |
| 参数读写服务 | ✅ `dict.service.ts`：`listParams` / `getParam` / `getBoolParam` / `getNumberParam` / `upsertParam` |
| 接口 | ✅ `GET /api/params`、`PUT /api/params`（含 `RequirePerm` 权限控制） |
| 管理端页面 | ✅ `apps/web/src/pages/system/ParamsPage.tsx` |
| 缓存与失效 | ✅ `CACHE_KEY.PARAM + key`，保存时 `redis.del` 主动失效 |

**Round 3 更新 —— 接入已大幅推进**：

| 检查项 | Round 3 实际状态 |
|--------|------------------|
| `borrow.*`（总借期/续借次数/单次上限/默认天数/逾期提醒） | ✅ **已接入**：`getBorrowRules()` + `getInt('borrow.overdue_remind_days')` |
| `security.session_timeout_min` | ✅ **已接入**：`AuthService.readSessionTimeoutMinutes()`，QD-1 落库 |
| `security.permission_cache_ttl_seconds` | ✅ **已接入**：`UserService.permissionCacheTtl()` |
| `recycle.retention_days` | ✅ **已接入**：`recycle.service.ts` |
| `preview.download_mode` / 水印 | ✅ **已接入**：`DictService.getDownloadMode()` 等 |
| 区间校验、跨参数校验 C-1~C-5 | ❌ 仍未实现 |
| 参数变更留痕（操作人/旧值/新值/原因） | ❌ 仍未实现 |
| `PARAM_DEFS` 单一源 + `deriveParamKey()` | ✅ **已重构**（D-2 关闭）：`param-defs.spec.ts` 16 条守护 |

**仍存的典型故障表现**：管理端把 `borrow.overdue_remind_days` 设超区间（如 400）→ 无校验层拦截，直接落库 → 业务侧读到 400 后行为不可预期。**区间/跨参数校验是 D-1 的最后一块缺口。**

#### R7-1 参数键命名与种子数据三方不一致（**D-2 已关闭**）

Round 3 前：`PARAM_KEY` 硬编码 5 个 key 与架构 §4.3 不一致。

**Round 3 修复**：`PARAM_KEY` 改为 `deriveParamKey()` 从 `PARAM_DEFS` 自动派生（常量名 = key 大写、`.` 换 `_`），**key 漂移在结构上不可能再发生**；另保留 `LEGACY_PARAM_KEY` 供迁移脚本读取旧值，业务代码禁止引用。我新增 `param-defs.spec.ts`（16 条）守护：key 唯一性、默认值在区间内、派生一致性、`isDirectReadParam` 分组正确。

**遗留**：`seed-data.ts` 的种子值与 PRD 文案仍有差异（`session.timeout.minutes=120` vs 文档 30）。**以数据库实际值为准**设计用例，不按文档。

#### R7-2 待接入后补测清单（13 条 → **9 条已转真，4 条仍待**）

| # | 用例 | 状态 |
|---|------|------|
| 1 | `borrow.max_total_days` 越界拒绝（0/400，区间 1–365） | ❌ 待区间校验层 |
| 2 | 跨参数校验 C-1（`default_days` 40 > `max_total_days` 30 → 拒绝） | ❌ 待跨参数校验 |
| 3 | 跨参数校验 C-2（`max_renewal_days` > `max_total_days` → 拒绝） | ❌ 待跨参数校验 |
| 4 | C-4（`audit.retention` 3→10 年需"存储容量复核"提示） | ❌ 待变更留痕 + 提示 |
| 5 | 参数变更留痕五项齐全 | ❌ 待实现 |
| 6 | 生效时效 ≤60s | ⚠️ 部分（`security.*` 直读已即时；其余 60s 缓存未专项验证） |
| 7 | `borrow.renew.max = 0` 时禁止续借 | ✅ 已由 `renewal-boundary` 覆盖（`MAX_RENEWAL_COUNT`） |
| 8 | `recycle.retention.days = 7` 时 8 天前条目被清理 | ✅ 源码已接入，未写专项用例（建议补） |
| 9 | `backup.retention_copies = 7` 时第 8 份被清理 | ⚠️ 源码未接入（`backup.service.ts` 有未用 `PARAM_KEY` 导入） |
| 10 | `permission_cache_ttl_seconds = 0` 时权限变更即时生效 | ✅ 已由 `permission-cache` A 类覆盖 TTL 读取路径 |
| 11 | `borrow.overdue_remind_days = 7` → 提醒范围变 7 日内 | ✅ **已覆盖**（`overdue-remind` 9 条） |
| 12 | **`borrow.overdue_remind_days = 0` → 完全不提醒** | ✅ **已覆盖**（`Number.isFinite` 而非 `\|\|`，含陷阱对照用例） |
| 13 | 单次续借上限 | ✅ **已覆盖**（缺陷 #5 回归护栏 4 条） |

#### R7-3 缺陷 #5 单次续借上限缺失（**Round 3 已修复，转为回归护栏**）

- **修复前性质**：即使把 30 硬编码进去也没有这段校验逻辑 → 属**新增校验**，不是改读数来源
- **修复**：`BorrowRules` 新增 `maxRenewalDays` 字段；`renew()` 锁内 `if (days > rules.maxRenewalDays) throw`
- **我的用例改造**：原 2 条「期望失败」缺陷用例 → **4 条回归护栏**，并**新增前置守卫** `Number.isFinite(MAX_SINGLE_RENEW_DAYS)` 专防 NaN 假绿复发
- **回归结果**：33/33 通过，缺陷关闭

**测试方法论记录 —— 两次险情**：
1. **假绿**：初版用 `BORROW_RULES.maxRenewalDays`，因该字段不存在得到 `undefined + 1 = NaN`，被 `Number.isFinite` 入参校验拦下 → 用例"通过"但原因是 NaN。改为硬编码 30 才测出真缺陷。**修复后该字段真实存在，我仍保留守卫断言**——防止将来字段被改名/删除时再次静默失真。
2. **假阴性**：初版"余 60 天续 45 天"因总借期 105 > 90 被拒，看似通过实则走错分支。改为 `expectReturn=+40`（总 85 合规）才真正命中单次维度。

> 教训：**"因为别的原因通过/失败"最容易骗过自己**。设计用例时必须确保失败原因唯一归因。

---

## 六、验收结论

| 维度 | 结论 |
|------|------|
| 构建可复现 | ✅ 删空 `dist` 后从零重建 4/4 稳定通过（含 shared 产物自检 7 modules） |
| 静态检查 | ✅ typecheck 4/4、lint 零告警（含测试文件，`--max-warnings=0`） |
| 核心业务逻辑 | ✅ **436 用例通过 / 0 失败 / 0 跳过**，#1–#14 十四个缺陷全部修复并回归验证（见 §七） |
| 安全红线（权限） | ✅ 四要素矩阵 + fail-closed 已验证；撤权即时生效单实例已验证（service 级 + 请求级双证据）；**多实例双通道已实证**（T1/T2/T3，QA 变异验证「禁用广播恰好红 T2」，见 §3.4） |
| 合规红线（涉密审批） | ✅ 双级审批 + 并发窗口 R6 已修复（23/23 回归，含 12 条能力校验用例 + 双向变异验证） |
| 单次续借上限 | ✅ **缺陷 #5 已修复**（4 条回归护栏 + NaN 前置守卫） |
| PRD v1.3 参数化能力 | ✅ 22 项参数单一源 + 三层生效分类（D-1 结构性保证）+ 跨参数校验 C-1~C-5（blocking 已验证）+ `verify:params` **107/107 断言**（QA 独立实跑） |
| 权限变更入口完整性 | ✅ `PERMISSION_MUTATIONS` 单一源（8+1 排除）+ 测试级一致性守卫 20 条 + **独立 CI 静态脚本**（R1 正向/R2 反向/R3 自证，`pnpm ci:check` EXIT=0，反向变异可抓漏） |
| 更名（泰坦→天玑） | ✅ QA 五点验收通过：路径/包名/零残留/全量复跑/shared 恢复文件抽查 + build/typecheck 独立复跑 |
| 版本控制 | ✅ git 基线 `902f114` 可用，工作区仅有本报告与 测试方法学规范 的文档改动 |
| 真实中间件联调 | ✅ **完成（限定范围）** —— 五服务 healthy（minio 红为预期，degraded 如实记录）；迁移 5/5；seed 成功；IK 分词实测通过；**终跑 200×10 档号压测七项判据全绿**（`IS_PASS: YES`，日志 `docs/perf/runs/danghao-200x10-PASS-20261107-173726.log` 已入库）；双轨锚定已采。现场共修复并回归 9 个缺陷（#6~#14）。**两项如实排除**：MinIO 文件链路、多容器 pub/sub 跨进程 |

### **最终判定：PASS（限定范围）** —— 2026-11-07 联调轮终判复核后升级

**升级依据（三档评估框架全部满足，逐项证据见下「联调现场实录」）**：①压测原始数据落盘且七项判据全绿（QA 独立复算）；②迁移/seed/IK/health 证据链交叉复核无矛盾；③现场缺陷 #1–#14 全部有关闭证据（修复 + 防回归 + 变异验证）。

**可以签字的部分**：业务逻辑、权限模型、状态机、档号引擎、完整性校验、审批并发安全、参数化体系、权限撤权机制（单实例）、更名完整性、**真实 PG 行锁下的 200×10 并发发号（零重号/零断号/零解析失败）**、ES 容器与 IK 分词、Redis 单机运行时、容器启动装配层、迁移与 seed 链路——有 **436 个通过用例** + 107 项参数行为断言 + CI 静态门禁 + 终跑压测日志兜底，**#1–#14 十四个缺陷全部关闭**。交付核对清单 46 项抽查 14 项全部属实。

**仍不能签字的部分（如实保留，不因升级 PASS 消失）**：
1. **MinIO 文件存储真实链路**（R1）—— 官方镜像归档停服（Docker Hub 仓库消失、dl.min.io 410 Gone），`docker-compose.nominio.override.yml` 仅为联调摘除、主 compose 未改；替代对象存储选型待拍板（工程师方案集推荐 SeaweedFS 方案 A），P0 文件入库/下载/四性检测链路未验证；
2. **多容器 pub/sub 跨进程投递**（R1）—— `--scale api=2` 未跑，仅同进程双实例实证（版本号 INCR `perm_ver:{userId}` + publish `perm:invalidate`）。

上线前若需关闭上述两项，分别补：替代对象存储选型落地 + 文件管线联调；多 api 实例撤权验证。

**上线前置条件（Docker 环境，用户侧前置：Docker Desktop WSL2 初始化需手动完成一次；本轮联调已按此序列实跑通过）**：
```bash
mkdir -p volumes/{postgres,wal_archive,esdata,minio,redis,backup}
cp .env.example .env   # 改 5 个口令
docker compose build && docker compose up -d
docker compose exec api pnpm migration:run && docker compose exec api pnpm seed
docker compose exec -e CONCURRENCY=200 -e ROUNDS=10 api pnpm --filter @tianji/api perf:danghao
# 另需：IK 分词冒烟（详见 docs/部署与压测启动手册.md）；多实例 C-5 用例已启封为单测 T 类 3 条，无需容器侧操作
```

> **压测证据的锚定强度须分两层表述**（`apps/api/package.json` `perf:danghao` 实为 `ts-node src/scripts/danghao-concurrency-bench.ts`，压测侧跑 TS 源码；`.dockerignore` 已由 `b26ab71` 补齐，宿主 dist 与容器 dist 仍是独立文件）：
> 1. **判据层（TS 源码）**：source 锚 + 工作区 clean 证明「跑的是 commit X 的判据」；
> 2. **被测服务层（dist 产物）**：`docker compose up -d --build` 防旧层 + dist 锚必须 `docker compose exec api sha256sum` **从容器内取**。
> 两处锚不同文件：`dist/main.js` 锚被测服务；`dist/scripts/*.js` 锚压测脚本编译产物（本次 ts-node 跑源不执行它，作防御锚）。

**本次双轨锚定取证（team-lead 通报值；QA 独立复算 source 锚一致，dist 锚为容器内值、本地不可重算；完整 sha256 见 `docs/perf/PERF-TEMPLATE.md` §1.4 `4f0a69e` 回填块）**：

| 层 | 文件 | sha256（通报值前 8 位） | QA 复核 |
|---|---|---|---|
| 判据层（宿主 source） | `danghao-concurrency-bench.ts` | `8dd22e7b…` | ✅ QA 本地 `sha256sum` 独立复算一致（宿主工作区 == HEAD，clean） |
| 判据层（宿主 source） | `danghao-bench-judge.ts` | `a883e638…` | ✅ QA 本地独立复算一致 |
| 镜像新鲜度（容器内 source） | `danghao-concurrency-bench.ts` | `8dd22e7b…` | ✅ 与宿主一致（team-lead 容器内取值） |
| 镜像新鲜度（容器内 source） | `sequence.service.ts` | `907af8a2…` | ✅ QA 本地独立复算一致，与容器内通报值相同 |
| 被测服务层（容器内 dist） | `danghao-concurrency-bench.js` | `7ac38e06…` | 通报值，容器内取；本地不可重算 |
| 被测服务层（容器内 dist） | `danghao-bench-judge.js` | `71d76aa7…` | 通报值，容器内取；本地不可重算 |

> 报告分「判据层 / 被测服务层」两层写，不合并成一句「版本已锚定」。**复核深度如实声明**：镜像新鲜度由「容器内源码 hash == 宿主 HEAD」佐证，等价性优于单看 build 是否 CACHED；`PERF-TEMPLATE.md` §1.4 已由工程师 `4f0a69e` 回填终跑实测（**QA 终判 8c1d803 时点之后完成**）：两个 source 锚与 `sequence.service.ts` 的完整 sha256 落盘（QA 本地复算一致）、dist 锚按通报前 8 位记录并标注「容器内取、本地不可重算」；三行一致性核对表 ①工作区 clean ☑ ②镜像新鲜度 ☑ ③build CACHED 判定**如实不勾**（未单独留存 build 日志，以更强证据替代，不伪造证据），模板「结果」列仍留 ☐ 供每次压测重填（防复制模板继承旧勾的新形态假绿）。三处旧措辞（无 bind mount 的真实风险是整镜像过期、`.dockerignore` 已存在、dist 为防御锚非执行体）一并修正。此处为 QA 报告内的落盘记录，与模板回填同源一致。
联调与压测已全部通过，**2026-11-07 QA 终判复核后升级为 PASS（限定范围）**，详见下「终判升级评估框架」。

### 联调现场实录（2026-11-07，终判复核定稿）

#### 已确认项（QA 终判复核结论）

| 项 | 通报内容 | QA 独立复核方式 | 结论 |
|---|---|---|---|
| 1 | 五服务 healthy（api/web/es/pg/redis），minio 红为预期、degraded | 与 开发过程记录 §7.4 记录及压测日志启动横幅交叉核对 | ✅ 一致，无矛盾 |
| 2 | 迁移 5/5 成功（InitSchema/AddParamMetaColumns/MigrateParamKeys/SeedBaseline/AddBorrowDate） | 静态核对 `apps/api/src/infra/database/migrations/` 恰 5 个 `[0-9]*.ts` 迁移文件 + `seed-data.ts` 被 `[0-9]*` 排除（#10 守卫已钉）；执行态结果依通报记录 | ✅ 静态证据与通报一致（**未独立重跑容器**） |
| 3 | seed 成功，档号模板实输 `[目录号]-[年度(4)]-[保管期限]-[卷号(4)]-[件号(4)]` | 静态核对 `seed.ts:48-56` `buildDefaultSegments` 末段 `ITEM(pad 4)`，与终跑日志「档号末段类型：ITEM」一致 | ✅ 双证一致；第 7 项判据在正常 seed 数据下不误报的预判成立（终跑解析失败 0） |
| 4 | IK 分词实测通过（"中华人民共和国档案管理系统"正确切分） | 依 开发过程记录 §7.4 `_analyze` 实测记录；本地无 ES 执行权限 | ✅ 通报记录，未独立重跑（不影响压测结论支点） |
| 5 | 双轨锚定已采 | QA 本地 `sha256sum` 独立复算 3 个 source 锚（bench/judge/sequence.service）与通报值全部一致；`git status --short` 为空；dist 锚为容器内取值本地不可重算 | ✅ 见上方锚定表，两层表述分开 |
| 6 | 终跑 200×10 压测全绿 | 读 `docs/perf/runs/danghao-200x10-PASS-20261107-173726.log` 全文（35 行）；以日志统计量实跑 `evaluatePass` 纯函数返回 `pass:true, reasons:[]`；读判据源码确认第 7 项先于第 6 项、NaN 逐条计数不静默过滤 | ✅ **七项判据逐项对上，见下「七项判据复核」** |

#### 七项判据复核（终跑日志 × `evaluatePass(stats)` 源码逐项对账）

日志汇总（`danghao-200x10-PASS-20261107-173726.log:28-35`）：申请成功 2000、落库 2000 / 去重 2000、重号 0、取号失败 0、断号 0、解析失败 0、理论应落库 2000，10 轮每轮 200/200，单轮 383~735ms，`IS_PASS: YES`。

| # | 判据 | 日志值 | 结论 |
|---|------|--------|------|
| 1 | `totalDuplicate === 0` | 0 | ✅ |
| 2 | `totalRejected === 0` | 0 | ✅ |
| 3 | `dbTotal === dbDistinct` | 2000 === 2000 | ✅ |
| 4 | `dbTotal === totalSuccess` | 2000 === 2000 | ✅ |
| 5 | `dbTotal === concurrency × rounds` | 2000 === 200×10 | ✅ |
| 7 | `totalUnparsable === 0`（**源码中先于第 6 项输出**，`danghao-bench-judge.ts:230-236`） | 0 | ✅ |
| 6 | `totalGaps === 0` | 0 | ✅ |

**无静默过滤核验**：`extractSequenceNumbers`（:70-86）逐条计数 `unparsableCount`、样本上限 20；`computeRoundGaps`（:109-118）返回 `unparsableCount`；不存在 `filter(Number.isFinite)` 式静默丢弃。QA 以日志统计量实跑纯函数：`evaluatePass({...})` → `{"pass":true,"reasons":[]}`。**判据域在代码正确性层与真实数据适配性层同时闭合**（seed 末段 ITEM + 终跑解析失败 0）。

#### 证据可得性（显式检查项，team-lead 新增要求）

- **检查项定义**：**干净克隆必须能取到所有被本报告/开发过程记录 引用的证据文件**。
- **实证**：`git ls-tree -r --name-only HEAD docs/perf/runs/` 返回四份日志全在树内（首跑挂起、二跑全失败、2×2 复验、终跑全绿）；`wc -l` 本地合计 4134 行（通报 4139，计数口径差异，不影响结论）；四份日志 LF 行尾，QA 抽查 `password|secret|token|api_key|口令` 零命中（与通报「无口令/密钥/令牌」一致）；终跑日志可直接读到 `IS_PASS: YES` 与全部汇总数字。
- **背景**：全局 `*.log` 曾把四份现场日志吞掉（与 #7 gitignore 无锚点炸弹同族：「文档写了、仓库里没有」），`833802e` 开白名单并补录，按**仓库完整性问题**处置、不占缺陷编号（与 team-lead 口径一致）。
- **结论**：✅ 通过。报告中所有引用（`docs/perf/runs/*.log`、`docs/perf/PERF-TEMPLATE.md`、§六锚定表）在干净克隆均可取得。

#### MinIO 归档遗留项（degraded 说明）

MinIO 官方镜像归档停服，compose 以 `3e6c5a6` 临时覆盖摘除 minio 服务。**状态如实记录为 degraded（红为预期，非故障）**。
- **本轮联调未覆盖**：文件入库（分片上传）、下载、四性检测的真实对象存储链路——`storage.minio-contract` 的 11 条用例为**契约绿**，真实链路仍不可签字（见 §五 R1 MinIO 行）。
- **遗留决策（待 team-lead/用户拍板）**：替代对象存储方案选型（如 SeaweedFS / 本地卷 / 兼容 S3 的其他发行版）与 docker-compose 恢复方式。选型落地后需补一轮文件管线联调才能解除该项签字限制。

#### 联调现场缺陷分类（代码缺陷 vs 部署缺陷 vs 外部环境）

| # | 缺陷 | 分类 | 修复 | 防回归 |
|---|------|------|------|--------|
| 6 | `AccessModule` 标 `@Global()` 未入 AppModule 模块树，全局 DI 失效、容器启动即崩 | **代码缺陷**（装配层） | `4118d48` | `app.module-tree.spec.ts`（该 commit 之前精确红）+ `ci:check:module-wiring` 全量审计 |
| 7 | `BackupModule` 未 import `ParamModule`，构造器注入失败 | **代码缺陷**（装配层，同根因家族） | `784db23` | 同上（全量审计脚本抓出该形态） |
| 8 | `tsconfig.base.json` 未拷入运行层镜像，TS5083 编译失败 | **部署缺陷**（构建上下文） | `1bada72` | Dockerfile 运行层补拷（注释说明相对继承关系）；重建后链路推进实证——**QA 已核 diff** |
| 9 | data-source 双导出，迁移脚本取错导出对象 | **代码缺陷**（脚本结构性） | `65760bf` | 移除 default 保留 named；QA 独立核对全部 3 个消费方（seed/dev-sync-schema/bench）均为 named import，零影响主张成立——**QA 已核验** |
| 10 | 迁移文件通配先取 `*.js` 致静默空跑 + `seed-data.ts` 误纳迁移集 | **代码缺陷**（脚本健壮性，「工具不喊疼」家族：静默空转 = 假绿） | `4d44a20` + `1f7b5be` | 判定改为 `__dirname` 是否处于 dist（不再以「目录存在」为准）+ 通配收窄 `[0-9]*`（排除 seed-data.ts；QA 核对迁移文件名全为时间戳前缀，收窄正确）——**QA 已核验**；**防回归已实现**：静态守卫 `data-source.migrations.spec.ts` 3 条（`756acb5`），钉死「双分支 selector + 发现集非空 + 不含非迁移文件」，把静默空跑掐在 CI 阶段（QA 判断说明：放弃运行时 `executed>0` 断言的理由成立——运行路径每次启动跑迁移，已迁移库合法 0 pending；静态守卫在 CI 阶段拦截同族回归，复杂度更低。QA 复核时全量复跑确认基线 424（该轮）） |
| 11 | 档号生成路径二次取池连接致并发自死锁（详见 §七） | **代码缺陷**（并发可用性，**压测现场实证**） | `a1a0db7` | 生成路径单连接化 + 轮级看门狗 + 防回归 spec 6 条——**QA 变异验证通过**（摘 manager 参数恰好红探测针 1 条） |
| 12 | TypeORM 0.3.31 `UPDATE ... RETURNING` 双层返回 `[[rows],rowCount]`，`rows[0].next_value` → undefined → NaN → 2000 次取号全失败；`reserve` 零行静默回落 '1' 更危险 | **代码缺陷**（生产著录取号阻断，源码坐实非推断） | `eb44173` | 纯函数 `extractQueryRows` 归一化（双层取内层/单层原样/异常 fail-closed）+ `reserve` 零行改抛 `NO_LOCKED`；**假绿方法论第三例**：该轮 430 条单测全绿因全部 mock 返回单层，现已把两 spec 的 manager 桩改为真实双层为主用例 + 单层兼容；防回归 6 条，工程师自做变异 8 红 11 绿——**QA 已核 diff 与夹具形态** |
| 13 | 压测夹具漏传 `catalogNo`，seed 规则首段 CATALOG 要求非空 → 2000 次「档号段「目录号」取值为空」 | **测试夹具缺陷** | `648540c` | 从库中真实 `category.code` 取目录号（不伪造数据），与线上著录输入形态一致——QA 已核 diff |
| 14 | 压测未固定卷号，每个并发事务各取一卷、件号恒 1 → 末段序号全相同、`gaps` 出现负值 | **测试夹具缺陷**（压测形态失真） | `648540c` | 传 `volumeNo: 1`，200 并发在同一卷内竞争件序列（「同一作用域下 N 并发取连续号」的正确形态）——QA 已核 diff；小并发 2×2 先复验 `IS_PASS: YES` 后再跑正式 200×10 |
| — | `.gitignore` 无锚点致两目录自建库从未入库 | **工程配置缺陷**（已计入 DELIVERY §1-7，非源码） | `784db23`/`42daa28` | 仓库完整性条目 |
| — | MinIO 官方镜像归档停服 | **外部环境变更**（非缺陷） | `3e6c5a6` 临时摘除 | 见「MinIO 归档遗留项」 |

> 分类原则：能被单测/静态检查拦下的属**代码缺陷**；只在真实构建/容器环境暴露、代码本身正确的属**部署缺陷**；第三方服务生命周期变化属**外部环境**。三者处置路径不同（修代码+防回归 / 修配置+入清单 / 选型+补联调），不混记。

#### 终判升级评估框架（PASS_WITH_RISKS → PASS）—— **已裁定：升级**

**必要条件逐项复核结论（2026-11-07 QA 独立裁定）**：

| # | 条件 | 证据 | 裁定 |
|---|------|------|------|
| 1 | 压测原始数据落盘 + 七项判据全绿 + 双轨锚定 | 终跑日志入库（`833802e` 补录）；七项判据逐项对账见上表；QA 以日志统计量实跑 `evaluatePass` → `pass:true`；第 7 项先于第 6 项、NaN 不静默过滤（源码核查）；锚定表两层分开 | ✅ 满足 |
| 2 | 迁移/seed/IK 证据链闭合 | 已确认项表逐项列复核方式与结论：静态证据（迁移文件数/seed 模板/末段 ITEM）与通报记录交叉一致；**IK/health/迁移执行态未独立重跑**（本地无容器内执行权限），如实标注复核深度，不作为压测结论的唯一支点 | ✅ 满足（含如实标注的复核深度） |
| 3 | 联调现场缺陷全部有关闭证据 | #1–#14 全部：修复 commit + 防回归用例 + 关键变异验证（#11 QA 变异恰好红 1、#12 工程师 8 红 11 绿、#10 静态守卫 3 条、#6 该 commit 之前精确红）；436/24/0 全量复跑通过 | ✅ 满足 |

**裁定：终判由 PASS_WITH_RISKS 升级为 PASS（限定范围）**。签字范围扩展为：真实 PG 行锁与发号并发（200×10 压测数据支撑）、ES 容器与 IK 分词、Redis 单机运行时、容器启动装配层、迁移与 seed 链路，加上原有业务逻辑各项。

**升级后仍不可签字的残余项（如实保留，不因升级 PASS 消失）**：
- **MinIO 文件存储真实链路**：官方归档停服，替代方案落地 + 补文件管线联调前不可签；
- **多容器 pub/sub 跨进程投递**：`--scale api=2` 未跑；同进程双实例 T1/T2/T3 已实证，跨进程仍开着。

> 判读口径：PASS 针对「已验证且证据闭合的范围」，两项残余是**明确声明的范围排除**，不是被忽略的风险；终判效力与 §五 R1、§六开头表格、§七缺陷累计三处同源一致。

**升级影响须知**：本次更名含运行时标识变更（DB 用户、MinIO 别名、localStorage key、默认口令），存量环境不能原地升级，须按 `docs/交付核对清单.md` §10A 执行（QA 已核对该节与代码实际一致）。

---

## 七、缺陷累计（#1–#14 · 全部关闭；按 team-lead 统一编号口径）

| # | 缺陷 | 级别 | 位置 | 状态 |
|---|------|------|------|------|
| 1 | 未知密级 fail-open，权限放大 | 高·安全 | `shared/src/permission.ts` | ✅ 已验证 |
| 2 | SECRET 双级审批被跳过 | 高·合规 | `borrow/borrow.service.ts` | ✅ 已验证 |
| 3 | shared 构建脚本路径基准错误 | 中·工程 | `shared/scripts/build.cjs` | ✅ 已验证 |
| 4 | 续借并发绕过次数上限 | 中·一致性 | `borrow/borrow.service.ts` | ✅ 已验证 |
| 5 | 单次续借上限缺失（`max_renewal_days`） | 中·业务规则 | `borrow/borrow.service.ts` | ✅ **Round 3 已验证** |
| 6 | `AccessModule` 标 `@Global()` 却未入 AppModule 模块树，全局 DI 失效、容器启动即崩 | **高·可用性** | `common/access/access.module.ts` / `app.module.ts` | ✅ **联调现场发现**，`4118d48` 修复；防回归 `app.module-tree.spec.ts`（4118d48 之前精确红） |
| 7 | `BackupModule` 未 import `ParamModule`，构造器注入失败（与 #6 同根因家族：装配层零覆盖） | 中·可用性 | `modules/backup/backup.module.ts` | ✅ 联调现场发现，`784db23` 修复；全量审计脚本 `ci:check:module-wiring` 入 CI |
| 8 | `tsconfig.base.json` 未拷入运行层镜像，TS5083 | 中·部署 | 运行层构建上下文 | ✅ `1bada72`，QA 已核 |
| 9 | data-source 双导出，迁移取错导出对象 | 中·工程 | 迁移脚本 | ✅ `65760bf`，QA 已核（零影响主张独立验证成立） |
| 10 | 迁移通配先取 `*.js` 静默空跑 + `seed-data.ts` 误纳 | 中·工程（静默空转家族） | 迁移加载逻辑 | ✅ `4d44a20`+`1f7b5be`，QA 已核；防回归 `756acb5` 静态守卫 3 条（QA 已核） |
| 11 | 档号生成路径持有事务连接时再经全局 repository 申请**第二条**池连接，并发 > 池上限（200 > 20）全体持连接等连接 = **客户端自死锁**（压测挂起 18 分钟，pg_stat_activity 20 会话 idle in transaction / ClientRead；**根因非栅栏假设——bench 无显式栅栏**）；ArchiveService 生产路径同隐患 | **高·并发可用性** | `modules/danghao/rule.service.ts`（resolveRule/firstOrgCode） | ✅ 联调压测现场发现，`a1a0db7` 修复：生成路径单连接化（manager 参数贯穿规则/机构读取）+ 轮级看门狗（exit 2 不静默挂起）+ 防回归 spec 6 条；**QA 变异验证通过**（摘 manager 参数 → 恰好红探测针 1 条） |
| 12 | TypeORM 0.3.31 `PostgresQueryRunner.js:198-209` 对 UPDATE/DELETE 返回 `[[rows],rowCount]` 双层，`DataSource.query()` 原样透传；`nextInTransaction` 直接 `rows[0].next_value` → undefined → NaN → 2000 次取号全失败；`reserve` 零行静默回落 '1' | **高·生产著录取号阻断** | `modules/danghao/sequence.service.ts` | ✅ 压测现场发现，`eb44173`：`extractQueryRows<T>` 归一化四形态 + `reserve` 零行改抛 `NO_LOCKED`；两个 spec 的 manager 桩全部改为真实双层主用例（第三例假绿根因）；+6 防回归（430→436），工程师变异 8 红 11 绿，QA 已核 diff 与夹具形态 |
| 13 | 压测夹具漏传 `catalogNo`（seed 规则首段 CATALOG 要求非空）→ 2000 次「档号段「目录号」取值为空」 | 中·测试夹具 | `scripts/danghao-concurrency-bench.ts` | ✅ 压测现场发现，`648540c`：取库中真实 `category.code`（不伪造数据）——QA 已核 diff |
| 14 | 压测未固定 `volumeNo`，各并发事务各取一卷、件号恒 1 → 末段序号全同、`gaps` 负值 | 中·测试夹具（压测形态失真） | `scripts/danghao-concurrency-bench.ts` | ✅ 压测现场发现，`648540c`：固定 `volumeNo: 1` 使 200 并发同卷竞争件序列；小并发 2×2 复验 `IS_PASS: YES` 后再正式终跑——QA 已核 diff |
| R6 | `approve()`/`cancel()` 并发窗口 | 中·合规 | `borrow/borrow.service.ts` | ✅ **Round 3 已验证** |
| D-1 | 参数业务侧接入 | 中·功能 | 22 处调用点 | ⚠️ **大部分已接入**（borrow/security/recycle/preview）；区间与跨参数校验待补 |
| D-2 | 参数 key 命名/种子值三方不一致 | 中·数据 | `PARAM_KEY` vs 架构 §4.3 | ✅ **已关闭**：`deriveParamKey()` 单一源 + `param-defs.spec.ts` 16 条守护 |
| C-5 | 撤权多实例语义 | **高·安全** | `user.service.ts` | ✅ **已达标**：T 类 3 条（`8166c47` 启封），QA 变异验证「禁用广播恰好红 T2」，工程师反向「禁用 INCR 恰好红 3 条」 |
| C-5-B | 调用链覆盖（`PERMISSION_MUTATIONS`） | 中·工程 | 8 入口 + 1 排除 | ✅ 已达标：测试级 20 条 + 双向变异 + 独立 CI 静态脚本（R1/R2/R3，反向变异可抓漏） |

---

## 八、测试方法论自省（累计六处判断失误）

作为 QA，我的结论也可能错。如实记录，供后续参考：

### 8.1 定性错误：把"未接入"误判为"未实现"

- **表现**：断言 PRD v1.2 参数系统"未实现"，实为"基础设施完整、业务侧零接入"
- **根因**：`grep system-param|SystemParam` 只命中实体文件，未查服务方法名
- **影响**：可能导致排期误判（"要重做模块" vs "改 22 处调用"）
- **纠正**：改用 `grep getNumberParam|getBoolParam` 后确认服务完整存在
- **教训**：**查"某能力是否存在"时，要按"能力的使用方式"检索（方法名/调用点），不能只按"名词"检索**

### 8.2 假绿与假阴性：失败归因不唯一

- **假绿**：`BORROW_RULES.maxRenewalDays` 不存在 → `undefined + 1 = NaN` → 被 `Number.isFinite` 拦下 → 用例"通过"，但原因是 NaN 而非功能正确
- **假阴性**：某用例因"总借期超限"被拒，看似通过，实则未测到目标维度（单次上限）
- **纠正**：改为硬编码 PRD 定义值 30；调整夹具使失败原因唯一归因
- **教训**：**每条用例必须能回答"如果它失败，唯一原因是什么"**；否则就是假信号（此准则已由主理人批准作为团队测试规范）

### 8.3 夹具失真掩盖源码行为（Round 3 新增）

- **表现**：`FakeRedis.delByPrefix` 只扫数据键、未扫计数键，导致「全量失效清 `perm_ver:*`」被夹具吞掉，用例假绿
- **根因**：我下意识把「数据键」和「计数键」当成两个独立命名空间，但真实 Redis 的 `SCAN`/`DEL` 不区分
- **纠正**：`delByPrefix` 跨两 Map 操作，并加注释说明为何必须如此
- **教训**：**夹具越"方便"，越可能把源码缺陷吃掉**。凡是「模拟外部系统语义」的方法，都要问一句「真实系统这里会不会更严格？」

### 8.4 拿旧快照当最终态，且没有执行证伪（Round 3，**已更正为误报**）

- **表现**：我判定 `borrow.service.ts` 的 `resolveApproverLevel()` 是**死代码**（"全仓无调用点"），写进了报告，还建议工程师清理
- **真相**：**误报。** 该方法在 `borrow.service.ts:269` 有真实调用，实现为 `roles.includes(R4) ? 2 : 1`，是「终审仅 R4 可签」这条合规防线。我的 grep 来自一份**尚未包含该调用的中间快照**
- **后果评估**：这比"漏掉一个缺陷"更危险——如果工程师照我的建议删除，删掉的是一条**合规防线**。误报不仅浪费时间，还会**主动破坏系统**
- **为什么当时没发现**：我只做了"读代码"这一件事。读到 843 行的方法定义，grep 调用点为空，就停下了。我没有做**任何一次执行**去证伪（哪怕反射调一次看返回值）
- **纠正**：①全部表述改为"有效防线，误报"；②撤回删除建议；③补 12 条回归用例；④用**变异测试双向验证**用例真的能抓（见 §4.5）
- **教训（两条，第二条更重要）**：
  1. **代码读得再仔细，也不能替代执行。** 「看起来没人调用」和「真的没人调用」之间，差着一次 grep 的时间窗
  2. **在报告里写"这是死代码，建议删除"之前，必须先证明"删了没事"。** 我证明了"现在能跑通"（删的建议基于读代码），但没有证明"删了不破坏别的约束"。**对"建议删除/建议简化"类结论，举证责任比"发现缺陷"更重**——因为前者会被直接执行

**根因再往下钻一层（产品经理复核时指出，"读旧快照"只是现象）**：

真正的根因是**检索词过于精确**。我当时写的是 `grep "resolveApproverLevel("`（带左括号），而调用处写的是 `this.resolveApproverLevel(user)` —— **`this.` 与括号之间的组合让这个模式匹配不到**。

这不是"快照旧"的问题，是**检索式本身有盲区**。哪怕源码是最新的，这个 grep 也会返回空。也就是说：**我以为我在验证"有没有调用"，实际上我在验证"有没有一种特定写法的调用"。**

由此沉淀一条比「下次先跑代码」更可执行的规则（已采纳为方法学）：

> **凡用 grep 得出「不存在 / 无调用 / 无引用」的结论，必须换至少一个等价但形式不同的词再查一次**
> （去掉括号、去掉 `this.`、只留方法名、或按驼峰片段查），**两次结果一致才能下结论**。

举几个本仓常见的逃逸写法，都足以让单次 grep 失效：

| 你可能写的 | 实际可能存在的形式 | 单次 grep 是否命中 |
|---|---|---|
| `resolveApproverLevel(` | `this.resolveApproverLevel(user)` | ❌ |
| `saveJson(` | `this.repo.saveJson?.(...)` | ❌ |
| `invalidateSnapshot` | 动态调用 / 别名导入 | ⚠️ 视情况 |
| `R4` | `RoleCode.R4` / `'R4'` / `roles[0] === 'R4'` | ⚠️ 仅部分 |

> 「下次先跑代码」听起来更正确，但在赶工时**最容易被跳过**（跑代码要准备夹具、要等）。
> 「换第二个词再查一次」成本近乎为零，**不会因为没时间而被跳过**。
> PM 这条建议比我的版本更好，已替换。


### 8.5 把「字面要求」降级成「近似满足」（Round 3 收尾新增）

- **表现**：主理人验收口径是「撤权后下一次**请求**立即 403（**请求级断言**）」。我在 B 类里写了 `expect(elapsed).toBeLessThan(100)` 就认为达标了，但断言对象是 `UserService.getSnapshot()` 的返回快照——那是 **service 层**
- **差距**：service 层与请求层之间还隔着 `JwtStrategy.validate` 与 `PermissionGuard`。这两段任何一段读错源（例如读 token 内嵌快照而非 `request.user`），越权就真实存在，而 service 层用例**全绿**
- **纠正**：新增 `user.permission-request-level.spec.ts`（9 条），让两段守卫源码与 Controller 的 `@RequirePerm` 真实元数据同框；并加 2 条「前置自检」专门防「Controller 漏挂 `@RequirePerm` 导致整组假绿」
- **补写过程中又暴露 3 个自身问题**（详见 §4 Round 3「C-5 补强」表）：`Reflector.get` vs `getAllAndOverride` 的原型链差异、`ErrorCode.FORBIDDEN` 是对象不是数字、`checkScope:false` 接口本就不做入口级密级校验
- **教训**：**验收口径里的每个名词都是一个必须落地的约束。** 「请求级」不是「差不多在请求附近」。当我的实现比要求弱一档时，我应该主动标注「这是 service 级，不是请求级」，而不是用一句 `elapsed < 100` 让它看起来像完成了

### 8.6 差点把架构取舍误报成缺陷（Round 3 收尾新增）

- **表现**：写「降密级后请求被拦」用例时，我用 `listItems` 接口，降密级后**依然放行**。第一反应是「密级校验失效 = 源码 Bug」
- **真相**：`listItems` 的 `@RequirePerm` 是 `checkScope: false`，`permission.guard.ts:67` 在此时**提前 `return true`**，密级与数据范围整段跳过——这是有意设计，列表类接口把密级交给 `AccessFilterBuilder` 做**行级**过滤
- **若无核对**：我会给工程师报一个不存在的缺陷，并被反问「列表接口为什么要入口级密级校验」
- **教训**：**断言失败的第一嫌疑人是测试，不是源码。** 尤其当失败发生在「我新写的、还没和实现方核对过语义」的路径上时。误报比漏报更伤协作信任——漏报会被线上抓到，误报只会消耗工程师的时间

---

## 九、方法学沉淀（摘要）

> **本节为摘要。权威版本与后续修订以 [`docs/测试方法学规范.md`](./测试方法学规范.md) 为准。**

本轮沉淀出五条可执行规则，已抽成独立团队规范：

1. **检索双词复核**（§8.4 教训）：凡用 grep 得出「不存在 / 无调用」的结论，必须换第二个形式不同的词复核（如 `foo(` 须补查 `this.foo(`）。
2. **断言强度分级 L1–L5**：下限 = 防线被绕过的业务后果等级，合规红线必须 L4 起步、关键防线标配 L5（含变异验证）。禁止安全用例停留在裸 `toThrow()`。
3. **「建议删除」类结论的举证责任重于发现缺陷**：建议写错了会被直接执行，防线即失。
4. **夹具语义同构检查**：`Reflector.get` vs `getAllAndOverride`、`ErrorCode` 是对象非数字、方法体检查先剥注释——详见规范 §4 陷阱表。
5. **变异测试最小实践**：注入变异必须红、恢复后 `grep -c MUTANT` 必须为 0；双向夹逼（改坏/改死都要红）防止恒红假信号。

---

## 十、交付核对清单 独立性抽查记录（最终回归，14/46 抽样，全部属实）

> 方法：不读清单结论，直接按清单给出的位置/命令独立验证。抽中项覆盖 C-5、D 包、CI、git、更名、参数化六个域。

| # | 抽中项（清单编号） | 独立验证方式 | 结果 |
|---|---|---|---|
| 1 | C-5 版本号通道（#38） | 读 `user.service.ts:320` `redis.incr(perm_ver:{userId})` | ✅ 实有 |
| 2 | C-5 pub/sub 通道（#39） | 读 `user.service.ts:341/:352` `redis.publish('perm:invalidate')` | ✅ 实有 |
| 3 | 禁裸 redis.del 作唯一路径（#40） | 读 `:337/:339/:350` —— del 仅存于清理路径，注释明写「只清理，不承担生效职责」，生效由 INCR+publish 承担 | ✅ 与清单表述一致 |
| 4 | D 包 C-1~C-5 阻断行为（A12/§8） | **实跑** `validateCrossParams`：`default_days=400 > max_total=90` → C-1 blocking=true；`renewal=120>90` → C-2 blocking=true；合法视图零阻断（无过度拦截）；C-3 为提示级（与 B4 边界说明一致） | ✅ 行为级验证通过 |
| 5 | CI 脚本 R2 反向规则（A15/#43） | 读 `ci-check-permission-mutations.cjs` R1/R2/R3 三规则文本；`pnpm ci:check` 独立实跑 EXIT=0；此前已做反向变异（删 invalidate → EXIT=1 精确定位） | ✅ 真实有效 |
| 6 | git 基线可用性（§13） | `git log` 见 `902f114` 基线 + `3995e86` 文档提交；工作区改动仅 QA 两个文档 | ✅ 可用 |
| 7 | 参数生效验证 107 断言（A14/#45） | **独立实跑** `pnpm --filter @tianji/api verify:params` → 107/107 通过 | ✅ 非转述 |
| 8 | 默认口令三处一致（#13） | grep `Tianji@2024`：seed.ts / LoginPage.tsx / search-bench.ts 三处命中 | ✅ 一致 |
| 9 | 加载期自检（#18） | `params.ts` 文件末 `assertParamDefs()` 裸调用实有 | ✅ |
| 10 | 旧 key 迁移（#20） | `1700000000004-MigrateParamKeys.ts` 存在于 migrations 目录 | ✅ |
| 11 | IK 离线包目录（#48） | `infra/elasticsearch/ik/.gitkeep` 实有 | ✅ |
| 12 | 前端存储 key（#12） | `client.ts:34-35` `tianji.accessToken` / `tianji.refreshToken` | ✅ |
| 13 | PARAM_KEY 派生（#19） | `PARAM_KEY = deriveParamKey()` 实有（实际位置 `apps/api/src/common/constants/enums.ts`，清单写「enums.ts」系简写，实质正确） | ✅ |
| 14 | CLI 边界承接（A16/B1） | `cli-migrator/src/cli.ts:58` `--batch-max-rows` 实有 | ✅ |

**一处测试侧教训（非源码问题）**：第 4 项首次实跑误用 `new Map()` 作 ParamView（类型实为 `Readonly<Record>`），`view[key]` 恒 undefined 导致取值回落默认值、C-1 假阴性。改用字面量对象后行为正确。此例再次印证 §4 夹具语义规则：**断言失败先怀疑自己的输入形态**。

**抽查结论：14/14 属实，未发现虚报。** 清单可信度高。

---

*报告完 · 严过关 · 2026-11-07（终判复核后升级：PASS〔限定范围〕，残余两项见 §六/§五 R1）*
*2026-11-09 阶段二结案更新：§五 R1 MinIO 行升级为「A 部分解除（限定范围）」（SeaweedFS 方案 A 实证，`SCOPE: CORE`），「下载业务放行」仍不可签（L2），多容器 pub/sub 保留；证据与例外条件见 §五 R1 结案更新段，提交 `eb58a02` / `4f5b1eb`。*
