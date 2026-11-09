package execx

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestTailKeepsLastLines(t *testing.T) {
	r := Result{Stdout: "1\n2\n3\n4\n5\n"}
	if got := r.Tail(2); got != "4\n5" {
		t.Fatalf("Tail(2) 应为 %q，实际 %q", "4\n5", got)
	}
	if got := r.Tail(0); got != "" {
		t.Fatalf("Tail(0) 应为空，实际 %q", got)
	}
	if got := r.Tail(100); !strings.HasPrefix(got, "1") {
		t.Fatalf("行数不足时应全给: %q", got)
	}
}

func TestCombinedPrefersBoth(t *testing.T) {
	r := Result{Stdout: "out", Stderr: "err"}
	if got := r.Combined(); got != "out\nerr" {
		t.Fatalf("Combined 不对: %q", got)
	}
	if got := (Result{Stdout: "only"}).Combined(); got != "only" {
		t.Fatalf("只有 stdout 时不对: %q", got)
	}
}

func TestErrorIncludesTailAndExitCode(t *testing.T) {
	e := &Error{Result: Result{Command: "dpkg -i a.deb", ExitCode: 2, Stderr: "line1\nline2\n"}}
	msg := e.Error()
	if !strings.Contains(msg, "退出码 2") || !strings.Contains(msg, "dpkg -i a.deb") {
		t.Fatalf("错误信息缺关键信息: %s", msg)
	}
	if !strings.Contains(msg, "line2") {
		t.Fatalf("错误信息应带最后输出: %s", msg)
	}
}

// Windows 上的 sh 不存在，命令执行相关用例只在类 Unix 上跑。
func TestOSRunnerCapturesExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 无 sh，跳过真实执行用例")
	}
	r := OSRunner{}
	res, err := r.Run(context.Background(), "sh", "-c", "echo out; echo err >&2; exit 3")
	if err == nil {
		t.Fatal("非零退出码必须返回 error")
	}
	if res.ExitCode != 3 {
		t.Fatalf("退出码应为 3，实际 %d", res.ExitCode)
	}
	if !strings.Contains(res.Stdout, "out") || !strings.Contains(res.Stderr, "err") {
		t.Fatalf("stdout/stderr 未分别捕获: %+v", res)
	}
	var execErr *Error
	if !errors.As(err, &execErr) {
		t.Fatalf("错误应可断言为 *Error: %T", err)
	}
}

func TestOSRunnerWritesSink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 无 sh，跳过真实执行用例")
	}
	var sb strings.Builder
	r := OSRunner{Sink: &sb}
	_, _ = r.Run(context.Background(), "sh", "-c", "echo hello-sink")
	if !strings.Contains(sb.String(), "hello-sink") {
		t.Fatalf("Sink 未收到输出: %q", sb.String())
	}
}

func TestOSRunnerRespectsContextTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 无 sh，跳过真实执行用例")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := (OSRunner{}).Run(ctx, "sh", "-c", "sleep 5")
	if err == nil {
		t.Fatal("超时必须返回 error")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("超时未生效")
	}
}
