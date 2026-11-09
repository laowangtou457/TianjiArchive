# installer/ · 服务器端安装包构建手册

本目录是 `docs/INSTALLER-DESIGN.md` 的实现落点。**只放构建机侧代码与载荷模板**，
服务器端运行期逻辑在 `server/`（Go 静态二进制），用户端在 `client-lite/`。

> 状态（本轮）：`build/` 与 `server/` 两侧均已打通，**真载荷、真签名、真体积的包已经出来了**。
> `server/` 为 16 个 Go 文件 / 10 个测试文件，`go test ./...` **85 pass / 3 skip（Windows
> 无 `sh` 的三个用例）**，`gofmt -l` 与 `go vet` 均干净；交叉编译产物
> `GOOS=linux GOARCH=amd64 CGO_ENABLED=0` = 6,385,816 字节。
> 真实安装包 = 150,107,053 字节（含 85 个真 `.deb` / 147,505,075 字节闭包），G1/G2/G3 全绿，
> `SHA256SUMS.asc` 已签，sha256 = `c7fe6a1175cd83b97895ede04842f5759f784b6ce370e8e31266afbe97fe9b88`。
> **第 ③ 步「特权 systemd 容器十步端到端」已跑通 S1→S10 全 DONE**（8/8 容器 healthy、
> 迁移执行、种子完成、四项冒烟 4/4 PASS）；真机（含变体 B 麒麟/UOS）仍由 vm-harness 覆盖，
> 容器不能替代真机，见文末「仍然没验证的事」。

## 目录

```text
installer/
├── build/                          # 构建机侧（可以联网）
│   ├── fetch-docker-debs.sh        # 变体 A：抓 docker-ce 的 .deb 闭包
│   ├── fetch-docker-static.sh      # 变体 B：抓 docker static tgz + compose v2
│   ├── build-server-package.sh     # 主打包脚本，产出 .run（三道 fail-closed 闸门）
│   ├── make-manifest.sh            # manifest.json（含 files[] 与 image_count）+ SHA256SUMS + 签名
│   ├── selfextract/header.sh.in    # .run 的自解压头模板（POSIX sh）
│   ├── pubkeys/tianji-build.asc    # 构建密钥公钥 + 指纹（现场核验用；私钥不入库）
│   ├── README.md                   # 本目录的职责/坑/签名核验（改脚本前先读）
│   └── payload/
│       ├── common/
│       │   ├── compose/docker-compose.offline.yml
│       │   ├── scripts/{load-images,save-images,smoke}.sh
│       │   ├── scripts/images.txt              # 镜像清单（安装器按它逐个 inspect）
│       │   ├── seaweedfs/{entrypoint.sh,s3.json.tpl}
│       │   └── sysctl/{99-tianji.conf,99-tianji-limits.conf}
│       ├── ubuntu-debian/<codename>/debs/*.deb # 变体 A 载荷（不入库）
│       └── kylin-uos/docker-static/*.tgz       # 变体 B 载荷（不入库）
├── server/                         # 安装器本体（Go，静态二进制，禁出网）
│   ├── go.mod                      # 模块 tianji-archive/installer，仅 stdlib
│   ├── cmd/tianji-installer/       # main.go / flow.go / web.go / tui.go
│   ├── internal/
│   │   ├── execx/                  # 统一的子进程执行（捕获+旁路日志+退出码）
│   │   ├── buildplan/              # manifest 解析 / 路径布局 / OS 匹配 / 载荷校验
│   │   ├── preflight/              # K1~K13 逐条实测
│   │   ├── dockerinstall/          # deb 与 static 两条安装路径 + sysctl 落盘与回读
│   │   ├── images/                 # tar 溯源 + docker load + 8/8 inspect
│   │   ├── envfile/                # .env 渲染（禁静默覆盖）
│   │   ├── stack/                  # compose up / health / migrate / seed / 四项冒烟
│   │   ├── state/                  # state.json 状态机 + 断点重入
│   │   ├── selfclean/              # 端口释放 + 临时目录清理（defer 与信号双路）
│   │   └── audit/                  # append-only 日志 + 凭据打码
│   └── web/                        # embed.FS 前端（原生 HTML/JS/CSS，无 CDN）
├── e2e/                            # 特权 systemd 容器内十步端到端（降级验证途径，非真机）
│   ├── Dockerfile                  # ubuntu:22.04 + systemd（官方镜像没有 /lib/systemd/systemd）
│   ├── poll.sh                     # POSIX sh 读 /api/status 打印十步进度
│   └── README.md                   # 跑法、容器适配项、磁盘陷阱（vfs 会吃盘）与边界声明
└── client-lite/                    # 用户端一键配置器与自检（已完成，e4d4adb）
```

## 构建命令（均在仓库根执行）

```bash
# 先确认工具链（本机实测：E:\tools\go\bin\go.exe，go1.22.10 windows/amd64）
export PATH="/e/tools/go/bin:$PATH"
export GOPROXY=https://goproxy.cn,direct

cd installer/server && gofmt -l . && go vet ./... && go test ./... && cd ../..

# 变体 A（Ubuntu 22.04 jammy / 24.04 noble、Debian 12 bookworm）
bash installer/build/fetch-docker-debs.sh --codename jammy --pin-version
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags '-s -w -X main.version=1.0.0' \
  -o installer/server/dist/tianji-installer ./installer/server/cmd/tianji-installer
bash installer/build/build-server-package.sh --variant ubuntu-debian --codename jammy \
  --images-tar offline/tianji-offline-images.tar \
  --sign --gpg-key 0AD2912CF8FE57E202C275F20A038555B153ACC9

# 变体 B（麒麟 V10 / 统信 UOS）
bash installer/build/fetch-docker-static.sh
bash installer/build/build-server-package.sh --variant kylin-uos \
  --images-tar offline/tianji-offline-images.tar \
  --sign --gpg-key 0AD2912CF8FE57E202C275F20A038555B153ACC9

# 只重算清单与签名
bash installer/build/make-manifest.sh --dir <staging> --variant ubuntu-debian --sign
```

> `--gpg-key` 建议**总是显式给**：构建机上通常还有开发用密钥，靠「默认密钥」会在换机器时
> 静默签到另一把钥匙上，现场拿公钥一验就对不上，而错因会指向「包被篡改」这个完全错误的方向。
>
> `go build` 必须在 `installer/server`（Go 模块目录）里执行；在仓库根执行
> `go build ./installer/server/...` 会报 `cannot find main module`。
>
> 抓闭包只需要**直连**，不要设 `HTTP(S)_PROXY`（实测设了反而被中间设备掐 TLS：
> `curl: (35) error:0A000126:SSL routines::unexpected eof while reading`）；
> 镜像源抖动时用 `--docker-base https://mirrors.aliyun.com/docker-ce/linux/ubuntu` 换源，
> 换源不降低安全性——摘要才是可信锚点。

产物落在 `dist/installer/`（不入库），与 `offline/tianji-offline-images.tar`
**分离分发**（设计 §7.1），交付时必须同目录。

### 构建机取基础镜像的老经验（团队要求入库）

本机 Docker 直连 `registry-1.docker.io` 不稳，镜像要这样拿：

```bash
docker pull docker.1ms.run/library/ubuntu:22.04
docker tag  docker.1ms.run/library/ubuntu:22.04 ubuntu:22.04
```

换成其他基础镜像同理（把 `library/<name>` 替换掉）。这条只影响**构建机**，
与「部署现场无公网」的硬约束无关——`installer/server/` 里没有任何出网调用。

## 三道 fail-closed 闸门（过不了就退出，不产出半成品）

| 闸门 | 内容 | 失败即 |
|---|---|---|
| **G1 载荷同源** | `payload/common/` 下 **7** 个文件与 `offline/`、`infra/` 的源 `cmp` 逐字节相同 | 退出，提示「用 cp 整体覆盖，不要挑行合并」 |
| **G2 二进制形态** | 安装器必须是 ELF64 **x86-64**（校验魔数 + `e_machine=0x3e`） | 退出，附交叉编译命令 |
| **G3 自解压可用性** | 产出后立刻 `TIANJI_VERIFY_SHELL_ONLY=1 sh <run> --verify-only` | 退出并**删除**不完整产物 |

`--images-tar` 若同时存在 `offline/SHA256SUMS`，会强制两者 sha256 **逐字一致**
（设计 §2.2「必须同源，不允许安装器自己算一遍就当真」）。

## 安装器：三前端共享一套逻辑（设计 §3.1 的落法）

```text
tianji-installer [--web]      本机临时 Web 向导，绑 127.0.0.1:18080（占用则 18081/18082）
tianji-installer --tui        终端向导（无第二台机器时的降级入口）
tianji-installer --resume     从 state.json 断点继续跑到完成
tianji-installer --verify-only 只校验包完整性（L-a 逐文件 + 镜像 tar 溯源）
tianji-installer --uninstall [--purge-volumes]
```

三个前端都只调 `session.RunStep(step)`，**没有第二套安装逻辑**；顺序、幂等、
「只有 PASS 才写 DONE」全部由 `internal/state` 保证。

Web 安全边界（设计 §3.3）：默认只绑回环；`--listen` 到非回环地址时**强制**生成
32 字节一次性 token（URL 携带）并校验 `Origin` 与 `Host` 同源，无 token 一律 403。

## 实现决定与偏离（理由都写在代码注释里）

1. **`.env.tpl` 改为构建期派生**，不再作为提交入库的载荷文件（设计 §2.1 原写法）。
   派生源是 `.env.example`，好处是不存在「源改了、模板忘了改」的静默漂移。
2. **`S3_PUBLIC_ENDPOINT` 从注释里放出来并占位化**。`.env.example` 里这三项是注释
   掉的占位符（刻意不代拍板 IP），但离线 compose 用 `${S3_PUBLIC_ENDPOINT:-127.0.0.1}`
   兜底——默认回环地址会让局域网浏览器拿到指向 `127.0.0.1:8333` 的预签名 URL，
   症状正是「能登录、能检索、一上传就失败」（设计风险 **R9**，红色高风险）。
   向导把这一项做成**必填且拒绝 127.0.0.1/localhost**，与 `client-lite` 的 8333
   自检判据前后呼应。
3. **`limits.d` 配置并列放在 `sysctl/` 下**（`99-tianji-limits.conf`）。设计 §2.1 只
   列了 `sysctl/99-tianji.conf`，但 §4.5 的 K6/K7 要求 memlock/nofile，落盘位置是
   `/etc/security/limits.d/`。
4. **`PAYLOAD_OFFSET` 定宽 10 位 + 剥前导零**。定宽保证替换前后头部字节数不变
   （offset 才准）；剥前导零是因为 POSIX sh 的算术展开把带前导 0 的数字当**八进制**
   解析，实测会算错一个字节导致 sha256 恒失败。
5. **Go 包目录取名 `internal/buildplan/`**（team-lead 裁定）。顶层 `installer/build/`
   保持设计原名给构建机脚本；`buildplan` 表示「安装计划」，职责是读 manifest、
   给出落盘布局、判定 OS 与变体是否匹配、逐文件复核 sha256。
6. **`images.txt` 加进 `payload/common/scripts/` 与 G1 清单**。安装器 `S4_IMAGES`
   要按清单逐个 `docker inspect`（8/8），载荷里没有这份清单就无从核对；同时它必须
   与 `offline/images.txt` 逐字节同源，否则「构建机 save 的 8 个」与「现场 inspect
   的 8 个」可能是两份不同的清单。
7. **`manifest.json` 补 `files[]` 与 `images_tar.image_count`**。设计 §2.2 要求
   `files[]`，它是安装器逐文件深度校验（§4.4 L-a）的唯一依据；`image_count` 用来
   交叉核对「清单条数 vs manifest」，两边不一致说明包被人换过。此前 `make-manifest.sh`
   两个字段都没写，安装器 `Validate()` 直接拒绝启动——是容器内实测暴露的真 bug。
8. **`--verify-only` 分两层**：非 root 只做壳层 payload sha256；以 root 运行则继续
   解包，由安装器按 `manifest.json` 复核每个载荷文件 + 镜像 tar。构建机 G3 闸门用
   `TIANJI_VERIFY_SHELL_ONLY=1` 显式只跑壳层，避免在 CI 里往 `/opt` 写东西。
9. **`--verify-only` 不消耗状态机**（`session.persist=false`）。否则「先校验包、再正式
   安装」会让 `S2_VERIFY` 被标成 DONE 而跳过——等于把完整性校验静默关掉。
10. **K9/K10 按十进制 GB 换算**。磁盘与内存都是十进制标注的（16GB 机器的
    `MemTotal` 是 16384000 kB），按 GiB 相除会得 15，把足量机器误判成 WARN；这类
    假警报会直接让现场操作员不信任安装器的判定。
11. **`DEBS-MANIFEST.txt` 兼容 `hash *name`**。GNU coreutils 的二进制模式（`sha256sum -b`
    或 Git Bash 默认）会在文件名前加 `*`，不认就会报「哈希明明相同却未登记」。
12. **`dpkg -i` 允许补装一轮**。实测（85 个真 deb，特权 systemd 容器）：单次 `dpkg -i`
    按**参数顺序**逐个检查 Pre-Depends，`python3-minimal` 的 Pre-Depends 是
    `python3.10-minimal`，而字典序把它排在前面 → 报「`python3.10-minimal` is not installed」，
    连带 `networkd-dispatcher`/`python3-dbus`/`python3-gi` 失败，整步 S3 判 FAIL。
    可那个包就在同一批参数里，只是还没轮到解包。修法：第 1 轮失败 → `dpkg --configure -a`
    → 补装第 2 轮，两轮都失败才判失败。**仍然不自动 `--force-depends`**：
    那会把「依赖真不满足」降级成「装上了但起不来」，现场更难查。
13. **`--resume` 从 `.env` 读回表单值**。`--resume` 此前只是 usage 里写了、`main` 的
    switch 没有分支（实际落 `--web`，等于文档骗人）；接上之后还有个坑：重入时 8 项凭据
    是空的，用户得为已填过的表单再抄一遍，且 `S10` 汇总的访问地址取自
    `values.Endpoint`，读不回来会印出 `http://:8080`——「装完了但地址是空的」比报错更吓人。
    因此启动时从 `<部署根>/.env` 读回，且要求 8 个占位键**全部非空**才认：
    半份值渲染出的 `.env` 会让容器起来但一连 Redis 就认证失败。
14. **签名产物名用 `SHA256SUMS.asc`（armor 分离签名）**，不是 `.sig`。二进制签名现场
    贴不进工单/邮件，armor 文本可以直接比对；配合 `gpg --verify SHA256SUMS.asc SHA256SUMS.txt`
    加指纹比对，构成 L-b 层可执行的最小核验流程（见 `build/README.md`）。
15. **`fetch-docker-*.sh` 里禁止 `… | awk '{print $2; exit}'` 与 `… | grep -q`**。
    上游命令吃 SIGPIPE（141）后，`set -o pipefail` 判整条失败，`set -e` 又让脚本静默退出——
    现象是「刚打印抓到 N 个 deb 就退出，既不报错也不生成清单」，只能靠 `bash -x` 定位。
    统一改 `awk '…' | sed -n '1p'` 与 `[ -n "$(find … -print -quit)" ]`。
16. **卷目录属主由安装器按「容器内 uid」分派，不靠镜像自己 chown**。
    bind mount 不改宿主目录属主，容器里看到的就是宿主上的数字 uid。多数镜像以 root 启动后
    自己 chown（实测 `postgres:16-alpine` → 70、`redis:7-alpine` → 999），但**以非 root
    直接启动的镜像不做**：`elasticsearch:8.13.4` 的 `USER` 是 `uid=1000`，属主给成
    `root:root 0750` 就报
    `failed to obtain node locks … Suppressed: AccessDeniedException: .../node.lock`——
    这句话一个字都不提属主，现场会去查磁盘满 / 并发 / 锁残留。
    因此 `prepareDeployRoot` 内置 `volumeOwners` 表：`esdata → 1000:1000`、
    `wal_archive → 70:70`（后者错不会让 postgres 起不来，只会让 WAL 归档静默失败）。
    表里只登记「必须由安装器给属主」的卷；其余交给镜像 entrypoint，避免与镜像未来版本打架。
    chown 失败只 WARN 不中断（NFS/CIFS 上会被拒而 runc 仍能起来），但必须把后果写进输出。
17. **变体 B 六项预检只探测不处置，且只对 `kylin-uos` 生效**。核定过的三条边界：
    ① `setstatus -t` / `setenforce 0` / `systemctl disable firewalld` 一概不写进代码——
    这些改的是现场安全策略，必须由人签认，工具不能替人决定；
    ② 「探测失败」与「确认关闭」在数据结构上就分开（`Facts["kysec"]=probe-failed` vs `disabled`），
    不允许把失败折叠成放行；
    ③ SELinux 只认 `getenforce`，绝不读 `/etc/selinux/config`——麒麟实测该文件写 enforcing
    而实际 Disabled，按文件判断会误报并触发不必要的处置。
    另外变体 A 的 K1–K13 一项不掺，避免把「Ubuntu 上跑通的东西」和「麒麟上要判的东西」混成一张表。

## 本轮验证结果（可复现）

### 1. Go 侧

```text
gofmt -l .            → 空
go vet ./...          → 空
go test ./...         → 11 个包全绿，85 pass / 3 skip（Windows 无 sh）
```

关键回归用例（都指向真实踩过的坑）：

- `TestValidateRejectsMissingImagesSHA`：缺 `images_tar.sha256` 必须拒绝启动（§7.2）
- `TestLoadStopsBeforeLoadOnSHAMismatch`：sha256 不匹配时**不得**执行 `docker load`
- `TestCheckComposeVersionRejectsV1`：compose v1 必须硬拦，且错误里要说明原因
- `TestSmokeUsesSameTokensAsSmokeSh`：判据字符串与 `offline/smoke.sh` 完全同口径
- `TestRunIsIdempotent`：selfclean 在 defer 与信号两路都调用时不能互相干扰
- `TestVerifyDebManifestDetectsTamper`：能定位到具体被换掉的 deb 文件名
- `TestInstallDebsRetriesOnceOnPreDependsOrder`：Pre-Depends 顺序失败必须补装一轮，
  且两轮都失败才算失败（真机踩过，见实现决定 12）
- `TestLoadEnvValuesRejectsPartialEnv`：`--resume` 只认 8 个键全非空的 `.env`（实现决定 13）
- `TestPrepareDeployRootAssignsEsVolumeOwner`：卷目录属主必须是容器内 uid（esdata 1000:1000、
  wal_archive 70:70），否则 S6 以 `failed to obtain node locks` 失败（实现决定 16）
- `TestVolumeOwnersTargetsAreRealVolumeDirs`：属主表里的目录名必须在 `volumeDirs` 里，
  防「改了卷名但 chown 打在空气上」
- `TestPrepareDeployRootChownFailureIsWarnNotAbort`：chown 被拒只 WARN 不中断，但必须把
  「报错不会提属主」这个后果写进输出

### 2. 交叉编译与打包（真载荷）

```text
binary  : 6,385,816 字节（ELF64 / e_machine=0x3e / CGO_ENABLED=0）
deb 闭包 : 85 个 .deb / 147,505,075 字节
           docker-ce 5:29.9.3-1~ubuntu.22.04~jammy
           docker-ce-cli 5:29.9.3 · containerd.io 2.4.2-3
           docker-compose-plugin 5.7.0-1 · libseccomp2 2.5.3-2ubuntu3~22.04.1
package : tianji-server-setup-ubuntu-debian-amd64-1.0.0.run
          150,107,053 字节
          sha256 c7fe6a1175cd83b97895ede04842f5759f784b6ce370e8e31266afbe97fe9b88
          payload sha256 013b093359b193a554a160863e7e0b622204baefe31c67c42b19c93f38145741
闸门    : G1 7/7 逐字节一致 · G2 ELF64/amd64 · G3 壳层校验 PASS
签名    : SHA256SUMS.asc（gpg armor 分离签名，key 0A038555B153ACC9）
```

> 与设计 §9.1 的 ≈130MB 估算同一量级（实测 150MB，其中 147.5MB 是 deb 闭包）。
> 包内 `manifest.json`：`file_count=98`、`images_tar.image_count=8`，镜像 tar sha256 与
> `offline/SHA256SUMS` 记录**逐字一致**。
>
> 签名密钥：`tianji-build`，RSA4096，有效期至 **2027-11-09**，指纹
> `0AD2 912C F8FE 57E2 02C2 75F2 0A03 8555 B153 ACC9`。**私钥只在构建机 `~/.gnupg`，
> 不入库**；入库的只有 `installer/build/pubkeys/tianji-build.asc` 与指纹文件。
> 现场核验：`gpg --import pubkeys/tianji-build.asc` → `gpg --fingerprint 0A038555B153ACC9`
> （指纹必须逐字一致，不一致即停：说明公钥本身被换过）→
> `gpg --verify SHA256SUMS.asc SHA256SUMS.txt` → `sha256sum -c SHA256SUMS.txt`。
>
> **这条流程已在空钥匙圈上实测过一次**（模拟现场：`GNUPGHOME` 指向新建空目录，只 import
> 仓库里的公钥）：从 `.run` 截出 payload（sha256 `e1380de6…` 与构建日志一致）→ 解包
> 102 个文件 → 验签得到 `Good signature`、指纹 `0AD2 912C … B153 ACC9` →
> `sha256sum -c` **98/98 全 OK**。gpg 会照例提示
> `This key is not certified with a trusted signature`——这是裸公钥的正常提示，
> 正确做法是**比对指纹**而不是忽略它，README 里写的顺序就是这个意思。

### 3. `ubuntu:22.04` 容器内实测（真实目标环境，非模拟）

> 这一节的 A~F 是最早一轮（载荷还是**假 .deb**）跑出来的，判据与话术仍有效，保留作回归基线。

| # | 场景 | 结果 |
|---|---|---|
| A | `sh <run> --verify-only`（非 root 语义校核） | `壳层校验通过（仅 payload 完整性 sha256；未做逐文件深度校验与镜像校验——不代表可安装）`，退出码 0 |
| B | root 深度校验 + **真实 1.5GB 镜像 tar** | `IS_PASS: YES`，18/18 文件 + 镜像 tar 全通过，耗时 **18.5s** |
| C | root 深度校验但**不给镜像 tar** | `IS_PASS: NO`，18/18 仍全对，卡在 tar 并给出「放同目录 / 用 --images-tar」的可执行处置 |
| D | `--tui` 环境体检 | 13 PASS + 1 WARN（K13 AppArmor），`nextStep` 推进到 `S2_VERIFY` |
| E | `--web` + 原始 HTTP 调用 | `/api/status` 200 且 10 步齐全、无 token 的 loopback 模式可读；`/` 返回内嵌 index.html 且带 CSP；`POST /api/step` 正常执行；伪造 `Origin` → **403** |
| F | 篡改检测（上一批已验） | 向 `.run` 追加 1 字节 → `--verify-only` 退出码 1 |

容器内 K 值（`01-preflight.log` 原文，证明判据是实测而非空跑）：

```text
[K5]  PASS vm.max_map_count —— 262144（要求 ≥ 262144）
[K9]  PASS 磁盘可用空间 —— 1007 GB
[K10] PASS 内存 —— 32 GB
[K11] PASS dpkg 锁 —— 未被占用
```

### 4. 特权 systemd 容器内的十步端到端（本轮，**S1→S10 全 DONE**）

构建机没有虚拟化工具（`wsl.exe` 与 Hyper-V 均被策略拦、无 VirtualBox/VMware），
因此第 ③ 步按 team-lead 的降级口径做：特权 systemd 容器 + 嵌套 dockerd。

```bash
docker run -d --name tj-e2e --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v //e/TianjiArchive:/repo tianji-e2e-base:22.04 /lib/systemd/systemd
```

> `ubuntu:22.04` 官方镜像里**没有** `/lib/systemd/systemd`（只有 `libsystemd0`），
> 直接当 init 起会 `stat /lib/systemd/systemd: no such file or directory`；
> 必须先 `apt-get install systemd systemd-sysv dbus` 做一个派生镜像。
> 另外容器里 `dockerd` 只能用 `--storage-driver=vfs`（外层是 overlayfs），
> 且必须 `"iptables": false` —— 这两项是**容器适配**，真机不需要。

驱动方式：`--web` 起向导 → `POST /api/env` 填 8 项表单 → `POST /api/run-all`，
即真实前端路径（不是绕过 UI 直接调内部函数）。

| 步 | 结果 | 证据 |
|---|---|---|
| S1_PREFLIGHT | **DONE** | OS 识别 `Ubuntu 22.04.5 LTS` → `osMatch.level=exact`；`vm.max_map_count=262144` |
| S2_VERIFY | **DONE** | `IS_PASS: YES —— 载荷与镜像 tar 校验全部通过` |
| S3_DOCKER | **DONE**（修 bug 后才通） | `client=29.9.3 server=29.9.3`、`driver=vfs cgroup=2`、`systemctl is-active docker=active` |
| S4_IMAGES | **DONE** | **8/8** 镜像载入，`1m30s`；限额卷 `/dev/loop2 79G 40G 39G 51%` |
| S5_ENV | **DONE** | `.env` 渲染 + 卷属主两行（`esdata → 1000:1000`、`wal_archive → 70:70`）|
| S6_UP | **DONE**（修 bug 后才通） | `21.2s`，**8/8 容器 `state=running` 且 6 个带 healthcheck 的全 healthy** |
| S7_MIGRATE | **DONE** | `2.7s`，`typeorm_migrations` 逐条 `executed successfully` |
| S8_SEED | **DONE** | `1.8s`，示例机构 / 档号规则 / `admin` 账号 |
| S9_SMOKE | **DONE** | **4/4 PASS**：`/api/health status=ok 且 objectStorage.ok=true`、S3 九项探针 `IS_PASS: YES`、样品书籍全链路 `IS_PASS: YES`（6 册 / 12 文件 / 抽取 12-12 / 检索命中 6）、IK 切出「中华人民共和国」 |
| S10_DONE | **DONE** | `99-summary.txt` 输出访问地址与部署根；S5→S10 合计 **46s** |

> 上表是**冷启动**那一轮（容器全新建、ES 首次建索引，S5→S10 合计 46s）。
> 此后代码又有三次变动（`gofmt` 纯格式；变体 B 六项预检接入 S1；firewalld 结论按统信第二版
> 实测校正），二进制字节随之变化，交付件按最终源码**重打包**，并在最终产物
> （sha256 `c7fe6a11…`）上**复跑**了 S5→S10：仍全部 DONE，冒烟仍 4/4 PASS
> （容器已就绪，S6 只花 117ms，五步合计 11s；日志目录 `/var/log/tianji-install/20261109T153205Z/`）。
> 也就是说：**十步证据对应的是最终交付的那个包**，不是中间产物。
> S1–S4 的 DONE 记录来自最早那一轮（新增预检项只对变体 B 生效，变体 A 路径未改动）。

**本轮在真栈上抓到并修掉的缺陷（这是做这一层的价值）**

| 现象 | 根因 | 修法 |
|---|---|---|
| `S6_UP` 失败：ES 无限重启，日志 `failed to obtain node locks … AccessDeniedException: .../node.lock` | 安装器建的 `volumes/esdata` 是 `root:root 0750`，而 `elasticsearch:8.13.4` 以 **uid=1000** 启动且 entrypoint 不做 chown | `prepareDeployRoot` 新增 `volumeOwners` 表，按容器内 uid 分派（实现决定 16）；同类隐患 `wal_archive`（postgres uid=70 写归档）一并修 |

对照证据：修前 `docker inspect` 显示 `tianji-elasticsearch Restarting (1)`、`volumes/esdata` 为 `0:0`；
改属主后 20s 内 `healthy`。**报错文案一个字都没提属主**——这也是为什么必须在容器/真机上跑，
单测与 `--verify-only` 都不可能发现它。

**磁盘限额与放大倍数（本轮两次实测，都留了原始输出）**

`--storage-opt size=` 在 Docker Desktop 的 overlayfs 驱动上**被静默忽略**（命令成功、`df` 仍显示整盘
1006.9G），因此改用 loop + ext4 硬限额：

```sh
# 容器内（先自证：hostname / [ -f /.dockerenv ] / readlink -f /var/lib/docker）
truncate -s 80G /root/nested-docker.img && mkfs.ext4 -q -F -m 1 -L tj-nested /root/nested-docker.img
mount -o loop /root/nested-docker.img /var/lib/docker
dumpe2fs -h /dev/loop2 | grep -Ei 'block count|block size'   # 20971520 × 4096 = 80GiB
fallocate -l 200G /var/lib/docker/.probe                      # 期望 ENOSPC（实测 No space left on device）
```

| 轮次 | 载入情况 | 占盘 | 放大倍数 |
|---|---|---|---|
| 第一次（中断） | 7/8 镜像 | 22GB | **14.6 倍** |
| 第二次（本轮） | 8/8 镜像 | 40GB | **约 26 倍** |

tar 本体 1.51GB。**按 30 倍留盘**。详见 `installer/e2e/README.md`「磁盘陷阱」与
`offline/README.md` §8.3。

**结论**：第 ③ 步在「特权 systemd 容器 + 嵌套 dockerd（vfs）」这一降级环境下**十步全部跑通**，
并因此在真栈上抓到两个单测抓不到的缺陷（S3 的 Pre-Depends 顺序、S6 的卷属主）。
**它仍然不是真机验证**——差异见下一节第 2 条，该条仍由 vm-harness 覆盖。

### 5. 变体 B 六项 OS 基线探测（`internal/preflight/variantb.go`）

`docs/VARIANT-B-OS-BASELINE.md` §4.1–§4.6 写成了代码：`preflight.CheckVariantB`，
在 `S1_PREFLIGHT` 里**仅当变体为 `kylin-uos`** 时追加执行（变体 A 的检查项一项不动）。

| 项 | 探测 | 归一化判定 |
|---|---|---|
| B1 cgroup 版本 | `stat -fc %T /sys/fs/cgroup` | `tmpfs`=v1 / `cgroup2fs`=v2，**只记录不设阈值**；认不出 → WARN |
| B2 SELinux | `getenforce`（旁证 `/sys/fs/selinux/enforce`） | Disabled/Permissive → PASS；Enforcing 且 `rpm -q container-selinux` 查不到 → WARN；**绝不读 `/etc/selinux/config` 下结论**（麒麟实测该文件写 enforcing 而实际 Disabled） |
| B3 麒麟 kysec | `command -v getstatus` → `getstatus` → 解析 `KySec status:` 与 `exectl:` | 无工具且无 `/etc/kysec` → PASS「确认未启用」；**工具在但查询失败 → WARN「探测失败」**（不得当放行）；enforcing + exectl on → FAIL；有 `/etc/kysec` 但无工具 → WARN |
| B4 iptables 后端 | `iptables --version` + `command -v iptables-legacy / iptables-nft` | 只记录后端（nf_tables/legacy）；完全找不到 iptables → WARN |
| B5 overlay2 前置 | `uname -r` + `/proc/filesystems` + `modprobe overlay` + `stat -f -c %T <DataDir>` | 内核 <4.19 或 overlay 载不上 → WARN（会退回 vfs，放大 14~26 倍）；**xfs `ftype=1` 放到安装时在数据目录建好后查** |
| B6 firewalld | `firewall-cmd --state` | 未装 → N/A；在跑 → WARN。结论点明**统信实测的 ZONE_CONFLICT**（重启后再起 dockerd 直接失败，是 daemon 起不来而非端口不通）；处置「`disable --now` 或 `--iptables=false`」，并明确**否掉「加 trusted zone」**——那批实验（含 restart 后 SSH 失联）已由二分实验证伪为 QEMU slirp 环境假象 |

三条纪律写进代码注释也写进用例：

1. **只探测、不处置**。`setstatus -t` / `setenforce 0` / 停 firewalld 一个都不做——它们要现场签认；
2. **「探测失败」≠「确认关闭」**。kysec 守护没起时 `getstatus` 必然失败，按放行处理就是赌；
3. **命令不存在 / 命令超时 / 输出无法解析**三类必须产出可读结论（`describeRunErr` 区分），
   既不能 panic，也不能静默变成 PASS。

10 条用例全部用 `execx` 的 fake 形态（`stubRunner` 喂固定输出与错误），覆盖：
麒麟最小化基线全绿、`/etc/selinux/config` 说谎、Enforcing 无 container-selinux、
kysec 探测失败不当放行、enforcing+exectl on 判 FAIL、命令不存在、命令超时、输出无法解析、
非麒麟标 N/A、每项都留 Raw 与 Hint。


## 仍然没验证的事（如实登记，不打包成「已通过」）

1. **十步端到端只在容器里跑通过，真机仍未跑**：`S1→S10` 已在特权 systemd 容器 + 嵌套
   dockerd（vfs）下全部 DONE（见上一节），但那是「容器里的 ten-step」。
   真机要验的是另一批东西：真 systemd 的 unit 依赖与 restart 语义、cgroup v1 hybrid、
   AppArmor 真生效、overlay2（而非 vfs）下的磁盘与 inode 表现。
   需要一个真 VM（Ubuntu 22.04 / 4C8G / 120G，dockerd 用 overlay2）——由 vm-harness 覆盖。
2. **真机安装（ISO 装系统后跑 `--tui` 十步）**：构建机无虚拟化工具，这一层完全没做。
   注意真机与容器有三处硬差异：真 systemd（无 `--cgroupns host` 这类妥协）、
   cgroup v1 hybrid（Ubuntu 22.04 默认，Docker 28+ 已标记 deprecated → 我们钉 29.9.3 需现场确认）、
   AppArmor 策略真生效（容器里基本是关的）。
3. **变体 B（static）端到端**：载荷已抓到并验过静态性（`ldd` 全部 not a dynamic executable）、
   二进制在容器里能起 27.5.1 + compose v2.29.7，但 `installStatic` 的 `systemctl` 分支
   没有 systemd 可用，**未在麒麟/UOS 上装过**。基线已从 ISO 离线取证，见
   `docs/VARIANT-B-OS-BASELINE.md`。
   六项预检已写成 Go（见上一节第 5 小节）并有 10 条单测，但**这 10 条跑的是 fake 输出，
   不是真机**：vm-harness 用 shell 在麒麟 V10 SP3 真机上实测过这六项（结论已回写基线文档），
   Go 侧需要在真机上再复跑一次，才能说「代码与实测一致」。
4. **18080 端口冲突回退（18081/18082）**：**已意外验证通过**——本轮连开后忘了杀旧实例，
   三个安装器分别落在 18080 / 18081 / 18082，三个 `/api/status` 都返回 200。
   顺手留下一条教训（值得写进排查手册）：**`pkill -x tianji-installer` 杀不掉它**，
   进程名被截断成 `tianji-installe`，`pgrep -x` 同样匹配不到；只能按命令行匹配
   `pgrep -f "[/]opt/tianji-installer/bin/tianji-installer"`（方括号防止匹配到自己）。
   更隐蔽的是后果：旧实例还活着时，`POST /api/run-all` 会打到**旧进程**上，
   它拿着内存里的旧状态、看到全部 DONE，于是只跑 S10 就返回成功——
   看起来「复跑通过」，实际一步都没重跑（本轮就踩了一次，靠比对 `state.json` 里
   S6 的时间戳才发现）。**复跑前必须确认端口上没有别的实例。**
5. **`--sign` 的现场侧闭环**：包已签、公钥已入库，但「现场拿公钥验签名」这条流程
   只在构建机上跑过，没有第二个人照 README 独立走过一遍。签名链路的价值全靠这一步。
