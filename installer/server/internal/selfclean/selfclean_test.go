package selfclean

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 关键回归：清理必须幂等。安装器在 defer 与 SIGINT/SIGTERM 两处都会调用它，
// 两路同时到达时不能互相干扰，否则会出现「二次 Close 报错被写进汇总」。
func TestRunIsIdempotent(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	c := New()
	c.AddListener("测试监听", l)
	c.AddFunc("计数", func() error { return nil })

	first := c.Run()
	if len(first) != 2 {
		t.Fatalf("首次应清理 2 项，实际 %d", len(first))
	}
	second := c.Run()
	if len(second) != len(first) {
		t.Fatalf("重复调用应返回同一份结果，实际 %d vs %d", len(second), len(first))
	}
	for _, s := range second {
		if s.Err != nil {
			t.Fatalf("重复清理不应报错: %s: %v", s.Name, s.Err)
		}
	}
	// 端口必须真的被释放
	if _, dialErr := net.DialTimeout("tcp", l.Addr().String(), 200*time.Millisecond); dialErr == nil {
		t.Fatal("监听未释放，端口仍可连接")
	}
}

func TestRunRemovesTempDirs(t *testing.T) {
	dir := t.TempDir()
	tmp := filepath.Join(dir, "installer-tmp")
	if err := os.MkdirAll(filepath.Join(tmp, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "sub", "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := New()
	c.AddTempDir(tmp)
	steps := c.Run()
	if len(steps) != 1 || steps[0].Err != nil {
		t.Fatalf("删除临时目录应成功: %+v", steps)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Fatalf("临时目录应已删除: %v", err)
	}
}

func TestSummarize(t *testing.T) {
	ok := Summarize([]Step{{Name: "关闭监听"}, {Name: "删 tmp"}})
	if !strings.Contains(ok, "无异常") {
		t.Fatalf("全成功时应说无异常: %s", ok)
	}
	bad := Summarize([]Step{{Name: "关闭监听", Err: errors.New("boom")}})
	if !strings.Contains(bad, "关闭监听: boom") {
		t.Fatalf("应列出失败项: %s", bad)
	}
}

// Countdown 必须能被 skip 通道提前打断（完成页的「立即结束」）。
func TestCountdownCanBeSkipped(t *testing.T) {
	skip := make(chan struct{})
	go func() {
		time.Sleep(50 * time.Millisecond)
		close(skip)
	}()
	start := time.Now()
	done := Countdown(nil, 5*time.Second, skip, nil)
	if done {
		t.Fatal("被跳过时不应返回 true")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("skip 未生效，倒计时没被打断")
	}
}
