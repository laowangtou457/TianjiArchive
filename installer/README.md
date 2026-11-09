# installer/ · 服务器端安装包构建手册

本目录是 `docs/INSTALLER-DESIGN.md` 的实现落点。**只放构建机侧代码与载荷模板**，
服务器端运行期逻辑在 `server/`（Go 静态二进制），用户端在 `client-lite/`。

> 状态（本轮）：`build/` 与 `server/` 两侧均已打通。
> `server/` 为 25 个 Go 文件 / 9 个测试文件，`go test ./...` **67 pass / 3 skip（Windows
> 无 `sh` 的三个用例）**，`gofmt -l` 与 `go vet` 均干净；交叉编译产物
> `GOOS=linux GOARCH=amd64 CGO_ENABLED=0` = 6,332,568 字节，真实 `.run` 已在
> `ubuntu:22.04` 容器内跑通「自解压 → 逐文件深度校验 → Web 向导 → 环境体检」。
> 未验证的部分见文末「仍然没验证的事」，逐条如实登记。

## 目录

```text
installer/
├── build/                          # 构建机侧（可以联网）
│   ├── fetch-docker-debs.sh        # 变体 A：抓 docker-ce 的 .deb 闭包
│   ├── fetch-docker-static.sh      # 变体 B：抓 docker static tgz + compose v2
│   ├── build-server-package.sh     # 主打包脚本，产出 .run（三道 fail-closed 闸门）
│   ├── make-manifest.sh            # manifest.json（含 files[] 与 image_count）+ SHA256SUMS + 签名
│   ├── selfextract/header.sh.in    # .run 的自解压头模板（POSIX sh）
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
  --images-tar offline/tianji-offline-images.tar --sign

# 变体 B（麒麟 V10 / 统信 UOS）
bash installer/build/fetch-docker-static.sh
bash installer/build/build-server-package.sh --variant kylin-uos \
  --images-tar offline/tianji-offline-images.tar --sign

# 只重算清单与签名
bash installer/build/make-manifest.sh --dir <staging> --variant ubuntu-debian --sign
```

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

## 本轮验证结果（可复现）

### 1. Go 侧

```text
gofmt -l .            → 空
go vet ./...          → 空
go test ./...         → 11 个包全绿，67 pass / 3 skip（Windows 无 sh）
```

关键回归用例（都指向真实踩过的坑）：

- `TestValidateRejectsMissingImagesSHA`：缺 `images_tar.sha256` 必须拒绝启动（§7.2）
- `TestLoadStopsBeforeLoadOnSHAMismatch`：sha256 不匹配时**不得**执行 `docker load`
- `TestCheckComposeVersionRejectsV1`：compose v1 必须硬拦，且错误里要说明原因
- `TestSmokeUsesSameTokensAsSmokeSh`：判据字符串与 `offline/smoke.sh` 完全同口径
- `TestRunIsIdempotent`：selfclean 在 defer 与信号两路都调用时不能互相干扰
- `TestVerifyDebManifestDetectsTamper`：能定位到具体被换掉的 deb 文件名

### 2. 交叉编译与打包

```text
binary  : 6,332,568 字节（ELF64 / e_machine=0x3e / CGO_ENABLED=0）
package : tianji-server-setup-ubuntu-debian-amd64-1.0.0.run
          2,744,690 字节
          sha256 fb7dd67de98adea5ba942bb8bdd6f9392f85935cabeade984c1bd62a6291f747
```

> 体积远小于设计 §9.1 的 ≈130MB 估算，因为**本地验证用的是假 `.deb`**（5 个几十字节
> 的占位文件）。真实包 = 本包 + 真实 deb 闭包（≈95MB）。体积结论在拿到真载荷后需复测。

包内 `manifest.json`：`file_count=18`、`files[]` 18 条、`images_tar.image_count=8`、
镜像 tar sha256 与 `offline/SHA256SUMS` 记录**逐字一致**。

### 3. `ubuntu:22.04` 容器内实测（真实目标环境，非模拟）

| # | 场景 | 结果 |
|---|---|---|
| A | `sh <run> --verify-only`（非 root 语义校核） | `PASS：安装包完整`，退出码 0 |
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

## 仍然没验证的事（如实登记，不打包成「已通过」）

1. **真 `.deb` 闭包的安装**：本机没有 `fetch-docker-debs.sh` 的出网条件，`dpkg -i`
   路径只跑了「载荷缺失即停」的负向用例。`fetch-docker-debs.sh` 需要构建机联网执行。
2. **变体 B（static）**：`docker-XX.tgz` 与 compose v2 单二进制未下载，`installStatic`
   只覆盖了「载荷缺失即停」；`systemctl` 分支在本机与容器都没有 systemd 可用。
3. **compose up / migrate / seed / 四项冒烟**：容器内无 systemd、无 dockerd，
   `docker` 客户端与 8 个镜像都不可用，故这四步是**分段验证**：逻辑由单测覆盖
   （`TestSmokeUsesSameTokensAsSmokeSh` 用 httptest 复刻了 `/api/health` 与 `_analyze`
   的真实响应形状），真实栈联动留待有 Docker 的构建机或现场首次安装。
4. **GPG 签名（L-b 层）**：`--sign` 需要 `gpg` 与密钥，未执行；`make-manifest.sh`
   在不签名时会 WARN。**正式交付必须签名**，否则「包被篡改」这一层防线是空的。
5. **18080 端口冲突回退（18081/18082）**：代码已实现，未在容器里制造占用验证。
