# installer/build/ · 构建机侧脚本与载荷模板

本目录是**构建机侧**代码：可以联网、可以装工具、可以慢慢跑。产出一个自解压安装包
（`.run`）与一份可选的 gpg 分离签名。所有**运行期**逻辑都不在这里（在 `../server/`，
静态二进制、全程不出网）。

> 上层说明见 [`../README.md`](../README.md)，设计依据见
> [`../../docs/INSTALLER-DESIGN.md`](../../docs/INSTALLER-DESIGN.md)。
> 本文件只写「这个目录里有什么、生成物为什么这样放、踩过哪些坑」。

## 目录内容

| 路径 | 职责 | 是否入库 |
|---|---|---|
| `fetch-docker-debs.sh` | 变体 A 载荷：抓 `docker-ce` 的 `.deb` 闭包 + 逐文件 `DEBS-MANIFEST.txt` | **入库** |
| `fetch-docker-static.sh` | 变体 B 载荷：抓 `docker-27.5.1.tgz` + compose v2 单二进制（摘要内置、双源比对） | **入库** |
| `build-server-package.sh` | 主打包脚本：组装 staging → G1/G2 闸门 → 打 payload → 拼自解压头 → G3 闸门 | **入库** |
| `make-manifest.sh` | 生成 `manifest.json` + `SHA256SUMS.txt`（+ `--sign` 时 `SHA256SUMS.asc`） | **入库** |
| `selfextract/header.sh.in` | `.run` 的 POSIX sh 自解压头模板（构建期替换定长占位符） | **入库** |
| `payload/common/` | 与 `offline/`、`infra/` 同源的载荷模板（compose、脚本、sysctl、seaweedfs） | **入库** |
| `payload/ubuntu-debian/<codename>/debs/` | 变体 A 真实 `.deb` 闭包（约 147MB / 85 个包） | **不入库**（体积大、平台相关） |
| `payload/ubuntu-debian/<codename>/fake-debs/` | 5 个**假** `.deb`，仅供安装器行为验证 | **不入库** |
| `payload/kylin-uos/docker-static/` | 变体 B 载荷（`docker-27.5.1.tgz` 76MB + compose 64MB） | **不入库** |
| `pubkeys/tianji-build.asc` | 构建密钥公钥（现场用于核验签名） | **入库** |
| `pubkeys/tianji-build.fingerprint.txt` | 公钥指纹（供现场逐字比对） | **入库** |

载荷目录不入库由 `.gitignore` 第 33–34 行逐条锚定（**不能**写成 `payload/`，那会把
`common/` 一起吞掉）。因此**干净克隆里必须先跑 `fetch-*.sh` 才能出包**，这是刻意的：
载荷是可复现的抓取结果，入库只会随构建机漂移。

## 关于 `fake-debs/`：非真实载荷，仅供安装器行为验证

`payload/ubuntu-debian/<codename>/fake-debs/` 里的 5 个 `.deb` 是几十字节的占位文件，
**非真实载荷，仅供安装器行为验证**——用来复现设计 §4.2 的三类失败场景：

- **B**：载荷文件缺失 → 安装器必须「载荷缺失即停」，而不是继续往下装；
- **C**：`DEBS-MANIFEST.txt` 里某个包的 sha256 对不上 → 必须点名是哪个包被换过；
- **E**：`dpkg -i` 报错时的错误话术与 `dpkg -l` 快照是否给得出来。

这些场景在真机上难以按需制造（真的把系统装坏代价太大），所以保留假载荷做回归。
**它们绝不能被误打进出包产物**：`build-server-package.sh` 只收 `debs/`，且真闭包存在时
`debs/` 与 `fake-debs/` 不会同时被读——出包日志里的「deb 载荷：N 个」是唯一的判据来源。

## 构建（变体 A，Ubuntu 22.04 jammy）

```bash
# 1) 抓真闭包（构建机联网；走直连，不需要代理）
bash installer/build/fetch-docker-debs.sh --codename jammy --pin-version

# 2) 交叉编译安装器（仓库根执行；必须在 installer/server 模块目录内）
cd installer/server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags '-s -w -X main.version=1.0.0' \
  -o dist/tianji-installer ./cmd/tianji-installer && cd ../..

# 3) 打包 + 签名（--gpg-key 建议显式指定，别靠「默认密钥」）
GNUPGHOME=~/.gnupg bash installer/build/build-server-package.sh \
  --variant ubuntu-debian --codename jammy \
  --installer installer/server/dist/tianji-installer \
  --images-tar offline/tianji-offline-images.tar \
  --sign --gpg-key 0AD2912CF8FE57E202C275F20A038555B153ACC9
```

产物在 `dist/installer/`（不入库），需与 `offline/tianji-offline-images.tar`
**同目录**交付（设计 §7.1）。

## 本目录踩过的坑（改脚本前先读这段）

| # | 坑 | 现象 | 修法 |
|---|---|---|---|
| 1 | `set -o pipefail` + `awk '{print $2; exit}'` | 脚本刚打印「抓到 N 个 deb」就以 **141** 静默退出，不报错、不生成清单 | `awk '/Candidate:/ {print $2}' \| sed -n '1p'`；同理禁止 `… \| grep -q`，改用 `find … -print -quit` 或先落变量 |
| 2 | 容器/精简系统里 apt 索引为空 | `Package 'ca-certificates' has no installation candidate` | 装工具前先 `apt-get update` |
| 3 | Ubuntu/Debian 官方源没有 `docker-ce` | `Unable to locate package docker-ce` | 加 Docker 官方源；被墙时 `--docker-base https://mirrors.aliyun.com/docker-ce/linux/ubuntu` |
| 4 | apt 增量语义 | 构建机已装 `libseccomp2` → `Need to get 0 B` → 包里没有这个 deb | `ALWAYS_DOWNLOAD` 名单用 `--reinstall` 强制落盘，再逐包核对 |
| 5 | `sha256sum -b`（Git Bash 默认） | 清单里是 `hash *name`，安装器把路径认成 `*bin/…` 判定全部缺失 | 生成清单时统一规范化成 `hash  path`（去前导 `\`、去 `*`） |
| 6 | `python3-minimal` 缺 `json` 模块 | 报「manifest.json 不是合法 JSON」，实际是 `ModuleNotFoundError` | `make-manifest.sh` 三分支：能 import 才解析，缺模块就 WARN，别把工具缺失伪装成数据损坏 |
| 7 | `tar -tzf … \| grep -qx` | 包是好的却报「缺少 docker/dockerd」（grep 命中即退出 → tar 收 SIGPIPE → 141） | 先把清单落成变量，再 `grep <<<"$LIST"` |
| 8 | `download.docker.com` 在 `.tgz.sha256` 上 404 | 靠「同名 .sha256 文件」校验的假设不成立 | 摘要**内置**在脚本里（双源比对后固化），未知版本 fail-closed，可用 `--docker-sha256` 显式传入 |

## 签名与现场核验

- 构建密钥：`tianji-build`，RSA4096，有效期至 **2027-11-09**，**无口令**（构建机无人值守）；
  **私钥只留在构建机 `~/.gnupg`，绝不入库**。入库的只有公钥 `pubkeys/tianji-build.asc`
  与指纹文件。
- 指纹：`0AD2 912C F8FE 57E2 02C2 75F2 0A03 8555 B153 ACC9`
- 签名对象是 `SHA256SUMS.txt`，产出 `SHA256SUMS.asc`（**armor 分离签名**，文本可直接贴进
  工单/邮件核对）。
- 现场核验：

  ```bash
  gpg --import  tianji-build.asc
  gpg --fingerprint 0A038555B153ACC9      # 必须与上面指纹逐字一致
  gpg --verify SHA256SUMS.asc SHA256SUMS.txt
  sha256sum -c SHA256SUMS.txt             # 逐文件核对载荷
  ```

  指纹不一致即**停止**：那说明公钥本身被换过，签名验证再成功也没有意义。

- 轮换：到期前重新生成同名密钥并更新 `pubkeys/`，旧公钥保留一个发布周期，
  避免已在现场的介质验不过。
