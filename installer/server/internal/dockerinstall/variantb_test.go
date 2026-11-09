package dockerinstall

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
	"tianji-archive/installer/internal/installed"
)

// vrunner 是变体 B 用例的假 runner：除了记账，还能在 tar / install 时**真的**
// 把文件写出来（解压与安装都是外部命令，假 runner 不写文件的话，后面
// os.Stat 校验永远失败，用例就只能测到「报错路径」）。
type vrunner struct {
	calls  []string
	out    map[string]string
	err    map[string]error
	onCall func(name string, args []string)
}

func (v *vrunner) Run(_ context.Context, name string, args ...string) (execx.Result, error) {
	key := strings.TrimSpace(name + " " + strings.Join(args, " "))
	v.calls = append(v.calls, key)
	if v.onCall != nil {
		v.onCall(name, args)
	}
	res := execx.Result{Command: key, Stdout: v.out[key]}
	if err, ok := v.err[key]; ok {
		res.ExitCode = 1
		return res, err
	}
	if _, ok := v.out[key]; !ok {
		// 未预置输出的命令一律视为「不可用」——但 tar/install 由 onCall 负责造文件，
		// 调用方在自己的用例里给出对应 out。
		return res, nil
	}
	return res, nil
}

func (v *vrunner) called(substr string) bool {
	for _, c := range v.calls {
		if strings.Contains(c, substr) {
			return true
		}
	}
	return false
}

// vbFixture 造一套变体 B 的临时布局：载荷目录、静态落点、插件目录、unit 路径全部指到 temp。
type vbFixture struct {
	layout buildplan.Layout
	runner *vrunner
	logs   []string
}

func newVBFixture(t *testing.T) *vbFixture {
	t.Helper()
	root := t.TempDir()
	layout := buildplan.DefaultLayout()
	layout.Root = root
	layout.DeployRoot = filepath.Join(root, "deploy")
	layout.StateFile = filepath.Join(root, "state", "state.json")
	layout.LogRoot = filepath.Join(root, "log")
	layout.UnitPath = filepath.Join(root, "etc", "tianji-stack.service")
	// 变体 B 的四项落点
	layout.StaticDockerDir = filepath.Join(root, "usr", "local", "lib", "tianji", "docker-static")
	layout.ComposePluginDir = filepath.Join(root, "usr", "local", "lib", "docker", "cli-plugins")
	layout.DockerUnit = filepath.Join(root, "etc", "systemd", "system", "docker.service")
	layout.RecordFile = filepath.Join(root, "state", "installed-files.json")

	fx := &vbFixture{layout: layout, runner: &vrunner{out: map[string]string{}, err: map[string]error{}}}

	// 载荷：docker tgz（内容不重要，解压由 runner 模拟）+ compose 单二进制
	staticDir := layout.StaticDir()
	if err := os.MkdirAll(staticDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staticDir, "docker-27.5.1.tgz"), []byte("tgz"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(layout.ComposePluginPath()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.ComposePluginPath(), []byte("compose-binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	// tar：模拟解压（写 docker / dockerd / containerd / runc）
	// install：模拟安装 compose 插件（源 → 目标）
	fx.runner.onCall = func(name string, args []string) {
		switch name {
		case "tar":
			binDir := ""
			for i, a := range args {
				if a == "-C" && i+1 < len(args) {
					binDir = args[i+1]
				}
			}
			if binDir == "" {
				return
			}
			_ = os.MkdirAll(binDir, 0o755)
			for _, b := range []string{"docker", "dockerd", "containerd", "runc", "containerd-shim-runc-v2", "docker-proxy", "ctr"} {
				_ = os.WriteFile(filepath.Join(binDir, b), []byte("static-"+b), 0o755)
			}
		case "install":
			if len(args) >= 4 {
				_ = os.MkdirAll(filepath.Dir(args[3]), 0o755)
				_ = os.WriteFile(args[3], []byte("compose"), 0o755)
			}
		}
	}
	fx.runner.out["systemctl daemon-reload"] = ""
	fx.runner.out["systemctl enable --now docker"] = ""
	return fx
}

func (fx *vbFixture) opts(t *testing.T) Options {
	t.Helper()
	return Options{
		Layout:   fx.layout,
		Manifest: &buildplan.Manifest{Variant: buildplan.VariantKylinUOS},
		Runner:   fx.runner,
		// 变体 B 的 docker 是绝对路径
		DockerBin:    fx.layout.DockerCLI(buildplan.VariantKylinUOS),
		CheckSystemd: func() bool { return true },
		Logf: func(format string, args ...any) {
			fx.logs = append(fx.logs, sprintf(format, args...))
		},
	}
}

func sprintf(format string, args ...any) string {
	if len(args) == 0 {
		return format
	}
	return fmt.Sprintf(format, args...)
}

// TestStaticInstallPlacesBinariesOutsidePath：二进制必须落静态目录，**不进 /usr/local/bin**。
func TestStaticInstallPlacesBinariesOutsidePath(t *testing.T) {
	fx := newVBFixture(t)
	opts := fx.opts(t)
	res := &Result{}
	if err := installStatic(context.Background(), &opts, res); err != nil {
		t.Fatalf("installStatic 失败: %v", err)
	}
	for _, bin := range []string{"docker", "dockerd"} {
		if _, err := os.Stat(fx.layout.StaticDockerBin(bin)); err != nil {
			t.Fatalf("%s 应落在 %s: %v", bin, fx.layout.StaticDockerBinDir(), err)
		}
	}
	for _, c := range fx.runner.calls {
		if strings.Contains(c, "/usr/local/bin") || strings.Contains(c, "/usr/bin/docker") {
			t.Fatalf("不得往 PATH 目录里装东西（会与发行版 docker 争抢）：%s", c)
		}
	}
	if res.Installed == nil || len(res.Installed) == 0 {
		t.Fatal("必须登记安装清单（卸载只删清单里的东西）")
	}
}

// TestStaticUnitUsesAbsolutePathsAndWaitsReady：unit 的三个硬要求。
func TestStaticUnitUsesAbsolutePathsAndWaitsReady(t *testing.T) {
	fx := newVBFixture(t)
	opts := fx.opts(t)
	if err := installStatic(context.Background(), &opts, &Result{}); err != nil {
		t.Fatalf("installStatic 失败: %v", err)
	}
	raw, err := os.ReadFile(fx.layout.DockerUnitPath())
	if err != nil {
		t.Fatalf("unit 未写入: %v", err)
	}
	unit := string(raw)

	wantExec := "ExecStart=" + fx.layout.StaticDockerBin("dockerd")
	if !strings.Contains(unit, wantExec) {
		t.Fatalf("ExecStart 必须是静态目录的绝对路径（%s）：\n%s", wantExec, unit)
	}
	wantPost := "ExecStartPost=" + filepath.Join(fx.layout.StaticDockerBinDir(), buildplan.WaitReadyScript)
	if !strings.Contains(unit, wantPost) {
		t.Fatalf("ExecStartPost 必须做就绪等待（%s）：\n%s", wantPost, unit)
	}
	if !strings.Contains(unit, "After=network-online.target firewalld.service") {
		t.Fatalf("After 必须含 network-online.target 与 firewalld.service：\n%s", unit)
	}
	if strings.Contains(unit, "/usr/local/bin/dockerd") {
		t.Fatalf("unit 不许指向 /usr/local/bin：\n%s", unit)
	}
	// systemd 会对 $VAR 做自己的展开：就绪等待放成独立脚本，unit 里不该出现 shell 循环。
	if strings.Contains(unit, "while ") || strings.Contains(unit, "$$(") {
		t.Fatalf("unit 里不该出现 shell 循环/转义（应放在 wait-ready.sh）：\n%s", unit)
	}

	waiter, err := os.ReadFile(filepath.Join(fx.layout.StaticDockerBinDir(), buildplan.WaitReadyScript))
	if err != nil {
		t.Fatalf("就绪等待脚本未写入: %v", err)
	}
	if !strings.Contains(string(waiter), fx.layout.StaticDockerBin("docker")) {
		t.Fatalf("就绪脚本必须用绝对路径调 docker：\n%s", waiter)
	}
}

// TestStaticUnitCarriesRuntimeEnvironment：unit 模板四缺陷修复的回归（真麒麟 S3 实测，
// journal 双层实证 + `701f1e6` 证据）。
//
//  1. dockerd 27.5.1 经 PATH 找 docker-proxy 与托管 containerd：unit 必须自带
//     Environment=PATH 且静态目录在最前——fixture 把静态目录指到临时路径，
//     若实现硬编码 /usr/local/lib/tianji/docker-static 第二份，这里必失败；
//  2. ExecStart 必须带 --userland-proxy-path 绝对路径；
//  3. Restart=on-failure + StartLimit 上限：Restart=always 遇 ExecStart 秒败是
//     每 2s 一次的无限循环（真机 restart counter 31+，failed 态永不可见）。
func TestStaticUnitCarriesRuntimeEnvironment(t *testing.T) {
	fx := newVBFixture(t)
	opts := fx.opts(t)
	if err := installStatic(context.Background(), &opts, &Result{}); err != nil {
		t.Fatalf("installStatic 失败: %v", err)
	}
	raw, err := os.ReadFile(fx.layout.DockerUnitPath())
	if err != nil {
		t.Fatalf("unit 未写入: %v", err)
	}
	unit := string(raw)

	// ① Environment=PATH：静态目录派生自 Layout（fixture 已指到 temp），放最前、系统目录兜底。
	wantEnv := "Environment=PATH=" + fx.layout.StaticDockerBinDir() + ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	if !strings.Contains(unit, wantEnv) {
		t.Fatalf("unit 必须自带 Environment=PATH（静态目录在最前、系统目录兜底）：\n期望含 %s\n实际：\n%s", wantEnv, unit)
	}
	// 硬编码第二份静态路径必被 fixture 抓住：Environment 行若不来自 Layout 就不含 temp 路径。
	envLine := ""
	for _, line := range strings.Split(unit, "\n") {
		if strings.HasPrefix(line, "Environment=PATH=") {
			envLine = line
		}
	}
	if !strings.HasPrefix(strings.TrimPrefix(envLine, "Environment=PATH="), fx.layout.StaticDockerBinDir()) {
		t.Fatalf("Environment=PATH 的静态目录必须从 Layout 派生且放最前，实际 %q", envLine)
	}

	// ② --userland-proxy-path 绝对路径（同样派生自 Layout）。
	wantProxy := "--userland-proxy-path=" + fx.layout.StaticDockerBin("docker-proxy")
	if !strings.Contains(unit, wantProxy) {
		t.Fatalf("ExecStart 必须带 --userland-proxy-path 绝对路径：\n期望含 %s\n实际：\n%s", wantProxy, unit)
	}

	// ③ 重启策略：给上限，消灭无限 auto-restart。
	if !strings.Contains(unit, "Restart=on-failure") {
		t.Fatalf("Restart 必须是 on-failure（always + 秒败 = 无限循环）：\n%s", unit)
	}
	if strings.Contains(unit, "Restart=always") {
		t.Fatalf("unit 不许再出现 Restart=always：\n%s", unit)
	}
	if !strings.Contains(unit, "StartLimitIntervalSec=120") || !strings.Contains(unit, "StartLimitBurst=5") {
		t.Fatalf("必须有 StartLimitIntervalSec=120 与 StartLimitBurst=5（让 systemd 放弃后 failed 可见）：\n%s", unit)
	}

	// ④ wait-ready.sh 的排障 hint：ExecStart 秒败时 ExecStartPost 不运行是 systemd
	// 语义，现场要知道去 journalctl 查根因，而不是盯着脚本等。
	waiter, werr := os.ReadFile(filepath.Join(fx.layout.StaticDockerBinDir(), buildplan.WaitReadyScript))
	if werr != nil {
		t.Fatalf("就绪等待脚本未写入: %v", werr)
	}
	if !strings.Contains(string(waiter), "journalctl -u docker") {
		t.Fatalf("wait-ready.sh 必须提示「ExecStart 秒败时本脚本不会执行，查 journalctl -u docker」：\n%s", waiter)
	}
}

// TestEnsureDockerGroupCreatesWhenMissing：组不存在 → groupadd --system。
func TestEnsureDockerGroupCreatesWhenMissing(t *testing.T) {
	fx := newVBFixture(t)
	opts := fx.opts(t)
	// vrunner 对未预置输出的命令返回 nil 错误、空 stdout：等价于「getent 查无此组」。
	if err := ensureDockerGroup(context.Background(), &opts); err != nil {
		t.Fatalf("建组不应失败: %v", err)
	}
	if !fx.runner.called("groupadd --system docker") {
		t.Fatalf("组不存在时必须执行 groupadd --system docker，实际调用: %v", fx.runner.calls)
	}
	if !fx.runner.called("getent group docker") {
		t.Fatal("建组前必须先 getent 探测（幂等纪律）")
	}
}

// TestEnsureDockerGroupSkipsWhenExists：组已存在 → 不碰 groupadd。
func TestEnsureDockerGroupSkipsWhenExists(t *testing.T) {
	fx := newVBFixture(t)
	fx.runner.out["getent group docker"] = "docker:x:173:\n"
	opts := fx.opts(t)
	if err := ensureDockerGroup(context.Background(), &opts); err != nil {
		t.Fatalf("组已存在不应失败: %v", err)
	}
	if fx.runner.called("groupadd") {
		t.Fatal("组已存在时不得执行 groupadd")
	}
	if !strings.Contains(strings.Join(fx.logs, "\n"), "已存在") {
		t.Fatalf("日志要如实记录「组已存在」: %v", fx.logs)
	}
}

// TestEnsureDockerGroupFailureFailsClosed：groupadd 真失败 → 阻断并说明后果。
func TestEnsureDockerGroupFailureFailsClosed(t *testing.T) {
	fx := newVBFixture(t)
	fx.runner.err["groupadd --system docker"] = errors.New("groupadd: failure")
	opts := fx.opts(t)
	err := ensureDockerGroup(context.Background(), &opts)
	if err == nil {
		t.Fatal("groupadd 失败必须阻断（否则 docker.sock 的 chown 必败）")
	}
	if !strings.Contains(err.Error(), "docker.sock") {
		t.Errorf("错误要说明失败后果（docker.sock chown 会随之失败）: %v", err)
	}
}

// TestStaticInstallCreatesGroupBeforeEnable：顺序守卫——建组必须在 enable --now 之前
// （dockerd 一起来就要 chown socket，晚了没用）。
func TestStaticInstallCreatesGroupBeforeEnable(t *testing.T) {
	fx := newVBFixture(t)
	opts := fx.opts(t)
	if err := installStatic(context.Background(), &opts, &Result{}); err != nil {
		t.Fatalf("installStatic 失败: %v", err)
	}
	groupIdx, enableIdx := -1, -1
	for i, c := range fx.runner.calls {
		if strings.Contains(c, "groupadd --system docker") && groupIdx == -1 {
			groupIdx = i
		}
		if strings.Contains(c, "systemctl enable --now docker") && enableIdx == -1 {
			enableIdx = i
		}
	}
	if groupIdx == -1 || enableIdx == -1 {
		t.Fatalf("groupadd 或 enable 调用缺失，calls=%v", fx.runner.calls)
	}
	if groupIdx > enableIdx {
		t.Fatalf("groupadd（#%d）必须在 systemctl enable --now docker（#%d）之前", groupIdx, enableIdx)
	}
}

// TestStaticInstallNeverTouchesPackageManager：禁 apt/dpkg/rpm/dnf/brctl/update-ca-certificates。
func TestStaticInstallNeverTouchesPackageManager(t *testing.T) {
	fx := newVBFixture(t)
	opts := fx.opts(t)
	if err := installStatic(context.Background(), &opts, &Result{}); err != nil {
		t.Fatalf("installStatic 失败: %v", err)
	}
	banned := []string{"apt", "apt-get", "dpkg", "rpm -", "dnf", "yum", "brctl", "update-ca-certificates"}
	for _, c := range fx.runner.calls {
		for _, b := range banned {
			if strings.HasPrefix(c, b) || strings.Contains(c, " "+b+" ") {
				t.Fatalf("变体 B 不得使用 %q（包管理器/桥接工具/Ubuntu 专属 CA 命令）：%s", b, c)
			}
		}
	}
}

// TestFirewalldDisableWhenActive：在跑就 disable --now，前后状态都留痕。
func TestFirewalldDisableWhenActive(t *testing.T) {
	fx := newVBFixture(t)
	state := "active"
	fx.runner.onCall = func(name string, args []string) {
		key := strings.TrimSpace(name + " " + strings.Join(args, " "))
		switch key {
		case "systemctl is-active firewalld":
			fx.runner.out[key] = state
		case "systemctl disable --now firewalld":
			state = "inactive" // 处置生效
		}
	}
	opts := fx.opts(t)
	fw := handleFirewalld(context.Background(), &opts)

	if fw.Before != "active" || fw.After != "inactive" {
		t.Fatalf("前后状态必须留痕，实际 before=%q after=%q", fw.Before, fw.After)
	}
	if fw.Tool != "systemctl" {
		t.Fatalf("tool 应为 systemctl，实际 %q", fw.Tool)
	}
	if !strings.Contains(fw.Action, "已 disable --now") {
		t.Fatalf("结论要说清做了处置，实际 %q", fw.Action)
	}
	if !fx.runner.called("systemctl disable --now firewalld") {
		t.Fatal("firewalld 在跑时必须真的执行 disable --now")
	}
}

// TestFirewalldInactiveNeedsNoAction：没在跑就别乱动系统。
func TestFirewalldInactiveNeedsNoAction(t *testing.T) {
	fx := newVBFixture(t)
	fx.runner.out["systemctl is-active firewalld"] = "inactive"
	opts := fx.opts(t)
	fw := handleFirewalld(context.Background(), &opts)
	if fw.Before != "inactive" || fw.After != "inactive" {
		t.Fatalf("状态记录不对: %+v", fw)
	}
	if fx.runner.called("disable --now") {
		t.Fatal("firewalld 没在跑时不该执行 disable")
	}
}

// TestFirewalldDisableFailureIsRecordedNotFatal：处置失败要留痕，但不能让 S3 直接挂掉
// （真失败会在后面起 dockerd 时以 ZONE_CONFLICT 暴露，报错更具体）。
func TestFirewalldDisableFailureIsRecordedNotFatal(t *testing.T) {
	fx := newVBFixture(t)
	fx.runner.out["systemctl is-active firewalld"] = "active"
	fx.runner.err["systemctl disable --now firewalld"] = errors.New("Access denied")
	opts := fx.opts(t)
	fw := handleFirewalld(context.Background(), &opts)
	if !strings.Contains(fw.Action, "处置失败") {
		t.Fatalf("处置失败必须写进结论，实际 %q", fw.Action)
	}
	if fw.Before != "active" {
		t.Fatalf("前状态要留住，实际 %q", fw.Before)
	}
}

// TestFirewalldWithoutSystemdIsSkipped：没有 systemctl 时说「跳过」，不假装处置过。
func TestFirewalldWithoutSystemdIsSkipped(t *testing.T) {
	fx := newVBFixture(t)
	opts := fx.opts(t)
	opts.CheckSystemd = func() bool { return false }
	fw := handleFirewalld(context.Background(), &opts)
	if fw.Tool != "absent" {
		t.Fatalf("没有 systemctl 时 tool 应为 absent，实际 %q", fw.Tool)
	}
	if !strings.Contains(fw.Action, "跳过") {
		t.Fatalf("结论应是跳过，实际 %q", fw.Action)
	}
	if fx.runner.called("systemctl") {
		t.Fatal("没有 systemctl 时不该去调它")
	}
}

// TestResolveComposeSourcePrefersCanonical：规范落点优先，旧落点也认但要提示。
func TestResolveComposeSourcePrefersCanonical(t *testing.T) {
	fx := newVBFixture(t)
	src, why, err := resolveComposeSource(fx.layout)
	if err != nil {
		t.Fatalf("应找到规范落点: %v", err)
	}
	if src != fx.layout.ComposePluginPath() {
		t.Fatalf("应优先规范落点，实际 %s", src)
	}
	if strings.Contains(why, "旧") {
		t.Fatalf("规范落点不该被描述成旧落点: %s", why)
	}

	// 删掉规范落点 → 应回落到 docker/static/docker-compose，并说明是旧落点
	if err := os.Remove(fx.layout.ComposePluginPath()); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(fx.layout.StaticDir(), "docker-compose")
	if err := os.WriteFile(legacy, []byte("compose"), 0o755); err != nil {
		t.Fatal(err)
	}
	src, why, err = resolveComposeSource(fx.layout)
	if err != nil {
		t.Fatalf("旧落点应被接受: %v", err)
	}
	if src != legacy || !strings.Contains(why, "旧") {
		t.Fatalf("应回落到旧落点并提示，实际 src=%s why=%s", src, why)
	}

	// 两个都没有 → 明确报错（不许「大概能跑」）
	_ = os.Remove(legacy)
	if _, _, err := resolveComposeSource(fx.layout); err == nil {
		t.Fatal("找不到 compose 二进制时必须报错")
	}
}

// TestInstallStaticMissingPayloadFailsClosed：没有 tgz 就不许继续。
func TestInstallStaticMissingPayloadFailsClosed(t *testing.T) {
	fx := newVBFixture(t)
	if err := os.Remove(filepath.Join(fx.layout.StaticDir(), "docker-27.5.1.tgz")); err != nil {
		t.Fatal(err)
	}
	opts := fx.opts(t)
	err := installStatic(context.Background(), &opts, &Result{})
	if err == nil {
		t.Fatal("缺 static 载荷必须失败")
	}
	if !strings.Contains(err.Error(), "变体 B 载荷缺失") {
		t.Fatalf("错误信息要说清缺什么，实际 %v", err)
	}
}

// TestDockerCLIFollowsLayout：变体 A 走 PATH，变体 B 走绝对路径。
func TestDockerCLIFollowsLayout(t *testing.T) {
	l := buildplan.DefaultLayout()
	if got := l.DockerCLI(buildplan.VariantUbuntuDebian); got != "docker" {
		t.Fatalf("变体 A 应走 PATH 的 docker，实际 %q", got)
	}
	got := l.DockerCLI(buildplan.VariantKylinUOS)
	if got != l.StaticDockerBin("docker") {
		t.Fatalf("变体 B 应走静态目录里的 docker，实际 %q", got)
	}
	if !strings.HasPrefix(got, buildplan.DefaultStaticDockerDir) && !strings.Contains(got, "docker-static") {
		t.Fatalf("变体 B 的 docker 必须来自静态目录，实际 %q", got)
	}
	// 绝对路径的断言只在 POSIX 上成立：Windows 上 filepath.Join("/usr/local/...") 会变成
	// `\usr\local\...`（没有盘符就不是绝对路径）。生产目标是 Linux，这条按平台判。
	if runtime.GOOS != "windows" && !filepath.IsAbs(got) {
		t.Fatalf("变体 B 的 docker 必须是绝对路径，实际 %q", got)
	}
}

// TestInstalledEntriesCoverEverythingWeWrote：清单必须覆盖 unit / 插件 / 脚本 / 目录，
// 少一项就会在卸载后留下孤儿文件。
func TestInstalledEntriesCoverEverythingWeWrote(t *testing.T) {
	fx := newVBFixture(t)
	opts := fx.opts(t)
	res := &Result{}
	if err := installStatic(context.Background(), &opts, res); err != nil {
		t.Fatalf("installStatic 失败: %v", err)
	}
	want := map[string]bool{
		fx.layout.StaticDockerBinDir():                                           false,
		filepath.Join(fx.layout.StaticDockerBinDir(), buildplan.WaitReadyScript): false,
		fx.layout.ComposePluginTarget():                                          false,
		fx.layout.DockerUnitPath():                                               false,
	}
	for _, e := range res.Installed {
		if _, ok := want[e.Path]; ok {
			want[e.Path] = true
		}
	}
	for p, ok := range want {
		if !ok {
			t.Fatalf("清单漏了 %s（卸载会留孤儿文件）", p)
		}
	}
	if kind := res.Installed[0].Kind; kind != installed.KindDir && kind != installed.KindFile {
		t.Fatalf("类别不合法: %v", kind)
	}
}
