// Command tianji-installer 是天玑档案管理系统的服务器端离线安装器。
//
// 三个前端共享同一个 session（= 同一套安装逻辑），符合设计 §3.1 的裁定：
//
//	--web（默认）  本机临时 Web 向导，绑 127.0.0.1:18080（占用则 18081/18082）
//	--tui         无第二台机器时的降级入口（纯终端）
//	--verify-only 只做包完整性校验，可独立跑
//	--uninstall   卸载（默认保留业务数据）
//
// 安装器严禁出网：所有依赖都在 payload 里，任何 fetch 都不存在（设计 §5.3）。
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/selfclean"
	"tianji-archive/installer/internal/state"
)

// version 由 -ldflags "-X main.version=1.0.0" 注入；缺省值让本机自测也能跑。
var version = "dev"

// config 是命令行解析后的运行配置。
type config struct {
	rootDir    string
	deployRoot string
	stateFile  string
	logRoot    string
	unitPath   string

	imagesTar string
	listen    string
	runFile   string
	token     string
	tokenTTL  time.Duration

	web           bool
	tui           bool
	resume        bool
	verifyOnly    bool
	uninstall     bool
	purgeVolumes  bool
	overwrite     bool
	noSystemd     bool
	shutdownGrace time.Duration
}

func usage() {
	fmt.Fprintf(os.Stderr, `天玑档案管理系统 · 服务器端离线安装器 %s

用法:
  tianji-installer [选项]

模式:
  --web                启动本机临时 Web 向导（默认）
  --tui                终端向导（无第二台机器时的降级入口）
  --resume             从 state.json 的断点继续，跑到完成
  --verify-only        仅校验安装包完整性（L-a 层 + 镜像 tar 溯源），不安装
  --uninstall          卸载：compose down，保留业务数据
  --uninstall --purge-volumes
                       卸载并删除 volumes/（业务数据不可恢复）

选项:
  --listen <addr>      监听地址，默认 127.0.0.1:18080；绑定非回环地址时强制启用一次性 token
  --images-tar <path>  指定 tianji-offline-images.tar 的路径（默认与安装包同目录）
  --overwrite          允许覆盖已存在的 .env（会先备份到日志目录）
  --no-systemd         跳过 systemctl（容器内验证或无 systemd 的精简系统）
  --root <dir>         payload 目录，默认 %s
  --deploy-root <dir>  部署根，默认 %s
  --state <path>       状态文件，默认 %s
  --log-dir <dir>      日志根目录，默认 %s
  --version            打印版本
`, version, buildplan.DefaultRootDir, buildplan.DefaultDeployRoot,
		buildplan.DefaultStateFile, buildplan.DefaultLogRoot)
}

func main() {
	cfg, err := parseFlags(os.Args[1:])
	if err != nil {
		if err == errHelp {
			usage()
			return
		}
		fmt.Fprintln(os.Stderr, "参数错误:", err)
		usage()
		os.Exit(2)
	}

	sess, err := newSession(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "初始化失败:", err)
		os.Exit(1)
	}
	defer func() { _ = sess.log.Close() }()

	switch {
	case cfg.verifyOnly:
		os.Exit(runVerifyOnly(sess))
	case cfg.uninstall:
		os.Exit(runUninstall(sess, cfg.purgeVolumes))
	case cfg.resume:
		// --resume 是「无人值守把剩下的步骤跑完」，与 --tui 的逐步确认是两条路：
		// 现场掉线续装、或某步修好后继续，都不该再要求人守在终端前按回车。
		os.Exit(runResume(sess))
	case cfg.tui:
		os.Exit(runTUI(sess))
	default:
		os.Exit(runWeb(sess))
	}
}

var errHelp = fmt.Errorf("help requested")

func parseFlags(args []string) (config, error) {
	cfg := config{
		rootDir:       buildplan.DefaultRootDir,
		deployRoot:    buildplan.DefaultDeployRoot,
		stateFile:     buildplan.DefaultStateFile,
		logRoot:       buildplan.DefaultLogRoot,
		unitPath:      buildplan.DefaultUnitPath,
		listen:        "127.0.0.1:18080",
		tokenTTL:      30 * time.Minute,
		shutdownGrace: 60 * time.Second,
		web:           true,
	}
	// 环境变量优先作为默认值：自解压头会把真实路径通过环境变量传进来，
	// 这样 .run 决定布局、Go 只负责执行，两边不会各写一份路径常量。
	if v := os.Getenv("TIANJI_INSTALLER_ROOT"); v != "" {
		cfg.rootDir = v
	}
	if v := os.Getenv("TIANJI_DEPLOY_ROOT"); v != "" {
		cfg.deployRoot = v
	}
	if v := os.Getenv("TIANJI_STATE_FILE"); v != "" {
		cfg.stateFile = v
	}
	if v := os.Getenv("TIANJI_LOG_DIR"); v != "" {
		cfg.logRoot = v
	}
	cfg.runFile = os.Getenv("TIANJI_RUN_FILE")

	for i := 0; i < len(args); i++ {
		arg := args[i]
		next := func() (string, error) {
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s 需要一个参数", arg)
			}
			i++
			return args[i], nil
		}
		var err error
		switch arg {
		case "-h", "-help", "--help":
			return cfg, errHelp
		case "--version":
			fmt.Printf("tianji-installer %s\n", version)
			os.Exit(0)
		case "--web":
			cfg.web, cfg.tui = true, false
		case "--tui":
			cfg.tui = true
		case "--resume":
			cfg.resume = true
		case "--verify-only":
			cfg.verifyOnly = true
		case "--uninstall":
			cfg.uninstall = true
		case "--purge-volumes":
			cfg.purgeVolumes = true
		case "--overwrite":
			cfg.overwrite = true
		case "--no-systemd":
			cfg.noSystemd = true
		case "--listen":
			if cfg.listen, err = next(); err != nil {
				return cfg, err
			}
		case "--images-tar":
			if cfg.imagesTar, err = next(); err != nil {
				return cfg, err
			}
		case "--root":
			if cfg.rootDir, err = next(); err != nil {
				return cfg, err
			}
		case "--deploy-root":
			if cfg.deployRoot, err = next(); err != nil {
				return cfg, err
			}
		case "--state":
			if cfg.stateFile, err = next(); err != nil {
				return cfg, err
			}
		case "--log-dir":
			if cfg.logRoot, err = next(); err != nil {
				return cfg, err
			}
		default:
			return cfg, fmt.Errorf("未知参数 %q", arg)
		}
	}

	if cfg.purgeVolumes && !cfg.uninstall {
		cfg.uninstall = true
	}
	if cfg.runFile == "" {
		cfg.runFile = fmt.Sprintf("tianji-server-setup-%s-amd64.run", "1.0.0")
	}
	cfg.runFile = filepath.Base(cfg.runFile)

	// 非回环监听必须带 token（设计 §3.3：无 token 的 LAN 可写向导等价于远程 root）。
	if !isLoopback(cfg.listen) {
		cfg.token = randomToken()
	}
	return cfg, nil
}

func isLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	switch host {
	case "", "127.0.0.1", "::1", "localhost":
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// randomToken 生成 32 字节一次性 token。
func randomToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		// 拿不到熵源时宁可失败，也不要降级成弱 token。
		fmt.Fprintln(os.Stderr, "无法生成安全 token:", err)
		os.Exit(1)
	}
	return hex.EncodeToString(buf)
}

// runVerifyOnly 只做完整性校验，返回进程退出码。
func runVerifyOnly(sess *session) int {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Minute)
	defer cancel()
	out := os.Stdout
	fmt.Fprintf(out, "校验安装包: %s（变体 %s，版本 %s）\n", sess.layout.Root, sess.manifest.Variant, sess.manifest.Version)
	if err := sess.RunStep(ctx, state.StepVerify); err != nil {
		fmt.Fprintln(os.Stderr, "IS_PASS: NO ——", err)
		return 1
	}
	fmt.Fprintln(out, "IS_PASS: YES —— 载荷与镜像 tar 校验全部通过")
	return 0
}

// runResume 从 state.json 的断点一路跑到完成，逐步打印进度（无人值守续装）。
//
// 与 Web 向导的「一键执行」共用 session.RunAll，所以不存在第二套顺序逻辑；
// 这里只负责把结果画到终端。失败时区分两类，因为处置完全不同：
//   - formRequiredError：还差第 ④ 步的 8 项表单值，属「缺输入」，不是安装故障，
//     必须引导去 --web（TUI 没有表单输入界面，硬填这些凭据等于让人在命令行历史里留密码）；
//   - 其它：真正的安装故障，给出该步日志路径与「修好后重跑 --resume」的指引。
func runResume(sess *session) int {
	// 总上限取各步上限之和的量级：超时也要能明确说「卡在哪一步」，而不是无限等。
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Minute)
	defer cancel()

	out := os.Stdout
	names := buildplan.StepNames()
	next := sess.st.NextStep()
	fmt.Fprintf(out, "断点续装：当前应执行 %s（%s）\n", names[string(next)], next)

	var failed state.Step
	err := sess.RunAll(ctx, func(step state.Step, stepErr error) {
		if stepErr != nil {
			failed = step
			return
		}
		fmt.Fprintf(out, "OK   %-10s %s\n", step, names[string(step)])
	})
	if err == nil {
		fmt.Fprintf(out, "安装完成。访问地址与凭据见 %s\n", sess.log.Path(stepLogFile[state.StepDone]))
		return 0
	}

	var formErr *formRequiredError
	if ok, _ := asForm(err, &formErr); ok {
		fmt.Fprintf(os.Stderr, "需要先填写部署表单：%s\n", formErr.Error())
		fmt.Fprintln(os.Stderr, "请改用 Web 向导填写（sh 安装包 --web），凭据不要写进命令行历史。")
		return 1
	}

	fmt.Fprintf(os.Stderr, "断点续装失败：%v\n", err)
	if failed != "" {
		fmt.Fprintf(os.Stderr, "   失败步骤：%s（%s）\n", names[string(failed)], failed)
		fmt.Fprintf(os.Stderr, "   该步日志：%s\n", sess.log.Path(stepLogFile[failed]))
	}
	fmt.Fprintln(os.Stderr, "   修好之后重新执行 --resume（已完成的步骤不会重跑）。")
	return 1
}

// runUninstall 卸载。
func runUninstall(sess *session, purge bool) int {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if purge {
		fmt.Fprintln(os.Stdout, "注意：--purge-volumes 将删除业务数据目录，此操作不可恢复。")
		fmt.Fprint(os.Stdout, "请输入产品名 tianji-archive 确认: ")
		var answer string
		_, _ = fmt.Fscanln(os.Stdin, &answer)
		if strings.TrimSpace(answer) != "tianji-archive" {
			fmt.Fprintln(os.Stderr, "确认串不匹配，已取消。")
			return 1
		}
	}
	if err := sess.Uninstall(ctx, purge, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "卸载失败:", err)
		return 1
	}
	fmt.Fprintln(os.Stdout, "卸载完成。")
	return 0
}

// installCleanup 把「信号 + defer」两条路径都接到同一个 Cleaner 上。
func installCleanup(sess *session) func() {
	cleanup := func() {
		steps := sess.cleaner.Run()
		_ = sess.log.Append("99-summary.txt", "清理: "+selfclean.Summarize(steps))
	}
	ctx, cancel := context.WithCancel(context.Background())
	stop := selfclean.HandleSignals(ctx, os.Stdout, cleanup, syscall.SIGINT, syscall.SIGTERM)
	return func() {
		cancel()
		stop()
		cleanup()
	}
}
