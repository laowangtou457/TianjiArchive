# installer/ · 服务器端安装包构建手册

本目录是 `docs/INSTALLER-DESIGN.md` 的实现落点。**只放构建机侧代码与载荷模板**，
服务器端运行期逻辑在 `server/`（Go 静态二进制），用户端在 `client-lite/`。

> 状态：`client-lite/` 已完成并交付（commit e4d4adb）。`build/` 已完成并通过本机
> 端到端试跑（G1/G2/G3 三道闸门全绿）。`server/`（Go 主体）**未开工**——本机构建机
> 没有 Go 工具链、也没有出网，无法编译与单测，已上报等待裁定，见本文末「阻塞」。

## 目录

```text
installer/
├── build/
│   ├── fetch-docker-debs.sh      # 变体 A：抓 docker-ce 的 .deb 闭包（构建机联网）
│   ├── fetch-docker-static.sh    # 变体 B：抓 docker static tgz + compose v2（联网）
│   ├── build-server-package.sh   # 主打包脚本，产出 .run（三道 fail-closed 闸门）
│   ├── make-manifest.sh          # manifest.json + SHA256SUMS.txt + 可选 gpg 签名
│   ├── selfextract/header.sh.in  # .run 的自解压头模板（POSIX sh）
│   └── payload/
│       └── common/               # 载荷模板，与仓库源逐字节同源（见 G1）
│           ├── compose/docker-compose.offline.yml
│           ├── scripts/{load-images,save-images,smoke}.sh
│           ├── seaweedfs/{entrypoint.sh,s3.json.tpl}
│           └── sysctl/{99-tianji.conf,99-tianji-limits.conf}
├── server/                       # （未开工）Go 安装器：web/tui 双前端 + 10 步状态机
└── client-lite/                  # 已完成：用户端一键配置器与自检
```

## 构建命令（均在仓库根执行）

```bash
# 变体 A（Ubuntu 22.04 jammy / 24.04 noble、Debian 12 bookworm）
bash installer/build/fetch-docker-debs.sh --codename jammy --pin-version
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w' \
  -o installer/server/dist/tianji-installer ./installer/server/cmd/tianji-installer
bash installer/build/build-server-package.sh --variant ubuntu-debian --codename jammy \
  --images-tar offline/tianji-offline-images.tar --sign

# 变体 B（麒麟 V10 / 统信 UOS；本期只就位载荷，安装逻辑未做）
bash installer/build/fetch-docker-static.sh
bash installer/build/build-server-package.sh --variant kylin-uos \
  --images-tar offline/tianji-offline-images.tar --sign

# 只重算清单与签名
bash installer/build/make-manifest.sh --dir <staging> --variant ubuntu-debian --sign
```

产物落在 `dist/installer/`（不入库），与 `offline/tianji-offline-images.tar`
**分离分发**（设计 §7.1），交付时必须同目录。

## 三道 fail-closed 闸门（过不了就退出，不产出半成品）

| 闸门 | 内容 | 失败即 |
|---|---|---|
| **G1 载荷同源** | `payload/common/` 下 6 个文件与 `offline/`、`infra/` 的源 `cmp` 逐字节相同 | 退出，提示「用 cp 整体覆盖，不要挑行合并」 |
| **G2 二进制形态** | 安装器必须是 ELF64 **x86-64**（校验魔数 + `e_machine=0x3e`），不是脚本、不是 darwin 产物 | 退出，附交叉编译命令 |
| **G3 自解压可用性** | 产出后立刻 `sh <run> --verify-only`，用头部记录的 sha256 校验 payload 段 | 退出并**删除**不完整产物 |

`--images-tar` 若同时存在 `offline/SHA256SUMS`，会强制两者 sha256 **逐字一致**
（设计 §2.2「必须同源，不允许安装器自己算一遍就当真」）。

## 实现决定与偏离（都已在代码注释里写明理由）

1. **`.env.tpl` 改为构建期派生**，不再作为提交入库的载荷文件（设计 §2.1 原写法）。
   派生源是 `.env.example`，好处是不存在「源改了、模板忘了改」的静默漂移。
2. **`S3_PUBLIC_ENDPOINT` 从注释里放出来并占位化**。`.env.example` 里这三项是注释
   掉的占位符（刻意不代拍板 IP），但离线 compose 用 `${S3_PUBLIC_ENDPOINT:-127.0.0.1}`
   兜底——默认回环地址会让局域网浏览器拿到指向 `127.0.0.1:8333` 的预签名 URL，
   症状正是「能登录、能检索、一上传就失败」（设计风险 **R9**，红色高风险）。
   故安装包里的 `.env.tpl` 强制把 `S3_PUBLIC_ENDPOINT` 提为必填占位符。
3. **`limits.d` 配置并列放在 `sysctl/` 下**（`99-tianji-limits.conf`）。设计 §2.1 只
   列了 `sysctl/99-tianji.conf`，但 §4.5 的 K6/K7 要求 memlock/nofile，落盘位置是
   `/etc/security/limits.d/`。两个文件都带 `99-tianji` 前缀，卸载时精确移除。
4. **`PAYLOAD_OFFSET` 定宽 10 位 + 剥前导零**。定宽保证替换前后头部字节数不变
   （offset 才准）；剥前导零是因为 POSIX sh 的算术展开把带前导 0 的数字当**八进制**
   解析，实测会算错一个字节导致 sha256 恒失败。

## 本机已完成的验证（构建机 Windows / Git Bash，无 Go）

用最小 ELF 桩二进制 + 假 `.deb` 跑通全链路（产物 20411 字节）：

- G1 PASS（6 个文件逐字节一致）、G2 PASS（ELF64/amd64）、G3 PASS
- payload 内容 13 个条目，`manifest.json` 可被 python json 解析
- `.env.tpl` 的 6 项凭据 + `S3_PUBLIC_ENDPOINT` + `CORS_ORIGINS` 已占位
- 篡改检测：向 `.run` 末尾追加 1 字节 → `--verify-only` 退出码 **1** 并打印期望/实际
- `--help` 正常；`.run` 头部为 POSIX sh，`sh -n` 通过

未验证（缺工具链）：Go 二进制真实编译、`go test`、容器内端到端安装闭环。

## 阻塞（待裁定）

本机构建机无 Go 工具链（`go` 不在 PATH，`Program Files\Go` 不存在）、无出网
（`go.dev`/`proxy.golang.org`/`registry-1.docker.io` 三个探测全部超时）、无
`golang:*` 与 `ubuntu:22.04` 镜像。因此 `server/` 的 Go 主体代码一旦开工就无法编译
验证。已上报 team-lead，选项：提供离线 Go 工具链（推荐）／授权一次性联网／降级
交付并标注 `BUILD_VERIFIED=no`／暂缓。
