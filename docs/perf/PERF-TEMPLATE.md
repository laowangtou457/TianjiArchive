# 档号并发压测报告模板（`perf:danghao`）

> 用途：硬性验收要点 1 的**可审计证据**。
> 每次正式压测复制本模板为 `docs/perf/YYYY-MM-DD-danghao-run<N>.md` 并如实填写。
> **只写「P99 xxx ms 通过」而无原始输出的结论不可审计** —— 补测成本远高于当时存档。

---

## 〇、这个压测到底在测什么（先读，避免误判）

`perf:danghao` 测的**不是吞吐也不是延迟**，而是**档号生成的正确性**：

> 同一全宗 + 同一年度 + 同一保管期限，N 个并发同时申请档号，
> 是否做到**零重号、零断号**（连续整数序列完整）。

为什么并发正确性是性能项：档号由 `DanghaoSequenceService` 的
`UPDATE ... RETURNING next_value - 1` 原子自增实现。若退化为
`SELECT MAX(danghao)+1` 或应用层加锁不足，并发下必然重号——
而重号在档案业务里是**不可修复的数据事故**（档号是法定唯一标识，
一旦重号，两份实体档案归到同一编号，事后无法优雅修正）。

因此本压测的通过判据是**布尔型**：零重号 + 零断号 + 全部落库。**没有"P99 低于多少毫秒"这种阈值**。

> ⚠️ 常见的误写：把耗时（`elapsedMs`）当通过标准。脚本确实会打印每轮耗时，
> 但那是**观测数据**，不参与 `IS_PASS` 判定。耗时仅用于发现"某轮异常慢"这种
> 现象（可能是锁等待），需要人看一眼，但不是判据。

---

## 一、环境记录（必填，缺一项则该报告不可复现）

### 1.1 宿主机

| 项 | 填写 | 采集命令 |
|---|---|---|
| CPU 型号 / 逻辑核数 | | `wmic cpu get name,NumberOfLogicalProcessors` |
| 内存总量 | | `wmic ComputerSystem get TotalPhysicalMemory` |
| 磁盘类型（SSD/HDD） | | 人工确认 |
| 操作系统 | | `ver` |
| Docker Desktop 版本 | | `docker version` |
| WSL2 内核版本 | | `wsl --status` |

### 1.2 容器资源

| 服务 | 镜像 | 内存限制 | 实际占用（压测中 `docker stats`） |
|---|---|---|---|
| `tianji-postgres` | | | |
| `tianji-api` | | | |
| `tianji-elasticsearch` | | `ES_JAVA_OPTS` = | （本压测不经 ES，可留空） |
| `tianji-redis` | | | |

> Docker Desktop 的 **全局内存上限**必须记（Settings → Resources）。
> 同一套参数在 4 GB 与 16 GB 的 Docker VM 上跑出的耗时差异可达数倍，
> 但**重号/断号结论不受影响**——这是本压测的好处：正确性与资源不相关。

### 1.3 数据基线

| 项 | 填写 | 采集命令 |
|---|---|---|
| 全宗数 | | `SELECT count(*) FROM fonds;` |
| 档号规则数 | | `SELECT count(*) FROM danghao_rule;` |
| 目标全宗 `fonds_no` | | 脚本会打印，抄下来 |
| 规则段数 / 重置周期 | | 脚本会打印 |
| `archive_item` 行数 | | `SELECT count(*) FROM archive_item;` |
| 探针表是否残留 | 应为 0 行 | `SELECT count(*) FROM perf_danghao_probe;` |

### 1.4 代码版本

```bash
git rev-parse HEAD          # 填完整 hash
git status --short          # 必须为空（有未提交改动则该报告标记为「非基线」）
```

| 项 | 填写 |
|---|---|
| commit hash | |
| 工作区是否 clean | |
| 压测脚本路径 | `apps/api/src/scripts/danghao-concurrency-bench.ts` |
| 脚本 sha256 | `sha256sum apps/api/src/scripts/danghao-concurrency-bench.ts` |

> 记 sha256 的理由：脚本一旦被修改（比如判据被放宽），同样的 commit hash
> 会有不同的压测语义。hash + sha256 双锚定才能保证"这份报告对应的确实是这套判据"。

---

## 二、执行命令（原样抄，勿改）

```bash
cd /e/TianjiArchive

# 0) 前置：必须已 seed，否则报「找不到全宗」
docker compose exec postgres psql -U tianji -d tianji_archive \
  -c "SELECT count(*) FROM fonds;"

# 1) 正式压测（硬性验收要点 1 的推荐参数）
docker compose exec -e CONCURRENCY=200 -e ROUNDS=10 api \
  pnpm --filter @tianji/api perf:danghao
```

**参数记录**

| 环境变量 | 本次取值 | 缺省值 |
|---|---|---|
| `CONCURRENCY` | 200 | 100 |
| `ROUNDS` | 10 | 5 |
| `BENCH_YEAR` | （缺省＝当前年） | 当前年 |

理论取号总量 = `CONCURRENCY × ROUNDS` = **2000**

---

## 三、通过判据（`evaluatePass()` 的完整逻辑）

判据的权威实现是 **`apps/api/src/scripts/danghao-bench-judge.ts` 导出的纯函数
`evaluatePass(stats): { pass, reasons }`**（b62bd1f 提取，零依赖、可单测）。
压测脚本 `danghao-concurrency-bench.ts` 只负责采集统计量并调用它，
打印 `IS_PASS` 与 `reasons`；判据算式**不在脚本里重复写第二遍**。

> 读报告时认这一处：若本表与 `danghao-bench-judge.ts` 不一致，以源码为准，
> 且应视为本模板的缺陷（提 issue 修模板）。判据回归测试见
> `apps/api/__tests__/danghao-bench-judge.spec.ts`（9 条，逐项钉住失败模式）。

六项**全部成立**才算通过：

| # | 条件 | 含义 | 不满足时说明什么 |
|---|---|---|---|
| 1 | `totalDuplicate === 0` | 内存层面零重号 | 序列自增不是原子的 |
| 2 | `totalRejected === 0` | 零取号失败 | 锁竞争过激 / 超时 / 唯一约束冲突被捕获 |
| 3 | `dbTotal === dbDistinct` | 落库后零重号 | **唯一索引没拦住**（最严重） |
| 4 | `dbTotal === totalSuccess` | 内存成功数与落库数一致 | 事务提交丢失 / 回滚未察觉 |
| 5 | `dbTotal === concurrency × rounds` | 全部取号都拿到了 | 有号被静默吞掉（断号） |
| 6 | `totalGaps === 0`（各轮 `gaps` 合计为 0） | 序号区间内无空洞 | 序列跳号——档号被"吃掉" |

**第 6 项为什么必须有**（曾被遗漏，已修）：条件 5 只约束「取号总数」，
不约束「序号连续性」。单轮拿到 `1,2,3,7,8,…,203` 共 200 个号时，
`gaps = 3`（跳过 4/5/6）但 `dbTotal` 仍凑满 2000，**旧判据五项全绿、`IS_PASS: YES`**。
而档号缺号与重号同级严重：编号永久空缺，将来可能被误用或对不上账。

> 修复前状态：`gaps` 变量在脚本里被计算、被打印，却未进入 `pass` 表达式。
> 这类「算了但没判」的缺口最难发现——输出里明明有 `断号 3` 这个字，
> 汇总却报 `IS_PASS: YES`。判据必须自洽，不能依赖人眼复核脚本已算出的数。
>
> 该漏洞现有回归测试兜住：`danghao-bench-judge.spec.ts` 的
> 「【f67a60f 反例】跳号凑满总数」一条，把当时的反例原样固化。
> 若有人删掉第 6 项，这条会红。

**双重校验的设计意图**：条件 1 是应用层自检，条件 3 是数据库层自检。
只查 1 会漏掉"内存里不重复但落库时被覆盖"（若唯一索引缺失）；
只查 3 会漏掉"内存判重逻辑本身有 bug"（若判重写法错误）。
两套独立机制同时为零，才排除"某一边的检查本身就是坏的"。

### 断号（gaps）的算法与含义

`gaps` 字段 = `MAX(序号) - MIN(序号) + 1 - COUNT(*)`。
探针表每轮 `TRUNCATE` 后重新计数，所以单轮 `gaps` 应为 0。

**判据用的是「各轮合计」`totalGaps`，不是逐轮判断**：因每轮 `gaps` 恒非负
（不同序号数不会超过区间长度），「合计为 0」⟺「每轮为 0」，两种写法等价。
`BenchStats` 只携带聚合值，逐轮明细留在脚本的 `rounds[]` 里供诊断输出。
判据对 `totalGaps !== 0` 判负（而非 `> 0`），因此异常负值同样被拒绝——单测有专项钉住。

**该值已纳入判据第 6 项**（见上表）。同时也逐轮打印、并在汇总处打印合计，
报告填写时仍建议逐轮核对一遍——不是为了"补判据"，而是为了在失败时
能立刻定位是哪一轮、缺了几个号。

> 历史说明：本模板初版写作「gaps 不参与 IS_PASS，须人工复核」，
> 当时反映的是脚本的真实状态。team-lead 裁定「判据必须自洽」后，
> 脚本已加 `totalGaps === 0`，该人工复核从**兜底手段**降级为**排查辅助**。
> 保留这段历史是因为它正好说明了一类问题：**输出里有信号 ≠ 判据里有约束**。

---

## 四、原始输出（**必附，粘贴完整，不要摘要**）

> 粘贴位置。保留脚本的 `════` 分隔线与汇总块原样。
> 若输出超过 200 行，允许省略中间重复的轮次行，但**必须保留**：
> 首轮、末轮、所有 `✖` 错误行、完整汇总块、`IS_PASS` 行。

```text
（粘贴 docker compose exec ... perf:danghao 的完整 stdout + stderr）
```

**stderr 也要贴**：脚本的取号失败日志 `✖ 取号失败：...` 走的是 `console.error`，
只看 stdout 会把失败信息漏掉。

---

## 五、逐轮明细（从输出抄录，便于人类核对）

| 轮 | 成功 | 去重后 | 重号 | 断号(gaps) | 拒绝 | 耗时(ms) |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| … | | | | | | |
| 10 | | | | | | |
| **合计** | | | | | | |

**汇总块核对**

| 字段 | 脚本输出 | 期望 | 一致 |
|---|---|---|---|
| 申请成功数（内存） | | 2000 | ☐ |
| 落库总数 | | 2000 | ☐ |
| 去重后 | | 2000 | ☐ |
| 重号数（内存） | | 0 | ☐ |
| 取号失败 | | 0 | ☐ |
| 理论应落库 | | 2000 | ☐ |

---

## 六、结论

```text
IS_PASS: ________（YES / NO）
```

### 若 YES

- 六项判据全部满足，逐轮 `gaps` 均为 0，原始输出已附。
- 结论表述建议：**「CONCURRENCY=200 / ROUNDS=10 下零重号、零断号、零取号失败，
  2000 次取号全部落库且唯一索引无冲突」**。
- 耗时数据仅供参照，**不要写进结论当作通过理由**。

### 若 NO

必须按下列格式逐项交代，不允许只写"失败"：

| 现象 | 具体表现（贴输出行） |
|---|---|
| 重号 | 哪些档号重复，出现在第几轮 |
| 断号 | gaps 值，缺了哪些序号 |
| 取号失败 | 异常类型与消息（`23505` / 锁超时 / 其它） |
| 落库不一致 | 内存 N 条，落库 M 条，差值 |

**排查顺序**（与 DEPLOY.md §5.4 一致）：

1. `danghao_rule.next_value` 是否被进程外修改
2. 是否走了 `UPDATE ... RETURNING next_value - 1` 原子自增，而非 `SELECT MAX()+1`
3. 是否有外部直接 INSERT `archive_item` 绕过服务层
4. 多实例并发时（`--scale api=N`）是否存在跨进程竞争——**当前压测是单进程内多协程，
   不覆盖多实例取号场景**，若要验证需另设方案

---

## 七、已知边界（填报告时一并声明，避免过度宣称）

| 边界 | 说明 |
|---|---|
| **单实例** | 压测在**一个 api 容器内**用 N 个并发事务。多实例（`--scale api=2`）同时取号是**不同**的场景，本压测不覆盖 |
| **不经 ES** | 档号生成直连 PG，探针表独立。ES 健康状况不影响本结论 |
| **同全宗同年度** | 全部取号落在同一个 `scope_key`，这是最容易暴露重号的乐观场景；跨全宗并发不在范围内 |
| **不含 HTTP 层** | 直接调 `ruleService.generateItemDanghao`，绕过 Controller/Guard。**测的是档号服务，不是接口吞吐** |
| **探针表会 DROP** | 脚本 finally 里 `DROP TABLE IF EXISTS perf_danghao_probe`，所以压测后无法回查明细；要留证据必须在压测中另做 `pg_dump` |

> 若要保留可回查的明细，把 `finally` 里的 DROP 注释掉（**仅限本地调查，勿提交**）。

---

## 八、归档

- 文件路径：`docs/perf/YYYY-MM-DD-danghao-run<N>.md`
- 提交信息建议：`perf: 档号并发压测报告（CONCURRENCY=200 ROUNDS=10，IS_PASS=YES）`
- 若与 Docker 联调同批提交，可合并在联调提交里，但报告必须独立成文件

---

## 附：本模板的填写自检清单

提交前逐项打勾，缺任一项视为**报告不完整**：

- [ ] 环境记录四项（CPU/内存/OS/Docker 版本）齐全
- [ ] Docker 全局内存上限已记
- [ ] 数据基线（全宗数/规则数/fonds_no/规则段数）齐全
- [ ] commit hash + 工作区 clean 已确认
- [ ] 压测脚本 sha256 已记
- [ ] CONCURRENCY / ROUNDS 已记，理论总量已算
- [ ] **原始输出完整粘贴，含 stderr**
- [ ] 逐轮明细表已填满 10 行
- [ ] 汇总块六个字段逐项核对
- [ ] **每轮 gaps 已人工确认为 0**（判据已自洽，此步为失败时的定位辅助）
- [ ] 结论写明 IS_PASS 与判据六项的满足情况
- [ ] 边界声明（单实例/不经 ES/不含 HTTP 层）已写
