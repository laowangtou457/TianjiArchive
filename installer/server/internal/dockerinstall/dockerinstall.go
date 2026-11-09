// Package dockerinstall 实现设计 §4 的两条完全不同的 Docker Engine 安装路径。
//
//	变体 A（ubuntu-debian）：dpkg -i 离线闭包 + dpkg --configure -a + systemctl
//	变体 B（kylin-uos）    ：static tgz 解到 /usr/local/bin + 自写 systemd unit + compose v2 单二进制
//
// 两条路径的共同戒律：**不得调用任何会出网的工具**（apt-get install / apt update /
// curl 下载）。现场无公网是硬约束，任何一次「顺手 apt 一下」都会让安装卡死几分钟
// 再报一个看不出原因的网络错误。
package dockerinstall

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
)

// MinComposeMajor/Minor 是硬门槛：离线 compose 用了顶层 `name:` 与
// depends_on.condition，compose v1 直接不认（设计 §4.3）。
const (
	MinComposeMajor = 2
	MinComposeMinor = 20
)

// docker.service 的内容（变体 B 专用）。
//
// LimitMEMLOCK=infinity 与 LimitNOFILE 是 ES 的要求（compose 里 elasticsearch
// 服务声明了 memlock 与 nofile），写在 unit 上比只写 limits.d 更可靠——limits.d
// 只对登录会话生效，而 dockerd 由 systemd 拉起。
const staticDockerUnit = `[Unit]
Description=Docker Application Container Engine (tianji static install)
Documentation=https://docs.docker.com
After=network-online.target firewalld.service
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/local/bin/dockerd
ExecReload=/bin/kill -s HUP $MAINPID
TimeoutStartSec=0
RestartSec=2
Restart=always
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

// Options 是一次 Docker 安装的全部输入。
type Options struct {
	Layout   buildplan.Layout
	Manifest *buildplan.Manifest
	Runner   execx.Runner
	// Codename 用于选 deb 子目录（jammy / noble / bookworm）；空则用 debs/ 平铺目录。
	Codename string
	// NoSystemd 为 true 时跳过 systemctl，只等待 dockerd 就绪。
	// 仅用于容器内（docker run ubuntu:22.04）验证与无 systemd 的精简系统。
	NoSystemd bool
	// SysctlDir / LimitsDir 是内核参数落盘目录，默认 /etc/sysctl.d、/etc/security/limits.d。
	SysctlDir string
	LimitsDir string
	// DaemonTimeout 是等待 dockerd Server 段就绪的上限，默认 90s。
	DaemonTimeout time.Duration
	// Hash 可注入，nil 用 buildplan.HashFile（用于复核 DEBS-MANIFEST.txt）。
	Hash func(string) (string, error)
	Logf func(format string, args ...any)
}

// Result 是安装结果。
type Result struct {
	// Method 是 "reuse" / "deb" / "static"。
	Method         string `json:"method"`
	DaemonVersion  string `json:"daemonVersion"`
	ComposeVersion string `json:"composeVersion"`
	DebCount       int    `json:"debCount,omitempty"`
	// DpkgSnapshot 是 dpkg -i 前已装包快照（设计 §4.2 的冲突定位依据）。
	// 只在日志里用，不进 JSON（可能上千行）。
	DpkgSnapshot string   `json:"-"`
	Steps        []string `json:"steps,omitempty"`
}

func (o Options) logf(format string, args ...any) {
	if o.Logf != nil {
		o.Logf(format, args...)
	}
}

func (o *Options) normalize() {
	if o.Runner == nil {
		o.Runner = execx.OSRunner{}
	}
	if o.SysctlDir == "" {
		o.SysctlDir = buildplan.DefaultSysctlDir
	}
	if o.LimitsDir == "" {
		o.LimitsDir = buildplan.DefaultLimitsDir
	}
	if o.DaemonTimeout <= 0 {
		o.DaemonTimeout = 90 * time.Second
	}
	if o.Hash == nil {
		o.Hash = buildplan.HashFile
	}
}

// Install 按 manifest 声明的变体安装（或复用）Docker，然后写内核参数、
// 校验 compose 版本、等待 dockerd 就绪。
func Install(ctx context.Context, opts Options) (*Result, error) {
	opts.normalize()
	if opts.Manifest == nil {
		return nil, errors.New("dockerinstall: manifest 为空")
	}

	res := &Result{}
	daemonVersion, composeVersion, err := probeExisting(ctx, opts)

	switch {
	case err == nil && daemonVersion != "":
		// 已有可用 Docker：只校验 compose 版本（设计 K12「跳过安装，仅校验 compose v2」）。
		if opts.Manifest.Docker.Version != "" {
			opts.logf("检测到已有 Docker Server %s（本包期望 %s），复用现有安装",
				daemonVersion, opts.Manifest.Docker.Version)
		}
		res.Method = "reuse"
		res.DaemonVersion = daemonVersion
		if composeVersion == "" {
			// 有 dockerd 但没有 compose 插件：仍然要补装插件，否则流程走不下去。
			opts.logf("已有 Docker 但缺少 compose 插件，将补装")
			if err := installComposePluginOnly(ctx, opts); err != nil {
				return res, err
			}
		}
	default:
		switch opts.Manifest.Variant {
		case buildplan.VariantUbuntuDebian:
			res.Method = "deb"
			debCount, snapshot, err := installDebs(ctx, &opts, res)
			if err != nil {
				return res, err
			}
			res.DebCount = debCount
			res.DpkgSnapshot = snapshot
		case buildplan.VariantKylinUOS:
			res.Method = "static"
			if err := installStatic(ctx, &opts, res); err != nil {
				return res, err
			}
		default:
			return res, fmt.Errorf("未知变体 %q", opts.Manifest.Variant)
		}
	}

	// 内核参数：设计 §4.5 的 K5/K6/K7 要求由安装器写入。
	if err := EnsureKernelParams(ctx, opts); err != nil {
		return res, err
	}
	res.Steps = append(res.Steps, "sysctl+limits 已写入并应用")

	// 等 dockerd 就绪
	version, err := WaitDaemon(ctx, opts.Runner, opts.DaemonTimeout, opts.logf)
	if err != nil {
		return res, err
	}
	res.DaemonVersion = version
	res.Steps = append(res.Steps, "dockerd 就绪: "+version)

	// compose v2 版本硬门槛
	cv, err := CheckComposeVersion(ctx, opts.Runner)
	if err != nil {
		return res, err
	}
	res.ComposeVersion = cv
	res.Steps = append(res.Steps, "docker compose "+cv+" 满足 ≥2."+strconv.Itoa(MinComposeMinor))
	return res, nil
}

// probeExisting 探测是否已有可用的 dockerd 与 compose 插件。
func probeExisting(ctx context.Context, opts Options) (daemonVersion, composeVersion string, err error) {
	if out, e := opts.Runner.Run(ctx, "docker", "version", "--format", "{{.Server.Version}}"); e == nil {
		daemonVersion = strings.TrimSpace(out.Stdout)
	}
	cv, cerr := CheckComposeVersion(ctx, opts.Runner)
	if cerr == nil {
		composeVersion = cv
	}
	if daemonVersion == "" {
		return "", composeVersion, errors.New("未检测到运行中的 dockerd")
	}
	return daemonVersion, composeVersion, nil
}

// installDebs 走变体 A：dpkg -i 离线闭包。
func installDebs(ctx context.Context, opts *Options, res *Result) (int, string, error) {
	dir := opts.Layout.DebsDir(opts.Codename)
	if _, statErr := os.Stat(dir); statErr != nil {
		// 兼容「没按 codename 分子目录」的包
		dir = opts.Layout.DebsDir("")
	}
	debs, err := filepath.Glob(filepath.Join(dir, "*.deb"))
	if err != nil {
		return 0, "", fmt.Errorf("扫描 deb 目录失败: %w", err)
	}
	if len(debs) == 0 {
		return 0, "", fmt.Errorf("变体 A 载荷缺失：%s 下没有 .deb（包不完整，禁止继续）", dir)
	}
	sort.Strings(debs)
	opts.logf("发现 %d 个 deb 包，目录 %s", len(debs), dir)

	// L-c：构建机在 DEBS-MANIFEST.txt 里记了每个 deb 的 sha256；有就复核，
	// 这样单个 deb 被换掉能定位到文件名，而不是笼统报「依赖不满足」。
	manifestPath := filepath.Join(dir, "DEBS-MANIFEST.txt")
	if _, statErr := os.Stat(manifestPath); statErr == nil {
		if err := verifyDebManifest(manifestPath, debs, opts.Hash); err != nil {
			return 0, "", err
		}
		opts.logf("DEBS-MANIFEST.txt 校验通过")
	} else {
		opts.logf("WARN: 缺少 DEBS-MANIFEST.txt，跳过逐包 sha256 复核")
	}

	// 设计 §4.2：dpkg -i 前先做已装包快照，失败时用来输出「冲突包名+已装版本+期望版本」。
	snapshot := ""
	if snap, sErr := opts.Runner.Run(ctx, "dpkg", "-l"); sErr == nil {
		snapshot = snap.Stdout
		opts.logf("已装包快照 %d 行（供依赖冲突定位）", countLines(snapshot))
	}

	// 显式 --force-confdef/--force-confold：现场没有人能回答 dpkg 的交互提问。
	args := append([]string{"-i", "--force-confdef", "--force-confold"}, debs...)
	opts.logf("执行 dpkg -i（%d 个包）…", len(debs))
	dpkgRes, err := opts.Runner.Run(ctx, "dpkg", args...)
	opts.logf("%s", strings.TrimRight(dpkgRes.Combined(), "\n"))
	if err != nil {
		// 单次 dpkg -i 是**按参数顺序**逐个检查 Pre-Depends 的，顺序不利时会误判。
		// 实测（ubuntu:22.04 特权 systemd 容器，85 个包）：python3-minimal 的
		// Pre-Depends 是 python3.10-minimal，而字典序把 python3-minimal 排在前面，
		// 于是报「python3.10-minimal is not installed」——可这个包就在同一批参数里，
		// 只是还没轮到解包；连带 networkd-dispatcher / python3-dbus / python3-gi 一起失败。
		//
		// 这不是缺包、也不是版本冲突，所以先 --configure -a 再补装一轮；
		// 两轮都失败才算真失败。仍然坚持**不**自动加 --force-depends：
		// 那会把「依赖真的不满足」降级成「装上了但起不来」，现场更难查。
		opts.logf("第 1 轮 dpkg -i 未全部成功（多为 Pre-Depends 参数顺序所致），configure 后补装第 2 轮…")
		if cfgRes, cfgErr := opts.Runner.Run(ctx, "dpkg", "--configure", "-a"); cfgErr == nil {
			opts.logf("%s", strings.TrimRight(cfgRes.Combined(), "\n"))
		} else {
			opts.logf("WARN: 补装前的 dpkg --configure -a 也报错（继续补装一轮）: %v", cfgErr)
		}
		retryRes, retryErr := opts.Runner.Run(ctx, "dpkg", args...)
		opts.logf("%s", strings.TrimRight(retryRes.Combined(), "\n"))
		if retryErr != nil {
			return len(debs), snapshot, fmt.Errorf("dpkg -i 失败（已补装第 2 轮；未自动 --force-depends，避免静默降级）: %w\n"+
				"处置：按上面输出里的「冲突包名」比对下面快照，确认版本后再重跑", retryErr)
		}
		opts.logf("第 2 轮 dpkg -i 成功（第 1 轮失败确系参数顺序，不是缺包）")
		res.Steps = append(res.Steps, "dpkg -i 第 1 轮因 Pre-Depends 参数顺序未全成功，第 2 轮补齐")
	}

	cfgRes, err := opts.Runner.Run(ctx, "dpkg", "--configure", "-a")
	opts.logf("%s", strings.TrimRight(cfgRes.Combined(), "\n"))
	if err != nil {
		return len(debs), snapshot, fmt.Errorf("dpkg --configure -a 失败: %w", err)
	}

	if err := ensureDockerUnitLimits(*opts); err != nil {
		return len(debs), snapshot, err
	}

	if err := enableAndStart(ctx, opts); err != nil {
		return len(debs), snapshot, err
	}
	res.Steps = append(res.Steps, fmt.Sprintf("dpkg 安装完成（%d 个包）", len(debs)))
	return len(debs), snapshot, nil
}

// installStatic 走变体 B：static tgz + 自写 unit + compose 插件。
func installStatic(ctx context.Context, opts *Options, res *Result) error {
	tgzs, err := filepath.Glob(filepath.Join(opts.Layout.StaticDir(), "docker-*.tgz"))
	if err != nil {
		return fmt.Errorf("扫描 static 目录失败: %w", err)
	}
	if len(tgzs) == 0 {
		return fmt.Errorf("变体 B 载荷缺失：%s 下没有 docker-*.tgz", opts.Layout.StaticDir())
	}
	sort.Strings(tgzs)
	tgz := tgzs[len(tgzs)-1]
	opts.logf("解开 static 包 %s → /usr/local/bin", filepath.Base(tgz))

	// --strip-components=1：tgz 内是 docker/ 一级目录（设计 §4.3）。
	tarRes, err := opts.Runner.Run(ctx, "tar", "-xzf", tgz, "-C", "/usr/local/bin", "--strip-components=1")
	if err != nil {
		return fmt.Errorf("解压 docker static 包失败: %w\n%s", err, tarRes.Tail(10))
	}

	for _, bin := range []string{"docker", "dockerd"} {
		if _, statErr := os.Stat(filepath.Join("/usr/local/bin", bin)); statErr != nil {
			return fmt.Errorf("static 包解压后缺少 /usr/local/bin/%s（包损坏）", bin)
		}
	}

	// compose v2 单二进制（static 包不含插件）
	if err := installComposePluginOnly(ctx, *opts); err != nil {
		return err
	}

	// 自写 unit
	if !opts.NoSystemd {
		if err := os.MkdirAll(filepath.Dir(buildplan.DefaultSystemdUnit), 0o755); err != nil {
			return fmt.Errorf("创建 unit 目录失败: %w", err)
		}
		if err := os.WriteFile(buildplan.DefaultSystemdUnit, []byte(staticDockerUnit), 0o644); err != nil {
			return fmt.Errorf("写 %s 失败: %w", buildplan.DefaultSystemdUnit, err)
		}
		opts.logf("已写入 %s（LimitMEMLOCK=infinity / LimitNOFILE=65535）", buildplan.DefaultSystemdUnit)
	}

	if err := enableAndStart(ctx, opts); err != nil {
		return err
	}
	res.Steps = append(res.Steps, "static 安装完成（docker/dockerd/containerd/runc 已就位）")
	return nil
}

// installComposePluginOnly 只补装 compose v2 插件（变体 B 必需，变体 A 通常在 deb 里自带）。
func installComposePluginOnly(ctx context.Context, opts Options) error {
	src := opts.Layout.ComposePluginPath()
	if _, err := os.Stat(src); err != nil {
		return fmt.Errorf("缺少 compose v2 单二进制 %s（变体 B 必须随包提供：compose v1 不认 name: 与 depends_on.condition）", src)
	}
	destDir := "/usr/local/lib/docker/cli-plugins"
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return fmt.Errorf("创建 %s 失败: %w", destDir, err)
	}
	dest := filepath.Join(destDir, "docker-compose")
	if out, err := opts.Runner.Run(ctx, "install", "-m", "0755", src, dest); err != nil {
		return fmt.Errorf("安装 compose 插件失败: %w\n%s", err, out.Tail(6))
	}
	opts.logf("compose 插件已安装到 %s", dest)
	return nil
}

// enableAndStart 拉起 dockerd。systemd 缺失时降级为「由外部拉起」，并如实记录。
func enableAndStart(ctx context.Context, opts *Options) error {
	if opts.NoSystemd {
		opts.logf("已指定 --no-systemd：跳过 systemctl，等待外部拉起的 dockerd")
		return nil
	}
	if !execx.Has("systemctl") {
		opts.logf("WARN: 本机没有 systemctl（容器或精简系统），跳过 enable --now；请手动拉起 dockerd")
		return nil
	}
	if _, err := opts.Runner.Run(ctx, "systemctl", "daemon-reload"); err != nil {
		opts.logf("WARN: systemctl daemon-reload 失败（继续尝试启动）")
	}
	out, err := opts.Runner.Run(ctx, "systemctl", "enable", "--now", "docker")
	if err != nil {
		return fmt.Errorf("systemctl enable --now docker 失败: %w\n%s", err, out.Tail(10))
	}
	opts.logf("%s", strings.TrimRight(out.Combined(), "\n"))
	return nil
}

// WaitDaemon 轮询 docker Server 段，直到就绪或超时。
//
// 为什么要轮询而不是 sleep 固定秒数：慢机器上 dockerd 首次起要初始化
// containerd 与 overlay2，可能 10 秒也可能 40 秒；固定 sleep 要么慢要么假失败。
func WaitDaemon(ctx context.Context, runner execx.Runner, timeout time.Duration, logf func(string, ...any)) (string, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	deadline := time.Now().Add(timeout)
	attempt := 0
	var lastErr error
	for {
		attempt++
		out, err := runner.Run(ctx, "docker", "version", "--format", "{{.Server.Version}}")
		if err == nil {
			if v := strings.TrimSpace(out.Stdout); v != "" {
				return v, nil
			}
		} else {
			lastErr = err
		}
		if time.Now().After(deadline) {
			msg := fmt.Sprintf("等待 dockerd 就绪超时（%s，尝试 %d 次）", timeout, attempt)
			if lastErr != nil {
				msg += "：最后一次错误 " + lastErr.Error()
			}
			msg += "\n处置：systemctl status docker -l / journalctl -u docker -n 100 看真实原因"
			return "", errors.New(msg)
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// CheckComposeVersion 校验 compose v2 版本 ≥ 2.20。
func CheckComposeVersion(ctx context.Context, runner execx.Runner) (string, error) {
	out, err := runner.Run(ctx, "docker", "compose", "version", "--short")
	raw := strings.TrimSpace(out.Stdout)
	if err != nil || raw == "" {
		// 老版本没有 --short，退回解析整段输出
		out2, err2 := runner.Run(ctx, "docker", "compose", "version")
		if err2 != nil {
			return "", fmt.Errorf("docker compose 插件不可用（%v）", err2)
		}
		raw = strings.TrimSpace(out2.Stdout)
		if raw == "" {
			raw = strings.TrimSpace(out2.Combined())
		}
	}
	ver := extractVersion(raw)
	if ver == "" {
		return "", fmt.Errorf("无法解析 docker compose 版本：%q", raw)
	}
	major, minor, ok := parseMajorMinor(ver)
	if !ok {
		return ver, nil // 解析不出主次版本时不阻断，只记录
	}
	if major < MinComposeMajor || (major == MinComposeMajor && minor < MinComposeMinor) {
		return ver, fmt.Errorf("docker compose 版本 %s 过低（要求 ≥ %d.%d）：离线 compose 使用了 name: 顶层键与 depends_on.condition，v1 不认",
			ver, MinComposeMajor, MinComposeMinor)
	}
	return ver, nil
}

// extractVersion 从 "2.29.7" 或 "Docker Compose version v2.29.7" 或
// "docker-compose version 1.29.2, build 5becea4c" 里取出版本号。
func extractVersion(s string) string {
	for _, field := range strings.Fields(s) {
		field = strings.TrimPrefix(field, "v")
		// 去掉尾部的逗号/括号等标点（老版本 compose v1 的输出带 ", build xxxx"）
		field = strings.TrimRight(field, ",;:)")
		if field == "" {
			continue
		}
		if field[0] >= '0' && field[0] <= '9' && strings.Contains(field, ".") {
			return field
		}
	}
	return ""
}

func parseMajorMinor(v string) (int, int, bool) {
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return 0, 0, false
	}
	major, err1 := strconv.Atoi(strings.TrimFunc(parts[0], notDigit))
	minor, err2 := strconv.Atoi(strings.TrimFunc(parts[1], notDigit))
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return major, minor, true
}

func notDigit(r rune) bool { return r < '0' || r > '9' }

// verifyDebManifest 复核 DEBS-MANIFEST.txt 里登记的每个 deb。
// 文件格式与 sha256sum 输出一致：`<sha256>  <filename>`。
func verifyDebManifest(path string, debs []string, hash func(string) (string, error)) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读 DEBS-MANIFEST.txt 失败: %w", err)
	}
	want := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimLeft(strings.TrimSpace(line), `\`)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := strings.TrimSpace(strings.Join(fields[1:], " "))
		// GNU coreutils 的二进制模式会在文件名前加一个 `*`（`sha256sum -b` 或
		// Windows 上的 Git Bash 默认如此），文本模式则是两个空格。两种都要认，
		// 否则会出现「哈希明明相同却报未登记」这种极难自查的误判。
		name = strings.TrimPrefix(name, "*")
		want[name] = fields[0]
	}
	if len(want) == 0 {
		return errors.New("DEBS-MANIFEST.txt 内容为空或格式不对（应为 <sha256>  <filename>）")
	}
	for _, deb := range debs {
		base := filepath.Base(deb)
		expected, ok := want[base]
		if !ok {
			return fmt.Errorf("deb %s 未在 DEBS-MANIFEST.txt 中登记（包被替换过？）", base)
		}
		actual, err := hash(deb)
		if err != nil {
			return fmt.Errorf("计算 %s 的 sha256 失败: %w", base, err)
		}
		if !strings.EqualFold(actual, expected) {
			return fmt.Errorf("deb 校验失败 %s\n  期望: %s\n  实际: %s", base, expected, actual)
		}
	}
	return nil
}

func countLines(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}
