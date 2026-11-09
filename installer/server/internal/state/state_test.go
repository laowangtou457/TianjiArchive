package state

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNewStartsAtPreflight(t *testing.T) {
	s := New("tianji-archive", "1.0.0", "ubuntu-debian", "amd64")
	if got := s.NextStep(); got != StepPreflight {
		t.Fatalf("首个未完成步骤应为 %s，实际 %s", StepPreflight, got)
	}
	if s.AllDone() {
		t.Fatal("全新状态机不应判定为已完成")
	}
	if len(s.Steps) != len(Steps) {
		t.Fatalf("步骤数应为 %d，实际 %d", len(Steps), len(s.Steps))
	}
}

// 关键回归：FAIL 不能推进 NextStep，否则 --resume 会跳过失败步骤。
func TestFailDoesNotAdvance(t *testing.T) {
	s := New("tianji-archive", "1.0.0", "ubuntu-debian", "amd64")
	s.Begin(StepPreflight)
	s.Fail(StepPreflight, 1, "内核版本过低", "uname -r => 3.10.0")
	if got := s.NextStep(); got != StepPreflight {
		t.Fatalf("FAIL 后仍应停在 %s，实际 %s", StepPreflight, got)
	}
	if s.IsDone(StepPreflight) {
		t.Fatal("FAIL 的步骤不得被视为 DONE")
	}
	rec := s.Steps[StepPreflight]
	if rec.ExitCode != 1 || !strings.Contains(rec.Message, "内核") {
		t.Fatalf("FAIL 记录不完整: %+v", rec)
	}
}

func TestCompleteAdvancesInOrder(t *testing.T) {
	s := New("tianji-archive", "1.0.0", "ubuntu-debian", "amd64")
	for _, step := range []Step{StepPreflight, StepVerify, StepDocker} {
		s.Begin(step)
		s.Complete(step, "ok")
	}
	if got := s.NextStep(); got != StepImages {
		t.Fatalf("应停在 %s，实际 %s", StepImages, got)
	}
}

func TestResetFromClearsTail(t *testing.T) {
	s := New("tianji-archive", "1.0.0", "ubuntu-debian", "amd64")
	for _, step := range Steps {
		s.Begin(step)
		s.Complete(step, "ok")
	}
	if !s.AllDone() {
		t.Fatal("全部标记完成后 AllDone 应为 true")
	}
	if err := s.Reset(StepEnv); err != nil {
		t.Fatalf("Reset 失败: %v", err)
	}
	if s.Status(StepImages) != StatusDone {
		t.Fatal("Reset 不应清掉 Env 之前的步骤")
	}
	if s.Status(StepEnv) != StatusPending || s.Status(StepDone) != StatusPending {
		t.Fatal("Reset 应清掉 Env 及其后续步骤")
	}
	if err := s.Reset(Step("S99_UNKNOWN")); err == nil {
		t.Fatal("未知步骤应返回错误")
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	s := New("tianji-archive", "1.0.0", "ubuntu-debian", "amd64")
	s.SetFact("os_id", "ubuntu")
	s.Begin(StepPreflight)
	s.Complete(StepPreflight, "K1..K13 全绿")
	if err := s.Save(path); err != nil {
		t.Fatalf("Save 失败: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load 失败: %v", err)
	}
	if loaded.NextStep() != StepVerify {
		t.Fatalf("重入点应为 %s，实际 %s", StepVerify, loaded.NextStep())
	}
	if loaded.Facts["os_id"] != "ubuntu" {
		t.Fatalf("facts 未持久化: %+v", loaded.Facts)
	}
	// 落盘文件不允许是 0644：状态里含安装探针结果，按敏感文件处理。
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat 失败: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("state.json 权限应为 0600，实际 %o", info.Mode().Perm())
	}
}

func TestLoadMissingReturnsNil(t *testing.T) {
	got, err := Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("文件不存在不应报错: %v", err)
	}
	if got != nil {
		t.Fatal("文件不存在应返回 nil")
	}
}

func TestLoadRejectsWrongVersion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte(`{"formatVersion": 999, "steps": {}}`), 0o600); err != nil {
		t.Fatalf("准备测试文件失败: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("版本不兼容应报错，不能猜着用")
	}
}

func TestTruncateKeepsTail(t *testing.T) {
	long := strings.Repeat("A", 100) + "TAIL"
	got := truncate(long, 10)
	if !strings.HasSuffix(got, "TAIL") {
		t.Fatalf("截断应保留尾部，实际 %q", got)
	}
	if len(got) > len(long) {
		t.Fatal("截断不应变长")
	}
}
