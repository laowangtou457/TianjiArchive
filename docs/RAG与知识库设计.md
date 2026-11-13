# RAG 与知识库设计

> 版本：v1.0（2026-11-13，P4 落地）
> 关联：`docs/系统架构设计.md`（§11 共享约定）、`docs/RAG知识库可行性评估.md`、`docs/工作流与审批流设计.md`

---

## 1. 定位：它不是"给档案加个聊天框"

| 需求 | 通用 RAG 做法 | 天玑的做法 | 为什么 |
|---|---|---|---|
| 召回 | 先 TopK，再用权限过滤 | **SQL 里就带密级/全宗条件** | 无权内容不能进候选集，否则模型会基于"空上下文"编答案，且越权文本已进日志 |
| 回答 | 自由发挥 | 只依据片段，必须带 `[序号]` 引用 | 档案回答要能回溯到档号，否则不可用于业务 |
| 无模型时 | 报错 | 降级为词法召回 + 抽取式摘要，并明示 | 内网现场常常没有 GPU；"能查"比"能聊"重要 |
| 存在性 | 403 告知无权 | **404**（当作不存在） | 涉密档案的"存在"本身也是敏感信息 |

结论：这是一个**带权限的档案知识检索层**，聊天只是它的一种呈现方式。

---

## 2. 三个预留接口（P4 三件套）

```
┌──────────────────────────────────────────────────────────────┐
│ 1) EmbeddingProvider    embed(texts) -> number[][]            │
│    实现：OllamaEmbeddingProvider（/api/embed 批量）            │
│    可替换：内网 embedding 服务 / 商用 API（只改 providers）     │
├──────────────────────────────────────────────────────────────┤
│ 2) RagService.retrieve(query, topK, user) -> RagRetrieveResult │
│    **全系统唯一 RAG 检索入口**，内部强制走 AccessFilterBuilder    │
├──────────────────────────────────────────────────────────────┤
│ 3) LlmGateway.chat(system, user) -> string                     │
│    只负责"发消息收文本"，提示词留在业务层（RAG/Wiki/编研各写各的）│
└──────────────────────────────────────────────────────────────┘
```

文件位置：`apps/api/src/modules/rag/embedding.provider.ts`、`rag.service.ts`。

---

## 3. 数据与存储

### 3.1 `item_chunk`（机器切块，可全量重建）

| 列 | 类型 | 说明 |
|---|---|---|
| `item_id` / `chunk_no` | uuid / int | 联合唯一，保证重建幂等 |
| `content` / `char_len` | text / int | 片段正文与长度 |
| `embedding` | `vector(768)` | pgvector 列；无扩展时退化为 `double precision[]` |
| `security_level` / `fonds_id` | varchar / uuid | **刻意冗余**：召回 SQL 直接过滤，不能先召回再过滤 |
| `deleted` | bool | 条目删除后同步标记（避免残留被召回） |

与 `kb_entry` 的分工（不要合并）：

| | `kb_entry` | `item_chunk` |
|---|---|---|
| 来源 | 人工/半自动整理的片段 | 从全文机器切块 |
| 用途 | 「片段检索」业务，可编辑 | 向量召回，可随时重建 |
| 重建影响 | 会冲掉人工编辑 → 不参与重建 | 每次重建整体替换 |

### 3.2 pgvector 怎么装上的（现场重要）

官方 `postgres:16-alpine` 不含 pgvector，而 Alpine 仓库的 `postgresql-pgvector`
是**为 PG18 编译**的（扩展目录 `/usr/share/postgresql18`），塞进 PG16 会加载失败。

因此自建镜像 `infra/postgres/Dockerfile`：

```
FROM postgres:16-alpine
下载 pgvector 0.8.1 源码 → 用 PG16 的 pg_config 编译 → make install
关键：make with_llvm=no（官方镜像带 JIT，会强制要求 clang 生成 .bc 位码）
```

- 主版本仍是 16，数据目录格式不变，`./volumes/postgres` **原地复用**（无需 dump/restore）；
- `CREATE EXTENSION vector` 在迁移 `1700000000010` 里执行，失败会静默跳过（降级路径仍可用）；
- 索引：`USING hnsw (embedding vector_cosine_ops)` —— 小库上 HNSW 比 ivfflat 召回稳
  （ivfflat 需要足够训练样本，几千条时召回率差）。

### 3.3 换嵌入模型的四步（维度一变必须做）

`vector(N)` 的 N 是**列定义的一部分**，换模型（768 → 1024）不能只改配置：

1. `DELETE FROM item_chunk;`（旧向量维度不同，无法混用）
2. `ALTER TABLE item_chunk ALTER COLUMN embedding TYPE vector(1024);`（索引会随之失效）
3. `DROP INDEX idx_item_chunk_vec;` → `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops);`
4. 改环境变量 `EMBEDDING_MODEL` / `EMBEDDING_DIM`，重启 API，`POST /api/rag/reindex` 重建。

---

## 4. 检索链路

### 4.1 三条路径（同一 DTO 出参）

```
                    ┌── 嵌入可用 ──┬── 向量召回（SQL: 1 - (embedding <=> $q)）
retrieve(query) ────┤              └── 2-gram 词法召回 ──▶ 融合（0.65 / 0.35）
                    └── 嵌入不可用 ──▶ 纯词法召回（degraded=true）
```

**为什么混合而不是纯向量**：中文短查询（「四性检测」「卷宗」）在通用英文嵌入模型
（nomic-embed-text）下语义漂移明显，纯向量会把字面强相关的片段排到后面；
2-gram 词法补精确匹配，向量补同义/改写。同一 chunk 两路都命中时分数相加
（字面 + 语义双相关，应更靠前）。

### 4.2 权限过滤（不可妥协）

```sql
SELECT c.id, ..., 1 - (c.embedding <=> $1::vector) AS score
  FROM item_chunk c
  JOIN archive_item i ON i.id = c.item_id
 WHERE c.deleted = FALSE AND c.embedding IS NOT NULL
   AND i.security_level IN ($3, $4)      -- ← AccessFilterBuilder 生成
   AND (i.fonds_id = ANY($5))            -- ← 数据范围
 ORDER BY c.embedding <=> $1::vector
 LIMIT $2
```

数组回退路径（无 pgvector）同样带过滤条件，只是排序在 Node 里算（候选上限 4000 条，
再大就该上 pgvector 而不是硬算）。

### 4.3 降级语义（前端可见）

| 情况 | `mode` | `degraded` | 用户看到 |
|---|---|---|---|
| 嵌入 + 生成都可用 | `VECTOR` | false | 模型综述 + 引用 |
| 嵌入可用、生成不可用 | `VECTOR` | true | 「生成模型不可用，以下为检索摘录」 |
| 嵌入不可用 | `LEXICAL` | true | 「当前为全文词法召回」+ 配置提示 |

---

## 5. 建库（reindex）

### 5.1 文本来源顺序（不可颠倒）

```
document_text（抽取器产物） → kb_entry（片段表） → archive_item.full_text（人工/历史）
```

**顺序颠倒会清空已抽取的全文**：抽取器只写 `document_text` + ES，若优先读
`archive_item.full_text`，重建时会用空值覆盖已抽好的文本（P2 曾因此丢过全文）。

### 5.2 切块参数

复用 `packages/shared/src/chunker.ts`（与 `kb_entry` 同一实现，避免两套口径）：
`target=400`、`max=600`、`overlap=80`，单条目上限 `RAG_MAX_CHUNKS_PER_ITEM=40` 块。

### 5.3 执行方式

| 方式 | 触发 | 批量 | 说明 |
|---|---|---|---|
| 手动 | `POST /api/rag/reindex`（PARAM WRITE） | `limit` ≤ 500 | 现场首次建库 / 指定 ids 重建 |
| 增量 | `RagScheduler` 每 3 分钟 | 20 件 | 只挑「还没有任何块」的条目，`RAG_AUTO_INDEX=false` 可关 |

嵌入按 **8 条/批** 请求：实测单批 20 条会触发 Ollama 超时（GPU 上排队），
小批虽然往返多，但成功率和总耗时都更优。

实测（3469 件演示数据）：约 5 块/件，嵌入吞吐 ≈ 20 块/秒，全量约 15–20 分钟。

---

## 6. 问答（`/api/rag/ask`）

提示词策略（写在 `RagService.ask` 里，不在网关）：

```
system: 你是档案查询助手。只能依据给定片段回答，禁止使用片段以外的知识或推测。
        末尾用 [序号] 标注依据；片段不足时直接说明缺少哪些信息。
user:   档案片段：[1] 档号｜题名 + 正文(700 字) …  问题：xxx
```

- `temperature=0.2`、`num_ctx=8192`；
- 每个片段截 700 字（6 个片段 ≈ 4.2k 字，留出回答空间）；
- 生成失败 → 抽取式摘要（前 3 段原文 + 明示「未经归纳」）；
- 引用回显：`citations[]` 含档号、题名、片段序号与摘要，前端可跳原件。

模型选择：默认 `qwen3:8b`（单轮 5–15s）。`qwen3:32b` 更强但单轮 30s+，
现场按 `LLM_MODEL` 覆盖；超时由 `LLM_TIMEOUT_MS` 控制（默认 180s）。

---

## 7. LLM Wiki（`/api/wiki/*`）

| 能力 | 接口 | 实现要点 |
|---|---|---|
| 条目关联 | `GET/POST /wiki/items/:id/relations` | 双向查询；对端无权则**不出现在结果里** |
| 自动关联 | `POST /wiki/items/:id/auto-link` | 同主题词重合度 → `RELATED`；同案卷 → `SERIES`；权重 0.4+0.15×重合数 |
| 删除关联 | `DELETE /wiki/relations/:id` | 需源条目的读权限 |
| 主题聚合 | `GET /wiki/topics` | `unnest(keywords)` 分组统计，**带密级/范围过滤**（主题词分布本身会泄露馆藏结构） |
| 条目摘要 | `POST /wiki/items/:id/summary` | 元数据 + 首 2 块正文 → LLM；不可用时退化为元数据摘要并标 `degraded` |

关系类型：`RELATED`（主题相关）/ `SERIES`（同卷）/ `CITES`（引用，人工）/ `SAME_DOC`（同文件不同版本，人工）。
`source='AUTO'` 可被重建覆盖/删除，`MANUAL` 保留。

---

## 8. 配置项（`.env` / compose）

| 变量 | 默认 | 说明 |
|---|---|---|
| `EMBEDDING_BASE_URL` | `http://host.docker.internal:11434` | Ollama 地址（容器内指宿主） |
| `EMBEDDING_MODEL` | `nomic-embed-text` | 中文场景建议换 768 维中文嵌入模型 |
| `EMBEDDING_DIM` | `768` | 必须与列定义一致 |
| `EMBEDDING_TIMEOUT_MS` | `60000` | 批量嵌入超时 |
| `LLM_BASE_URL` | 同 embedding | 生成网关 |
| `LLM_MODEL` | `qwen3:8b` | 32b 更强但慢 |
| `LLM_TIMEOUT_MS` | `180000` | 长上下文生成留足时间 |
| `RAG_TOP_K` | `6` | 默认召回条数 |
| `RAG_MIN_SCORE` | `0.2` | 相似度下限（低于即丢弃） |
| `RAG_AUTO_INDEX` | `true` | 增量建库开关 |
| `RAG_AUTO_INDEX_BATCH` | `20` | 每轮件数 |
| `RAG_MAX_CHUNKS_PER_ITEM` | `40` | 单件最多块数 |

容器访问宿主机 Ollama 依赖 `extra_hosts: host.docker.internal:host-gateway`（compose 已加）。

---

## 9. 实测与容量

| 指标 | 实测值 | 备注 |
|---|---|---|
| 嵌入吞吐 | ≈ 20 块/秒 | nomic-embed-text，8 条/批 |
| 检索延迟 | 0.8–1.6s（含嵌入） | 3.5k 件 / 1.7 万块规模 |
| 生成延迟 | 5–15s（8b）/ 30s+（32b） | 取决于模型与上下文长度 |
| 存储 | ≈ 3 KB/块 | 768 维 float4 + 正文 |

容量判断：千万级块以内单机 pgvector 足够；再上量再考虑 Milvus（接口已隔离）。

---

## 10. 排错

| 现象 | 根因 | 处理 |
|---|---|---|
| `/rag/status` 显示 `embeddingAvailable=false` | Ollama 未启动 / 模型未拉 | `ollama pull nomic-embed-text`；检查 `EMBEDDING_BASE_URL` |
| `chunkCount=0` 但能看到档案 | 尚未建库 | `POST /api/rag/reindex`，或等增量调度 |
| 检索结果与问题无关 | 只建了少量条目 / 嵌入模型中文弱 | 先全量建库；中文场景换中文嵌入模型 |
| 建库报 `This operation was aborted` | 单批过大或模型排队 | 已默认 8 条/批；可调 `EMBEDDING_TIMEOUT_MS` |
| 问答返回「未经归纳」 | 生成超时/模型不可用 | 换 8b、提高 `LLM_TIMEOUT_MS` |
| `vectorStore=ARRAY_FALLBACK` | 扩展未安装 | 重建 PG 镜像（`docker compose build postgres`）并 `CREATE EXTENSION vector` |
| 检索越权（理论不应发生） | 自定义 SQL 绕过 AccessFilterBuilder | 任何新检索必须复用 `buildSql`，代码评审拦截 |

---

## 11. 后续演进

1. **交叉编码器重排**（bge-reranker）：混合召回后取 Top20 重排取 Top6，中文场景收益最大；
2. **中文嵌入模型**：换 768 维中文模型（如 dmeta-embedding-zh 类）成本最低、收益最直接；
3. **多模态**：照片/录像档案接入视觉嵌入（`item_chunk` 加 `modality` 字段）；
4. **编研辅助**：Wiki 主题聚类 + 摘要 → 自动生成编研提纲（复用 LlmGateway）；
5. **评估集**：建 30–50 条「问题 → 应命中文档」基准，改模型/改切块后跑回归（现在靠人眼）。
