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

> **启动横幅的判读（缺陷 #11 修复后）**：脚本现在会打印
> `连接池上限=N，单轮看门狗=...ms`；当 `CONCURRENCY > 池上限`（本次 200 > 20）
> 时会额外打印「任务将排队等连接（合法，修复后不再死锁）」提示行。
> **这条提示不是异常、也不是判据失败信号**：#11 修复后生成路径单连接化
> （规则/机构读全部经事务 manager），多余并发只是排队等空闲连接，属合法调度。
> 真正需要警惕的是「单轮无任何输出且迟迟不结束」——轮级看门狗会在
> `ROUND_WATCHDOG_MS`（默认 5 分钟，env 可调）后打印诊断并 `exit 2`；
> 看到 exit 2 才按挂起排查（历史形态：并发 > 池上限且事务内二次取连接自死锁）。
> 换言之：**有提示行 = 正常排队；无输出 + exit 2 = 挂起**，两者勿混。

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

**双锚定采集命令**（在**宿主机仓库根**执行，`dist` 取容器内实际运行的那份）：

```bash
# source 锚：仓库工作区里的 TS 源码
sha256sum apps/api/src/scripts/danghao-concurrency-bench.ts \
          apps/api/src/scripts/danghao-bench-judge.ts

# dist 锚：容器里真实被执行的那份编译产物（必须从容器内取，不能取宿主机 dist）
docker compose exec api sha256sum \
  apps/api/dist/scripts/danghao-concurrency-bench.js \
  apps/api/dist/scripts/danghao-bench-judge.js
```

| 项 | 填写 |
|---|---|
| commit hash | |
| 工作区是否 clean | |
| 压测脚本路径 | `apps/api/src/scripts/danghao-concurrency-bench.ts` |

**source 锚（TS 源码 · 供审计与 diff）**

| 文件 | sha256 |
|---|---|
| `src/scripts/danghao-concurrency-bench.ts` | |
| `src/scripts/danghao-bench-judge.ts` | |

**dist 锚（容器内实际执行的 JS 产物 · 证明跑的就是这份源码）**

| 文件 | sha256 |
|---|---|
| `apps/api/dist/scripts/danghao-concurrency-bench.js` | |
| `apps/api/dist/scripts/danghao-bench-judge.js` | |

| 一致性核对 | 结果 |
|---|---|
| 宿主 `git status --short` 为空（源码 == HEAD） | ☐ |
| 容器内 `dist` 由本次 `docker compose build` 产出，非挂载的旧文件 | ☐ |
| 本次 `docker compose build` 无缓存命中提示「CACHED」（否则可能沿用旧层） | ☐ |

> **为什么必须双锚**：commit hash 只锚住「提交」，锚不住「实际执行的东西」。
> 两类错配它都抓不出来——
> ①判据被放宽但没提交（源码脏）→ 同一个 hash 跑出不同语义；
> ②源码改了但容器没重建（旧 `dist`）→ 报告证明的是一份已不存在的代码。
> **source 锚供人审计（可读、可 diff），dist 锚回答「这份报告对应的确实是这套判据」。**
> 只锚 source 会漏掉 ②，那是「报告看着严谨、实际证明的对象错了」，与静默空转同族。
>
> **dist 必须从容器内取**：仓库无 `.dockerignore`，宿主机 `apps/api/dist` 与容器内同名路径
> 是两个独立文件。在宿主机 `sha256sum dist/...` 得到的是本地构建产物，与容器里跑的那份
> 可能不同，锚了等于没锚。

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

判据的权威实现是 **`apps/api/src/scripts/danghao-bench-judge.ts`** 导出的三个纯函数
（零依赖、可单测，与 DB 彻底隔离）：

| 函数 | 职责 |
|---|---|
| `extractSequenceNumber(danghao)` | 单条档号 → 序号（失败返回 `null`，**不静默丢弃**） |
| `computeRoundGaps(danghaos)` | 单轮 → `{ gaps, unparsableCount, unparsable }` |
| `evaluatePass(stats)` | 聚合统计量 → `{ pass, reasons }`，七项判据 |

压测脚本 `danghao-concurrency-bench.ts` 只负责采集统计量并调用它们，
打印 `IS_PASS` 与 `reasons`；判据算式**不在脚本里重复写第二遍**。

> 读报告时认这一处：若本表与 `danghao-bench-judge.ts` 不一致，以源码为准，
> 且应视为本模板的缺陷（提 issue 修模板）。判据回归测试见
> `apps/api/__tests__/danghao-bench-judge.spec.ts`，逐项钉住七条判据的失败模式。

七项**全部成立**才算通过：

| # | 条件 | 含义 | 不满足时说明什么 |
|---|---|---|---|
| 1 | `totalDuplicate === 0` | 内存层面零重号 | 序列自增不是原子的 |
| 2 | `totalRejected === 0` | 零取号失败 | 锁竞争过激 / 超时 / 唯一约束冲突被捕获 |
| 3 | `dbTotal === dbDistinct` | 落库后零重号 | **唯一索引没拦住**（最严重） |
| 4 | `dbTotal === totalSuccess` | 内存成功数与落库数一致 | 事务提交丢失 / 回滚未察觉 |
| 5 | `dbTotal === concurrency × rounds` | 全部取号都拿到了 | 有号被静默吞掉（断号） |
| 6 | `totalGaps === 0`（各轮 `gaps` 合计为 0） | 序号区间内无空洞 | 序列跳号——档号被"吃掉" |
| 7 | `totalUnparsable === 0` | 序号可全部解析 | **末段非纯数字，第 6 项失效**（fail-closed） |

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

**第 7 项为什么必须有（fail-closed）**：第 6 项的前提是「档号末段能解析出序号」。
档号模板 `segments` **运行时可配**，若配成以 `ORG` / `RETENTION` 收尾
（`volumeSegmentsOnly` 的卷级模板必然去掉 ITEM 段），末段会全部解析失败。
此时若不显式判负，`totalGaps` 恒为 0，**第 6 项空转通过，报告照绿**——
这是比第 6 项那次更隐蔽的假绿：那次输出里至少还有「断号 0」这行字可被人眼怀疑，
这次连可疑痕迹都没有。

> 修复前状态：序号提取用 `filter(Number.isFinite)` 静默过滤，解析失败被丢弃、
> 从不计数。修复方式是把失败计数升格为判据第 7 项 `totalUnparsable === 0`，
> 宁可错杀（真实压测若档号确实带非数字末段，再议提取规则——那是数据问题，
> 不是判据问题），不可放过。
>
> 判据顺序上第 7 项排在**第 6 项之前**输出：解析失败时 `gaps` 恒 0，
> 先看到「断号 0」再看「判据失效」会把因果读反。

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

> 该等价性以「单轮内序号同属一个重置周期」为前提。压测把 `BENCH_YEAR` 取为
> 常量、全程固定，故同轮内不会跨年。若将来加入跨年轮次（`resetCycle=YEAR`
> 且同轮混取两个年度），序号会各自从 1 起，可能算出负数——届时须改为逐轮
> `every` 并重新审视 gaps 定义。**此时判据红是对的，但根因在压测工具不适用
> 于跨年重置规则，不在判据本身。**

### 序号提取（extractSequenceNumber）的行为边界

取最后一个 `-` 分隔段并按十进制**前缀**解析：

| 档号末段 | 提取结果 | 说明 |
|---|---|---|
| `0042` | `42` | 纯数字，正常 |
| `0042A` | `42` | **前缀解析**，后缀字母被忽略（不是 `NaN`） |
| `A`（ORG 收尾） | `null` | 计为不可解析 → 第 7 项判负 |
| 空串 / `…-`（末段为空） | `null` | 同上 |

> 这张表存在的原因是：我曾凭「`parseInt` 遇非数字就得 `NaN`」的想当然判断，
> 误报「带字母后缀会失效」。实测证伪——`Number.parseInt('0042A', 10)` 返回 `42`。
> **推断不能替代实测**，此表即实测结果固化。

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
| 断号数（各轮 gaps 合计） | | 0 | ☐ |
| 序号解析失败数 | | 0 | ☐ |
| 理论应落库 | | 2000 | ☐ |

---

## 六、结论

```text
IS_PASS: ________（YES / NO）
```

### 若 YES

- 七项判据全部满足（含第 7 项：序号全部可解析），逐轮 `gaps` 均为 0，原始输出已附。
- 结论表述建议：**「CONCURRENCY=200 / ROUNDS=10 下零重号、零断号、零取号失败、
  序号全部可解析，2000 次取号全部落库且唯一索引无冲突」**。
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
- [ ] **双锚已记**：source sha256（2 个 TS 文件）+ dist sha256（容器内 2 个 JS 产物），且三行一致性核对已勾
- [ ] CONCURRENCY / ROUNDS 已记，理论总量已算
- [ ] **原始输出完整粘贴，含 stderr**
- [ ] 逐轮明细表已填满 10 行
- [ ] 汇总块七个字段（含「序号解析失败数」）逐项核对
- [ ] **每轮 gaps 已人工确认为 0**（判据已自洽，此步为失败时的定位辅助）
- [ ] 结论写明 IS_PASS 与判据七项的满足情况
- [ ] 第 7 项已确认：`序号解析失败数：0`，且档号末段类型为序号段（ITEM）
- [ ] 边界声明（单实例/不经 ES/不含 HTTP 层）已写
