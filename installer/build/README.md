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
| `audit-debs.py` | **闭包自洽性审计**：自己算一遍依赖（不依赖 dpkg/网络/Docker），把缺包与版本冲突前移到构建机 | **入库** |
| `audit_debs_test.py` | 上面那个工具的回归用例（`python3 installer/build/audit_debs_test.py`，12 条） | **入库** |
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
| 9 | 收尾清理只删 `.stage.*/`，漏了 `.stage.*.payload.tar.gz` | 产物完全正确，但每次打包静默泄漏 ~150MB | 清理对象成对清（`lib/stage-cleanup.sh`，用例第 7 条守着）；判据是 `dist/installer/` 里出现 `.stage.*` 就算没清干净 |
| 10 | 「确定性打包」说得比实际强 | 同输入两次构建 `sha256` 不同，一度怀疑载荷漂移 | `manifest.json` 里有 `built_at` 与 `builder`（含 hostname）。要逐字节复现就传 `SOURCE_DATE_EPOCH` 并同一台机器；否则别把 sha 不同当异常 |

## 闭包自洽性审计（`audit-debs.py`）

`fetch-docker-debs.sh` 抓回来的是「apt 认为该下的一堆包」，**它不证明这批包凑起来能装得上**。
真机上已经因此炸过两次，而且现象都出现在很远的地方：

| 事件 | 现象 | 真实原因 |
|---|---|---|
| `libseccomp2` 缺席 | docker-ce 装上了，dockerd 起不来 | 构建机已装过该包 → apt 认为依赖满足 → 不下载 |
| `python3-minimal` Pre-Depends | 整步 `S3_DOCKER` FAIL | `python3.10-minimal` 就在同一批参数里，但字典序排后面，被 dpkg 判「未安装」 |

这两类问题的共同点是「闭包不自洽，但报错点离根因很远」。`audit-debs.py` 把它们前移到构建机：

```bash
# 只读核对，不需要 dpkg、不需要联网、不需要 Docker
python3 installer/build/audit-debs.py --dir installer/build/payload/ubuntu-debian/jammy/debs

# 顺带产出机器可读报告（供 CI / 出包脚本消费）
python3 installer/build/audit-debs.py --dir <debs> --json /tmp/closure.json
python3 installer/build/audit_debs_test.py     # 12 条回归用例，改判定口径后必跑
```

它自己解析 `.deb`（ar 归档 → `control.tar.*` → `./control`），等价于 `dpkg-deb -I`，判定分三档：

- **ERROR**（必须修，退出码 1）：闭包**内部**矛盾——依赖在闭包里点名了但版本不满足、
  同名包出现两次、`DEBS-MANIFEST.txt` 多登记/少登记/哈希不符。这些到真机必然炸。
- **EXTERNAL**（正常，只登记）：依赖不在闭包里，只能由目标系统（`ubuntu:22.04` 基础系统）
  提供。闭包本来就只补「基础系统没有的那部分」，这一档是**清单**，不是失败——
  它的用途是让人一眼看出「我们在依赖目标系统的什么」，出了事有据可查。
- **OK**：闭包内满足，版本也满足（含 `Provides` 虚拟包与 `a | b` 或关系）。

实测（85 个包 / 147,491,640 字节 .deb）：`IS_PASS: YES`，闭包外依赖 53 项，全部是
`libc6`/`libssl3`/`dpkg`/`debconf` 这类基础系统的核心件。

> 一个容易被误读的数字：目录 `du -sb` 是 147,505,075，而 `.deb` 之和是 147,491,640，
> 差 13,435 字节 = `DEBS-MANIFEST.txt` 本身。两个数都对，别当成「载荷少了一截」。

> **zstd 依赖**：Ubuntu 21.10 起 `.deb` 的 `control.tar` 与 `data.tar` 默认用 zstd 压缩，
> 而 Python 3.13 的 `tarfile` 还不认 zstd（`r:*` 只覆盖 gz/bz2/xz）。工具会按魔数分派，
> 缺能力时提示 `pip install zstandard`（或装 `zstd` 命令），并明确写「这是环境缺能力，
> 不是闭包坏」——否则很容易被误判成「.deb 损坏」而去重新抓包。

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

### 构建机运行环境问题：gpg 卡在锁死循环（**不是产品缺陷**）

2026-11-09 在构建机上实际撞到，现象很吓人但定性清楚：**这是这台机器的运行环境坏了，
不是签名链路、不是密钥、更不是包的问题。**

**现象**

```text
gpg: removing stale lockfile (created by 1942)
gpg: removing stale lockfile (created by 1942)
…（同一行无限重复，进程永不返回）
```

表现为 `make-manifest.sh` 在签名那一步**永久挂住**（不是 pinentry 等口令），
或者直接以 `gpg 签名失败（用了 --gpg-key 0A038555B153ACC9）` 退出。
连带副作用：回收站里堆了上千个 `pubring.kbx.lock`。

**根因（两层叠在一起）**

1. `~/.gnupg/` 里残留了上次异常退出时的 `S.gpg-agent*`（0 字节，`mv` 报
   `Device or resource busy`，`rm` 也删不掉——AF_UNIX socket 残留，没有进程持有它）。
   于是新起的 `gpg-agent` 起不来：`error running '/usr/bin/gpg-agent': exit status 2`。
2. gpg 建了自己的锁文件后**判断该锁已过期**（判活失败），去删又删不掉，于是删→建→删
   无限循环。所以看到的「removing stale lockfile」里那个 pid 往往是**它自己**。

**绕过（已批准作为标准做法记录在此，不进任何脚本）**

```bash
# 1) 把钥匙圈复制到一个隔离的 GNUPGHOME（不要改动 ~/.gnupg）
mkdir -p /e/tmp/gnupg-build && chmod 700 /e/tmp/gnupg-build
cp -a ~/.gnupg/pubring.kbx ~/.gnupg/trustdb.gpg /e/tmp/gnupg-build/
cp -a ~/.gnupg/private-keys-v1.d /e/tmp/gnupg-build/

# 2) 在该副本里写 gpg.conf，只对这份副本关掉钥匙圈加锁
printf 'lock-never\n' > /e/tmp/gnupg-build/gpg.conf

# 3) 打包时用环境变量指向它（仓库脚本一行都不用改）
GNUPGHOME=/e/tmp/gnupg-build bash installer/build/build-server-package.sh \
  --variant ubuntu-debian --codename jammy --sign --gpg-key 0A038555B153ACC9 …
```

验证绕过是否成功的最小命令（不碰仓库）：

```bash
echo probe > /tmp/p.txt
GNUPGHOME=/e/tmp/gnupg-build gpg --batch --no-tty --yes \
  --local-user 0A038555B153ACC9 --detach-sign --armor -o /tmp/p.asc /tmp/p.txt && wc -c /tmp/p.asc
```

**根治**：重启机器清掉那些 AF_UNIX 残留，重启后确认
`ls -la ~/.gnupg/S.gpg-agent*` 是**随 agent 启动正常生成**的（有 socket，不是 0 字节旧文件）。

**硬约束（写死，别绕过）**

- **`lock-never` 只允许出现在上面那个隔离副本的 `gpg.conf` 里**：
  严禁写进入库脚本、严禁写进默认 `~/.gnupg`、严禁作为命令行参数固化到流水线。
  它放弃的是钥匙圈写保护——只对「单用户、串行签名」的构建机可接受。
- **无论用哪种方式签名，签名后的指纹核验一步都不能省**：
  `gpg --verify SHA256SUMS.asc SHA256SUMS.txt` + `gpg --fingerprint` 与
  `pubkeys/tianji-build.fingerprint.txt` 逐字比对。绕过的是本机的锁 bug，不是验收环节。

### 构建机环境问题：safe-delete 守卫拦截收尾清理（同样**不是产品缺陷**）

与上面那条 gpg 并列，都是「构建机环境」而不是「产品」：

**现象**：本机构建机的 safe-delete 守卫会拦批量 `rm`
（`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] count=103`），
`build-server-package.sh` 的收尾清理因此不生效——**产物是好的，但每次打包泄漏 ~150MB**，
`dist/installer/` 一路涨到 2.0G（四个 `.stage.*` 目录）。

**脚本侧已改（本轮）**：收尾清理从 `rm -rf "${STAGE}"` 改成
`lib/stage-cleanup.sh` 里的 `stage_cleanup`——**容忍失败但必须喊得响**：

- **清理对象是两个**（实测只清目录会漏掉中间那个 ~150MB 的包）：
  `.stage.XXXXXX/`（组装暂存目录）与 `.stage.XXXXXX.payload.tar.gz`（中间 payload 压缩包，
  它必须落在暂存目录**外面**，否则 tar 会把自己读进去报 `file changed as we read it`）；
- 删不掉时打 `[package] WARN:`，逐项列出三样：**残留完整路径**、**残留大小**（`du -sh`）、
  以及明确话术「产物不受影响，但这些都是构建中间物，不是交付物，手工清理前不要把它们当交付物分发」；
- **退出码不受影响**：这句清理跑在 G1/G2/G3 全过、产物摘要已打印之后，退出码的语义
  必须是「产物是否可用」，不能因为删不掉临时目录就把一次成功构建改判为失败；
- 但**不许静默吞**（禁止 `|| true`）：`rm` 返回 0 而路径还在（守卫把删除变成 no-op）也算失败，
  因为「守卫拦截」和「真删失败（权限/占用）」在现场都值得知道。
- 用例：`bash installer/build/tests/stage-cleanup.test.sh`（7 条，含 stub 一个必然失败的 `rm`、
  一个「目录删得掉但 tgz 删不掉」的变参用例）。

**处置优先级**

1. **首选**：构建时 `--out` 指到专门的临时目录，打完整体丢弃，别让 stage 目录落在交付目录里。
2. **次选**：手工清理。判据——`dist/installer/` 只应保留最终 `.run` 与 `SHA256SUMS*`；
   **出现 `.stage.*` 就是没清干净**。
3. **兜底**：给守卫配白名单（需人工操作，脚本不做，避免把守卫当成可绕过的摆设）。

**教训**：这四个 stage 目录的泄漏发生在「磁盘刚写满瘫过一次」的机器上。
凡是有收尾清理的脚本，**清理失败必须可感知**——否则它在最不该静默的时候静默。

> 当前状态（team-lead 认可为准）：手工清理后 `dist/installer/` = 144M，
> 产物 sha256 复核一致。

## `smoke.sh` 的用法（包内/部署后，不再依赖「同级」）

`payload/common/scripts/smoke.sh` 与 `offline/smoke.sh` **逐字节相同**（G1 会拦不一致）。
它以前假设「脚本与 `docker-compose.offline.yml` 同级」，那在仓库 `offline/` 里成立、
在**包内布局里必然找不到**（脚本在 `common/scripts/`，compose 在 `common/compose/`）。
现在改为显式解析：

| 项 | 解析顺序 |
|---|---|
| compose | `$TIANJI_DEPLOY_ROOT` → 脚本同级（仓库 `offline/`）→ `/opt/tianji`（部署后）→ 脚本的 `../compose`（包内兜底） |
| `.env` | compose 同级 → compose 的上一级 → `/opt/tianji/.env` |
| 端口 | 从 `.env` 读 `API_EXPOSED_PORT` / `ES_EXPOSED_PORT`，缺省才回落 3000 / 9200 |

> **为什么把 `/opt/tianji` 排在 `../compose` 前面**：compose 里的卷路径是
> **相对 compose 文件所在目录**解析的。拿包内那份**模板** compose 去跑，卷会指到
> `/opt/tianji-installer/common/volumes`——一套全新的空卷，现象是「compose 起来了但数据全没了」。
> 部署后必须用部署根那份。

用法：

```bash
# 仓库内
bash offline/smoke.sh
# 部署后（脚本自己在 /opt/tianji 找到 compose 与 .env）
sudo bash /opt/tianji-installer/common/scripts/smoke.sh
# 部署根不在默认位置时
sudo TIANJI_DEPLOY_ROOT=/data/tianji bash smoke.sh
```

日志默认写到临时目录（包内 `scripts/` 可能是 root 0700，不该往里写文件），
可用 `SMOKE_LOG_DIR` 指定。

**权威顺序**：验收判据以**安装器内置的 Go 冒烟（`S9_SMOKE`）**为准——它不依赖
`curl` / `docker compose`，目标机不必装这两个工具。`smoke.sh` 是「安装器出问题时的
人工独立复核手段」，两者判据字符串必须保持同口径（有单测
`TestSmokeUsesSameTokensAsSmokeSh` 守着）。
