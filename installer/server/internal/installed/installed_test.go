package installed

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 为什么所有用例都用 t.TempDir() 拼路径：生产代码判的是 filepath.IsAbs，
// 而 "/srv/x" 在 Windows 上**不是**绝对路径（缺盘符），直接写 POSIX 路径
// 会让用例在构建机上以「清单是空的」这种形式假失败——测的就不是被测逻辑了。
func abs(t *testing.T, base string, rel ...string) string {
	t.Helper()
	return filepath.Join(append([]string{base}, rel...)...)
}

func TestAddRejectsRelativeAndRoot(t *testing.T) {
	rec := New("kylin-uos", "1.0.0")
	if err := rec.Add("volumes/esdata", KindDir, "x"); err == nil {
		t.Fatal("相对路径必须被拒绝：卸载时会被解析到当前目录")
	}
	if err := rec.Add("/", KindDir, "x"); err == nil {
		t.Fatal("根目录必须被拒绝")
	}
	if err := rec.Add("  ", KindFile, "x"); err == nil {
		t.Fatal("空路径必须被拒绝")
	}
	if err := rec.Add(abs(t, t.TempDir(), "docker-static"), KindDir, "ok"); err != nil {
		t.Fatalf("合法绝对路径应通过: %v", err)
	}
}

func TestAddIsIdempotent(t *testing.T) {
	unit := abs(t, t.TempDir(), "docker.service")
	rec := New("kylin-uos", "1.0.0")
	for i := 0; i < 3; i++ {
		if err := rec.Add(unit, KindFile, "unit"); err != nil {
			t.Fatalf("第 %d 次登记失败: %v", i+1, err)
		}
	}
	if len(rec.Entries) != 1 {
		t.Fatalf("重复登记应去重，实际 %d 项", len(rec.Entries))
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state", "installed-files.json")

	if rec, err := Load(path); err != nil || rec != nil {
		t.Fatalf("文件不存在时应返回 (nil, nil)，实际 (%v, %v)", rec, err)
	}

	base := t.TempDir()
	rec := New("kylin-uos", "1.0.0")
	if err := rec.Add(abs(t, base, "docker-static"), KindDir, "静态二进制目录"); err != nil {
		t.Fatal(err)
	}
	if err := rec.Add(abs(t, base, "docker.service"), KindFile, "unit"); err != nil {
		t.Fatal(err)
	}
	if err := rec.Save(path); err != nil {
		t.Fatalf("落盘失败: %v", err)
	}

	got, err := Load(path)
	if err != nil {
		t.Fatalf("读回失败: %v", err)
	}
	if got.Variant != "kylin-uos" || len(got.Entries) != 2 {
		t.Fatalf("读回内容不对: %+v", got)
	}
	if got.Entries[0].Kind != KindDir || got.Entries[1].Kind != KindFile {
		t.Fatalf("类别没保住: %+v", got.Entries)
	}
}

func TestLoadBrokenFileReportsError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "installed-files.json")
	if err := os.WriteFile(path, []byte("{不是 json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("清单损坏必须报错，不能当成「没装过」")
	}
}

// 核心纪律：只删清单里登记的，且文件先于目录。
func TestUninstallOnlyListedAndFilesBeforeDirs(t *testing.T) {
	base := t.TempDir()
	dir := abs(t, base, "docker-static")
	script := abs(t, base, "docker-static", "wait-ready.sh")
	unit := abs(t, base, "docker.service")

	var removed []string
	rec := New("kylin-uos", "1.0.0")
	_ = rec.Add(dir, KindDir, "dir")
	_ = rec.Add(script, KindFile, "script")
	_ = rec.Add(unit, KindFile, "unit")

	items := rec.Uninstall(RemoveOptions{Remove: func(p string) error {
		removed = append(removed, p)
		return nil
	}})

	if len(items) != 3 || len(removed) != 3 {
		t.Fatalf("应对 3 项全部执行删除，实际 items=%d removed=%d", len(items), len(removed))
	}
	if removed[0] == dir {
		t.Fatalf("目录必须排在文件之后删（否则子项会先变不存在），实际顺序 %v", removed)
	}
	if last := removed[len(removed)-1]; last != dir {
		t.Fatalf("目录应是最后一项，实际 %v", removed)
	}
}

func TestUninstallProtectsVolumesPrefix(t *testing.T) {
	base := t.TempDir()
	volumes := abs(t, base, "tianji", "volumes")
	esdata := abs(t, base, "tianji", "volumes", "esdata")
	decoy := abs(t, base, "tianji-backup-bak", "keep")

	rec := New("kylin-uos", "1.0.0")
	// 清单被人手改过、混进了业务数据路径：必须跳过，不是「删了再说」。
	_ = rec.Add(esdata, KindDir, "不该出现在清单里")
	_ = rec.Add(decoy, KindDir, "前缀相近但不是子路径")

	var removed []string
	items := rec.Uninstall(RemoveOptions{
		Protected: []string{volumes},
		Remove: func(p string) error {
			removed = append(removed, p)
			return nil
		},
	})

	if len(items) != 2 {
		t.Fatalf("应返回 2 项结果，实际 %d", len(items))
	}
	// 结果顺序按「深的先删」，所以按路径查而不是按下标断言。
	byPath := map[string]Removed{}
	for _, it := range items {
		byPath[it.Path] = it
	}
	if byPath[esdata].Skipped == "" {
		t.Fatalf("volumes 下的路径必须被跳过: %+v", byPath[esdata])
	}
	// tianji-backup-bak 与 tianji/volumes 只是字符串前缀相近，
	// 按路径分段比较就不该被判成受保护（否则运维自己的备份目录删不掉）。
	if byPath[decoy].Skipped != "" {
		t.Fatalf("字符串前缀相近的目录不该被误判为受保护: %+v", byPath[decoy])
	}
	if len(removed) != 1 || removed[0] != decoy {
		t.Fatalf("只有非受保护项才应真正删除，实际 %v", removed)
	}
}

func TestUninstallDryRunTouchesNothing(t *testing.T) {
	rec := New("kylin-uos", "1.0.0")
	_ = rec.Add(abs(t, t.TempDir(), "docker.service"), KindFile, "unit")

	called := false
	items := rec.Uninstall(RemoveOptions{DryRun: true, Remove: func(string) error {
		called = true
		return nil
	}})
	if called {
		t.Fatal("干跑不许真的删")
	}
	if len(items) != 1 || !strings.Contains(items[0].Skipped, "干跑") {
		t.Fatalf("干跑应标记 Skipped，实际 %+v", items)
	}
}

func TestUninstallReportsErrorsButKeepsGoing(t *testing.T) {
	base := t.TempDir()
	first, second := abs(t, base, "b"), abs(t, base, "c")

	rec := New("kylin-uos", "1.0.0")
	_ = rec.Add(first, KindFile, "x")
	_ = rec.Add(second, KindFile, "y")

	items := rec.Uninstall(RemoveOptions{Remove: func(p string) error {
		if p == first {
			return errors.New("device or resource busy")
		}
		return nil
	}})
	if len(items) != 2 {
		t.Fatalf("一项失败不该中断其余项，实际 %d 项", len(items))
	}
	var failed int
	for _, it := range items {
		if it.Err != nil {
			failed++
		}
	}
	if failed != 1 {
		t.Fatalf("应恰好 1 项失败，实际 %d", failed)
	}
}

func TestUninstallTreatsNotExistAsSuccess(t *testing.T) {
	rec := New("kylin-uos", "1.0.0")
	_ = rec.Add(abs(t, t.TempDir(), "already-gone"), KindFile, "x")
	items := rec.Uninstall(RemoveOptions{Remove: func(string) error {
		return os.ErrNotExist
	}})
	if items[0].Err != nil {
		t.Fatalf("文件本就不在不算失败（重跑卸载不该报错）: %v", items[0].Err)
	}
}

func TestSummaryCounts(t *testing.T) {
	items := []Removed{
		{Path: "a"},
		{Path: "b", Skipped: "受保护"},
		{Path: "c", Err: errors.New("busy")},
	}
	got := Summary(items)
	for _, want := range []string{"已删除 1 项", "跳过 1 项", "失败 1 项"} {
		if !strings.Contains(got, want) {
			t.Fatalf("汇总缺 %q：%s", want, got)
		}
	}
	if Summary(nil) == "" {
		t.Fatal("空清单也要给人话")
	}
}
