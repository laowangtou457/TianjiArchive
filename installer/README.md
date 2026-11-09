# installer/ · 服务器端安装包构建手册

本目录是 `docs/INSTALLER-DESIGN.md` 的实现落点。**只放构建机侧代码与载荷模板**，
服务器端运行期逻辑在 `server/`（Go 静态二进制），用户端在 `client-lite/`。

> 状态（本轮）：`build/` 与 `server/` 两侧均已打通，**真载荷、真签名、真体积的包已经出来了**。
> `server/` 为 16 个 Go 文件 / 10 个测试文件，`go test ./...` **71 pass / 3 skip（Windows
> 无 `sh` 的三个用例）**，`gofmt -l` 与 `go vet` 均干净；交叉编译产物
> `GOOS=linux GOARCH=amd64 CGO_ENABLED=0` = 6,344,856 字节。
> 真实安装包 = 150,088,493 字节（含 85 个真 `.deb` / 147,505,075 字节闭包），G1/G2/G3 全绿，
> `SHA256SUMS.asc` 已签。
> 安装器本体在 `ubuntu:22.04` 容器内跑到过 `S3_DOCKER` 完成（真 dpkg 装真闭包 + 真 dockerd 起来），
> 第 ③ 步「特权 systemd 容器十步端到端」**在 S4 因构建机磁盘写满而中断**，未跑完，
> 详见文末「仍然没验证的事」第 1 条——不打包成「已通过」。

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

## 本轮验证结果（可复现）

### 1. Go 侧

```text
gofmt -l .            → 空
go vet ./...          → 空
go test ./...         → 11 个包全绿，71 pass / 3 skip（Windows 无 sh）
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

### 2. 交叉编译与打包（真载荷）

```text
binary  : 6,344,856 字节（ELF64 / e_machine=0x3e / CGO_ENABLED=0）
deb 闭包 : 85 个 .deb / 147,505,075 字节
           docker-ce 5:29.9.3-1~ubuntu.22.04~jammy
           docker-ce-cli 5:29.9.3 · containerd.io 2.4.2-3
           docker-compose-plugin 5.7.0-1 · libseccomp2 2.5.3-2ubuntu3~22.04.1
package : tianji-server-setup-ubuntu-debian-amd64-1.0.0.run
          150,088,493 字节
          sha256 85478f08b5d42d8120a7262015762cd04cfb1844c51f42dac3af79d6a834c138
          payload sha256 e1380de63e484535eae9d5f07da5496e46b7ccf85bf1eed702cff0ebf916c1e0
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

### 4. 特权 systemd 容器内的十步端到端（本轮，**未跑完**）

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
| S1_PREFLIGHT | **DONE** | OS 识别 `Ubuntu 22.04.5 LTS` → `osMatch.level=exact`；`vm.max_map_count=262144`；磁盘 1007GB |
| S2_VERIFY | **DONE** | `IS_PASS: YES —— 载荷与镜像 tar 校验全部通过`，真 1.5GB tar **12.8s** |
| S3_DOCKER | **DONE**（修 bug 后才通） | `client=29.9.3 server=29.9.3`、`driver=vfs cgroup=2`、`systemctl is-active docker=active` |
| S4_IMAGES | **未完成** | 镜像 tar sha256 校验通过，`docker load` 成功载入 **7/8** 个镜像（缺 `tianji-archive-extractor:1.0.0`）后构建机磁盘写满 |
| S5–S10 | **未验证** | compose up / migrate / seed / 四项冒烟 全部没跑到 |

**中断原因（如实登记，不是「通过」）**：vfs 驱动对镜像每一层做完整复制，1.5GB tar 展开后
把 Docker Desktop 的 ext4 虚拟盘（`docker_data.vhdx`，45.3GB，位于只有 199GB 的 C 盘）
撑满，daemon 随即报 `read-only file system`、容器 fs 变只读、Docker Desktop 起不来。
恢复需要人工退出 Docker Desktop → 腾空间 → `Clean/Purge data` → 重启（这些操作需要 GUI
或提权，构建机当前 `isAdmin=False` 且 `wsl.exe`/`com.docker.service` 被策略拦）。

**结论**：第 ③ 步只能记作「**特权 systemd 容器内分段验证，未跑完整十步**」。
已证明的是 S1–S3 在真 OS 基线 + 真 deb 闭包 + 真 dockerd 下成立；
**S4 之后（compose up / migrate / seed / 四项冒烟）仍未在真实栈上验证过**。

顺带一个必须写下来的负面经验：**别在这类「外层 Docker Desktop」的机器上用 vfs 跑嵌套
dockerd 加载 GB 级镜像**。要么给虚拟盘留足空间并换 overlay2（需要非 overlay 的 backing fs），
要么直接在真 VM / 独立机器上做——这本身就是「容器降级方案」的固有代价。

## 仍然没验证的事（如实登记，不打包成「已通过」）

1. **十步端到端（S4 之后）**：`S4_IMAGES` 只载入 7/8 个镜像就被构建机磁盘占满打断，
   `S5_ENV → S6_UP → S7_MIGRATE → S8_SEED → S9_SMOKE` **一次都没在真栈上跑过**。
   单测覆盖了逻辑（`TestSmokeUsesSameTokensAsSmokeSh` 用 httptest 复刻 `/api/health`
   与 `_analyze` 响应形状），但「8 个容器真起来、迁移真跑、四项冒烟真绿」仍属未验证。
   需要一个真 VM（Ubuntu 22.04 / 4C8G / 120G，dockerd 用 overlay2）或磁盘充裕的机器。
2. **真机安装（ISO 装系统后跑 `--tui` 十步）**：构建机无虚拟化工具，这一层完全没做。
   注意真机与容器有三处硬差异：真 systemd（无 `--cgroupns host` 这类妥协）、
   cgroup v1 hybrid（Ubuntu 22.04 默认，Docker 28+ 已标记 deprecated → 我们钉 29.9.3 需现场确认）、
   AppArmor 策略真生效（容器里基本是关的）。
3. **变体 B（static）端到端**：载荷已抓到并验过静态性（`ldd` 全部 not a dynamic executable）、
   二进制在容器里能起 27.5.1 + compose v2.29.7，但 `installStatic` 的 `systemctl` 分支
   没有 systemd 可用，**未在麒麟/UOS 上装过**。基线已从 ISO 离线取证，见
   `docs/VARIANT-B-OS-BASELINE.md`；真机六项预检（kysec/SELinux/overlay2/cgroup/firewalld/CA）仍等真机。
4. **18080 端口冲突回退（18081/18082）**：代码已实现，未在容器里制造占用验证。
5. **`--sign` 的现场侧闭环**：包已签、公钥已入库，但「现场拿公钥验签名」这条流程
   只在构建机上跑过，没有第二个人照 README 独立走过一遍。签名链路的价值全靠这一步。
