package images

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tianji-archive/installer/internal/execx"
)

// stubRunner 记录被调用的命令，并按 key 返回预置输出，用于验证「失败即停」。
type stubRunner struct {
	calls []string
	out   map[string]string
	err   map[string]error
}

func (s *stubRunner) Run(_ context.Context, name string, args ...string) (execx.Result, error) {
	key := name + " " + strings.Join(args, " ")
	s.calls = append(s.calls, key)
	res := execx.Result{Command: key, Stdout: s.out[key]}
	if err, ok := s.err[key]; ok {
		res.ExitCode = 1
		return res, err
	}
	if _, ok := s.out[key]; !ok {
		res.ExitCode = 1
		return res, errors.New("未预置输出: " + key)
	}
	return res, nil
}

func (s *stubRunner) called(substr string) bool {
	for _, c := range s.calls {
		if strings.Contains(c, substr) {
			return true
		}
	}
	return false
}

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	full := filepath.Join(dir, name)
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return full
}

const imageList = `# 离线部署镜像清单
postgres:16-alpine
redis:7-alpine
tianji-archive-api:1.0.0
`

func TestReadListIgnoresCommentsAndBlankLines(t *testing.T) {
	got := ReadList(imageList + "\n\n  \n")
	want := []string{"postgres:16-alpine", "redis:7-alpine", "tianji-archive-api:1.0.0"}
	if len(got) != len(want) {
		t.Fatalf("条数不对: %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 条不对: %v", i, got)
		}
	}
}

// 关键回归：sha256 不匹配时**不能**执行 docker load。
// 先 load 再校验会让宿主机残留半套可信度不明的镜像。
func TestLoadStopsBeforeLoadOnSHAMismatch(t *testing.T) {
	dir := t.TempDir()
	tar := writeFile(t, dir, "tianji-offline-images.tar", "not really a tar")
	list := writeFile(t, dir, "images.txt", imageList)

	runner := &stubRunner{out: map[string]string{}, err: map[string]error{}}
	opts := Options{
		TarPath:        tar,
		ListPath:       list,
		ExpectedSHA256: strings.Repeat("f", 64),
		ExpectedCount:  3,
		Runner:         runner,
		Hash:           func(string) (string, error) { return strings.Repeat("0", 64), nil },
	}
	_, err := Load(context.Background(), opts)
	if err == nil {
		t.Fatal("sha256 不匹配必须报错")
	}
	if !strings.Contains(err.Error(), "校验失败") {
		t.Fatalf("错误信息应说明校验失败: %v", err)
	}
	if runner.called("docker load") {
		t.Fatal("校验未通过时绝不能执行 docker load")
	}
	if !strings.Contains(err.Error(), "U 盘传输损坏") {
		t.Fatalf("应给出可执行的处置建议: %v", err)
	}
}

func TestLoadFailsWhenImageMissing(t *testing.T) {
	dir := t.TempDir()
	tar := writeFile(t, dir, "tianji-offline-images.tar", "tar")
	list := writeFile(t, dir, "images.txt", imageList)

	runner := &stubRunner{
		out: map[string]string{
			"docker load -i " + tar: "Loaded image: postgres:16-alpine\n",
			"docker image inspect --format {{.Id}} postgres:16-alpine": "sha256:aaaa1111\n",
			"docker image inspect --format {{.Id}} redis:7-alpine":     "sha256:bbbb2222\n",
		},
		err: map[string]error{},
	}
	opts := Options{
		TarPath:        tar,
		ListPath:       list,
		ExpectedSHA256: "abc",
		ExpectedCount:  3,
		Runner:         runner,
		Hash:           func(string) (string, error) { return "abc", nil },
	}
	res, err := Load(context.Background(), opts)
	if err == nil {
		t.Fatal("缺镜像必须报错")
	}
	if !strings.Contains(err.Error(), "2/3") {
		t.Fatalf("错误信息应给出到位数 2/3: %v", err)
	}
	missing := res.Missing()
	if len(missing) != 1 || missing[0] != "tianji-archive-api:1.0.0" {
		t.Fatalf("缺失清单不对: %v", missing)
	}
}

func TestLoadSucceedsWhenAllImagesPresent(t *testing.T) {
	dir := t.TempDir()
	tar := writeFile(t, dir, "tianji-offline-images.tar", "tar")
	list := writeFile(t, dir, "images.txt", imageList)

	runner := &stubRunner{
		out: map[string]string{
			"docker load -i " + tar: "",
			"docker image inspect --format {{.Id}} postgres:16-alpine":       "sha256:aaaa1111",
			"docker image inspect --format {{.Id}} redis:7-alpine":           "sha256:bbbb2222",
			"docker image inspect --format {{.Id}} tianji-archive-api:1.0.0": "sha256:cccc3333",
		},
		err: map[string]error{},
	}
	res, err := Load(context.Background(), Options{
		TarPath:        tar,
		ListPath:       list,
		ExpectedSHA256: "abc",
		ExpectedCount:  3,
		Runner:         runner,
		Hash:           func(string) (string, error) { return "abc", nil },
	})
	if err != nil {
		t.Fatalf("全部到位不该报错: %v", err)
	}
	if res.LoadedCount() != 3 {
		t.Fatalf("到位数应为 3，实际 %d", res.LoadedCount())
	}
}

func TestLoadRejectsEmptyExpectedSHA(t *testing.T) {
	dir := t.TempDir()
	tar := writeFile(t, dir, "t.tgz", "x")
	list := writeFile(t, dir, "images.txt", imageList)
	_, err := Load(context.Background(), Options{TarPath: tar, ListPath: list, Runner: &stubRunner{}})
	if err == nil || !strings.Contains(err.Error(), "拒绝导入") {
		t.Fatalf("缺期望 sha256 必须拒绝: %v", err)
	}
}

func TestLoadRejectsCountMismatch(t *testing.T) {
	dir := t.TempDir()
	tar := writeFile(t, dir, "t.tgz", "x")
	list := writeFile(t, dir, "images.txt", imageList)
	_, err := Load(context.Background(), Options{
		TarPath:        tar,
		ListPath:       list,
		ExpectedSHA256: "abc",
		ExpectedCount:  8,
		Runner:         &stubRunner{},
		Hash:           func(string) (string, error) { return "abc", nil },
	})
	if err == nil || !strings.Contains(err.Error(), "image_count") {
		t.Fatalf("清单条数与 manifest 不符必须报错: %v", err)
	}
}

func TestLoadRejectsMissingTar(t *testing.T) {
	dir := t.TempDir()
	list := writeFile(t, dir, "images.txt", imageList)
	_, err := Load(context.Background(), Options{
		TarPath:        filepath.Join(dir, "nope.tar"),
		ListPath:       list,
		ExpectedSHA256: "abc",
		Runner:         &stubRunner{},
		Hash: func(string) (string, error) {
			return "", os.ErrNotExist
		},
	})
	if err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("tar 不可读必须报错: %v", err)
	}
}
