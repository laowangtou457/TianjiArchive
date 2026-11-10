# RAG 知识库 / LLM Wiki 可行性评估

> 评估对象：PRD F-22「智能问答（RAG/LLM）」与 US-13 的落地可行性。
> 评估方式：**读源码 + 读编排 + 读需求判据**，不做任何实现改动。
> 结论性质：技术可行性判断 + 缺陷清单 + 分档路径建议。**不含工期承诺**。
> 评估基线：`main` @ 离线包 `7332518f…` 对应提交（2026-11-10）。

---

## 0. 结论摘要

**可行，但不是"打开开关"，而是一个独立子项目。**

| 档位 | 内容 | 可行性 | 主要代价 | 是否满足 F-22 判据 |
| --- | --- | --- | --- | --- |
| **A 检索增强**（不上生成模型） | chunk 切分 + 片段索引 + BM25/IK 召回 + 返回原文片段与档号 | ✅ **已交付**（v1.2，真机闭环） | 新增 chunker + 片段索引 + 两段式检索 | ✅ 天然满足（不生成即不臆造） |
| **B RAG 问答**（本地 embedding + 本地小 LLM） | A + bge 系 embedding + Qwen2.5-3B/7B 量化 + 抽取式作答 | ⚠️ **中**，卡在硬件与交付体积 | 内存门槛上调、交付包增 4~6GB、问答改异步 | ✅ 满足，但需强制引用与无依据短路 |
| **C LLM Wiki**（自动生成百科式条目） | 模型把档案内容改写成 wiki 页 | ❌ **不建议 v1 做** | 与档案凭证价值冲突 | ❌ **天然违判据**（改写内容无法逐句溯源） |

**建议：先做 A，把三个真实缺陷修掉；B 待硬件复核后单独立项；C 不做，最多做"带引用的导读页"。**

> **v1.2 状态**：D-2 / D-3 / D-5 已修，A 档已落地并通过真机闭环（6 条目 / 6 片段 / 越权零返回 / 无依据可判），接口不再返回 501。B / C 档结论不变。

一句话理由：A 档不引入任何模型，就把「能不能检索到、检索得对不对、越不越权」这三件事做实了；而 B 档的瓶颈既不是算法也不是代码，是**闭网内的推理硬件**和**"一个安装包即完整安装"这个已定目标**。

---

## 1. 现行地基盘点（比预期厚，但中段是空的）

P0 阶段留下的不是空壳，是"两端实、中间空"。

### 1.1 已经可用的部分

| 能力 | 位置 | 状态 | 评价 |
| --- | --- | --- | --- |
| 需求判据 | `产品需求文档.md:173`（F-22）、`:126`（US-13）、`:378` | 已定 | 三条硬口径：**引用可溯源**、**未命中明确提示"无依据"**、**私有化无外网依赖** |
| 接口契约 | `/api/kb/status`、`/api/kb/query`、`/api/kb/reindex`（`kb.controller.ts:40,54,65`） | 已上线，返回 501 | 前端接入不会 404，无需改契约 |
| 返回结构 | `KbQueryResponse` / `KbCitation`（`@tianji/shared`） | 已定型 | 字段含 `danghao` / `itemId` / `snippet` / `securityLevel`，溯源所需字段齐 |
| **权限前置过滤** | `AccessFilterBuilder.buildKbFilter` + `canAccessRecord`（`kb.service.ts:88,120`） | **已完整实现** | 这是 RAG 最容易出事的地方，结论是**已经闭环**；未知密级 fail-closed，空集合降级 `FALSE` 而非 `IN ()`（`:94-98`，避免了 PG 语法错误） |
| 审计 | `kb.controller.ts:56` `@Audit({action:'SEARCH', mandatory:true})` | 已挂 | 问答行为入审计，合规要求满足 |
| 存储表 | `kb_entry`（`kb-entry.entity.ts`）+ 迁移 `1700000000000-InitSchema.ts:411` + 双索引 | 已建 | 字段够用：`item_id/source_danghao/security_level/chunk/version/embedding_status` |
| 检索后端 | `tianji-elasticsearch-ik:8.13.4`（自建镜像，含 IK 分词） | 已在跑 | **ES 8.13 原生支持 `dense_vector` + `knn` 且 kNN 可带 `filter`** → 不必引 pgvector，不必加新组件 |
| 正文来源 | extractor → `archive_item.fulltext`（`es.indexer.ts:33-46`，截断 500KB） | 已打通 | chunk 的原料现成 |
| 前端 | `KbPage.tsx`：状态展示 + 引用契约 + 「**绝不编造答案**」硬约束注释 | 已就位 | UI 不用从零做 |
| 诚实降级 | `/kb/query` 抛 501 `KB_NOT_ENABLED`，且**带候选条数**（`kb.service.ts:106-109`） | 已实现 | 现状不撒谎，这是本项目一贯口径 |

> 架构侧既有裁决（`系统架构设计.md:831`）：**"Q11 RAG 模型来源：默认本地私有化；P0 仅落接口与表，不部署向量库。"** 本评估与该裁决一致，不推翻。

### 1.2 中段确实是空的（关键）

**`kb_entry` 表在运行期永远是 0 行。** 依据：

- 全仓检索 `KbEntry|kb_entry` 的写入方，只有实体注册、迁移建表、`VectorStore.upsert` 的定义 —— **没有任何调用方产生 chunk**。
- `kb.service.reindex()`（`:143-148`）拿到 `itemId` 后**只做两件事**：查有没有行、把 `embedding_status` 改成 `OK`。**不切块、不向量化、不写行**。
- 因此 `/api/kb/status` 的 `indexedChunks` 恒为 0，`/api/kb/query` 的"候选片段 N 条"恒为 0。

**"入库 → 向量 → 召回 → 过滤 → 组装"这条链路，两端有实现，中间的"生产 + 向量化"是缺的。**

> **v1.2 已补齐**（`packages/shared/src/chunker.ts` + `kb.indexer.ts` + `kb.scheduler.ts`）：chunk 生产者、片段落库（`kb_entry` 新增 `chunk_no` + 唯一索引 `uk_kb_item_chunk`）、ES `kb_chunks` 索引、5 分钟自愈扫描均已就位。真机 `kb:reindex --all` 结果为「条目 6 / 片段 6 / 失败 0」，`/api/kb/status` 的 `indexedChunks` 不再恒 0。

---

## 2. 四个硬缺口（含 2 个已定位的代码缺陷）

### D-1 缺 chunk 生产者（缺功能，非缺陷） ✅ **已修（A 档）**

`kb_entry.chunk` 没有任何生成逻辑。现有 `fulltext` 是**整篇 500KB 截断文本**，直接拿去向量化既超模型上下文、又会让相似度坍缩。

**A 档必须先补一个 chunker**：按段落/句号切 300~500 字、重叠 50 字，同时写入 `item_id` / `source_danghao` / `security_level`（从条目元数据带过来，**不能由 chunker 自己推断密级**）。触发点有两条：抽取完成事件（增量）、`/kb/reindex`（存量）。

**实际处置**：触发点最终选了**扫描式增量**而非抽取完成回调 —— 抽取器是独立进程，回调要引入"内网回调 + 鉴权 + 重试"三套问题，而"每 5 分钟扫一遍陈旧条目"天然幂等、失败自愈（`kb.scheduler.ts`）。切分目标值取 `target=400 / max=500 / min=120 / overlap=50`（`DEFAULT_CHUNK_OPTIONS`），句读优先、不切断英文词、结果确定性可复现。密级**只从 `archive_item.security_level` 取**，绝不由文本推断。

### D-2 向量空间不一致 —— **真缺陷，会导致排序完全无意义** ✅ **已修（`0bbf744`）**

| | 实现 | 哈希方式 | 贡献 | 归一化 |
| --- | --- | --- | --- | --- |
| 查询向量 | `embedding.provider.ts:52-68` `hashVector` | `SHA1(2-gram)` 取 `h[0]<<8\|h[1] % 256` | **带符号** `±1` | **有**，L2 归一 |
| 文档向量 | `kb.service.ts:151-163` `hashOf` | `h*31+charCode % 1000003` 再 `% 256` | 恒 `+1` | **无** |

`kb.service.ts:130` 把两者直接算余弦：

```ts
score: this.cosine(vector, this.hashOf(r.chunk))
```

**两个不同的特征空间做余弦，结果接近随机。** 也就是说：即使今天把 501 去掉、把数据灌进去，返回的排序也是噪声 —— 比"没启用"更糟，因为看起来像能用。

> 这一条的处置有两条路：A 档里**删掉 `hashOf`，统一走 provider**（唯一正确解）；或者明确把 `retrieve()` 标 `@deprecated` 不接进主链路。推荐前者。

### D-3 召回是"先取 500 条最新，再过滤权限" —— 逻辑错位 + 不可扩展 ✅ **已修（`0bbf744`）**

`kb.service.ts:119`：

```ts
const rows = await this.entryRepo.find({ take: 500, order: { createdAt: 'DESC' } });
```

先按 **createdAt 倒序**截 500 行，再在内存里 `filter(canAccessRecord)`（`:120-125`），再截 200 条打分（`:128`）。两个后果：

1. **漏检**：若最近入库的 500 个 chunk 全属 SECRET，R2 用户的可访问片段根本进不了窗口 → **稳定返回 0 命中**，且前端会显示"无依据"，属于**假阴性**。
2. **不可扩展**：全表扫 + 内存余弦，10 万 chunk 级别就顶不住；档案系统的正文量级远超此数。

**修复处置（`0bbf744`）**：权限条件经 `applyAccessFilter` 下推为 SQL（与主检索同一入口，防漂移），逐页扫描（256/页）在"已过滤集合"内取 topK；召回改为 `JOIN archive_item` 取密级与数据范围，杜绝"条目改密级、片段留旧值"的静默越权。回归用例含"600 条全 SECRET + 唯一 PUBLIC"的假阴性场景。

> 遗留（未修，单独登记）：`applyAccessFilter` 对 ORG 范围会生成 `"org_id"` 条件，而 `archive_item` 无该列（机构归属实际在 `volume.org_id`）。这是**主检索同款既有缺口**，仅在用户存在 ORG 型数据范围授权时触发；建议单独立项修，不在 kb 模块内私修以免两套口径。

### D-4 没有推理/向量化运行时（能力缺口）

- 8 个容器镜像（`docker-compose.yml`）：`postgres:16-alpine`、`tianji-elasticsearch-ik:8.13.4`、`seaweedfs:3.79`、`redis:7-alpine`、`tianji-archive-{api,extractor,web,backup}:1.0.0` —— **没有任何模型运行时**（无 ollama / TEI / vLLM / onnx）。
- 硬件门槛**无 CPU 核数条目、无 GPU 条目**；内存 K10 = `≥8GB（建议 16GB）`（`安装器总体设计.md:319`）。
- 结论：**闭网内只能走 CPU 推理**，且现有门槛没有为推理预留余量。

### D-5 引用回显的密级取自索引快照 —— **真机验证时发现，属安全问题** ✅ **已修（A 档）**

片段表 / ES 文档里的 `securityLevel` 是**建索引那一刻**的快照。条目升密后、自愈扫描跑到之前，索引里的密级比真值更宽松。

权限**过滤**本身没被击穿（两段式检索的第二段用 PG 真值回表核对，越权片段仍然零返回）。真正的问题在**回显**：有权限的用户看到的引用标签是旧值。真机实测（同一问题、同一索引命中）：

| 账号 | 密级上限 | 命中 | 引用回显密级（修前） |
| --- | --- | --- | --- |
| `kb_reader` | PUBLIC | 0（正确剔除） | — |
| `admin` | SECRET | 1 | `PUBLIC` ❌ 实际已升 SECRET |

把机密件标成公开级，标签本身就在说假话 —— 在档案系统里这是独立于"能不能看"的第二个错误。

**修复**：`verifyAccessible` 的返回从 `Set<itemId>` 改为 `Map<itemId, securityLevel>`，一次回表同时拿到"能否访问"和"当前真密级"；词法路径与向量路径都改成用真值回显（`vector.store.ts` 补 `loadTrueLevels`，查不到时才退回快照，权限不受影响）。两条路径各加一条回归用例，变异探针确认会转红。

### 附：三处"骨架未闭环"（✅ 均已于 `0bbf744` 收口）

- `EsVectorStore`（`vector.store.ts`）**注册了 provider 但从未被注入** —— `KbService` 直接用 `entryRepo`（`kb.service.ts:49`）。该类的 `search()` 对所有命中返回 `score: 0`（`vector.store.ts:53`）。**抽象层曾是死代码** → 现真正被调用，打分改为真实余弦。
- `EMBEDDING_PROVIDER` 令牌（`embedding.provider.ts:25`）**全仓零引用** —— `KbService` 注入的是具体类 `LocalHashEmbeddingProvider`（`:51`）。想换模型必须改代码，不是改配置 → 现两个实现均经令牌注入，换模型只改 `kb.module.ts` 一处 wiring。
- KB 模块**零测试**：`apps/api/__tests__/` 22 个 spec，无一覆盖 kb → 新增 `kb.retrieval.spec.ts`（16 例），全量 459/459。
- 另修一处**伪造完成态**：`reindex()` 旧实现把 `embedding_status` 改成 `OK` 却不做任何向量化。现改为"无片段返回 0、不动状态位、WARN 说明 chunk 生产者未实现"。

---

## 3. LLM Wiki 与档案凭证价值的冲突（为什么建议不做）

「LLM Wiki」指让模型把档案内容自动改写成百科式条目/摘要页。它在一般知识管理里很好用，但在**档案系统**有三处硬冲突：

1. **违 F-22 判据**。验收要求"答案引用可溯源到具体条目"、"不生成无据内容"（`产品需求文档.md:173,378`）。wiki 式改写是**再创作**，一句话可能揉合 5 个 chunk 的信息、还掺入模型的世界知识 —— **无法逐句挂出处**。判据过不了。
2. **违档案的凭证价值**。档案的权威性来自原文不动。生成摘要一旦与原文有偏差，用户又拿它当结论用，这是**实质性风险**，不是体验问题。
3. **"不臆造"是代码级既定约束**。`KbPage.tsx` 里写着"前端如实提示「未启用」，绝不编造答案 —— 这是本项目对'不臆造'的硬约束"。wiki 生成会直接顶到这条线。

**唯一可做的变体**：**"带引用的导读页"** —— 每段生成内容后强制挂 `[档号:片段]`，且页首标注"AI 生成，仅供导览，不作为凭证"。这是 B 档的一个 UI 形态，不是独立档位。

---

## 4. 分档路径

### A 档｜检索增强（不上生成模型）

**做什么**
1. 新增 chunker（按段切分，300~500 字 / 重叠 50），写入 `kb_entry`，密级从条目元数据带。
2. 删 `kb.service.hashOf`，`retrieve()` 统一调 `embedding.embedOne()` —— 消除 D-2。
3. **权限下推**：ES mapping 加 `dense_vector` 字段（`dims` 与 provider 对齐），召回改 `knn` + `filter`；`kb_entry` 保留为权威元数据表 —— 消除 D-3。
4. `/kb/query` 返回 topK 片段 + 档号 + 密级，**不做生成**；命中为空时返回"无依据"而非 501。
5. 补 KB 单测（chunker 边界、权限过滤、kNN filter 构造）。

**为什么先做它**：不引入任何模型 → **不动硬件门槛、不动交付包体积、不新增容器**；且"不生成"天然满足 F-22 的"不臆造"。判据干净。

**实际形态（v1.2 交付，与上文计划的差异必须说明）**：计划里写的是"ES 加 `dense_vector` + kNN"，实际**先落在词法路径**上——`es-bm25-ik`（BM25 + IK 中文分词）召回、PG 回表二次校验。原因是当前 `LocalHashEmbeddingProvider` 声明 `productionReady = false`（字符 2-gram 哈希没有语义能力），拿它做向量召回会把无关片段排到前面，**看起来像语义检索，实际是噪声**，比词法更糟。

因此检索器按**能力声明**择一，而不是按配置开关（开关会被"顺手打开"，能力声明是代码事实）：

```
CHUNK_RETRIEVER = embedding.productionReady ? EsVectorStore : LexicalChunkRetriever
```

`EsVectorStore`（`pg-vector-scan`：权限下推 SQL + 逐页扫描 + 同空间余弦）已完整实现并单测覆盖，处于**待命**状态——换成真实 embedding 模型（bge 系）并置 `productionReady=true` 即自动接管，不需要改调用方。ES `dense_vector` kNN 留到片段量级需要时再做（当前量级下 PG 逐页扫描足够，避免提前引入 mapping 迁移与回填）。

### B 档｜RAG 问答（本地 embedding + 本地小 LLM）

**在 A 之上加**
1. **embedding**：bge-small-zh-v1.5（~95MB / 512 维，CPU 单条几十毫秒量级）起步；bge-m3（~2.2GB / 1024 维）效果好但权重与内存代价都要重新算。
2. **LLM**：Qwen2.5-3B-Instruct 或 7B-Instruct 的 **GGUF 量化（q4）**，CPU 推理。
3. **作答约束（三条硬规则）**：
   - 只允许基于给定片段作答，**片段为空 → 直接返回"无依据"，不调模型**（短路，省算力也保判据）；
   - 每个结论句后强制挂出处，**引用率不到 100% 的答案直接丢弃**重试或降级为"仅列片段"；
   - 模型输出只作"自然语言组织"，**不允许引入片段外的实体与数字**。
4. **接口形态改为异步**：CPU 上 7B q4 首 token 秒级到十几秒、整答数十秒 —— 同步 HTTP 撑不住。改成"提交任务 → 轮询/推送"与现有视频类异步任务同构。

**两个跨不过去的约束**
- **内存**：embedding + 7B q4 同机需 **≥16GB（建议 32GB）**，现状 K10 是 `≥8GB`。这是**门槛变更**，要写进安装器预检，属于交付面改动。
- **交付体积**：模型权重 2~5GB，主包当前 `tianji-offline-images.tar` 1.41GiB、整包 1,765,044,444 B。塞进去会让"**一个安装包即完整安装**"这个刚刚达成的目标变成 6~8GB。

> **建议：模型作为「可选离线包」独立分发**，与 images tar 同级。这与既有 §7.1「镜像 tar 必须独立分发」的裁决逻辑一致（双重解压磁盘成本、无法逐项校验、FAT32 4G 单文件上限）—— 模型包同样撞这三条，且更严重。**不要为了"单文件"这个说法牺牲可校验性。**

### C 档｜LLM Wiki

不建议 v1 做（理由见 §3）。若坚持，只能做 §3 末尾的"带引用导读页"，且需在 PRD 补一条明确的能力边界声明。

---

## 5. 合规判据对照（F-22 三条怎么落地）

| 判据 | 出处 | A 档 | B 档 |
| --- | --- | --- | --- |
| 答案引用可溯源到具体条目 | `产品需求文档.md:173` | ✅ 直接返回 `danghao + snippet`，无生成环节 | ✅ 强制引用率 100%，不达标即降级 |
| 未命中明确提示"无依据" | 同上 | ✅ 空结果 → 明确"无依据" | ✅ **片段为空直接短路，不进模型** |
| 支持按密级/全宗隔离 | 同上 | ✅ `buildKbFilter` 已实现，A 档补的是"下推"而非"新增" | 同 A |
| 私有化、无外网依赖 | 同上 | ✅ 无新增组件 | ⚠️ **需模型权重随包交付**，且需验证运行期零外呼 |
| 等保：数据不出内网 | `产品需求文档.md:173` | ✅ | ⚠️ 同上，需显式封禁外呼并留证 |

**权限口径提醒**：`buildKbFilter` 是**硬性验收要点 3**（`kb.service.ts:38-39`、`系统架构设计.md:64,765`）。A/B 两档**任何"为了召回率放宽过滤"的改动都不可接受**，只能改"过滤发生的时机"（下推），不能改"过滤的严格度"。

---

## 6. 建议的下一步（按顺序）

1. ~~先修 D-2 + D-3，不必等立项~~ → **已完成**（`0bbf744`）：向量空间统一、权限下推 SQL、`EsVectorStore` 与令牌接线收口、16 例回归 + 变异探针。这两条本就是既有代码缺陷，与"要不要做 RAG"无关。
2. ~~**A 档立项**：补 chunker + ES `dense_vector` 迁移 + kNN 检索~~ → **已交付**（《RAG知识库立项书》`TJ-RAG-01` M1）：chunker / 片段索引 / 自愈扫描 / 两段式检索 / 前端「片段检索」页 / `kb:reindex` 脚本全部落地，501 已解除。真机证据见 §8。
3. **B 档先做硬件复核**，再谈实现：目标机实际内存分布、CPU 是否支持 AVX2、7B q4 的实际 tokens/s。**硬件没结论之前不写 B 档代码。**
4. **交付面裁定**：模型包是否独立分发 —— 建议独立，理由同 §7.1。
5. **PRD 补两条边界**：①RAG 答案不作为档案凭证；②模型包可选，缺失时降级为 A 档能力。避免现场预期错位。
6. **ORG 范围缺口单独立项**：`archive_item` 无 `org_id`，ORG 型数据范围授权会在主检索与 kb 同时失效。与 RAG 无关，但会被 RAG 继承。

---

## 7. 本评估明确**未**验证的事

- 未做任何性能实测（CPU 上 embedding 吞吐、LLM tokens/s、kNN 延迟）—— 全部为量级估计。
- 未验证 ES `dense_vector` 在本项目 `ik` 自定义分析器/`dynamic:strict` 配置下的建索引与 kNN 行为（需实测，mapping 冲突风险真实存在）。A 档实际未走 kNN，该项仍悬空。
- 未核目标机 CPU 指令集（AVX2 缺失会让 GGUF 推理慢一个数量级）。
- 未评估 `fulltext` 500KB 截断对检索质量的影响（超长文档尾部内容对 RAG 不可见）。
- 本文档 v1.0 阶段未做任何代码改动；A 档实现与真机验证见 §8，**B/C 档仍不构成实现承诺**。

---

## 8. A 档真机验证证据（v1.2）

环境：本机 `docker compose` 全家桶（`tianji-api / postgres / elasticsearch-ik / seaweedfs / redis` 均 healthy），数据由 `demo:books` 造数（6 条目 / 12 文件 / 8 行 `document_text`）。

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 迁移 | 容器内 `typeorm migration:run` | `AddKbChunkNo1700000005000` 执行成功；`\d kb_entry` 确认 `chunk_no int not null default 0` + `uk_kb_item_chunk UNIQUE` |
| 建索引 | `kb:reindex --all` | 条目 6 / 片段 6 / 失败 0；3 个样本回读「PG 片段=1 ES 文档=1 ✓」 |
| 状态 | `GET /api/kb/status` | `{"enabled":true,"indexedChunks":6,"retriever":"es-bm25-ik","mode":"lexical","searchReady":true}` |
| 命中 | `POST /api/kb/query` | `{"answer":"","grounded":true,"citations":[{"danghao":"DEMO-BOOK-2026-0002-0001",…,"snippet":"题名：<em class=\"hl\">数字</em>…"}]}` |
| **越权零返回** | 条目升 SECRET 后**不重建索引**，用 PUBLIC 上限账号查询 | `citations=0 / grounded=false`；同问题 SECRET 账号 `citations=1`。ES 原始查询该问题返回 1 条（索引仍标 PUBLIC）→ 证明是**二次校验精确剔除**，不是整体失效 |
| 无依据 | 查询索引中不存在的主题 | `citations=[] / grounded=false`，前端显示「无依据」并列出三种可能 |
| 单元测试 | `vitest run` | 490 passed / 28 files |
| 静态检查 | `tsc --noEmit`（api + web）、`eslint --max-warnings=0`、`vite build` | 全部干净；构建产物正常 |

> 环境限制记录：宿主直连容器映射的 PG:5432 / ES:9200 会在 TCP 握手后立即断开（`Connection terminated unexpectedly`），`curl localhost:3000` 却正常。故迁移、脚本、SQL 一律在**容器内**执行。这一条已写入维护手册的排障节。

---

## 变更记录

| 版本 | 日期 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-11-10 | 首版：地基盘点（含 2 个代码缺陷 D-2/D-3 定位到行）、四缺口、三档路径、F-22 判据对照、模型包独立分发建议 |
| v1.1 | 2026-11-10 | **D-2/D-3 已修**（`0bbf744`）：补修复处置与验证证据；三处骨架未闭环（死代码 / 令牌零引用 / 零测试）+ `reindex` 伪造完成态 一并收口；新增 ORG 范围缺口登记（`archive_item` 无 `org_id`，主检索同款，待单独立项） |
| v1.2 | 2026-11-10 | **A 档交付**：D-1（chunk 生产者）闭合，新增 D-5（引用回显密级取索引快照，真机发现，已修）；补「计划 dense_vector kNN / 实际先落词法 + 向量路径待命」的差异说明与原因；新增 §8 真机验证证据表（越权零返回、无依据、状态口径、静态检查） |
