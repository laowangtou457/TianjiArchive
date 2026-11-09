# QA 独立验证方案 —— P0 文件链路（SeaweedFS 方案 A）

> 编制：严过关（QA）｜ 阶段：**阶段一（方案与脚本准备，不执行验收）**｜ 基线：`E:\TianjiArchive` HEAD `f111a7c`（架构文档自述）｜ 日期：2026-11-09
> **事实读取时刻锚**：§1 的源码事实读于 2026-11-09 09:39–09:45，且当时工作区有**工程师并发在途改造**（`git status` 显示 `storage.module.ts` / `configuration.ts` / `.env.example` / `docker-compose.yml` 等为 `M`，另有未跟踪的 `infra/seaweedfs/`、`apps/api/src/scripts/seaweedfs-s3-probe.ts`）。这些是**工作区状态、不是 HEAD 定论**；阶段二起栈时须以届时源码为准重新核对，本方案的 C05/C06/C08 均用实测判据而非读源码断言，故不受在途改动影响。
> **v1.1 变更（并入主理人补充裁定 D-4、PM `DEMO-ACCEPTANCE.md` v1.1 `63f4d69`）**：新增独立检查点 **C18**（D-4 下载技术层 wire 用例，复现 `file.service.ts:418-420` 生产 `presignGet` + `response-content-disposition` 调用形态）；新增 **§2.5 D-4 下载链路分层纪律**；§8 阶段二对 §五 R1 的解除意见**收窄为「部分解除」——下载业务放行仍不可签**；脚本输出新增 `D4_TECH_LAYER` / `D4_BUSINESS_LAYER` / `D4_CONCLUSION` 三行分层结论。计数广播：core 19→**20**、full 20→**21**、`--self-test` 17→**18** 条，全部已全仓复核。PM 上一条消息中「R0 临时授予 FILE:DOWNLOAD」路径已由 D-1 否决作废，**本方案不含该夹具、不构造带 `DOWNLOAD` 授权的用户快照**。
> **v1.2 变更（C08 判据必然假红修正 · 主理人放行前裁定，2026-11-09）**：架构师对 SeaweedFS **3.79** 完成 6 组容器内只读实测（镜像 `21425305e04b`），证伪阶段一 F9 / F10 / 风险② 基于「需显式配置 CORS 才能暴露 ETag」的**原假设**——3.79 内置全局 CORS middleware，带 `Origin` 的请求无条件返回 `Access-Control-Expose-Headers: *`（通配）+ `Allow-Origin: *` + `Allow-Credentials: true`，PUT / UploadPart 返回 ETag，OPTIONS 预检 200，鉴权开启下 403 亦带全套 CORS 头；`PutBucketCors`（501）、s3.json `cors` 段（被忽略）、`exposeHeaders` flag（不存在）均被证伪。**后果**：阶段一 C08 按字面量 `ETag` 精确断言，面对 `*` 必然假红，把一个正确实现误判为 `INCOMPATIBLE`（§8 C 档「验出不支持」），与「CORS 非阻断」结论相反。**修正**：抽出纯函数 `exposesEtag(v)` 接受 `*` 与显式 `ETag` 两种合法形态，C08 改为验「浏览器能否读到 ETag」这一**效果**而非响应头字面值；接受 `*` 附带 `credentials=omit` 静态源码守卫（不默认成立，运行时前端配置列入阶段二报告未验证项）；C08 失败归因改为三查（Origin / 同域反代 / credentials），`INCOMPATIBLE` 仅在「带了 Origin 且非同域前提成立、仍未返回合法暴露头」时使用，无任何 CORS 头归 `TOOL_ERROR`。**计数广播**：`--self-test` 18→**25 条**；core **20** / full **21** 不变。**等价正确性**：本次是**纠正语义错误（把响应头字面值误当验收目标），不是放宽判据、不是降级**——`*` 在 `credentials=omit` 下按 CORS 规范确实达成「浏览器可读 ETag」效果，故「`*` 或显式 `ETag`」是等价正确判据，强度不降低（完整论证见 §5 C08）。**按项目纪律保留「原假设 → 实测更正」全过程，不静默删改旧表述**（见 §1 F9/F10、§1.2 风险②、§7.1 更正链条第 5 条）。本次仍**未执行 `--suite core`、未改方案外文件**。
6. > **v1.3 变更（阶段二首跑 3 FAIL 归因后主理人四项裁定授权，2026-11-09）**：阶段二 core 首跑（HEAD `5a0fbc2`，日志 `qa-file-pipeline-stage2-core-20261109084451952.log`）**17/20，3 FAIL**，QA 逐项归因均为**判据/裁定层**而非产品缺陷，上报后主理人四项裁定（采 QA 建议方案）授权修正：① **C01 → 收权正验证**：s3.json identity 收权（`storage.module.ts:34` 注释即来源）使业务身份 CreateBucket 被拒属**安全架构裁定**，判据改写为「业务身份 CreateBucket **应被拒**：403/AccessDenied 即 PASS（`isAccessDenied()` 纯函数）」，桶存在性由 G2 四桶 HeadBucket 保证；原「CreateBucket 幂等」判据与收权裁定冲突，留痕作废（§5 C01）。② **C02 → 等效判据**：主判据 `Content-Type` 回读一致（生产真实依赖：`backup.service:316`/`file.service:361`/`object.fetcher:50` 只传 Content-Type，`backup.service:319` 只读 `stat.etag`，**metaData 自定义键生产零消费面已查证**）；`x-amz-meta-*` 接受「带前缀 / SeaweedFS 剥前缀」两种回读形态（`metaValueLoose()` 纯函数），差异登记 §8 已知边界（§5 C02）。③ **C08 → methods/headers 效果判据**：实测（`qa-stage2-cors-20261109165117.log` + `lead-stage-c4-cors-headers-20261109153324.log` 原值双证）3.79 返回 `Allow-Methods: *` / `Allow-Headers: *` 通配形态，字面断言与 v1.2 前 Expose-Headers **同构必然假红**；`methodsOk`/`headersOk` 改用 `corsListAllows(v, needle)` 纯函数（`*` 通配或显式列表），与 `C08_WILDCARD_PREMISE=CREDENTIALS_OMIT_REQUIRED` **共用同一守卫**（任一头为 `*` 即触发 `credentialsOmitGuard()`），归因分叉维持（§5 C08）。④ **下载放行成功路径维持 L2 登记，不演示**（approval 授权写入链路未实现是产品事实，不为演示制造授权；QA 实测证据：预览放行 + sha256 与 DB 全等 + 下载 403/`code=4007` 拒绝正确 + 留痕 `DENIED`/`SUCCESS`）。**计数广播**：`--self-test` 25→**30 条**（新增 5 条守护用例）；core **20** / full **21** 不变。**等价正确性同 v1.2**：三项修正均为纠正「判据与架构裁定/实测形态不一致」的语义错误，**不是放宽、不是为绿改判据**——每项都以实测日志或生产消费面查证为依据，fail-closed 与归因分叉未松动。修正后复跑：`SELFTEST: PASS (30/30)`（`…selftest-v13-20261109090006172.log`）+ **core 20/20 全绿 `IS_PASS: YES`**（`…stage2-core-v13-20261109090025825.log`）。
> 上游依据：`docs/ARCHITECTURE-SEAWEEDFS.md` v1.1 §1.2 / §4；`docs/QA-REPORT.md` §五 R1（第 512、522、756、829、863 行）、§六；`docs/DEMO-ACCEPTANCE.md` §2 S0-3 / S4 / S8、§5 范围口径；`apps/api/src/infra/storage/storage.module.ts`；`apps/web/src/components/FileUploader.tsx:104-114`；`apps/api/__tests__/storage.minio-contract.spec.ts:4-8`。
>
> **本文件阶段一只交付「验证方案 + 可执行脚本」，不构成任何验证结论。** `IS_PASS` 只有在阶段二对真实 3.79 容器执行、并独立复核原始日志后才有意义。
>
> **边界（阶段一严格遵守）**：不改生产代码、不改 `docs/QA-REPORT.md` 正文、不改 `docs/ARCHITECTURE-SEAWEEDFS.md`、不改 `docs/DEV-PROCESS.md`、不改 `docs/DEMO-ACCEPTANCE.md`。`__tests__` 为 QA 领地，工程师改动测试文件前须报备（文件名 + 预计时长）。
>
> **纪律三条（写死，防止自造口径与假绿）**
> 1. `apps/api/__tests__/storage.minio-contract.spec.ts:4-8` 明确「不发起网络请求」，只校验 SDK 方法存在与 `MinioService` 契约；`QA-REPORT.md:177` 记其为**契约绿（11 条）**。它**不能作为任何一条 wire 兼容性的证据**，也不能作为「四桶已创建」的证据（`ARCHITECTURE-SEAWEEDFS.md:153` 同口径）。
> 2. **「脚本存在」≠「验证通过」**，「脚本 `--self-test` 全绿」≠「服务兼容」。脚本自证只证明判据引擎不假绿，不证明被测服务可用。
> 3. 验证必须走 **真实 wire**（真实 S3 网关 + `minio@8.0.7` SDK 调用序列 + 原生 HTTP 模拟浏览器），**禁止只用 mock**；QA 脚本不 import 被测 `storage.module.ts`，避免「自己验自己」的替身陷阱（`docs/TESTING-GUIDELINES.md` §5 变异 0 红排查顺序第 ① 条）。

---

## 0. 为什么要单独立这份方案

`QA-REPORT.md` 终判为 **PASS（限定范围）**，并如实保留两项排除范围（`QA-REPORT.md:862-866`）：

1. **MinIO 文件存储真实链路**（§五 R1 行 522、§六 756、§六 829-830、§八 863）：「P0 文件入库 / 下载 / 四性检测链路未验证」，判为「❌ 中·保留（**不可签**）」；
2. 多容器 pub/sub 跨进程投递。

用户已拍板 MinIO 替代选型为 **SeaweedFS 方案 A**，当前目标为「样品 demo 送封闭环境试用」，8 项高敏参数走试用态默认值，真实书籍样本后续提供、先用模拟数据。因此本轮要关闭的是第 1 项中「**功能级实证**」部分。`DEMO-ACCEPTANCE.md:354,361` 已明确界定：demo 通过只代表「样品 demo 功能可演示」，**不等于** `QA-REPORT.md §六`「仍不能签字的两项」被关闭，也不等于 2GB 断点续传 / 多容器 pub/sub 等生产级验证完成。本方案与脚本严格服从该范围口径，**不把 demo 范围的结论写成生产级签字**。

阶段二由 QA 独立裁定「是否解除 §五 R1 不可签意见」，判定档位见 §8。

---

## 1. 证据基线：当前 HEAD 已核实的事实与一处确定性风险

### 1.1 已核实事实（逐条有行号，非推断）

| # | 事实 | 出处（本次实读） |
|---|---|---|
| F1 | `MinioService` 仍是**单 `client`**，`presignedUrl('PUT')` / `presignedGetObject` 均由该 `client` 签发；构造参数 `endPoint/port/useSSL/accessKey/secretKey` 全来自 `config.get('minio')` | `storage.module.ts:33,37-55,107-127,267-286` |
| F2 | `configuration.ts` 的 `minio` 段默认 `endPoint='seaweedfs'`（**容器 DNS**）、`port=8333`，无任何 `S3_PUBLIC_*` / `publicClient` 字段 | `configuration.ts:107-122`（本次 grep `PUBLIC\|publicClient\|public` 命中 0） |
| F3 | `.env.example` 与 `docker-compose.yml` 均无 `S3_PUBLIC_*`；`MINIO_ENDPOINT=seaweedfs`、`MINIO_PORT=8333`；SeaweedFS 服务 `chrislusf/seaweedfs:3.79` 已配置，宿主发布 `${SEAWEEDFS_S3_EXPOSED_PORT:-8333}:8333`，healthcheck 为 `wget http://127.0.0.1:8333/` 期望 200/403 | `.env.example:33-53`；`docker-compose.yml:26-27,122-142,296-303` |
| F4 | 浏览器分片直传读 `res.headers.etag`（去引号）回传 `parts[]`，整对象直传走 `presign.putUrl`；分片阈值 `CHUNK_SIZE` | `FileUploader.tsx:97-119`；`ARCHITECTURE-SEAWEEDFS.md:314` 引 `packages/shared/src/enums.ts:572-574`（`MAX_FILE_SIZE=2GB`/`CHUNK_SIZE=5MB`） |
| F5 | `storage.minio-contract.spec.ts:4-8` 自述「本机无 Docker/MinIO，无法做真实连通性测试」「构造 `Minio.Client` 不会建立连接（惰性）」——**不发起网络请求** | 本次实读第 1-14 行 |
| F6 | 四桶默认名 `archive-original` / `archive-preview` / `archive-thumb` / `archive-backup` | `configuration.ts:115-120`；`.env.example:50-53`；架构 §3.1 |
| F7 | `minio@8.0.7` 实测存在于 `apps/api/node_modules/minio`（根 `.pnpm/minio@8.0.7`）；Node `v22.22.2`；`.gitignore:46` 已有 `!docs/perf/runs/*.log` 白名单 | 本次 `ls` / `node -v` / `.gitignore` 实读 |
| F8 | 架构 §1.2 已把原「预签名 host 高风险假设」升级为**已裁定双端点方案**：新增 `S3_PUBLIC_ENDPOINT` / `S3_PUBLIC_PORT` / `S3_PUBLIC_USE_SSL`，独立 `publicClient` **仅**用于生成预签名 URL，其余操作走内部 `seaweedfs:8333`；浏览器直连宿主 8333、不经 nginx 反代 | `ARCHITECTURE-SEAWEEDFS.md:75-78` |
| F9 | 架构 §4 明确 CORS `ExposeHeaders: ["ETag"]` 与分片 part ETag 格式仍「**待实测**」；双端点不消除跨域问题 | `ARCHITECTURE-SEAWEEDFS.md:77,224,324` |
| F10 | 工作区 `infra/seaweedfs/entrypoint.sh:45-52` 的 `weed server -dir=/data -ip.bind=0.0.0.0 -filer -s3 -s3.port=8333 -s3.config=... -master.port=9333` **不含任何 CORS flag**；`s3.json.tpl` 只有 `identities[].actions=["Admin","Read","Write","List"]`，**无 CORS / ExposeHeaders 配置** | 本次实读 `infra/seaweedfs/entrypoint.sh`、`s3.json.tpl`；全目录 grep `cors\|allowedOrigins\|ExposeHeaders\|expose` 命中 0 |

> **F9 / F10 实测更正（v1.2，保留原假设原文不删）**：上两行的**文件事实本身仍成立**（启动参数确无 CORS flag、s3.json.tpl 确无 cors 段），但由此推出的「3.79 未配置 CORS → 浏览器读不到 ETag」这一**推断已被实测证伪**。架构师对 3.79（镜像 `21425305e04b`）6 组容器内闭环实测：**全局 CORS middleware 是内置的、零配置生效**——带 `Origin` 的请求无条件返回 `Access-Control-Expose-Headers: *`（通配覆盖 ETag）+ `Allow-Origin: *` + `Allow-Credentials: true`；PUT / UploadPart 返回 ETag；OPTIONS 预检 200；鉴权开启下 403 响应亦带全套 CORS 头。`PutBucketCors` 返回 501、s3.json `cors` 段被忽略、无 `exposeHeaders` flag，即**无法按需配置成单列 ETag**。故「没有配置」≠「没有 CORS」；C08 判据必须验**效果**（浏览器能否读到 ETag），不能验响应头字面值。架构师该独立容器实测仅为「能力证据」，与阶段二**交付栈实测证据**分开、不合并。
| F11 | 工程师自验脚本 `apps/api/src/scripts/seaweedfs-s3-probe.ts`（207 行，未跟踪）用**单 client** + Node `fetch` 跑 `presignedUrl` / `presignedGetObject` / `initiateNewMultipartUpload` / `listParts` / `completeMultipartUpload` / SHA-256；grep 未覆盖 `CORS`、`ExposeHeaders`、`Range`、错误凭据 403、预签名 host 浏览器可达性 | 本次实读该文件第 10-11、48-62、104-162 行 |

| F12 | **QA 独立复核 D-4 事实（不轻信转述）**：`file.service.ts:410-434` 的 `download()` 在 `approval` 模式只读 `hasApprovedDownloadGrant(user)` → `user.grants['FILE'].ops.includes('DOWNLOAD')`；`:427` 注释称「审批通过后由审批链路写入」，但全仓 `*.ts` grep `DOWNLOAD` 字面量只命中枚举定义（`enums.ts:441,460,484`）、审计拦截器/装饰器注解、`configuration.ts:144,176` 的开关与启动提示、以及该读取点，**无任何一处把 `DOWNLOAD` 写入角色/用户授权**；`seed-data.ts` 五个内置角色 FILE 域 ops 均无该操作 | 本次实读 `file.service.ts:388-435`；全仓 Grep `DOWNLOAD` 20 处逐条分类；与 `DEMO-ACCEPTANCE.md:172` 结论一致但**证据源独立**（源码实读，非文档互证） |
| F13 | `apps/api/src/scripts/demo-books-seed.ts:580-591` 的 `PRESIGNED_DOWNLOADS_OK` 是**纯 S3 wire 自检**（`client.presignedGetObject` + `fetch` + `sha256` 比对），**不经 `file.service.download()` 鉴权、不构造 `DOWNLOAD` 授权**，故**不构成** D-1 禁止的「以绕过手段制造下载成功」；但命名 `*_DOWNLOADS_OK` 会被读成「下载功能已验证」，与 D-4 分层表述冲突，建议工程师在输出/文档里标注为「wire 层自检」 | 本次实读 `demo-books-seed.ts:580-620` |

### 1.2 【三项确定性风险 · 阶段二重点观测，QA 只记录不修改】

**风险① 双端点尚未落地（读取时刻 09:43 复核仍成立）**
F1/F2/F3 与 F8 存在**实现落差**：架构已裁定双端点，而工程师在途改造（本次 `git diff` 实证）只把 `configuration.ts` 的默认端点改为 `seaweedfs`、`MINIO_PORT` 改为 `8333` 并补了注释，`storage.module.ts` 只改了注释措辞；**`S3_PUBLIC_*` 与 `publicClient` 在 `configuration.ts` / `storage.module.ts` / `.env.example` / `docker-compose.yml` 四个文件全仓 grep 仍为 0 命中**。若阶段二起栈时仍以 `MINIO_ENDPOINT=seaweedfs` 签发预签名 URL，URL host 为容器 DNS，封闭环境浏览器无法解析，S0-3（`DEMO-ACCEPTANCE.md:80`）与架构 §4 #6/#9 两条「最高优先」判据会直接失败。
> 措辞纪律：以上是**读取时刻的工作区快照**，不是对工程师最终交付的判断；改造仍在进行，阶段二须以届时源码重新核对。

**风险② CORS 未配置，C08 大概率红（F10，架构 §7 第 2 条「仍待实测」）——【v1.2 原假设，已被实测证伪，保留留痕】**
`infra/seaweedfs/entrypoint.sh:45-52` 的 `weed server -s3` 启动参数与 `s3.json.tpl` 均无任何 CORS / `ExposeHeaders` 配置。架构 §1.2:77 明确「双端点不消除跨域问题：浏览器对 8333 的 PUT/GET 仍需 CORS，且分片合并依赖 `ExposeHeaders: ["ETag"]`」。若阶段二未补 `-s3.allowedOrigins` 等配置，浏览器即使 PUT 成功也读不到 `res.headers.etag`（`FileUploader.tsx:108`），分片合并链路必断。C08 用 preflight + 实际响应头精确断言，能抓出该缺口。

> **风险② 实测更正（v1.2）**：**CORS 不是阻断项**。3.79 内置全局 CORS middleware，零配置即返回 `Expose-Headers: *` 通配（见 F9/F10 更正），无需也不存在 `-s3.allowedOrigins` 这类配置。原假设「C08 大概率红」不成立；取而代之的真实风险是 **QA 判据自身的必然假红**——阶段一 C08 只认字面量 `ETag`，面对 `*` 会把正确实现误判为 `INCOMPATIBLE`。该缺陷已于 v1.2 修正（§5 C08、§7.1 第 5 条）。阶段二风险重心转为：①请求是否带 `Origin`（CORS 头是**条件性**的，不带 Origin 时 3.79 不返回任何 CORS 头）；②是否被反代收敛到与 Web 同域（同域浏览器不带 Origin）；③前端是否设 `withCredentials=true` / `credentials: include`（`Allow-Origin: *` + `Allow-Credentials: true` 会被浏览器拒绝，`Expose-Headers: *` 被当字面量）。**不得**把「分片 PUT 成功、completeMultipart 失败」或 C08 红写成「SeaweedFS 与 SigV4 不兼容」。

**风险③ 工程师自验脚本的绿不能当浏览器证据（F11）**
`apps/api/src/scripts/seaweedfs-s3-probe.ts` 用 Node `fetch` 读 `resp.headers.get('etag')`。**Node 不受浏览器同源策略约束，能读到响应头 ≠ 浏览器能读**；该脚本亦未覆盖 CORS、`Expose-Headers`、`Range`、错误凭据 403、预签名 host 可达性。因此：
- QA 独立脚本**不复用**该脚本，也不以它的全绿作为任何 wire 判据的证据（与 §0 纪律 1、3 同源）；
- 它的绿与 QA C08 的红若同时出现，恰恰证明「网关返回了 ETag，但浏览器读不到」，属于有效的分工证据，不是矛盾。【v1.2 注：这是**原假设**下的分工推理；3.79 实测 `Expose-Headers: *` 后，C08 的红不再是「浏览器读不到 ETag」的证据，须按风险②更正的三查归因，不得据此判不兼容】

**QA 立场**：
- 三项均属**工程师改造范围**（架构 §1.2、§7、文末「Compose 改造、SDK 兼容实测由工程师并行实施」）；QA 阶段一不改代码、不改配置、不改架构文档、不改工程师自验脚本。
- 本方案 C05/C06 把「预签名 URL host 必须浏览器可达、且不是容器 DNS」写成**实测判据**（真实 HTTP 请求）；C08（v1.2 修正后）把「浏览器能否读到 ETag」写成**效果判据**（`Expose-Headers` 为 `*` 或显式 `ETag` 均合法，非响应头字面值精确断言），都不是读源码断言；因此既能验收落地后的实现，也能在未落地时给出 `CONFIG_MISSING` / `INCOMPATIBLE` 的明确 NO，**不会假绿**。
- QA 不据此提前判定「方案 A 不兼容」——只有阶段二真实 wire 结果才是证据。

### 1.3 与 PM 验收文档的口径对齐

`docs/DEMO-ACCEPTANCE.md` 已建立「操作 / 预期 / 验收判据 / **如果失败，唯一原因是什么**」四栏体例（S0-3、S4、S7、S8 等），本方案 §5 全盘对齐该体例。读取范围口径亦对齐：

- `DEMO-ACCEPTANCE.md:66,228,257,376`：2GB 真实大文件与断点续传**不在 demo 范围**，demo 只验 >5MB 分片链路，`QA-REPORT.md §五 R5` 列为 L5 上线前项；
- `DEMO-ACCEPTANCE.md:189,378`：**不得把「四性全绿」写成验收判据**，P0 只实现完整性（SHA-256）；本方案 C07/C16 只判 SHA-256 一致性，不判四性；
- `ARCHITECTURE-SEAWEEDFS.md:205,190`：**ETag 不是完整性基线**，完整性只认服务端重算 SHA-256；本方案 C07 用 ETag 只判「part ETag 可读可回传」，完整性判据独立用 SHA-256。

---

## 2. 验证对象、防线串联与失败归因模型

### 2.1 验证对象

| 层 | 内容 | 由谁产生 | QA 是否复用 |
|---|---|---|---|
| 被测服务 | SeaweedFS `3.79` S3 Gateway（宿主 8333），四桶，identity 鉴权 | 工程师起栈 | — |
| 客户端调用序列 | `minio@8.0.7` SDK 的真实 wire 操作（14 项） | QA 脚本自建 SDK client（**不 import `storage.module.ts`**） | 否 |
| 浏览器视角 | 原生 HTTP PUT/GET/OPTIONS 到预签名 URL，读 `etag`、CORS 头、Host | QA 脚本原生 `node:http` | 否 |
| 完整性基线 | 本地源文件 SHA-256 ↔ 合并后 GET 全对象重算 SHA-256 | QA 脚本 `node:crypto` | 否 |

脚本用**两个独立 SDK client** 镜像架构 §1.2 双端点规格：`internalClient`（`S3_INTERNAL_ENDPOINT`，承担除预签名外全部操作）与 `publicClient`（`S3_PUBLIC_ENDPOINT`，**仅** `presignedUrl` / `presignedGetObject`）。这使脚本本身成为「双端点方案的可执行规格」：若 `S3_PUBLIC_ENDPOINT` 缺失或仍指向容器 DNS，判据会精确失败，而不是被 SDK 内部 host 处理掩盖。

### 2.2 串联防线（沿用 `TESTING-GUIDELINES.md` 通则）

测后一道闸门必先满足前一道；每条用例声明测哪道闸门，并断言拒绝理由指向它。据此把检查点分为三层：

```
G0 服务可达 ──► G1 凭据正确且鉴权生效 ──► G2 四桶存在 ──► C01~C16 wire 用例
   SERVICE_DOWN        BAD_CREDENTIALS        建桶/配置        INCOMPATIBLE
```

- 门禁任一失败 → 其后的**所有**检查点显式标 `BLOCKED`（不是静默跳过），并计入 fail-closed 统计；
- 门禁全部通过后，任何 wire 用例失败 → 在已排除「服务没起来 / 凭据错 / 桶不存在」的前提下，**唯一原因**收敛到「SeaweedFS 3.79 对该 wire 操作不兼容」，与 `DEMO-ACCEPTANCE.md:145,154,190` 的归因写法同源。【v1.2 更正：删除原「或 CORS/ETag 配置未生效」——3.79 零配置即带 CORS，该分支不复存在；C08 若红须先按 §5 归因三查排除请求/环境侧原因，不自动收敛到不兼容】

### 2.3 三类失败原因（+ 补充类），全部判 NO

| cause | 判据特征 | 人类读法 | 是否构成兼容性结论 |
|---|---|---|---|
| `SERVICE_DOWN` | `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` / `ETIMEDOUT` / `ECONNRESET` / 连接超时；G0 健康检查非 200/403 | **服务没起来** | ❌ 不构成，需整改后重跑 |
| `BAD_CREDENTIALS` | 合法凭据收到 403 / `InvalidAccessKeyId` / `SignatureDoesNotMatch` / `AccessDenied` / `RequestTimeTooSkewed`；或**错误凭据返回 200**（Allow-All 模式，架构 §2.1 安全红线） | **凭据错**（含未注入 identity） | ❌ 不构成，需整改后重跑 |
| `INCOMPATIBLE` | 门禁通过后任一 wire 断言失败：501/405/`NotImplemented`、part ETag 缺失、合并后 SHA-256 不一致、`listParts` 结构不符、lifecycle 回读不符；**C08 特例**：仅在「带了 `Origin` 且非同域前提成立、CORS middleware 已响应、仍未返回合法暴露头（`*` 或显式 `ETag`）」时成立 | **兼容不支持** | ✅ 构成（须列明具体 wire 操作） |
| `INCOMPATIBLE` 排除项（v1.2） | C08 响应**无任何 CORS 头** → `TOOL_ERROR`（归因三查：未带 Origin / 反代收敛同域 / credentials 配置）；`*` 通配前提静态守卫不过 → `CONFIG_MISSING`。二者均为「没验成」 | **没验成** | ❌ 不构成，不写「SeaweedFS 与 SigV4 不兼容」「SeaweedFS 不支持 CORS」 |
| `CONFIG_MISSING`（补充） | `S3_PUBLIC_ENDPOINT` / 凭据 / 桶名等必需项缺失，或 `S3_PUBLIC_ENDPOINT` 仍为容器 DNS 且不可解析 | 配置未落地（含双端点未解耦） | ❌ 不构成，需整改后重跑 |
| `TOOL_ERROR`（补充） | `minio` SDK 无法加载、脚本自身异常、日志写入失败 | 工具异常 | ❌ 不构成，需修复脚本后重跑 |

> **关键区分**：`SERVICE_DOWN` / `BAD_CREDENTIALS` / `CONFIG_MISSING` / `TOOL_ERROR` 的准确读法是「**没验成**」，不是「验出不支持」。四者与 `INCOMPATIBLE` 绝不混写，避免把环境问题错误记成方案 A 的缺陷，也避免把真缺陷稀释成环境问题。

### 2.4 fail-closed 判据（写死）

`IS_PASS: YES` **当且仅当**当前 suite 声明的**每一个**检查点 `status === 'PASS'`。下列任一情形即 `IS_PASS: NO`：任一 `FAIL` / `ERROR` / `BLOCKED` / `NOT_RUN`；任一检查点未执行；工具异常；日志写入失败；必需配置缺失；脚本被中断。

- 不许静默跳过、不许默认通过、不许「跳过按通过计」；
- `NOT_RUN` 与 `BLOCKED` 在报告中逐条列出编号与原因；
- 退出码：`0`=YES，`1`=NO，`2`=脚本自身不可用（`--self-test` 失败 / SDK 加载失败 / 无法写日志）；
- 判据引擎为**纯函数** `computeVerdict(checks)`，`--self-test` 直接对该生产判据函数做变异验证（见 §7.1），不是另写一套自测逻辑。

### 2.5 D-4 下载链路分层纪律（主理人补充裁定，2026-11-09）

**背景事实（QA 独立复核，见 F12）**：`approval` 下载模式只读 `grants.FILE.ops.DOWNLOAD`，全仓无授权写入处，即**下载业务放行链路未实现**，登记为上线前闭环项 **L2**。主理人裁定本次 demo 不修、不批准用 R0 临时授权绕过；PM 已把「临时 FILE:DOWNLOAD 授权」路径作废（D-1 / `docs/DEMO-ACCEPTANCE.md` v1.1 `63f4d69`）。

**三层必须分开写，禁止合并成一句「下载已验证」**：

| 层 | 结论措辞 | 由谁验 | 本方案落点 |
|---|---|---|---|
| ① 技术层（S3 wire） | 「**S3 协议下载技术链路已验证**」：服务端 `presignGet` 生成预签名 GET URL → 浏览器可达 host 实际 GET → 内容与源文件 SHA-256 一致（含 Range） | QA 脚本 | **C18**（+C15 兼容性）、脚本输出 `D4_TECH_LAYER` |
| ② 业务层（放行） | 「**下载业务放行链路未验证**」（`approval` 审批授权链路未实现，L2 上线前闭环项） | 本次**不验** | 脚本输出 `D4_BUSINESS_LAYER`；§8 判定档位 |
| ③ 表述层 | 「**不构成下载功能已验证的结论**」；禁止「下载已验证」「下载受控通过」「R1 已全部关闭」 | QA 报告 | 脚本输出 `D4_CONCLUSION`；§8 固定表述 |

**硬约束**：
1. C18 **只走 S3 wire**：不调用 `file.service.download()`、不构造 `PermissionSnapshot`、不写 `grants.FILE.ops`、不请求任何 `/api` 业务端点、不演示业务放行；脚本 `--self-test` 有一条静态检查钉死该边界（无 `file.service` / `PermissionSnapshot` import、且 C18 带 `D4_SCOPE=WIRE_ONLY` 声明）。
2. **不准备任何 `DOWNLOAD` 授权夹具**：D-1 已否决「R0 临时授予 FILE:DOWNLOAD 再回收」，本方案与脚本均不含该路径。若阶段二发现有人擅自实现授权写入或给账号授权以制造「下载成功」，按**重大偏差单独上报**（`DEMO-ACCEPTANCE.md` §5.1 不通过条件⑤）。
3. **S7b 的绿只证明 fail-closed 正确，不证明下载可用**；不得写「下载受控通过」这类合并说法。S7b 若「下载竟然成功」，唯一原因是 `preview.download_mode` 被改成 `free`（S0-7 被破坏）；`disabled` 同样拒绝下载、不在原因之列。
4. **L2 闭环顺序**：先由保密部门确认 Q4 下载模式 → 再决定并实现授权写入 → 最后补业务放行验证。现在**不实现、不验证**授权写入链路。
5. **S8 四性纪律**（PM §2 S8）：不得把「四性全绿」写成判据，P0 只实现完整性 SHA-256；本方案 C04/C07/C16/C18 只判 SHA-256 一致性。**S0-5 多角色前置**：演示前须备 R1/R3/R0 账号，否则 S2 403 会被误判成缺陷（属功能验收范围，不属本 wire 脚本）。

**逐字固定表述**（阶段二 QA 报告与 demo 验收结论均须包含，`DEMO-ACCEPTANCE.md:194-195`）：
> 「**下载放行链路未演示**。`approval` 模式的下载授权写入链路未实现（上线前闭环项 L2），本次 demo 仅验证预览可用与下载 fail-closed 拒绝正确；QA 技术层另行验证 SeaweedFS `presignGet` 下载 wire 链路。**不构成下载功能已验证的结论。**」

---

## 3. 架构 §4 十四项 wire 操作 → QA 检查点映射（逐条覆盖）

| §4 # | S3 wire 操作 | 本地调用 | QA 检查点 | 本方案关注的风险 |
|---|---|---|---|---|
| 1 | HeadBucket | `bucketExists` `storage.module.ts:63,73` | **G1 / G2** | 无 identity 时 Allow-All 掩盖鉴权 |
| 2 | CreateBucket | `makeBucket` `:65` | **C01** | 需 `Admin`；与 `autoCreateBucket` 叠加重复建桶；幂等【v1.3 实测更正：s3.json 收权下业务身份建桶**应被拒**（403/AccessDenied 即 PASS，收权正验证），原幂等判据作废留痕，见 §5 C01】 |
| 3 | PutObject | `putObject` `:233-260` | **C02 / C16** | `Content-Type` / `x-amz-meta-*` 回显与 HEAD 一致性 |
| 4 | GetObject（含 Range） | `getObject` `:178,217,222` | **C03 / C15 / C16 / C18** | Range 206；50MB 流式重算；C18 与独立下载源文件 SHA-256 一致 |
| 5 | HeadObject | `statObject` `:194` | **C04** | `metaData` 字段名大小写/前缀归一化 |
| 6 | Presigned URL（SigV4） | `presignedUrl` `:102-121`、`presignedGetObject` `:263-281` | **C05 / C15 / C18（D-4）** | **最高优先**：`uploadId`/`partNumber` 进签名、host 浏览器可达、过期；C18 复现生产下载 `presignGet(..., 300, {response-content-disposition})` 的响应头签名与回显（`file.service.ts:418-420`） |
| 7 | CreateMultipartUpload | `initMultipart` `:89-98` | **C06** | 桶级权限隐式放行；uploadId 返回 |
| 8 | ListParts | `listParts` `:130-151`（`as unknown as` 窄化 protected 内部 API） | **C09** | SDK 内部 API 版本敏感；返回 `{part,etag,size}` 结构 |
| 9 | CompleteMultipartUpload | `completeMultipart` `:149-166` | **C07 / C08** | **最高优先**：浏览器 `res.headers.etag` 去引号回传；CORS 使浏览器可读 ETag（3.79 零配置 `Expose-Headers: *` 通配，C08 验效果不验字面值）；合并后 SHA-256 |
| 10 | AbortMultipartUpload | `abortMultipart` `:164-175` | **C10** | 僵尸分片清理，abort 后 GET 应 404 |
| 11 | DeleteObject | `removeObject` `:284-295` | **C11** | 哈希不符删脏对象路径 |
| 12 | CopyObject | `copyObject` `:292-310` | **C12** | 源路径 `/${sourceBucket}/${sourceKey}` 形式 |
| 13 | ListObjectsV2 | `listObjects` `:313-332` | **C13** | delimiter `/`、prefix 列举完整性 |
| 14 | Put/GetBucketLifecycleConfiguration | 原 `mc ilm`（`docker-compose.yml:152`） | **C14** | `mc` 不可用；Transition 不支持；Expiration 执行周期未知 |

## 4. 架构 §4 十条最小用例集 → QA 检查点映射（逐条覆盖）

| 用例集 | 内容 | QA 检查点 | suite |
|---|---|---|---|
| ① | 四桶存在性与鉴权 | G0 / G1 / G2 / C01 | core |
| ② | 小文件 PUT/GET/HEAD + 自定义 meta | C02 / C03 / C04 / C11 | core |
| ③ | 整对象预签名 PUT | C05 | core |
| ④ | 分片预签名 PUT（≥3 片）+ ETag 回读 + 合并 + SHA-256 比对 | C06 / C07 | core |
| ⑤ | `listParts` / abort | C09 / C10 | core |
| ⑥ | 预签名 GET + Range | C15（预签名 GET）/ C03（Range）/ **C18（D-4 技术层下载，生产 `presignGet` 调用形态）** | core |
| ⑦ | CORS preflight + 浏览器可读 ETag（效果判据：`Expose-Headers: *` 或显式 `ETag` 两种合法形态） | C08 | core |
| ⑧ | 2GB / 5MB 分片（410 片）边界 | **C17** | **full**（demo 范围外，见 §1.3） |
| ⑨ | `statObject` 大小与 `computeSha256` 一致 | C04 / C16 | core |
| ⑩ | 错误凭据 403 | G1（负向对照） | core |

> `core` = **20 项**检查点（门禁 G0/G1/G2 共 3 项 + wire C01~C16 共 16 项 + D-4 技术层 **C18** 1 项，其中 C05/C06/C07/C08/C15/C18 覆盖最高优先项）；`full` = `core` + C17 = **21 项**。
> **C18 为何不复用 C15**（避免重复用例）：C15 验 §4 #6 的通用预签名 GET + Range 兼容性，复用 C07 合并对象；C18 是 D-4 裁定的**独立技术层证据**，新建独立「下载源」对象、复现 `file.service.ts:418-420` 的生产调用形态（`presignGet` 带 `response-content-disposition` 响应头签名、300s 时效），并断言该响应头回显 —— 这是 C15 未覆盖的 SigV4 维度，故独立编号、独立执行、独立引用。
> **⑧ 不进 core 不是「静默跳过」**：两个 suite 的完整清单在本文件与脚本输出中均事先公开，`core` 的 `YES` 会强制附 `SCOPE: CORE（未覆盖 2GB/410 片边界）` 且**不代表 `full` 通过**。依据 `DEMO-ACCEPTANCE.md:66,257,376`（demo 不宣称 2GB 达标）。

---

## 5. 检查点详细规格

> 统一四栏：**操作 / 预期 / 验收判据 / 如果失败，唯一原因是什么**（对齐 `DEMO-ACCEPTANCE.md` S0-3/S4/S8）。
> 「唯一原因」成立的前提是 §2.2 的**门禁已全部通过**；门禁未过时后序检查点一律 `BLOCKED`，不得归因到 wire 层。
> 所有对象使用 QA 专用前缀 `qa-pipeline/<runId>/`，跑完由脚本尽力清理（清理失败不进判据，但会在日志留档）。

### 门禁层

#### G0 服务可达
- **操作**：对 `S3_INTERNAL_ENDPOINT:S3_INTERNAL_PORT` 建立 TCP 连接并 `GET /`；超时 `--timeout-ms`（默认 8000ms）。
- **预期**：连接建立成功，HTTP 状态为 200 或 403（与 `docker-compose.yml:142` healthcheck 同口径）。
- **验收判据**：`connected=true` 且 `status ∈ {200,403}` 且 `elapsed < timeout`。
- **如果失败，唯一原因是什么**：**服务没起来**（`SERVICE_DOWN`）——SeaweedFS 容器未启动 / 8333 未发布 / 宿主防火墙 / 端点端口填错。此时不产生任何兼容性结论。

#### G1 凭据正确且鉴权生效（对应 §4 #1、用例①⑩）
- **操作**：① 合法凭据对 `archive-original` 发 `HeadBucket`；② 用**故意错误的 secretKey** 构造第二个 client 发同一 `HeadBucket`。
- **预期**：① 返回 200（或 404 但**非 403**）；② 返回 403 / `InvalidAccessKeyId` / `SignatureDoesNotMatch`。
- **验收判据**：合法侧非 403 **且** 错误侧 `status===403`（或错误体含上述 S3 错误码）。错误侧若返回 2xx 判 `FAIL` 并标 `INSECURE_ALLOW_ALL`。
- **如果失败，唯一原因是什么**：**凭据错**（`BAD_CREDENTIALS`）——s3.json identity 未注入 / `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` 与 s3.json 不一致 / 网关处于 Allow-All 模式（架构 §2.1 安全红线）。G0 已排除服务未起，故唯一变量是鉴权配置。

#### G2 四桶存在（对应 §4 #1、用例①）
- **操作**：对四桶 `archive-original` / `archive-preview` / `archive-thumb` / `archive-backup` 逐一 `HeadBucket`。
- **预期**：四个 200。
- **验收判据**：`existingBuckets.length === 4`，且逐一记录状态。
- **如果失败，唯一原因是什么**：**建桶责任未闭环**（`CONFIG_MISSING` / `INCOMPATIBLE`）——init sidecar 未建桶且 `autoCreateBucket=false`，或应用 `ensureBuckets` 降级为 warn 后未创建（架构 §3.2）。G0/G1 已排除服务与凭据，故唯一变量在建桶链路。**不得**以 `storage.minio-contract.spec.ts` 全绿替代本判据。

### wire 层

#### C01 CreateBucket 收权正验证（§4 #2）——**v1.3 判据改写（主理人裁定，2026-11-09）**

> **原判据（v1.1，与收权裁定冲突，留痕作废）**：用 `internalClient.makeBucket(qaBucket)` 建 QA 专用临时桶并二次调用验证幂等；失败唯一原因记为「CreateBucket 不兼容 / 权限不足（`INCOMPATIBLE`）」。**阶段二首跑实测**：首次 `makeBucket` 即 `Access Denied.`（日志 `qa-file-pipeline-stage2-core-20261109084451952.log` C01）。归因：**不是 SeaweedFS 不兼容**，而是 `storage.module.ts:34` 注释明示的安全架构裁定——**s3.json identity 收权**，业务身份 `tianji_minio` 不允许建桶，桶由 `infra/seaweedfs/entrypoint.sh` 预建；G2 四桶 HeadBucket 全 200、业务链路无需运行时建桶。原判据与该裁定冲突。
>
> **v1.3 改写（主理人裁定，采 QA 建议 A 方案）**：把「被正确拒绝」变成**正向断言**——比绕道管理身份验建桶更有证据价值（同时验证收权生效）。

- **操作**：用 `internalClient.makeBucket(qaBucket)` 尝试建 QA 专用临时桶（业务身份）。
- **预期**：被拒绝——错误为 `AccessDenied` / `Access Denied` / HTTP 403（`isAccessDenied(err)` 纯函数判定：错误码/消息匹配或 `statusCode===403`）。
- **验收判据**：`makeBucket` 抛错且 `isAccessDenied(e)===true` → **PASS（收权正验证）**，detail 记录错误原值并注明「桶存在性由 G2 四桶 HeadBucket 保证（临时桶未创建，无残留）」。**反向断言**：若 `makeBucket` 竟然成功 → **FAIL / `INCOMPATIBLE`**（收权未生效 = 安全架构裁定被破坏，需整改，不是「兼容性好」）。
- **归因分叉**：失败但**非** AccessDenied（网络/超时/DNS）→ `TOOL_ERROR`（没验成 ≠ 验出不支持）；只有「建桶成功」才归 `INCOMPATIBLE`（收权被破坏）。
- **self-test 守护**：`isAccessDenied` 三正向（`AccessDenied`/`Access Denied`/403）+ 二负向（`ETIMEDOUT`/`ENOTFOUND`）+ 源码级声明（收权注释与反向断言落码）。

#### C02 PutObject Content-Type 回读（主判据）+ 自定义 meta 双形态（§4 #3、⑤、用例②）——**v1.3 等效判据（主理人裁定）**

> **阶段二首跑实测（日志 `qa-file-pipeline-stage2-core-20261109084451952.log` C02）**：写入 `x-amz-meta-qa-case: C02` 后回读键为 `qa-case`——**SeaweedFS 3.79 剥 `x-amz-meta-` 前缀**，与 MinIO/SDK 期望的带前缀形态不一致，旧判据（仅匹配带前缀键）假红。**生产影响面已查证为零**：所有 `putObject` meta 只传 `Content-Type`（`backup.service.ts:316` / `file.service.ts:361` / `object.fetcher.ts:50`）；`statObject` 回读只用 `stat.etag`（`backup.service.ts:319`），**生产代码无人消费 metaData 自定义键**。主理人裁定（采 QA 建议 A+B 合并）：主判据 Content-Type 回读一致（生产真实依赖），自定义 meta 接受双形态等效判据，差异登记 §8 已知边界。

- **操作**：写小对象（确定性字节，含非 ASCII），`Content-Type: application/pdf` + `x-amz-meta-qa-case: C02`；随后 GET 全量、HEAD 回读。
- **验收判据（v1.3）**：`sha256(GET bytes) === sha256(source)`；`stat.size === source.length`；**主判据**：`content-type` 命中 `application/pdf`；**等效判据**：自定义 meta 经 `metaValueLoose(md, key)` 同时接受「带 `x-amz-meta-` 前缀 / 剥前缀」两种键形态（大小写不敏感），**值必须相等**；PASS detail 注明实际命中的形态。
- **如果失败，唯一原因是什么**：**Content-Type 回读不一致**（`INCOMPATIBLE`，主判据失败）或 **meta 值丢失/被改**（双形态均未命中）——前者是生产真实依赖被破坏，后者登记兼容矩阵差异并评估生产影响面。

#### C03 GetObject 全量 + Range 206（§4 #4、用例⑥）
- **操作**：对 C02 的对象发 SDK 全量 GET；再用原生 SigV4 请求（或 SDK `getObject` 带 range 选项）取 `Range: bytes=0-1023`。
- **预期**：全量一致；Range 返回 `206` + `Content-Range: bytes 0-1023/<total>` + 恰好 1024 字节且与源前 1024 字节一致。
- **验收判据**：`status===206`、`body.length===1024`、`content-range` 含正确 total、`sha256(body)===sha256(source.slice(0,1024))`。
- **如果失败，唯一原因是什么**：**GetObject Range 不兼容**（`INCOMPATIBLE`）——3.79 未实现或错误实现 `Range`（预览链路依赖，架构 §4 #4）。

#### C04 statObject 大小与 computeSha256 一致（§4 #5、用例⑨）
- **操作**：`statObject` 取 size；`getObject` 流式重算 SHA-256（等价于 `storage.module.ts:182-195` 的 `computeSha256`）。
- **预期**：`stat.size === 实际字节数`；重算 SHA-256 === 源文件 SHA-256。
- **验收判据**：三项数值相等；且 SHA-256 为 64 位小写 hex（禁止只判「非空」）。
- **如果失败，唯一原因是什么**：**HeadObject 大小语义或对象内容不一致**（`INCOMPATIBLE`）。ETag 不参与本判据（架构 §3.5）。

#### C05 整对象预签名 PUT（§4 #6 最高优先、用例③）——**重点单列①**
- **操作**：用 `publicClient.presignedUrl('PUT', bucket, key, expires, {'Content-Type': mime})` 生成 URL → 解析 URL 取 host → **原生 `node:http` PUT**（带与签名一致的 `Content-Type`）到该 URL → GET 回读；另生成 `expires=1` 的 URL，等待 2s 后 PUT。
- **预期**：URL host **等于** `S3_PUBLIC_ENDPOINT`（含端口），且该 host **不是容器 DNS**（`seaweedfs` / `minio` / 无点的服务名）且从宿主机可解析可连接；PUT 返回 2xx；GET 回读字节一致；过期 URL 返回 403。
- **验收判据**：
  1. `url.hostname === S3_PUBLIC_ENDPOINT` 且 `url.port` 与 `S3_PUBLIC_PORT` 一致；
  2. `S3_PUBLIC_ENDPOINT` 通过 `dns.lookup` 且能建立 TCP（`PRESIGN_HOST_REACHABLE=true`）；显式拒绝 `seaweedfs`/`minio` 等容器名（**浏览器不可达 host** 直接判 FAIL，cause=`CONFIG_MISSING` 或 `INCOMPATIBLE`）；
  3. 原生 PUT `status ∈ {200,204}`；GET 全量 SHA-256 与源一致；
  4. 过期 URL PUT `status===403`。
- **如果失败，唯一原因是什么**：**预签名 URL 链路不兼容**（`INCOMPATIBLE`）——三类之一：① host 为容器 DNS 导致浏览器不可达（F1/F2/F3 与 F8 的实现落差，见 §1.2）；② SigV4 对含 `Content-Type` 的规范化不被 3.79 接受（`SignatureDoesNotMatch`）；③ 预签名过期语义未实现。G0/G1/G2 已排除服务、凭据、桶。

#### C06 CreateMultipartUpload + ≥3 片预签名 PUT + ETag 回读（§4 #7/#6、用例④）——**重点单列②③**
- **操作**：`initiateNewMultipartUpload` 取 uploadId；生成 **恰好 ≥3 片**（core 用 3 片、每片 5MB，贴合 `CHUNK_SIZE=5MB`，总 15MB 确定性数据）；每片用 `publicClient.presignedUrl('PUT', ..., {uploadId, partNumber})` 生成 URL；**逐片原生 HTTP PUT**（复现 `FileUploader.tsx:104-107` 的浏览器直传），从 `response.headers.etag` 读 ETag 并去引号（复现 `:108`），收集 `parts[]`。
- **预期**：`uploadId` 非空；`parts.length >= 3`（硬断言，不足 3 直接判 FAIL）；每片 PUT 2xx 且 ETag 非空；`uploadId`/`partNumber` 作为签名 query 被网关接受。
- **验收判据**：`PART_COUNT >= 3`；每片 `status ∈ {200,204}`；每片 `etag` 去引号后非空且为 32 位 hex 或 SeaweedFS 实际 ETag 形式（记录原值，**不预设 MD5**）；`publicClient` 生成的 URL host 同样通过 C05 第 1/2 项可达性检查。
- **如果失败，唯一原因是什么**：**分片预签名 PUT 不兼容**（`INCOMPATIBLE`）——`uploadId`/`partNumber` 进入 SigV4 规范化后不被接受（架构 §4 #6 风险①），或 part ETag 未随响应返回 / 被 CORS 隐藏导致浏览器读不到（§4 #9）。ETag 是否 MD5 **不是**本判据内容（§3.5）。

#### C07 CompleteMultipartUpload + 合并后 SHA-256 比对（§4 #9 最高优先、用例④）——**重点单列④⑤**
- **操作**：`completeMultipartUpload(uploadId, parts)` → 原生 GET 全对象 → 本地按 3 片拼接顺序重算 SHA-256 与源文件比对 → `statObject` 比对 size；**负向对照**：另起 uploadId，上传 1 片后故意传入错误 ETag 合并，期望非 2xx / 抛错。
- **预期**：合并成功；合并后对象字节与源文件**逐字节一致**；错 ETag 被拒绝。
- **验收判据**：`sha256(merged) === sha256(source)`（64 位 hex 全等，禁止前缀比对）；`stat.size === source.length`；负向对照 `rejected===true`（防「合并恒成功」假绿）。
- **如果失败，唯一原因是什么**：**multipart 合并结果有误**（`INCOMPATIBLE`）——part ETag 格式/大小写差异导致合并失败，或合并后字节错序/缺失（`DEMO-ACCEPTANCE.md:190` 同口径归因）。**完整性只认 SHA-256，不认 ETag**（架构 §3.5）。

#### C08 CORS preflight + 浏览器可读 ETag（§4 #9、用例⑦）——**重点单列③④，v1.2 判据修正**

> **等价正确性论证（主理人 v1.2 硬约束，防误读）**：本次修改是**纠正语义错误，不是放宽、不是降级**。原判据断言的是响应头的**字面值**（`Expose-Headers` 必须含字符串 `ETag`），而验收目标自始至终是「**浏览器能否读到 ETag**」这一**效果**。`Expose-Headers: *` 在 credentials mode = `omit` 下按 CORS 规范确实达成该效果（通配全部响应头，含 ETag），故「`*` 或显式 `ETag`」是对同一验收目标的**等价正确判据**，断言强度不降低：仍是 L4 副作用断言（真实 preflight + 真实 PUT 响应头四头逐一核对）、仍受 fail-closed 约束、仍保留负向对照（`x-custom` / 空 → FAIL）。原判据是把「实现细节的字面形式」误当成「验收目标」，属于**假红**，不是更严。禁止把本次修正解读为「为让报告好看而降级判据」。
>
> **原假设（阶段一，已证伪，保留留痕）**：`Access-Control-Expose-Headers` 应含字面量 `ETag`，缺失或不含 `ETag` 直接判 FAIL；失败唯一原因是「CORS 配置未暴露 ETag（`INCOMPATIBLE`）」，依据架构 §1.2:77 / §4 #9 / §7 第 2 条「仍待实测」。3.79 实测（镜像 `21425305e04b`）证伪：全局 CORS middleware 零配置返回 `Expose-Headers: *`，**无法**配置成单列 ETag；按字面量断言会**必然假红**，把正确实现误判为 `INCOMPATIBLE`（§8 C 档）。以下为 v1.2 修正后的判据。

- **操作**：对 `S3_PUBLIC_ENDPOINT` 发原生 `OPTIONS`，带 `Origin`（取 `CORS_ORIGINS` 首项或 `--origin`）、`Access-Control-Request-Method: PUT`、`Access-Control-Request-Headers: content-type`；另对任一预签名 PUT 的**实际响应**读取 `Access-Control-Expose-Headers`。
- **预期**：`Access-Control-Allow-Origin` 含该 Origin（或 `*`）、`Access-Control-Allow-Methods` 使 PUT 预检放行（效果判据：`*` 通配或显式列表含 `PUT`）、`Access-Control-Allow-Headers` 使 content-type 预检放行（`*` 或显式含 `content-type`）；**`Access-Control-Expose-Headers` 使浏览器能读到 ETag**——`*`（通配，3.79 零配置形态）或显式 `ETag`（列表含 `etag` 项，大小写不敏感）**两种形态均合法**。
- **验收判据（效果判据，不验响应头字面值）**：四项头逐一精确断言；`exposesEtag(v)` 纯函数接受 `*` 与显式 `ETag`，`exposeOk` / `actualOk` 均改用它；**v1.3**：`methodsOk` / `headersOk` 改用 `corsListAllows(v, needle)` 纯函数（`*` 通配或显式列表）——实测（`qa-stage2-cors-20261109165117.log` + `lead-stage-c4-cors-headers-20261109153324.log` 原值双证）3.79 返回 `Allow-Methods: *` / `Allow-Headers: *` 通配形态，字面断言 `/PUT/i`、`/content-type/i` 在 `*` 下必然假红，与 v1.2 修正前 Expose-Headers **同构缺口**。按 CORS 规范，credentials mode=omit 时 `*` 通配全部方法/请求头（Authorization 除外，本链路预签名 PUT 不带凭据头，不受影响）；显式列表含对应项等效成立。本用例验的是「浏览器能否读到 ETag」这一**效果**，不是「响应头里写了 ETag 这个字符串」。
- **`*` 通配的前提守卫（防新假绿，主理人 v1.2/v1.3 硬约束）**：v1.3 起**任一 CORS 头为 `*`**（methods / headers / expose，含实际 PUT 响应的 expose）即触发同一前提——omit 下三头通配全部成立，include 下三头通配全部失效（规范同源，共用 `C08_WILDCARD_PREMISE=CREDENTIALS_OMIT_REQUIRED`）。脚本用静态源码守卫 `credentialsOmitGuard()` 做**两层核对**：
  - **兜底（全目录）**：递归扫 `apps/web/src` 下 `.ts/.tsx/.js/.jsx`，命中 `axios.defaults.withCredentials = true` / `withCredentials: true` / `credentials: 'include'` 任一即 `pass=false`。
  - **定向核对（三处，可追溯 `audit`）**：① `globalDefaults`——`axios.defaults` 全局赋值；② `axiosCreateConfig`——`axios.create({...})` 全局配置对象（全局 defaults 的另一来源，对应 `apps/web/src/api/client.ts:64`）；③ `fileUploaderPut`——`FileUploader.tsx:104-108` 的 `axios.put(url, blob, {...})` 调用参数块。三态 `CLEAN` / `HIT` / `N/A`；找不到 create/put 记 `N/A` 而非 fail（前端可合法改用 fetch，兜底扫描仍覆盖）。
  - **fail-closed**：目录不可读 / 文件读不到 / `FileUploader.tsx` 缺失 / 任一处 `HIT`，一律 `pass=false`，**不默认成立**。守卫不过 → 判 `FAIL` / `CONFIG_MISSING`，**不判 `INCOMPATIBLE`**（是「没验成」，不是 SeaweedFS 不兼容）。
  - `audit` 保留结构化详情供 self-test 断言与阶段二独立复核；`note` 保持精简，避免被 `emit` 的 600 字截断。
- **未验证项（阶段二报告须如实写出）**：静态源码断言只证明「源码里没写」，**不等价于前端运行时配置**。C08 `detail` 固定带 `C08_WILDCARD_PREMISE=CREDENTIALS_OMIT_REQUIRED` 声明与「本脚本未独立验证前端运行时配置」；阶段二报告把 `credentials=omit` 运行时前提列入**未验证项**，不默认成立、不替前端背书。
- **失败归因（v1.2，三查）**：`INCOMPATIBLE` **仅**在「带了 `Origin` 且非同域前提成立、CORS middleware 已响应、仍未返回合法暴露头」时使用。若响应**无任何 CORS 头**，归 `TOOL_ERROR`（没验成），并按三查排查：①请求是否带 `Origin`（CORS 头是条件性的，架构师实测「不带 Origin 的 GET / → 无任何 CORS 响应头」）；②是否被反代收敛到与 Web 同域（同域浏览器不带 Origin）；③是否设 `withCredentials=true` / `credentials: include`。**禁止**写成「SeaweedFS 与 SigV4 不兼容」「SeaweedFS 不支持 / 未配置 CORS」；亦不得把「分片 PUT 成功、completeMultipart 失败」误判为签名或对象存储兼容性问题。
- **已知边界（主理人裁定，阶段二报告如实写）**：`Allow-Origin: *` 与 `Expose-Headers: *` 在 3.79 上**无法收紧**（flag 无效、bucket CORS 501、s3.json `cors` 段被忽略），会暴露 `X-Amz-Request-Id` / `Server` 等全部响应头。样品 demo 封闭内网阶段**接受并登记为已知边界**；正式启用前若单位要求收紧到具体 origin，须重新裁定架构（反代改写响应头与双端点直连冲突）。**不得**写成「CORS 已安全配置」或「SeaweedFS 已支持按需配置 CORS」。

#### C09 listParts 返回结构（§4 #8、用例⑤）——**重点单列⑧**
- **操作**：在 C06 的 uploadId 完成合并**之前**，独立调用 SDK 的 protected 内部 `listParts(bucket, key, uploadId)`（JS 侧直接调用，等价 `storage.module.ts:135-151` 的 `as unknown as` 窄化）。
- **预期**：返回数组，元素含 `part` / `etag` / `size`；`partNumber` 升序；数量与已上传片数一致。
- **验收判据**：`Array.isArray(result)`；`result.length === 已上传片数`；每元素 `Number.isInteger(part)` / `typeof etag === 'string' && etag.length>0` / `Number.isInteger(size)`；`part` 严格升序。
- **如果失败，唯一原因是什么**：**ListParts 返回结构与 minio@8 内部 API 契约不符**（`INCOMPATIBLE` / 版本敏感）——架构 §4 #8 标为 SDK 内部 API 风险，与网关实现共同决定；现网分片 ETag 由浏览器回传（`FileUploader.tsx:108-109`），本用例专验该窄化调用在 3.79 上是否仍可用。

#### C10 AbortMultipartUpload（§4 #10、用例⑤）
- **操作**：另起 uploadId，上传 2 片后 `abortMultipartUpload`；随后 `statObject` 该 key。
- **预期**：abort 成功；key 不存在（404 / `NoSuchKey` / `NotFound`）。
- **验收判据**：`abortThrew===false`；后续 `objectExists===false`。
- **如果失败，唯一原因是什么**：**AbortMultipartUpload 未清理僵尸分片**（`INCOMPATIBLE`）。

#### C11 RemoveObject（§4 #11、用例②）
- **操作**：删除 C02 写入的对象 → 立即 `statObject`。
- **预期**：删除成功；对象不存在。
- **验收判据**：`objectExists===false`；删除调用未抛错。
- **如果失败，唯一原因是什么**：**DeleteObject 语义差异**（`INCOMPATIBLE`）——wiki 注明 SeaweedFS 会删除文件夹、空目录异步清理，与 AWS S3 行为不同（§4 #11）；该路径承载 `file.service.ts` 哈希不符删脏对象。

#### C12 CopyObject（§4 #12）
- **操作**：把 C07 合并后的对象从 `archive-original` 复制到 `archive-backup` 的 QA 前缀 key → `statObject` 目标。
- **预期**：目标存在，size 与源一致，SHA-256 与源一致。
- **验收判据**：`targetStat.size === sourceStat.size` 且 `sha256(target) === sha256(source)`。
- **如果失败，唯一原因是什么**：**CopyObject 源路径形式不兼容**（`INCOMPATIBLE`）——`copyObject` 写死 `/${sourceBucket}/${sourceKey}`（`:307`），3.79 对该形式的解析差异。

#### C13 ListObjectsV2（§4 #13）
- **操作**：在同一 QA 前缀下写 3 个对象（不同 key），用 `listObjectsV2(prefix, recursive)` 列举。
- **预期**：恰好返回这 3 个 key，size 正确。
- **验收判据**：`keys` 集合与预期完全相等（不多不少）；每项 `size` 与实际一致。
- **如果失败，唯一原因是什么**：**ListObjectsV2 delimiter/prefix 语义差异**（`INCOMPATIBLE`）——wiki 注明「不允许 `/` 之外的 delimiter」「同一路径不能同时是文件和文件夹」（§4 #13）。

#### C14 Put/GetBucketLifecycleConfiguration（§4 #14）
- **操作**：用原生 SigV4（`Authorization` header 形式）对 `archive-original` 发 `PUT ?lifecycle`（XML：`tmp/` 前缀 Expiration 1 天），再 `GET ?lifecycle` 回读。
- **预期**：PUT 2xx；GET 回读 XML 含该 `Rule` / `Prefix=tmp/` / `Expiration` `Days=1`。
- **验收判据**：`putStatus ∈ {200,204}`；回读 XML 解析出规则三要素（精确字段，不用 `/tmp|Expiration/` 宽松正则）。
- **如果失败，唯一原因是什么**：**Lifecycle API 不兼容**（`INCOMPATIBLE`）——3.79 未实现 `PutBucketLifecycleConfiguration` / Transition 不支持 / Expiration 执行周期未知（架构 §4 #14、【假设】）。若返回 501 或 `NotImplemented`，归因不变且**单列为「demo 非阻断但 R1 不可完全解除」**，见 §8 第三档。

#### C15 预签名 GET + Range（§4 #6/#4、用例⑥）——**重点单列⑥**
- **操作**：用 `publicClient.presignedGetObject(bucket, key, expires)` 生成 URL → 原生 GET 全量 → 原生 GET 带 `Range: bytes=0-1023`。
- **预期**：全量 200 且字节一致；Range 206 + 内容一致；URL host 与 `S3_PUBLIC_ENDPOINT` 一致。
- **验收判据**：全量 SHA-256 与源一致；`status===206`；`body.length===1024`；host 断言同 C05 第 1 项。
- **如果失败，唯一原因是什么**：**预签名 GET / Range 不兼容**（`INCOMPATIBLE`）——预览/下载链路（`file.service.ts` 300~900s 短时效 URL）依赖此路径。

#### C16 50MB 流式对象 SHA-256 重算（§4 #3/#4/#5、用例⑨）
- **操作**：以流式分块写入 50MB 确定性对象（不整体驻留内存），`getObject` 流式重算 SHA-256（等价 `computeSha256`），同时比对 `statObject.size`。
- **预期**：与本地边生成边计算的 SHA-256 完全一致；size 精确。
- **验收判据**：`sha256 === expected`（全等）；`size === 50*1024*1024`；记录耗时与峰值内存（诊断用，不进判据）。
- **如果失败，唯一原因是什么**：**大对象流式读/写不兼容**（`INCOMPATIBLE`）——架构 §4 #4 标注的「大文件 2GB 流式读取内存边界」在 demo 可验证范围内的前置证据。

#### C18（D-4 技术层）下载 wire 链路：`presignGet` 生产调用形态（§4 #6、用例⑥、补充裁定 D-4）

- **操作**：新建独立「下载源」对象（模拟 PDF 字节，本地记录 `sourceSha256`）→ 用 `publicClient.presignedGetObject(bucket, key, 300, { 'response-content-disposition': "attachment; filename*=UTF-8''..." })` 生成预签名 GET URL（**复现 `file.service.ts:418-420` 的生产下载调用形态**）→ 断言 URL host 为 `S3_PUBLIC_ENDPOINT` 且浏览器可达（非容器 DNS）→ **原生 HTTP GET 全量** → `sha256(body)` 与 `sourceSha256` 比对 → 断言 `content-disposition` 响应头回显 `attachment` → 原生 GET 带 `Range: bytes=0-1023` 验 206 + 内容一致。
- **预期**：URL host 浏览器可达；全量 GET 200 且与源文件 SHA-256 逐字节一致；`response-content-disposition` 被网关接受并回显；Range 206。
- **验收判据**：`u.hostname === S3_PUBLIC_ENDPOINT` + `dns.lookup` + TCP 可达 + 显式拒绝容器名；`status===200`；`sha256(body) === sourceSha`（64 位 hex 全等）；`content-disposition` 含 `attachment`；Range `status===206 && body.length===1024 && body.equals(src.slice(0,1024))`。**负向边界**：脚本全程未调用 `file.service.download()`、未构造 `PermissionSnapshot`、未写 `grants.FILE.ops`、未请求 `/api` 端点、未演示业务放行（`--self-test` 有静态检查钉死，见 §2.5）。
- **如果失败，唯一原因是什么**：**预签名 GET / `response-content-disposition` 响应头的 SigV4 规范化或回显不兼容**（`INCOMPATIBLE`）；或 host 为容器 DNS（`CONFIG_MISSING`）。G0/G1/G2 已排除服务、凭据、桶。**这与「下载业务放行链路未实现」是两个不同漏法，不得互相归因、不得合并表述。**
- **分层声明**：本用例 PASS 只能写「**S3 协议下载技术链路已验证**」；「**下载业务放行链路未验证**」另行单列（§2.5）。**不构成下载功能已验证的结论。**

#### C17（full）2GB / 5MB 分片（410 片）边界（用例⑧）
- **操作**：`--suite=full --large-mb 2048`，流式生成 2GB 确定性数据，按 5MB 切 410 片，逐片预签名 PUT → ETag 回读 → 合并 → GET 全对象流式重算 SHA-256。
- **预期**：410 片全部成功；合并后 SHA-256 与源一致；`statObject.size === 2GB`。
- **验收判据**：`partCount===410`（或 `ceil(total/5MB)`）、每片 ETag 非空、`sha256(merged)===sha256(source)`、size 精确。
- **如果失败，唯一原因是什么**：**大文件分片边界不兼容**（`INCOMPATIBLE`）——片数上限 / 文件大小上限 / 长任务超时 / ETag 累积。**本项不在 demo 范围**（`DEMO-ACCEPTANCE.md:66,257,376`），core 的 `YES` 不覆盖本项。

### 5.1 team-lead 八项重点单列的落点（自查表）

| # | 重点要求 | 检查点 | 断言形态（L 级） |
|---|---|---|---|
| ① | 预签名 PUT 必须用浏览器可达 host，不是容器 DNS | C05（+C06/C15） | URL host 精确等值 + `dns.lookup` + TCP 可达 + 显式拒绝容器名（L4 副作用） |
| ② | 分片上传 ≥3 片 | C06 | `PART_COUNT>=3` 硬断言 + 每片独立 PUT/ETag（L4） |
| ③ | 浏览器读 `res.headers.etag` | C06 / C08 | 原生 HTTP 响应头读取 + 去引号 + CORS 使 ETag 可读（L4） |
| ④ | CORS 使浏览器能读到 ETag（效果判据） | C08 | preflight + 实际响应四头逐一精确断言；`exposesEtag` 接受 `*` / 显式 `ETag` 两形态 + `credentialsOmitGuard` 静态守卫防假绿（L4，v1.2 修正） |
| ⑤ | 合并后 SHA-256 与源文件比对 | C07 / C16 | 64 位 hex 全等 + 负向对照（L5 变异） |
| ⑥ | 预签名 GET + Range | C15 / C03 | `206` + `Content-Range` + 1024 字节内容一致（L4） |
| ⑦ | 错误凭据 403 | G1 | 合法/错误双 client 对照 + Allow-All 反例（L4/L5） |
| ⑧ | `listParts` 返回结构 | C09 | 数组元素 `{part,etag,size}` 逐字段 + 升序（L4） |

**补充裁定 D-4 的落点（第九项，单独列出，不并入上表八项编号）**：

| 项 | 要求 | 检查点 | 断言形态 |
|---|---|---|---|
| ⑨ | 下载链路分两层：`presignGet` 技术层验 wire、业务放行层明确「未验证」，脚本输出 `D4_TECH_LAYER` / `D4_BUSINESS_LAYER` / `D4_CONCLUSION` 三行分层结论 | C18 | L4 副作用（host/SHA-256/Range/响应头）+ 静态边界检查（不构造 `DOWNLOAD` 授权夹具） |

> 「下载已验证」「下载受控通过」「R1 已全部关闭」为**禁用措辞**；逐字固定表述见 §2.5。

> 断言强度下限按 `TESTING-GUIDELINES.md` PM 规则「= 防线被绕过的业务后果等级，合规红线必须 L4+」：本链路为唯一 P0 签字缺口，故**不使用** L1 裸 `toThrow` / L2 仅错误类型 / L3 仅文案，全部落到 L4 副作用或 L5 变异对照。

---

## 6. 可执行脚本规格

| 项 | 内容 |
|---|---|
| 入口 | `scripts/qa-file-pipeline-verify.cjs`（CommonJS，与 `ci-check-permission-mutations.cjs` 同族） |
| 运行 | 宿主机任意 cwd：`node E:/TianjiArchive/scripts/qa-file-pipeline-verify.cjs --suite core` |
| 依赖 | Node ≥18；`minio@8.0.7`（从 `apps/api/node_modules/minio` 按脚本位置解析）；仅 `node:*` 内置模块，无新增 npm 依赖 |
| 端点 | 两个 SDK client：`internalClient` ← `S3_INTERNAL_ENDPOINT[:PORT]`；`publicClient` ← `S3_PUBLIC_ENDPOINT[:PORT]`（**必需**，缺失即 `CONFIG_MISSING`） |
| 配置来源 | 环境变量 / `--env-file`（默认尝试仓库根 `.env`）/ 命令行 `--public-endpoint` 等；**日志与 stdout 绝不打印 `accessKey`/`secretKey`**（架构 §5.2 红线） |
| 日志 | `docs/perf/runs/qa-file-pipeline-<suite>-<UTC>.log`（LF，`.gitignore:46` 白名单已开） |
| 输出 | 每个检查点一行结构化 JSON（含 `id/status/cause/detail/ms`）+ 人类可读摘要 + `SUITE` / `SCOPE` / `CHECKS_TOTAL` / `PRIMARY_CAUSE` / `IS_PASS: YES\|NO` + **`D4_TECH_LAYER` / `D4_BUSINESS_LAYER` / `D4_CONCLUSION` 三行分层结论**（无论 IS_PASS 为何值都输出，阶段二报告可直接引用） |
| 退出码 | `0`=YES，`1`=NO，`2`=脚本自身不可用 |
| 幂等 | 每轮 `runId` 唯一，对象写在 `qa-pipeline/<runId>/`，结束尽力清理；不修改业务数据 |
| `--self-test` | 不联网；直接对生产判据函数 `computeVerdict` 做变异验证（**30 条**，含空清单反假绿与三类归因）、校验 SigV4 签名构造的结构不变量、**真实写盘**验证日志链路、静态检查 D-4 技术层不经业务鉴权；**v1.2 新增 7 条**：`exposesEtag` 四形态（`*`→PASS / 显式 `ETag`→PASS / `x-custom`→FAIL / 空→FAIL）、`credentialsOmitGuard` 三态变异（干净源码 / include 命中 / 目录缺失 / 缺 FileUploader 的 fail-closed）、**`credentials=omit` 守卫生效**（三处定向核对 `audit` 全 CLEAN + 注入三处 HIT 均 fail-closed）、`C08_WILDCARD_PREMISE` 声明守卫；**v1.3 新增 5 条**：`corsListAllows` 两形态（`*` 通配双针→PASS / 显式列表→PASS、无关列表与空→FAIL）、`isAccessDenied` 五态（`AccessDenied`/`Access Denied`/403→true，`ETIMEDOUT`/`ENOTFOUND`→false）、`metaValueLoose` 双形态（带前缀/剥前缀/大小写混合均等效命中，未命中→null）、**v1.3 声明守卫**（C01 收权正验证落码 + C08 三头效果判据落码 + 守卫 fail-closed 链路未松动 + 旧字面断言已移除）；输出 `SELFTEST: PASS/FAIL` |

### 6.1 关键环境变量（QA 侧映射，与生产配置名解耦）

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `S3_INTERNAL_ENDPOINT` | 否 | `127.0.0.1` | 宿主机可达的内部 S3 地址（脚本在宿主机跑，不能填容器名） |
| `S3_INTERNAL_PORT` | 否 | `8333` | 与 `SEAWEEDFS_S3_EXPOSED_PORT` 对应 |
| `S3_PUBLIC_ENDPOINT` | **是** | 无 | 浏览器可达的预签名 host；缺失直接 `CONFIG_MISSING`（这正是 §1.2 双端点落地与否的探针） |
| `S3_PUBLIC_PORT` | 否 | `8333` | — |
| `S3_PUBLIC_USE_SSL` | 否 | `false` | — |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | **是** | 无 | 与 s3.json identity 一致；**不打印** |
| `S3_BUCKET_ORIGINAL/PREVIEW/THUMB/BACKUP` | 否 | 四桶默认名 | — |
| `QA_ORIGIN` | 否 | `CORS_ORIGINS` 首项 | CORS preflight 的 `Origin` |

> 若阶段二现场 `.env` 仍只有 `MINIO_*` 而无 `S3_PUBLIC_*`，QA **不代为推断**：可显式用 `--public-endpoint` 提供现场实际的浏览器可达 host；若确实不存在该配置，脚本将判 `CONFIG_MISSING` 并给出「预签名 host 未与内部端点解耦」的明确结论——这正是需要被抓出的事实。

---

## 7. 阶段一自证（脚本判据不假绿）与阶段二执行流程

### 7.1 阶段一已执行的自证（不触碰真实服务，不构成验收结论）

实测结果（2026-11-09 09:59 D-4 并入后重跑；2026-11-09 11:21 v1.2 C08 判据修正后再跑，全部实跑，非计划值）：

| 自证项 | 命令 | 实测结果 | 结论 |
|---|---|---|---|
| S-A 判据引擎变异（v1.1 阶段一，历史留痕） | `node scripts/qa-file-pipeline-verify.cjs --self-test` | `SELFTEST: PASS (18/18)`，EXIT=0；日志 `docs/perf/runs/qa-file-pipeline-self-test-20261109015949589.log` | 全 PASS→YES；注入 `FAIL`/`NOT_RUN`/`BLOCKED`/`ERROR` 各一例→NO；**空清单→NO**（反假绿元断言）；三类归因与优先级可分辨；SigV4 结构/确定性；**core=20、full=21** 清单数一致；**D-4 静态边界检查**（脚本无 `file.service`/`PermissionSnapshot` import、C18 带 `WIRE_ONLY` 声明）；日志真实落盘 |
| S-A′ 判据引擎变异（v1.2 修正后重跑） | 同上 | `SELFTEST: PASS (25/25)`，EXIT=0；日志 `docs/perf/runs/qa-file-pipeline-self-test-20261109033617610.log` | 原 18 条全保留全绿；**新增 7 条**全绿：`exposesEtag` 四形态（`*`→PASS / 显式 `ETag`→PASS / `x-custom`→FAIL / 空→FAIL）、`credentialsOmitGuard` 三态变异（干净源码放行 / include 命中 / 目录缺失 / 缺 `FileUploader` 均 fail-closed）、**`credentials=omit` 守卫生效**（临时目录构造含 `axios.create` 全局配置 + `FileUploader.tsx` 的 `axios.put` 调用，验三处 `audit` 全 CLEAN；注入 `axiosCreateConfig` / `fileUploaderPut` / `globalDefaults` 三处 HIT 后均 fail-closed）、`C08_WILDCARD_PREMISE` 声明守卫；**红数与守护用例数精确匹配 25/25**；`node --check` 语法 OK；日志真实落盘 |
| S-A″ 判据引擎变异（v1.3 修正后重跑，HEAD `5a0fbc2`） | 同上 | `SELFTEST: PASS (30/30)`，EXIT=0；日志 `docs/perf/runs/qa-file-pipeline-stage2-selftest-v13-20261109090006172.log` | 原 25 条全保留全绿；**新增 5 条**全绿：`corsListAllows` 两形态（`*` 通配双针 / 显式列表→PASS；无关列表与空→FAIL）、`isAccessDenied` 五态（三正向 AccessDenied/Access Denied/403→true；二负向 ETIMEDOUT/ENOTFOUND→false）、`metaValueLoose` 双形态（带前缀/剥前缀/大小写混合等效命中；未命中→null）、**v1.3 声明守卫**（`isAccessDenied`/`metaValueLoose`/`corsListAllows` 落码 + C01「业务身份 CreateBucket 竟然成功」反向断言存在 + `methodsOk/headersOk=corsListAllows` + `wildcardUsed` 覆盖三头 + `guard && !guard.pass→CONFIG_MISSING` fail-closed 链路 + 旧字面断言 `/PUT/i`、`/content-type/i` 已移除）；**红数与守护用例数精确匹配 30/30**；`node --check` 语法 OK；日志真实落盘 |
| S-B 服务未起 | `S3_PUBLIC_ENDPOINT=127.0.0.1 S3_ACCESS_KEY=… S3_SECRET_KEY=… node scripts/… --suite core --tag prerun-noservice` | `G0 FAIL/SERVICE_DOWN`；`CHECKS_TOTAL: 20 \| PASSED: 0 \| FAILED: 20`；`BY_STATUS: {"FAIL":1,"BLOCKED":19}`；`PRIMARY_CAUSE: SERVICE_DOWN`；`IS_PASS: NO`；EXIT=1；日志 `…prerun-noservice-20261109015950081.log` | 证明**没验成 ≠ 验出不支持**，且门禁后 19 项显式 `BLOCKED` 而非静默跳过；`D4_TECH_LAYER` 如实报「未验证（C18 BLOCKED）」、业务层单列「未验证」 |
| S-C 双端点未落地 | `S3_PUBLIC_ENDPOINT= … --tag prerun-noconfig` | `CONFIG_MISSING: S3_PUBLIC_ENDPOINT …`；`BY_STATUS: {"BLOCKED":20}`；`PRIMARY_CAUSE: CONFIG_MISSING`；`IS_PASS: NO`；EXIT=1；日志 `…prerun-noconfig-20261109015950582.log` | 证明 §1.2 风险①会被脚本精确抓出，不会假绿；D-4 三行分层结论仍照常输出 |
| S-D 工具静默陷阱体检 | `node --check`、行尾/脱敏/`git status`/`git diff --numstat` | 语法 OK；方案、脚本、3 份日志全部 `LF_ONLY`；日志 grep `qa_probe`/`tianji_minio*` **无泄漏**；`git diff --numstat` 无 CRLF 翻转（各文件增删数正常） | 防 CRLF 翻转与凭据入日志 |

**更正链条（按团队「不抹掉推断，显式记录推断→证伪→更正」方法学留痕）**：
1. 首轮 `--self-test` 为 16 条、红 1 条「SigV4 Authorization 结构」。定位为**测试断言自身 bug**：正则字符类 `[a-z;-]+` 漏了数字，而 `SignedHeaders` 含 `x-amz-content-sha256`（`256`）。自修为 `[a-z0-9;-]+` 并在失败时输出实际值便于诊断。
2. 修后 16/16 全绿，但核对 `docs/perf/runs/` 发现**只有两份 prerun 日志、没有 self-test 日志**——`--self-test` 分支漏调 `flushLog()`，导致「判据全绿但日志根本没写盘」。这正是「断言对象是否在生产路径」的同族假绿：只证了判据函数，没证日志链路。修法：新增第 17 条自证用例「日志目录真实可写」（真实写盘，不模拟），并在 `doSelfTest()` 结尾调用 `flushLog()` 覆盖 probe 文件、把 `flushed` 纳入返回码（当时 self-test 为 17 条）。
3. 两处均为 **QA 脚本 / 测试代码自身缺陷 → QA 自修，不报工程师**；该阶段最终 `SELFTEST: PASS (17/17)`。
4. **D-4 并入（v1.1）**：主理人补充裁定要求新增下载技术层用例与分层表述。新增独立检查点 **C18**（不复用 C15，理由见 §4），core 19→**20**、full 20→**21**；self-test 增第 18 条「D-4 技术层不经业务鉴权」静态检查 → `18/18`；脚本输出增 `D4_TECH_LAYER` / `D4_BUSINESS_LAYER` / `D4_CONCLUSION` 三行；§8 解除意见收窄为「部分解除」。所有计数按「计数类数字广播更新」全仓复核一致。
5. **C08 判据必然假红修正（v1.2）**：架构师 3.79 只读实测证伪 F9/F10/风险② 的旧 CORS 假设后，QA 只读复核脚本发现 `:653/:656` 用字面量正则 `/(^|,)\s*etag\s*(,|$)/i` 只认 `ETag`，面对 3.79 零配置返回的 `Expose-Headers: *` **必然假红**，会把正确实现误判为 `INCOMPATIBLE`（§8 C 档）。这是**QA 判据/测试代码自身缺陷 → QA 自修，不报工程师**（与第 1/3 条同族）。修法：抽纯函数 `exposesEtag(v)` 接受 `*` 与显式 `ETag` 两形态并让 `exposeOk`/`actualOk` 都改用它；加 `credentialsOmitGuard()` 静态源码守卫（fail-closed，防「接受 `*`」变成新假绿）与 `C08_WILDCARD_PREMISE` 声明；C08 失败归因改为三查，`INCOMPATIBLE` 收窄、无 CORS 头归 `TOOL_ERROR`、`*` 前提不过归 `CONFIG_MISSING`；`detail` 去掉已被实测更正的架构 §1.2:77 / §4 #9 / §7 第 2 条引用。self-test 18→**25 条**（新增 7 条守护用例），重跑 `SELFTEST: PASS (25/25)`，日志 `…self-test-20261109033617610.log`；中间产物 `…self-test-20261109031951773.log`、`…self-test-20261109032129837.log` 已清理。core **20** / full **21** 不变。方案 F9/F10、风险②、§2.3、§3 #9、§4 ⑦、§5 C08、§5.1 ③④ 全部按「保留原假设 → 实测更正」同步，未静默删改旧表述。
6. **主理人裁定补强（v1.2 定稿）**：主理人澄清「C08 判据不用改」是读到 `:653` 实现**之前**的作废表述，正式裁定**选 1**（判据对齐）。补强三处：① 方案 §5 C08 写入**等价正确性论证**（本次是纠正语义错误、把响应头字面值误当验收目标，**不是放宽/降级**，`*` 与显式 `ETag` 等价正确、强度不降低）；② `credentialsOmitGuard()` 从「全目录兜底」升级为「兜底 + **三处定向核对可追溯 `audit`**」——`globalDefaults` / `axiosCreateConfig`（`axios.create` 全局配置对象，对应 `apps/web/src/api/client.ts:64`）/ `fileUploaderPut`（`FileUploader.tsx:104-108` 的 `axios.put` 参数块），闭环此前「全局 defaults 未核」的开放项；③ self-test 新增第 25 条「`credentials=omit` 守卫生效」用例（定向核对 CLEAN + 注入三处 HIT 均 fail-closed）。**不选 2** 的理由：选项 2 会让 `IS_PASS: NO` / `PRIMARY_CAUSE=INCOMPATIBLE` 这一**机器可读输出**进入日志与下游引用链，即便正文澄清仍会被当成「验出不支持」，且带着已知错误判据做唯一一次真实实跑违反阶段一「判据引擎不假绿」自证纪律。**§8 三档规则、`computeVerdict` fail-closed 逻辑、20/21 计数、门禁串联、D-4 分层一律未动**。
7. **阶段二首跑 3 FAIL 判据修正（v1.3）**：阶段二 core 首跑（HEAD `5a0fbc2`）**17/20**——C01（业务身份 `makeBucket` 即 `Access Denied.`）、C02（meta 回读剥前缀形态）、C08（`Allow-Methods: *` / `Allow-Headers: *` 字面断言假红）。QA 逐项归因均指向**判据/裁定层而非产品缺陷**（C01 与 s3.json 收权裁定冲突、C02 生产零消费面已查证、C08 与 v1.2 前 expose 同构），上报后主理人**四项裁定授权 v1.3**（含「下载放行成功路径维持 L2 不演示」）：C01 改收权正验证（`isAccessDenied()`，建桶成功反而 FAIL）、C02 改 `metaValueLoose()` 双形态等效、C08 改 `corsListAllows()` 效果判据且 `wildcardUsed` 扩展覆盖三头共用守卫、归因分叉维持。self-test 25→**30 条**（新增 5 条），`PASS (30/30)`；core 复跑 **20/20 `IS_PASS: YES`**。日志：`…selftest-v13-20261109090006172.log`、`…stage2-core-v13-20261109090025825.log`。三项修正均为纠正「判据与架构裁定/实测形态不一致」，**不是放宽、不是为绿改判据**；§8 三档规则、`computeVerdict`、20/21 计数、D-4 分层未动。

> 自证日志带 `self-test` / `prerun` 标识，**明确标注不计入阶段二验收证据**；证据目录已清理中间调试日志（含 D-4 并入前的旧版、终检重复日志、v1.2 各次重跑的 `…031951773` / `…032129837` 中间产物与 `selftest-final2-*` 临时验证日志），只保留 **4 份**最终版（v1.1 的 3 份 + v1.2 定版 1 份 `…033617610`）。

### 7.2 阶段二（等 team-lead 明确通知后执行，本阶段不做）

1. 工程师起栈自验完成并通知；QA 按现场 `.env` 填好 6.1 变量；
2. **放行前 4 条门禁核验**（缺一不跑）：①双端点代码落地（`configuration.ts` 读 `S3_PUBLIC_*` + `storage.module.ts` 独立 `publicClient` + 三处 presign 切换）；②CORS 零配置 + **交付栈实测证据**：工程师在交付栈用真实预签名 URL 打一次 PUT，留 `HTTP 200 + ETag + Expose-Headers: * + Allow-Origin: *` 响应头原值日志（架构师独立容器实测仅「能力证据」，与本系统证据分开、不合并）；③`S3_PUBLIC_*` 已实际注入 api 容器 + API 实际签发 URL 的 host 实证（容器内 `printenv | grep S3_PUBLIC`、从 `MinioService.presignGet` 实际签发的 URL host 两条独立实证）；④起栈自验完成 + 原始日志落盘（四个镜像 ID、`BUILD-INFO` 校验结果）。
3. **现场验收清单补一项（架构师【不确定】项 13）**：用真实 partUrl 上传一个分片并断言拿到**非空 ETag**（带合法 SigV4 签名、鉴权开启下的 200 响应）；架构师因镜像无 openssl 未直接实测该项。
4. 执行 `node scripts/qa-file-pipeline-verify.cjs --suite core`；必要时 `--suite full --large-mb 2048`；
5. **独立复核原始日志**（不是只看脚本摘要）：逐检查点核对 JSON 行、SHA-256 值、HTTP 状态码、ETag 原值、CORS 头原值（含 `Expose-Headers: *` 原值）；核对日志 LF、无凭据泄漏、`git ls-tree` 可入库；**C08 红时先按 §5 归因三查核对，不自动计入 `INCOMPATIBLE`**。
6. **证据强度边界（分开表述）**：C05/C06/C15/C18 用 QA 自建 `publicClient` + 显式 public host，全绿只证明「给定正确 host 时 wire 链路可用」，**不证明被测服务读到了该配置**；报告把「wire 全绿」与「API 签发配置正确性」分两句写，后者证据不足如实写「未验证」，**不合并成「预签名 host 已验证」、不替被测服务背书**。
7. 出具「是否解除 `QA-REPORT.md §五 R1` 不可签意见」的独立结论（三档见 §8，**已按 D-4 收窄为部分解除**），并逐字包含 §2.5 固定表述；D-4 两层分开写、不写「四性全绿」、CORS 已知边界与 `credentials=omit` 未验证项如实写出；
8. 结论回传 team-lead 后，按通知更新 QA 文档（`QA-REPORT.md` 正文此时才允许改）；
9. 终判由 QA 独立裁定，不由工程师自验结果替代。

### 7.3 脚本不覆盖、需如实声明的范围

- 浏览器**真实同源策略**下的 CORS 行为：脚本用原生 HTTP 校验服务端响应头（真实 wire 证据），不等价于在真实浏览器内核里跑一次；若需浏览器级证据，阶段二补一条浏览器/Playwright 实录（不属本脚本）。
- **（v1.2）`Expose-Headers: *` 的 `credentials=omit` 前提**：`credentialsOmitGuard()` 只做前端源码静态核对，**未独立验证前端运行时配置、反代改写、构建产物**；`Allow-Origin: *` 与 `Expose-Headers: *` 在 3.79 上无法收紧（暴露 `X-Amz-Request-Id` / `Server` 等全部响应头），封闭内网阶段接受并登记为**已知边界**，正式启用若需收紧到具体 origin 须重裁架构。阶段二报告须把该前提列入**未验证项**，并禁止写「CORS 已安全配置」「SeaweedFS 已支持按需配置 CORS」。
- **（v1.3）`Allow-Methods: *` / `Allow-Headers: *` 同为通配且无法收紧**：与 Expose-Headers 同源于 3.79 内置全局 CORS middleware；credentials mode=omit 下通配全部方法/请求头（Authorization 除外，本链路预签名 PUT 不带凭据头），显式 `credentials: include` 下三头通配全部失效。报告口径同上，不单独写成「已按需配置」。
- **（v1.3）C01 收权边界**：业务身份 `tianji_minio` 无 CreateBucket 权限是 s3.json identity 收权的**安全架构裁定**（`storage.module.ts:34`），C01 以「应被拒」为正向判据；若未来切换到需运行时建桶的部署形态，本判据须随架构裁定重开，不得沿用。
- **（v1.3）C02 meta 回读剥前缀差异**：SeaweedFS 3.79 把 `x-amz-meta-*` 自定义键回读为剥前缀形态（如 `qa-case`），与 MinIO/SDK 带前缀形态不一致；**生产零消费面已查证**（`putObject` 只传 Content-Type、`statObject` 只读 `etag`），登记为兼容矩阵差异，不改代码、不改服务端；若未来业务需要消费自定义 meta，须按 `metaValueLoose()` 双形态适配或在服务端登记。
- 业务侧 `file.service.ts` 的 `FILE_HASH_MISMATCH` 删脏对象、魔数白名单、权限判定：属 `DEMO-ACCEPTANCE.md` S4/S7 的功能验收，由功能用例覆盖，本脚本只覆盖其**对象存储侧**依赖。
- **`approval` 下载业务放行链路（D-4 / L2）**：本脚本 C18 **只验 S3 wire 技术层**，不验 `file.service.download()` 的授权判定、`grants.FILE.ops.DOWNLOAD` 的写入、审批链路；该链路当前未实现，登记为上线前闭环项 L2，按 D-1/D-3 本次不修、不绕过、不演示成功下载。
- 1~5GB 连续导入预演（架构 §6.2）、2GB 断点续传、多容器 pub/sub 跨进程：范围外。

---

## 8. 阶段二判定档位（QA 独立裁定，预先公开判据）

> **D-4 收窄（主理人补充裁定）**：阶段二对 §五 R1 的解除意见**收窄为「部分解除」**。可解除的是上传/挂接/预览/`sha256` 完整性与 **S3 wire 层**（含 `presignGet` 下载技术链路）；**下载「业务放行」仍不可签**。是否**整体**解除由 QA 独立裁定，主理人不预先改判。

| 档 | 条件 | 对 §五 R1 的意见（D-4 收窄后） | 报告表述 |
|---|---|---|---|
| **A 部分解除（限定范围）** | `core` 全部 PASS 且 `IS_PASS: YES`；原始日志复核无异常；无凭据泄漏 | 建议**部分解除**：仅解除「文件入库 / 挂接 / 预览 / SHA-256 完整性」与「S3 wire 层（含 `presignGet` 下载技术链路）」的不可签；**「下载业务放行」仍不可签（L2）**，必须附 `SCOPE: CORE` | 技术层写「**S3 协议下载技术链路已验证**」，业务层**另起一句**写「**下载业务放行链路未验证**」；逐字包含 §2.5 固定表述；2GB/410 片边界、生产容量、多容器 pub/sub 仍排除。参照既有 `PASS（限定范围）` 体例，**禁用**「R1 全部关闭」「下载已验证」「文件链路已完整闭环」「四性全通过」 |
| **B 保持不可签（没验成）** | `IS_PASS: NO` 且 `PRIMARY_CAUSE ∈ {SERVICE_DOWN, BAD_CREDENTIALS, CONFIG_MISSING, TOOL_ERROR}` | **保持不可签**（含下载业务放行），且明确写「本轮未产生兼容性结论」 | 列出阻塞项与整改动作（起栈 / 注入 identity / 落地 `S3_PUBLIC_*` 双端点 / 修脚本），整改后重跑；**不得**写成「方案 A 不兼容」，也不得写成「下载已验证」 |
| **C 保持不可签（验出不支持）** | `IS_PASS: NO` 且 `PRIMARY_CAUSE = INCOMPATIBLE` | **保持不可签**，逐条列出不兼容的 wire 操作与原始证据 | 若仅 C14（lifecycle）红而 C05/C06/C07/C08/C15/C18 全绿，可给出**子范围结论**：「文件入库/预览/SHA-256 完整性与 S3 下载技术链路（wire 层）已实证；§4 #14 生命周期未闭环、下载业务放行仍未验证，R1 不可完全解除」；除此之外不拆分子范围 |

> **v1.2 C08 归因约束（三档公用，预先公开）**：`PRIMARY_CAUSE = INCOMPATIBLE` 是 C 档的唯一入口。C08 若因「响应无任何 CORS 头」判 `TOOL_ERROR`、或因「`*` 通配前提静态守卫不过」判 `CONFIG_MISSING`，按 `CAUSE_PRIORITY` 归入 **B 档「没验成」**，**不得**据此落 C 档或写「SeaweedFS 与 SigV4 不兼容 / 不支持 CORS」。只有「带了 Origin、非同域前提成立、CORS middleware 已响应、仍未返回合法暴露头」才构成 C 档证据。此约束与 §2.3 `INCOMPATIBLE` 排除项、§5 C08 归因三查一致。

**D-4 分层表述为三档公用约束**：
- 「S3 下载技术链路已验证」与「业务放行链路未验证」必须**分成两句**，不得合并成一句「下载已验证」；阶段二 QA 报告须逐字包含 §2.5 固定表述。
- §五 R1 原文「文件入库 / 下载 / 四性检测真实链路未验证」中的「**下载**」按 D-4 拆读：技术层可解除、业务层保留；「**四性检测**」按 PM S8 纪律只认完整性 SHA-256，真实性/安全性为 `UNKNOWN`、可用性随 `extractStatus` 派生，**不得**写成「四性全绿」（与 `QA-REPORT.md` §3.5「契约绿/逻辑绿」同族）。
- L2 闭环前，QA 不会把「下载业务放行」计入已验证范围；多容器 pub/sub 跨进程仍按原判定保留。

> 三档均需引用 `docs/perf/runs/` 的原始日志路径与 commit hash；`QA-REPORT.md` 正文更新只在阶段二结论回传后按 team-lead 通知进行。

---

## 9. 边界声明与待办

**阶段一已完成（5 个新文件 = 1 方案 + 1 脚本 + 3 份自证日志，`git status` 实证 5 个 `??`）**：
1. `docs/QA-FILE-PIPELINE-PLAN.md`（本方案）；
2. `scripts/qa-file-pipeline-verify.cjs`（可执行脚本，`node scripts/qa-file-pipeline-verify.cjs --suite core` 为阶段二入口）；
3. `docs/perf/runs/qa-file-pipeline-self-test-20261109015949589.log`；
4. `docs/perf/runs/qa-file-pipeline-prerun-noservice-20261109015950081.log`；
5. `docs/perf/runs/qa-file-pipeline-prerun-noconfig-20261109015950582.log`。

第 3~5 项为阶段一自证日志，**不计入阶段二验收证据**。

> 上述文件只读了工程师在途工作区、未做任何修改；为避免与工程师并发工作区相互干扰，**阶段一产物暂未提交**，如需入库请 team-lead 通知，QA 可只提交这 5 个明确路径。【v1.2 注：以上为阶段一历史状态留痕，不删改；实际 5 个路径已于 `377a593` 入库（并发暂存竞态一并带入 PM 的 `DEMO-ACCEPTANCE.md` v1.2，主理人裁定 A 保留、不 reset）。】

> **v1.2 变更文件（本次 C08 判据修正）**：改动 `docs/QA-FILE-PIPELINE-PLAN.md`（本方案）、`scripts/qa-file-pipeline-verify.cjs`（脚本）2 个既有文件；新增 `docs/perf/runs/qa-file-pipeline-self-test-20261109033617610.log`（v1.2 定版自证日志，仍**不计入阶段二验收证据**）。中间产物 `…031951773.log`、`…032129837.log` 与 `selftest-final2-*` 临时验证日志均已清理。**未执行 `--suite core`、未改方案外文件、未擅自提交**（待 team-lead 明确入库通知，避免重演并发暂存竞态）。

> **v1.3 变更文件（阶段二首跑 3 FAIL 判据修正，主理人四项裁定授权）**：改动 `docs/QA-FILE-PIPELINE-PLAN.md`（本方案：顶部 v1.3 变更段、§5 C01/C02/C08 判据、§6 self-test 30 条、§7.1 S-A″ 行、§7.2 更正链条第 7 条、§8 已知边界 3 条、本注）、`scripts/qa-file-pipeline-verify.cjs`（脚本：文件头 v1.3 版本演进、`isAccessDenied()`/`metaValueLoose()`/`corsListAllows()` 三纯函数、C01 收权正验证、C02 双形态、C08 methods/headers 效果判据 + wildcardUsed 扩展三头、CHECK_DEFS 两处标题、self-test 25→30）。阶段二日志（`eb58a02` 已入库 4 份）之外新增 2 份 v1.3 复跑日志：`…stage2-selftest-v13-20261109090006172.log`、`…stage2-core-v13-20261109090025825.log`（后者为本方案首次 **`--suite core` 全绿 `IS_PASS: YES`** 记录）。**下载放行成功路径维持 L2 不演示（主理人裁定第 4 项）**；未碰 apps / installer / 他人域文件；提交报 hash 由 team-lead 统一推送。

**阶段一未做（明确不做）**：
- 未执行任何针对真实 SeaweedFS 服务的验收（等服务起栈 + team-lead 通知）；
- 未改 `QA-REPORT.md` 正文、`ARCHITECTURE-SEAWEEDFS.md`、`DEV-PROCESS.md`、`DEMO-ACCEPTANCE.md`；
- 未改任何生产代码、配置、测试文件；
- **未准备任何 `DOWNLOAD` 授权夹具、未构造带 `DOWNLOAD` 授权的用户快照、未绕过 `approval` 鉴权**（D-1 否决的「R0 临时授权」路径已作废）；C18 只走 S3 wire，脚本 self-test 有静态边界检查；
- 未对 §1.2 的实现落差做修改或代工程师下结论，仅记录为阶段二重点观测项。

**待 team-lead 通知**：阶段二执行脚本 → 复核原始日志 → 出具 §8 三档之一的独立意见 → 按通知更新 QA 文档。

---

*编制 · 严过关（QA）· 2026-11-09 · 阶段一方案稿，不构成验收结论*
