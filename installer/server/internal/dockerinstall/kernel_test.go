package dockerinstall

// EnsureKernelParams 的回读校验用例。
//
// K5 在 S1 改判 WARN 之后，S3 的回读是唯一能证明「vm.max_map_count 真的修好了」
// 的环节。这组用例守四件事：
//  1. 成功路径必须打 before→after——让安装报告自己回答「这一步到底改没改成」，
//     只报 after 无法自证（值可能是上一次安装改好的）；
//  2. 生效值仍低于门槛时要报错，且错误里带上改前值；
//  3. sysctl 与 /proc 都读不到时要报错，绝不能静默放行——K5 敢改 WARN 的前提
//     就是这里能兜底，兜底失效等于把真风险放走；
//  4. 无 sysctl 命令时 /proc 直读兜底也能完成回读（before 记作 `-`）。

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
)

// sysctlSeqRunner：`sysctl -n vm.max_map_count` 每次调用返回 vals 的下一个值
// （耗尽后回落到 stubRunner 的默认行为——报「命令不可用」），用来模拟
// 「先读到旧值 → 改完再读到新值」以及「sysctl 整个不可用」两种现场。
type sysctlSeqRunner struct {
	stubRunner
	vals []string
	i    int
}

func (s *sysctlSeqRunner) Run(ctx context.Context, name string, args ...string) (execx.Result, error) {
	key := name + " " + strings.Join(args, " ")
	if key == "sysctl -n vm.max_map_count" && s.i < len(s.vals) {
		v := s.vals[s.i]
		s.i++
		return execx.Result{Command: key, Stdout: v + "\n"}, nil
	}
	return s.stubRunner.Run(ctx, name, args...)
}

// kernelFixture 备好 payload 侧的 sysctl 载荷、目标目录，并把 /proc 路径与
// 命令存在性判断注入到临时目录（Windows 开发机上没有 /proc 与 sysctl）。
// 返回的 logSink 收集 S3 的日志行，用例据此断言 before→after 留痕。
func kernelFixture(t *testing.T) (opts Options, procPath string, logSink *strings.Builder) {
	t.Helper()
	payload := t.TempDir()
	sysctlPayload := filepath.Join(payload, "common", "sysctl")
	if err := os.MkdirAll(sysctlPayload, 0o755); err != nil {
		t.Fatalf("建载荷目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sysctlPayload, SysctlFileName),
		[]byte("vm.max_map_count = 262144\n"), 0o644); err != nil {
		t.Fatalf("写 sysctl 载荷失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sysctlPayload, LimitsFileName),
		[]byte("* soft memlock unlimited\n* hard memlock unlimited\n"), 0o644); err != nil {
		t.Fatalf("写 limits 载荷失败: %v", err)
	}

	procPath = filepath.Join(t.TempDir(), "max_map_count")
	logSink = &strings.Builder{}

	origProc, origHas, origWrite := procMaxMapCountPath, execxHas, writeProcSys
	procMaxMapCountPath = procPath
	execxHas = func(string) bool { return false } // 走 /proc 直写兜底，避免真调 sysctl --system
	writeProcSys = func(path, value string) error {
		return os.WriteFile(path, []byte(value+"\n"), 0o644)
	}
	t.Cleanup(func() {
		procMaxMapCountPath = origProc
		execxHas = origHas
		writeProcSys = origWrite
	})

	opts = Options{
		Layout:    buildplan.Layout{Root: payload},
		Runner:    &sysctlSeqRunner{stubRunner: stubRunner{out: map[string]string{}, err: map[string]error{}}},
		SysctlDir: t.TempDir(),
		LimitsDir: filepath.Join(t.TempDir(), "limits.d"),
		Logf: func(format string, args ...any) {
			logSink.WriteString(fmt.Sprintf(format, args...) + "\n")
		},
	}
	return opts, procPath, logSink
}

// TestEnsureKernelParamsLogsBeforeAndAfter 成功路径：S3 日志必须留下 before→after。
func TestEnsureKernelParamsLogsBeforeAndAfter(t *testing.T) {
	opts, procPath, log := kernelFixture(t)
	opts.Runner = &sysctlSeqRunner{
		stubRunner: stubRunner{out: map[string]string{}, err: map[string]error{}},
		vals:       []string{"65530", "262144"}, // 改前 65530 → 改后 262144
	}

	if err := EnsureKernelParams(context.Background(), opts); err != nil {
		t.Fatalf("不应失败: %v", err)
	}
	if !strings.Contains(log.String(), "65530 → 262144") {
		t.Errorf("日志必须留下 before→after（S1 是 WARN，这里要自证修过）:\n%s", log.String())
	}
	raw, err := os.ReadFile(procPath)
	if err != nil {
		t.Fatalf("应直写 /proc 兜底路径: %v", err)
	}
	if strings.TrimSpace(string(raw)) != "262144" {
		t.Errorf("写入值应为 262144，实际 %q", strings.TrimSpace(string(raw)))
	}
}

// TestEnsureKernelParamsFailsWhenStillLow 生效值仍低：报错要带改前值。
func TestEnsureKernelParamsFailsWhenStillLow(t *testing.T) {
	opts, _, log := kernelFixture(t)
	opts.Runner = &sysctlSeqRunner{
		stubRunner: stubRunner{out: map[string]string{}, err: map[string]error{}},
		vals:       []string{"65530", "131072"}, // 写了但没生效（被别的文件盖回去）
	}

	err := EnsureKernelParams(context.Background(), opts)
	if err == nil {
		t.Fatal("生效值 131072 < 262144 必须报错")
	}
	for _, want := range []string{"131072", "65530", "262144"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("错误信息应包含 %s（before/after/要求值都要能对上）: %v", want, err)
		}
	}
	if strings.Contains(log.String(), "已回读确认") {
		t.Errorf("失败时不能打「已回读确认」:\n%s", log.String())
	}
}

// TestEnsureKernelParamsFailsWhenReadbackUnavailable sysctl 与 /proc 都读不到：
// 报错，绝不静默放行。
func TestEnsureKernelParamsFailsWhenReadbackUnavailable(t *testing.T) {
	opts, procPath, _ := kernelFixture(t)
	opts.Runner = &sysctlSeqRunner{
		stubRunner: stubRunner{out: map[string]string{}, err: map[string]error{}},
		vals:       nil, // sysctl 全程不可用
	}
	// 直写假装成功但不落盘 → 回读的 /proc 兜底也读不到。
	writeProcSys = func(string, string) error { return nil }

	if err := EnsureKernelParams(context.Background(), opts); err == nil {
		t.Fatal("两个回读来源都不可用时必须报错（K5 改 WARN 的兜底不能失效）")
	} else if !strings.Contains(err.Error(), "无法回读") {
		t.Errorf("错误要说明「无法回读」: %v", err)
	}
	if _, statErr := os.Stat(procPath); statErr == nil {
		t.Error("此用例不应有 /proc 文件被真的写出来")
	}
}

// TestEnsureKernelParamsProcFallbackReadback 无 sysctl 命令：/proc 直读兜底也要
// 完成回读；before 读不到时记作 `-`，不能让日志出现空段。
func TestEnsureKernelParamsProcFallbackReadback(t *testing.T) {
	opts, procPath, log := kernelFixture(t)
	opts.Runner = &sysctlSeqRunner{
		stubRunner: stubRunner{out: map[string]string{}, err: map[string]error{}},
		vals:       nil, // sysctl 不可用
	}
	// 真 writeProcSys 把值写进注入的 procPath，回读兜底读同一文件。

	if err := EnsureKernelParams(context.Background(), opts); err != nil {
		t.Fatalf("/proc 兜底路径不应失败: %v", err)
	}
	if !strings.Contains(log.String(), "- → 262144") {
		t.Errorf("before 读不到时应记作 `-`:\n%s", log.String())
	}
	if raw, err := os.ReadFile(procPath); err != nil || strings.TrimSpace(string(raw)) != "262144" {
		t.Errorf("直写内容不对: %q err=%v", raw, err)
	}
}

// TestEnsureKernelParamsWriteFailureIsWrapped 无 sysctl 且 /proc 直写失败：报错要
// 提到具体路径（否则现场没法判断是哪个文件写不了）。
func TestEnsureKernelParamsWriteFailureIsWrapped(t *testing.T) {
	opts, procPath, _ := kernelFixture(t)
	opts.Runner = &sysctlSeqRunner{
		stubRunner: stubRunner{out: map[string]string{}, err: map[string]error{}},
		vals:       nil,
	}
	writeProcSys = func(string, string) error { return errors.New("permission denied") }

	err := EnsureKernelParams(context.Background(), opts)
	if err == nil {
		t.Fatal("直写失败必须报错")
	}
	if !strings.Contains(err.Error(), procPath) || !strings.Contains(err.Error(), "permission denied") {
		t.Errorf("错误应包含直写路径与原始错误: %v", err)
	}
}
