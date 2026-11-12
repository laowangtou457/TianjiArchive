# 变体 A（ubuntu/debian + 麒麟/统信）真机 e2e 证据归档

- 时间：2026-11-12（UTC 08:39 装机 → 10:19 全链收尾）
- 被测对象：`dist/installer/tianji-server-setup-ubuntu-debian-amd64-1.0.0.run`
  - size = 154,407,859 B
  - sha256 = `5fab54c9dabeb29f943efee070f25d0123eb81b5306a8729c57b0f4365f0dc88`
  - deb 闭包 86 个（含本轮补入的 `perl-base_5.34.0-3ubuntu1.9_amd64.deb`）
  - 签名状态：**未签名**（本机 gpg 不可用，见下「遗留」）
- 被测系统：Ubuntu 22.04.5 LTS (jammy)，QEMU/KVM 真机（非容器）
  - install: disk=60G mem=8192MiB smp=4 accel=kvm，qemu 173s
  - boot(e2e): 同一块盘二次引导，qemu 272s
- 结论：**ALL-GREEN**（串口打点 `=== CX ubuntu ALL-GREEN ===`，boot log 第 909 行）

## 1. 安装器十步状态（`/var/lib/tianji-install/state.json`）

| 步骤 | 状态 | 耗时 |
|---|---|---|
| S1_PREFLIGHT 环境体检 | DONE | 44ms |
| S2_VERIFY 包完整性 | DONE | 982ms |
| S3_DOCKER 安装 Docker | DONE | 1m16.333s |
| S4_IMAGES 导入镜像 | DONE | 34.872s |
| S5_ENV 渲染配置 | DONE | 1ms |
| S6_UP 启动服务栈 | DONE | 52.009s |
| S7_MIGRATE 数据库迁移 | DONE | 3.113s |
| S8_SEED 初始化数据 | DONE | 2.087s |
| S9_SMOKE 四项冒烟 | DONE | 7.529s |
| S10_DONE 完成 | DONE | 0s |

干净一轮从 S3 到 S10 共 **177.9s**；`nextStep` 终值 `S10_DONE`，`osMatch.level=exact`（Ubuntu 22.04 jammy 已登记，无需二次确认）。

- Docker：method=`deb`，daemon `29.9.3`，compose `5.7.0`，`dockerBin=docker`（`/usr/bin/docker`）
- 部署目录 `/opt/tianji`，访问 `http://10.0.2.15:8080`，S3 端点 `http://10.0.2.15:8333`

## 2. 离线镜像 8/8（`S4_IMAGES` 回执，installer 自校验）

镜像 tar：`/root/tianji-offline-images.tar`
- sha256 expected = actual = `50fde9a8a99c5cac03f4f394083da4887637f03b65f8c8c9a3901dcde2ad1372`
- `imageCount=8`，`checks[]` 全 `ok:true`，`loadOutput` 逐条 `Loaded image:`

| 镜像 | image id | ok |
|---|---|---|
| postgres:16-alpine | `sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139` | ✅ |
| redis:7-alpine | `sha256:c5d34a98396a4775e223c74e929162c35c5a2182901ba26b50ade939941ce14b` | ✅ |
| tianji-elasticsearch-ik:8.13.4 | `sha256:d9605e3f516ad9c67a9f456ba85f738483c0ee0941c079b6a567036bfb2485e8` | ✅ |
| chrislusf/seaweedfs:3.79 | `sha256:21425305e04b355904ef350ff75a4e81b8afc5124f63e0485b946164b58562d3` | ✅ |
| tianji-archive-api:1.0.0 | `sha256:7e91c330c123ffea2dafe407e8cd4269b6a4d7104c089aadbe9abe235bdb41d3` | ✅ |
| tianji-archive-web:1.0.0 | `sha256:309a6e2c8e7d576f6ae3818e8b2cb51da5939092d95f2c7c24e2bd6caced9238` | ✅ |
| tianji-archive-extractor:1.0.0 | `sha256:939e1a91ac8c36891c8e4b432c09684369d3570bf2fb2fc4461442f5f503195c` | ✅ |
| tianji-archive-backup:1.0.0 | `sha256:6c32e7bb948a25afe09f444720b4171ee85d47d7b0f65c06cacdb295c859a7d1` | ✅ |

> 说明：变体 A 走 `docker load`，容器 `config.v2.json` 里记录的是 **sha 引用**而非 tag，故
> `docker images` 的口径（按 Repository:Tag 计数）在本变体不适用。此处以 installer 自己的
> 导入后校验回执为准，比事后 `docker images` 更接近「安装成功」的判定点。

## 3. 四项冒烟（`S9_SMOKE` 回执，4/4 passed）

1. **1/4 健康检查 `/api/health`** — `passed:true`，`status=ok`，deps 四项全 ok：
   postgres(1ms)、elasticsearch(8ms)、objectStorage(2ms)、redis(0ms)
2. **2/4 S3 兼容性探针** — `passed:true`，`OPS_TOTAL=13 OPS_PASSED=13 OPS_FAILED=0`，
   `IS_PASS: YES`（9 类 S3 操作与 SeaweedFS 3.79 S3 Gateway 全兼容，含分片上传与预签名直传）
3. **3/4 样品书籍全链路** — `passed:true`，`DEMO_BOOKS_TOTAL=6`、`DEMO_VOLUMES_TOTAL=2`、
   投抽取任务 12、`FILES_UPLOADED=12`、`EXTRACTED_OK=12`、`SEARCH_HITS=6`、`SHA256_VERIFIED=12`，
   `IS_PASS: YES`
4. **4/4 IK 中文分词** — `passed:true`，切出「中华人民共和国」

## 4. 串口打点（guest 内 oneshot 自跑，hostfwd SSH 在 docker0 起来后必失联）

`ubuntu-e2e-stagec-boot.log` 关键行：

```
807:=== CX ubuntu BOOT ===
845:=== CX ubuntu S1-DONE ===
846:=== CX ubuntu S2_VERIFY-OK ===
884:=== CX ubuntu S3_DOCKER-OK ===
885:=== CX ubuntu S4_IMAGES-OK ===
886:=== CX ubuntu S5_ENV-OK ===
895:=== CX ubuntu S6_UP-OK ===
896:=== CX ubuntu S7_MIGRATE-OK ===
897:=== CX ubuntu S8_SEED-OK ===
898:=== CX ubuntu S9_SMOKE-OK ===
899:=== CX ubuntu S10_DONE-OK ===
909:=== CX ubuntu ALL-GREEN ===
```

## 5. 容器清单（8 个，离线挂盘读 `/var/lib/docker/containers/*/config.v2.json`）

tianji-web / tianji-api / tianji-extractor / tianji-postgres / tianji-redis /
tianji-elasticsearch / tianji-seaweedfs / tianji-backup —— 8/8 齐全。

## 6. 本轮修复的产品缺陷（真机才暴露）

`perl (= 5.34.0-3ubuntu1.9)` 依赖 `perl-base (= 5.34.0-3ubuntu1.9)`，而 deb payload 只带了
perl 1.9 未带 perl-base 1.9；ISO 装出的 22.04.5 自带 `perl-base 1.3` →
`dpkg: dependency problems prevent configuration of perl` → 级联 `liberror-perl`、`git` → S3_DOCKER FAIL。

- 构建侧：`fetch-docker-debs.sh` 的 `ALWAYS_DOWNLOAD` 增加 `perl-base`；payload 补 86 号 deb
- 审计侧：`audit-debs.py` 新增规则——**严格等版（`=`）依赖若落在闭包外即 ERROR**
  （原逻辑把闭包外依赖一律记作「目标系统提供」，盲区导致该缺陷未被拦住）

## 7. 证据文件

| 文件 | 内容 |
|---|---|
| `ubuntu-install.log` / `-stages.log` | 无人值守装机串口全文（第 6 轮，零 `install_fail`，`Shutdown/shutdown: mode=POWEROFF`）/ 阶段耗时（173s） |
| `ubuntu-boot.log` / `-stages.log` | 装机后首次引导（验证 SSH / sudo / facts-boot.txt），含 `facts-boot` 留痕 |
| `ubuntu-e2e-stagec-boot.log` / `-stages.log` | 全链自跑串口全文（含 ALL-GREEN）/ 阶段耗时（272s） |
| `ubuntu-e2e-collect-boot.log` | collect 阶段串口全文 |
| `ubuntu-e2e-collect-files.tgz` | guest 内取证包：`state.json` + `S1..S10` 全部回执 API 响应 + `stagec-ubuntu.log` + `setup-web-C.log` |
| `ubuntu-e2e-docker-inventory.txt` | 采集失败留痕（SSH 被 docker0 掐断），已由本文件第 2/5 节替代 |

## 8. 遗留

- **未签名**：本机 gpg 在无 TTY 下卡 pinentry（22 分钟无进展，`--batch`/`loopback`/杀 agent 均无效），
  本轮出包跳过 `--sign`。payload 完整性由内嵌 `SHA256SUMS` 把守。正式交付前需在可用环境补 `.asc`。
- `run-vm.sh` 在 boot 模式打印的 `disk=30G` 与实际盘（60G，已存在不重建）不一致，属日志口径瑕疵，不影响行为。
- 变体 C（Windows）待用户 VM 就绪后按 `installer/windows/真机验证清单.md` V0→V10 执行。
