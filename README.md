# 天玑档案管理系统（TianjiArchive）

> 版本 1.0.0 ｜ 面向封闭内网（离线环境）的档案管理系统
> 文档与界面均为简体中文；本文是全仓库的入口索引。

---

## 一、这是什么

天玑档案管理系统是一套**面向机关/单位的封闭内网档案管理系统**：全宗—案卷—件三级著录、档号规则引擎、电子文件上传与文本抽取、全文检索（ES + IK 中文分词）、借阅审批（秘密级两级审批）、统计报表、备份恢复。全部服务离线交付，不依赖任何公网资源。

**技术栈**：React 18 + MUI（`apps/web`）｜ NestJS + TypeORM（`apps/api`）｜ 文本抽取 Worker（`apps/extractor`）｜ PostgreSQL 16 ｜ Elasticsearch 8.13.4（IK）｜ SeaweedFS S3 网关（预签名直传）｜ Redis ｜ Docker Compose 离线编排。

**交付形态**：服务端一键安装包（`.run` 自解压 + 图形化 Web 安装向导，10 步安装流程）＋ 用户端免安装配置器（client-lite，双击即配即检）＋ 离线镜像 tar。

## 二、目录导览

| 目录 | 内容 |
|---|---|
| `apps/web` | 前端 SPA（React 18 + MUI + Tailwind） |
| `apps/api` | 后端 API（NestJS，著录/档号/检索/借阅/统计/用户权限/备份模块） |
| `apps/extractor` | 文本抽取 Worker（异步消费上传文件） |
| `apps/cli-migrator` | 数据迁移 CLI |
| `packages/shared` | 前后端共享代码（权限矩阵、22 项系统参数单源等） |
| `docs/` | 全部工程文档（**文件名与正文均为中文**，见 §五索引） |
| `installer/` | 双安装包：`server/` Go 安装器、`client-lite/` 用户端、`build/` 构建脚本、`vmtest/` 真机验证 |
| `offline/` | 离线介质（镜像 tar、SHA256SUMS、离线 compose、.env 派生） |
| `scripts/` | QA / CI 自检脚本（如 `qa-file-pipeline-verify.cjs`） |
| `volumes/` | 本机试点数据卷（宿主机目录挂载，可整体拷贝归档） |

## 三、快速开始

### 3.1 离线部署（生产 / 交付口径）

1. 取交付介质：`tianji-server-setup-kylin-uos-amd64-1.0.0.run`（99,968,027 B，sha256 `d1120fda71cfcdf6dfc8f90ab8522c96430f3c9e2985f497bb52fa8042ebac5f`，构建日志 `dist/installer/build-kylin-uos-final-2.log`）＋ `offline/tianji-offline-images.tar`（1.5 GB，sha256 见 `offline/SHA256SUMS`）＋ `installer/client-lite/tianji-client-lite.zip`。
2. 目标机执行 `sudo sh <包>.run`，浏览器打开 `http://<服务器IP>:18080` 图形向导，S1→S10 十步全部 DONE。
3. 三步验收：`systemctl is-active docker`、浏览器登录、用户机跑 client-lite 自检三项全 PASS。

**详细步骤、门槛与排障见《离线部署手册》（`docs/离线部署手册.md`）。** 适用边界：目标机为麒麟 V10 SP3 / 统信 UOS 20 / Ubuntu 22.04+（amd64，真机验证覆盖麒麟与统信，Ubuntu 为变体 A 未真机验证）。

### 3.2 开发环境（本机试点口径）

前置：Docker Desktop（WSL2）＋ pnpm ＋ Node 22。

```bash
pnpm install                          # 安装依赖
docker compose up -d                  # 起 8 服务（web/api/extractor/pg/es-ik/seaweedfs/redis/backup）
pnpm -F api migration:run             # 建表
# 浏览器 http://localhost:8080 ，默认 admin / Tianji@2024（R0，业务操作需先建 R1~R4 账号）
```

开发环境细节（压测、卷结构、常见坑）见《部署与压测启动手册》（`docs/部署与压测启动手册.md`）。

### 3.3 用户端配置（档案员电脑）

解压 `tianji-client-lite.zip`（4 个文件）→ 双击「配置天玑客户端.bat」→ 输服务器 IP → 桌面出现快捷方式并自动跑三项连通性自检（网站 /api/health/8333 直传端口），三项全 PASS 即可登录使用。详见 zip 内《说明.txt》。

## 四、质量与验证口径

- **单测**：`packages/shared`（权限/参数 21 项断言）、`apps/api` 业务规则（R1~R8 并发与幂等修复均有回归）；Go 安装器 126 pass / 3 skip（`installer/server`）。
- **QA 文件链路**：`scripts/qa-file-pipeline-verify.cjs`（口径见《QA-文件链路验证方案》）。
- **真机端到端**：麒麟 V10 SP3 与统信 UOS 20 双机 S1→S10 全链全绿 + Go 冒烟 4/4（《变体B-真机实测结果》§7）。
- **审定版包**：每次构建 sha256 都会变（非恒等式）；当前审定值以《安装器总体设计》§14.6 回填为准。正式对外交付前必须做 `--sign` 签名版（见该节签名裁定）。

## 五、文档索引（docs/，全部中文）

| 文档 | 内容 |
|---|---|
| `产品需求文档.md` | 功能权威源（PRD v1.3-FINAL，含参数 5.5 封版） |
| `系统架构设计.md` / `类图.mermaid` / `时序图.mermaid` | 架构、数据模型、关键流程 |
| `SeaweedFS架构规格.md` | 对象存储方案 A（MinIO 替代）规格 |
| `安装器总体设计.md` | 双安装包总体设计、S1~S10 语义、交付物表、审定 digest（§14.6） |
| `变体B-系统基线实测.md` / `变体B-真机实测结果.md` | 国产 OS 基线与真机端到端全账 |
| `用户使用手册.md` | 面向档案员/审批人/管理员的操作手册 |
| `离线部署手册.md` | 面向实施人员：介质→安装→验收→排障 |
| `系统维护手册.md` | 面向运维：巡检/备份恢复/日志/升级/故障速查 |
| `部署与压测启动手册.md` | 开发环境（Docker Desktop）口径 |
| `QA验收报告.md` / `QA-文件链路验证方案.md` / `样品Demo验收清单.md` | QA 三件套 |
| `交付核对清单.md` / `开发过程记录.md` / `测试方法学规范.md` | 整改追踪、过程留痕、测试方法学 |

## 六、纪律与边界（务必读）

- **分支**：`main` 是唯一可推送分支（对外脱敏口径）；含真实主体信息的分支永不推送。
- **凭据**：生产密码在交付时通过安装向导填写（`.env.tpl` 占位化，仓库不含真实凭据）；`offline/.env` 仅为本机试点值。
- **已知限制**：无在线升级机制（升级=重装+数据卷迁移）、PITR 有 WAL 归档暂无恢复编排、extractor/backup 容器无 healthcheck（属设计）、真硬件与 tap/bridge 网卡场景未验证——详见《系统维护手册》§十一与《变体B-真机实测结果》§7.5。
- **Redis 驱逐策略**：`noeviction`（档案系统不许静默丢数据，内存压力显式报错）。

---

*本文由工程主理人维护；文档结构变更时请同步 §五索引。*
