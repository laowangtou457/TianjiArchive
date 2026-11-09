// 变体 B（kylin-uos / 统信 UOS）的静态安装路径。
//
// 与变体 A 的根本差别：不经过任何包管理器。系统里没有 rpm/dpkg 的归属数据库可用，
// 所以「装了哪些文件」必须自己记账（internal/installed），卸载只删这份账。
//
// 三条硬约束（docs/VARIANT-B-OS-BASELINE.md §6）：
//   - 二进制落 /usr/local/lib/tianji/docker-static，**不进 PATH**；
//   - compose 插件落 /usr/local/lib/docker/cli-plugins；
//   - unit 用绝对路径，且 ExecStartPost 做一次就绪等待。
package dockerinstall

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
	"tianji-archive/installer/internal/installed"
)

// staticDockerUnit 是我们的 docker.service 模板。
//
// 与 rpm 自带 unit 的差别，都是为了变体 B：
//   - Environment=PATH 把静态目录放最前：dockerd 27.5.1 经 PATH 找 docker-proxy、
//     托管拉起的 containerd 也走 PATH（真麒麟实测两层失败：先
//     `invalid userland-proxy-path`，修掉后再撞 `exec: "containerd": executable
//     file not found in $PATH`）。静态落点不进系统 PATH 是设计硬约束，所以只给
//     unit 自己的进程环境补——系统 PATH 一字不动，语义不破。
//   - ExecStart 带 --userland-proxy-path 绝对路径，同样为绕开 PATH 查找。
//   - ExecStart 指向静态目录（绝对路径），ExecStartPost 调 wait-ready.sh 等
//     Server 段就绪。**不把循环写进 unit**：systemd 会对 `$VAR` / `${VAR}` 做自己的
//     展开，把一个 shell 循环塞进 Exec= 要么得用 `$$` 转义（极易写错且看不出来），
//     要么被悄悄展开成空串。独立脚本可以在任何机器上单独 `sh wait-ready.sh` 复现。
//   - Restart=on-failure + StartLimit：Restart=always 遇 ExecStart 秒败是每 2s
//     一次的无限循环（真机实测 restart counter 31+ 永不放弃，现场只见
//     `activating (auto-restart)` 转圈、根因埋在 journal）。给上限让 systemd
//     放弃后进 failed 态可见。注意 systemd ≥230 的 StartLimit* 在 [Unit] 段。
//
// LimitMEMLOCK / LimitNOFILE 是 Elasticsearch 的要求（compose 里声明了 memlock 与
// nofile）。写在 unit 上比只写 limits.d 可靠：limits.d 只对登录会话生效，
// 而 dockerd 由 systemd 拉起。
const staticDockerUnit = `[Unit]
Description=Docker Application Container Engine (tianji static install)
Documentation=https://docs.docker.com
After=network-online.target firewalld.service
Wants=network-online.target
# 上限给足尝试机会（120s 内 5 次），超过则 failed 态可见，而不是无限 auto-restart
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=notify
# 静态目录放最前（dockerd 要经 PATH 找 docker-proxy / containerd），系统目录兜底
Environment=PATH=%s
ExecStart=%s --userland-proxy-path=%s
ExecStartPost=%s
ExecReload=/bin/kill -s HUP $MAINPID
TimeoutStartSec=0
RestartSec=2
Restart=on-failure
LimitNOFILE=65535
LimitMEMLOCK=infinity
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
Delegate=yes
KillMode=process
OOMScoreAdjust=-500

[Install]
WantedBy=multi-user.target
`

// dockerUnitEnvPath 返回 unit 的 Environment=PATH 值。
//
// 静态目录必须放最前，系统目录保留兜底：dockerd 运行期还要调 iptables /
// modprobe 等系统工具。staticDir 由 Layout 派生，绝不在这里手抄第二份路径——
// 静态落点是协议（buildplan/static_paths.go），抄第二份迟早分叉。
func dockerUnitEnvPath(staticDir string) string {
	return staticDir + ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
}

// renderDockerUnit 把落点填进模板。四个值全部从 Layout 派生。
func renderDockerUnit(layout buildplan.Layout, waiter string) string {
	return fmt.Sprintf(staticDockerUnit,
		dockerUnitEnvPath(layout.StaticDockerBinDir()),
		layout.StaticDockerBin("dockerd"),
		layout.StaticDockerBin("docker-proxy"),
		waiter)
}

// waitReadyScript 返回就绪等待脚本（由安装器写到静态目录，unit 的 ExecStartPost 调它）。
//
// 退出码永远是 0：它只负责「尽量等」，不该因为等不到就把 unit 判成 failed——
// 真正的判定在安装器的 WaitDaemon（那里有超时、有可读错误）。
//
// 结尾的 WARN 是真机排障换来的：ExecStart 秒败时 systemd 根本不会运行
// ExecStartPost，现场会误以为「脚本等了 60 秒都没等到」。把这句话打出来，
// 下次排障第一眼就知道该去 journalctl 而不是盯着本脚本。
func waitReadyScript(dockerBin string) string {
	return fmt.Sprintf(`#!/bin/sh
# 由 tianji 安装器写入（变体 B）。等 dockerd 的 Server 段就绪，最多 60 秒。
# 独立成脚本而不是塞进 systemd 的 ExecStartPost：避免 systemd 对 $ 变量的展开规则
# （$$ / ${VAR}）把一个简单循环写成隐蔽 bug；这里可以直接 sh wait-ready.sh 复现。
i=0
while [ "$i" -lt 60 ]; do
  %s version >/dev/null 2>&1 && exit 0
  i=$((i+1))
  sleep 1
done
echo "WARN: 等待 60 秒后 dockerd 仍未就绪（本脚本只等待，不判定成败）。" >&2
echo "若 ExecStart 秒败，本脚本根本不会被执行；请查 journalctl -u docker 看真实原因。" >&2
exit 0
`, dockerBin)
}

// FirewalldState 是变体 B 的 firewalld 处置留痕（设计 §4.4：唯一的 OS 级冲突源）。
//
// 为什么必须留痕：统信 UOS 实测「dockerd 二次启动 ZONE_CONFLICT 失败」——
// 现象是 daemon 起不来，报错完全不提 firewalld，现场会去查端口、查 iptables 规则、
// 甚至怀疑网卡。留下 Before/After 两个值，下次排查能直接看出「装的时候我们停过它」。
type FirewalldState struct {
	// Tool 是 "systemctl" 或 "absent"。
	Tool string `json:"tool"`
	// Before / After 是处置前后 `systemctl is-active firewalld` 的原文
	// （active / inactive / unknown / failed / 空）。
	Before string `json:"before"`
	After  string `json:"after"`
	// Action 是人话处置结论。
	Action string `json:"action"`
}

// handleFirewalld 处置 firewalld：在跑就 disable --now，并记录前后状态。
//
// 这是**安装步骤**，不是 preflight：preflight 只报告（见 preflight/variantb.go B6），
// 处置由安装器在本步执行并留痕——两者的边界必须清楚，否则「体检」会偷改系统状态。
func handleFirewalld(ctx context.Context, opts *Options) FirewalldState {
	st := FirewalldState{Tool: "systemctl"}
	if !opts.hasSystemctl() {
		st.Tool = "absent"
		st.Before = "unknown"
		st.After = "unknown"
		st.Action = "跳过：本机没有 systemctl（或指定了 --no-systemd），firewalld 无从处置"
		opts.logf("firewalld：%s", st.Action)
		return st
	}

	st.Before = firewalldActive(ctx, opts.Runner)
	if st.Before != "active" {
		st.After = st.Before
		st.Action = "无需处置（firewalld 当前不是 active）"
		opts.logf("firewalld：%s，实测 %q", st.Action, st.Before)
		return st
	}

	opts.logf("firewalld 正在运行：dockerd 与它会争 docker0（统信实测 ZONE_CONFLICT，二次启动必失败），执行 disable --now")
	out, err := opts.Runner.Run(ctx, "systemctl", "disable", "--now", "firewalld")
	opts.logf("%s", strings.TrimRight(out.Combined(), "\n"))
	st.After = firewalldActive(ctx, opts.Runner)
	if err != nil {
		st.Action = "处置失败：systemctl disable --now firewalld 返回错误，需现场手工停用"
		opts.logf("WARN: %s（err=%v）", st.Action, err)
		return st
	}
	if st.After == "active" {
		// 命令返回 0 但状态没变：可能是 firewalld 被别的 unit 拉起，或 systemd 在容器里。
		// 不在这里 fail——真失败会在后面起 dockerd 时以 ZONE_CONFLICT 暴露出来，
		// 但必须让用户现在就看见。
		st.Action = "处置无效：命令成功但 firewalld 仍是 active，起 dockerd 可能报 ZONE_CONFLICT"
		opts.logf("WARN: %s", st.Action)
		return st
	}
	st.Action = "已 disable --now（停机 + 取消开机自启），前后状态均已留痕"
	opts.logf("firewalld：%s（%q → %q）", st.Action, st.Before, st.After)
	return st
}

// firewalldActive 读 `systemctl is-active firewalld`。
// 注意 is-active 对 inactive 返回退出码 3，所以不能拿 err 判「探测失败」。
func firewalldActive(ctx context.Context, runner execx.Runner) string {
	out, err := runner.Run(ctx, "systemctl", "is-active", "firewalld")
	if v := strings.TrimSpace(out.Stdout); v != "" {
		return v
	}
	if v := strings.TrimSpace(out.Combined()); v != "" {
		return v
	}
	if err != nil {
		return "unknown"
	}
	return "unknown"
}

// ensureDockerGroup 幂等建立 docker 系统组。
//
// 为什么必须：变体 B 不走包管理器，没有 rpm 在装包时替我们建组；而 dockerd
// 起来后要把 /var/run/docker.sock chown 成 docker:docker，组不存在直接失败
// （真麒麟实测：could not change group /var/run/docker.sock to docker: group
// docker not found）。getent 探测、groupadd 补建，命令与结果都留进 S3 日志。
func ensureDockerGroup(ctx context.Context, opts *Options) error {
	if out, err := opts.Runner.Run(ctx, "getent", "group", "docker"); err == nil && strings.TrimSpace(out.Stdout) != "" {
		opts.logf("docker 组已存在：%s", strings.TrimSpace(out.Stdout))
		return nil
	}
	opts.logf("docker 组不存在（或探测不可用），执行 groupadd --system docker")
	out, err := opts.Runner.Run(ctx, "groupadd", "--system", "docker")
	opts.logf("%s", strings.TrimRight(out.Combined(), "\n"))
	if err != nil {
		// groupadd 本身幂等：组刚被别处建出来时报「already exists」，不算失败。
		if strings.Contains(strings.ToLower(out.Combined()), "already exists") {
			opts.logf("docker 组刚被别处创建（groupadd 报 already exists），继续")
			return nil
		}
		return fmt.Errorf("groupadd --system docker 失败（docker.sock 的 chown 会随之失败）: %w\n%s",
			err, out.Tail(6))
	}
	opts.logf("已创建系统组 docker")
	return nil
}

// installStatic 走变体 B：static tgz + compose 插件 + 自写 unit。
func installStatic(ctx context.Context, opts *Options, res *Result) error {
	tgzs, err := filepath.Glob(filepath.Join(opts.Layout.StaticDir(), "docker-*.tgz"))
	if err != nil {
		return fmt.Errorf("扫描 static 目录失败: %w", err)
	}
	if len(tgzs) == 0 {
		return fmt.Errorf("变体 B 载荷缺失：%s 下没有 docker-*.tgz（包不完整，禁止继续）", opts.Layout.StaticDir())
	}
	sort.Strings(tgzs)
	tgz := tgzs[len(tgzs)-1]

	binDir := opts.Layout.StaticDockerBinDir()
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("创建静态目录 %s 失败: %w", binDir, err)
	}
	opts.logf("解开 static 包 %s → %s", filepath.Base(tgz), binDir)

	// --strip-components=1：tgz 内是一层 docker/ 目录。
	tarRes, err := opts.Runner.Run(ctx, "tar", "-xzf", tgz, "-C", binDir, "--strip-components=1")
	if err != nil {
		return fmt.Errorf("解压 docker static 包失败: %w\n%s", err, tarRes.Tail(10))
	}

	// docker / dockerd 缺一个就直接失败：这两个是可用性的下限。
	for _, bin := range []string{"docker", "dockerd"} {
		if _, statErr := os.Stat(opts.Layout.StaticDockerBin(bin)); statErr != nil {
			return fmt.Errorf("static 包解压后缺少 %s（包损坏）", opts.Layout.StaticDockerBin(bin))
		}
	}
	// 其余组件缺了先 WARN 不阻断：真运行时（dockerd 起容器）才会暴露，
	// 这里硬失败会让一个「勉强能用」的包被拒，也不利于定位到底是哪个文件缺。
	for _, bin := range []string{"containerd", "runc", "containerd-shim-runc-v2", "docker-proxy", "ctr"} {
		if _, statErr := os.Stat(opts.Layout.StaticDockerBin(bin)); statErr != nil {
			opts.logf("WARN: static 包内缺少 %s（起容器时才会暴露，建议核对包完整性）", bin)
		}
	}
	if err := res.addInstalled(binDir, installed.KindDir, "docker 静态二进制目录（tar 解压，含 docker/dockerd/containerd/runc）"); err != nil {
		return err
	}

	// 就绪等待脚本
	waiter := filepath.Join(binDir, buildplan.WaitReadyScript)
	if err := os.WriteFile(waiter, []byte(waitReadyScript(opts.Layout.StaticDockerBin("docker"))), 0o755); err != nil {
		return fmt.Errorf("写 %s 失败: %w", waiter, err)
	}
	if err := res.addInstalled(waiter, installed.KindFile, "dockerd 就绪等待脚本（unit 的 ExecStartPost 调它）"); err != nil {
		return err
	}
	opts.logf("已写入 %s", waiter)

	// compose v2 单二进制（static 包不含插件，必须随包提供：
	// compose v1 不认 name: 顶层键与 depends_on.condition）
	if err := installComposePluginOnly(ctx, *opts); err != nil {
		return err
	}
	if err := res.addInstalled(opts.Layout.ComposePluginTarget(), installed.KindFile, "compose v2 CLI 插件（docker CLI 自动发现）"); err != nil {
		return err
	}

	// 自写 unit
	if opts.hasSystemctl() {
		unit := renderDockerUnit(opts.Layout, waiter)
		unitPath := opts.Layout.DockerUnitPath()
		if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
			return fmt.Errorf("创建 unit 目录失败: %w", err)
		}
		if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
			return fmt.Errorf("写 %s 失败: %w", unitPath, err)
		}
		if err := res.addInstalled(unitPath, installed.KindFile, "自写 docker.service（ExecStart 绝对路径 + ExecStartPost 就绪等待）"); err != nil {
			return err
		}
		opts.logf("已写入 %s（ExecStart=%s）", unitPath, opts.Layout.StaticDockerBin("dockerd"))
	}

	// docker 组必须在 enable --now 之前就位：dockerd 起来后要 chown
	// /var/run/docker.sock，组不存在是必失败项（幂等，重复安装无事）。
	if err := ensureDockerGroup(ctx, opts); err != nil {
		return err
	}

	if err := enableAndStart(ctx, opts); err != nil {
		return err
	}
	res.Steps = append(res.Steps, "static 安装完成（docker/dockerd/containerd/runc 已就位）")
	return nil
}

// resolveComposeSource 找 compose v2 单二进制在载荷里的位置。
//
// 两个候选，顺序固定：
//  1. docker/compose/docker-compose —— buildplan 的规范落点；
//  2. docker/static/docker-compose   —— 早期构建脚本的位置（包已发出去了就得认）。
//
// 认到第 2 个时打 WARN：不是错误，但说明这个包由旧脚本产出，规范落点才是长期形态。
func resolveComposeSource(layout buildplan.Layout) (string, string, error) {
	candidates := []struct {
		path string
		why  string
	}{
		{layout.ComposePluginPath(), "规范落点 docker/compose/docker-compose"},
		{filepath.Join(layout.StaticDir(), "docker-compose"), "旧构建脚本落点 docker/static/docker-compose（建议重新出包）"},
	}
	for _, c := range candidates {
		if _, err := os.Stat(c.path); err == nil {
			return c.path, c.why, nil
		}
	}
	return "", "", fmt.Errorf("缺少 compose v2 单二进制（找过 %s 与 %s）：变体 B 必须随包提供，"+
		"compose v1 不认离线 compose 的 name: 与 depends_on.condition",
		candidates[0].path, candidates[1].path)
}

// installComposePluginOnly 安装 compose v2 插件（变体 B 必需，变体 A 通常在 deb 里自带）。
func installComposePluginOnly(ctx context.Context, opts Options) error {
	src, why, err := resolveComposeSource(opts.Layout)
	if err != nil {
		return err
	}
	if strings.Contains(why, "旧构建脚本") {
		opts.logf("WARN: compose 二进制来自%s", why)
	}
	destDir := opts.Layout.ComposePluginTargetDir()
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return fmt.Errorf("创建 %s 失败: %w", destDir, err)
	}
	dest := opts.Layout.ComposePluginTarget()
	if out, err := opts.Runner.Run(ctx, "install", "-m", "0755", src, dest); err != nil {
		return fmt.Errorf("安装 compose 插件失败: %w\n%s", err, out.Tail(6))
	}
	opts.logf("compose 插件已安装到 %s", dest)
	return nil
}
