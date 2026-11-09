package dockerinstall

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
)

// 内核参数文件名，与 installer/build/payload/common/sysctl/ 下的载荷同名。
const (
	SysctlFileName = "99-tianji.conf"
	LimitsFileName = "99-tianji-limits.conf"
)

// ParamMaxMapCount 是 ES 8 的硬门槛（设计 K5）。写进去之后还要回读确认生效——
// 「写了但没生效」是这类操作最常见的失败方式（sysctl --system 被 SELinux 拒绝、
// /etc/sysctl.d 里后加载的文件把值覆盖回去），只写不验等于没做。
const ParamMaxMapCount = 262144

// docker.service 的 drop-in：让 dockerd 自身持有无限 memlock。
//
// 为什么需要：compose 里 elasticsearch 声明了 ulimits.memlock: -1，
// dockerd 要以 CAP_SYS_RESOURCE 为容器放开；同时变体 A 的官方 unit 没设
// LimitMEMLOCK，而 limits.d 只对「登录会话」生效、管不到 systemd 拉起的进程。
const dockerLimitsDropIn = `[Service]
LimitMEMLOCK=infinity
LimitNOFILE=65535
`

// EnsureKernelParams 把预检 K5/K6/K7 要求的内核参数落到宿主并立即生效。
//
// 顺序：先写文件（可审计、可重放），再 sysctl --system，最后回读校验。
// 任何一步失败都 fail-closed——ES 起不来时现场最容易误判成「镜像坏了」。
func EnsureKernelParams(ctx context.Context, opts Options) error {
	// ① sysctl.d
	srcSysctl := filepath.Join(opts.Layout.SysctlDir(), SysctlFileName)
	if err := copyFile(srcSysctl, filepath.Join(opts.SysctlDir, SysctlFileName), 0o644); err != nil {
		return fmt.Errorf("写入 %s 失败（载荷缺失或权限不足）: %w", filepath.Join(opts.SysctlDir, SysctlFileName), err)
	}
	opts.logf("已写入 %s", filepath.Join(opts.SysctlDir, SysctlFileName))

	// ② limits.d
	srcLimits := filepath.Join(opts.Layout.SysctlDir(), LimitsFileName)
	destLimits := filepath.Join(opts.LimitsDir, LimitsFileName)
	if err := os.MkdirAll(opts.LimitsDir, 0o755); err != nil {
		return fmt.Errorf("创建 %s 失败: %w", opts.LimitsDir, err)
	}
	if err := copyFile(srcLimits, destLimits, 0o644); err != nil {
		return fmt.Errorf("写入 %s 失败: %w", destLimits, err)
	}
	opts.logf("已写入 %s（对新登录会话生效）", destLimits)

	// ③ 应用
	if execxHas("sysctl") {
		out, err := opts.Runner.Run(ctx, "sysctl", "--system")
		if err != nil {
			return fmt.Errorf("sysctl --system 失败: %w\n%s", err, out.Tail(10))
		}
		opts.logf("%s", strings.TrimRight(out.Combined(), "\n"))
	} else {
		// 极简系统可能没有 sysctl 命令；用 /proc 直写兜底（需要 root）。
		if err := writeProcSys("/proc/sys/vm/max_map_count", strconv.Itoa(ParamMaxMapCount)); err != nil {
			return fmt.Errorf("本机没有 sysctl 命令，且直接写 /proc/sys/vm/max_map_count 失败: %w", err)
		}
		opts.logf("无 sysctl 命令，已直写 /proc/sys/vm/max_map_count")
	}

	// ④ 回读校验
	out, err := opts.Runner.Run(ctx, "sysctl", "-n", "vm.max_map_count")
	if err == nil {
		if v := strings.TrimSpace(out.Stdout); v != "" {
			n, convErr := strconv.Atoi(v)
			if convErr == nil && n < ParamMaxMapCount {
				return fmt.Errorf("vm.max_map_count 生效值为 %d，仍低于要求 %d（ES 8 会启动即崩）\n"+
					"处置：检查 /etc/sysctl.d/ 下是否有其他文件把该值改回去了（按文件名排序，后加载的覆盖前面的）",
					n, ParamMaxMapCount)
			}
			opts.logf("回读确认 vm.max_map_count=%s", v)
		}
	} else if raw, readErr := os.ReadFile("/proc/sys/vm/max_map_count"); readErr == nil {
		if n, convErr := strconv.Atoi(strings.TrimSpace(string(raw))); convErr == nil && n < ParamMaxMapCount {
			return fmt.Errorf("vm.max_map_count 生效值为 %d，仍低于要求 %d", n, ParamMaxMapCount)
		}
	}
	return nil
}

// ensureDockerUnitLimits 给变体 A 的官方 unit 补一个 drop-in（变体 B 的 unit 已自带）。
func ensureDockerUnitLimits(opts Options) error {
	if opts.NoSystemd {
		return nil
	}
	dropInDir := filepath.Join(filepath.Dir(buildplan.DefaultSystemdUnit), "docker.service.d")
	if err := os.MkdirAll(dropInDir, 0o755); err != nil {
		return fmt.Errorf("创建 %s 失败: %w", dropInDir, err)
	}
	path := filepath.Join(dropInDir, "10-tianji-limits.conf")
	if err := os.WriteFile(path, []byte(dockerLimitsDropIn), 0o644); err != nil {
		return fmt.Errorf("写 %s 失败: %w", path, err)
	}
	opts.logf("已写入 %s（dockerd 自身 memlock 放开）", path)
	return nil
}

func copyFile(src, dest string, perm os.FileMode) error {
	raw, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dest, raw, perm)
}

func writeProcSys(path, value string) error {
	return os.WriteFile(path, []byte(value+"\n"), 0o644)
}

// execxHas 抽出成变量，便于单测在不改 PATH 的前提下替换命令存在性判断。
var execxHas = execx.Has
