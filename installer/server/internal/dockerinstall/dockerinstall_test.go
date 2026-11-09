package dockerinstall

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
)

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
		return res, errors.New("命令不可用: " + key)
	}
	return res, nil
}

func TestCheckComposeVersionAcceptsModernV2(t *testing.T) {
	r := &stubRunner{out: map[string]string{"docker compose version --short": "2.29.7\n"}}
	v, err := CheckComposeVersion(context.Background(), r)
	if err != nil {
		t.Fatalf("2.29.7 应通过: %v", err)
	}
	if v != "2.29.7" {
		t.Fatalf("版本解析不对: %q", v)
	}
}

// 关键回归（设计 §4.3）：compose v1 不认 name: 顶层键与 depends_on.condition，
// 必须硬拦，否则现场会在 up 时看到一堆看不懂的语法错误。
func TestCheckComposeVersionRejectsV1(t *testing.T) {
	r := &stubRunner{
		out: map[string]string{"docker compose version": "Docker Compose version v1.29.2\n"},
		err: map[string]error{"docker compose version --short": errors.New("unknown flag")},
	}
	_, err := CheckComposeVersion(context.Background(), r)
	if err == nil {
		t.Fatal("compose v1 必须被拒绝")
	}
	if !strings.Contains(err.Error(), "过低") {
		t.Fatalf("错误信息应说明版本过低: %v", err)
	}
	if !strings.Contains(err.Error(), "depends_on.condition") {
		t.Fatalf("错误信息应解释为什么不认 v1: %v", err)
	}
}

func TestCheckComposeVersionRejectsBorderline219(t *testing.T) {
	r := &stubRunner{out: map[string]string{"docker compose version --short": "2.19.1\n"}}
	if _, err := CheckComposeVersion(context.Background(), r); err == nil {
		t.Fatal("2.19.1 低于 2.20，应被拒绝")
	}
}

func TestCheckComposeVersionUnavailable(t *testing.T) {
	r := &stubRunner{out: map[string]string{}, err: map[string]error{}}
	if _, err := CheckComposeVersion(context.Background(), r); err == nil {
		t.Fatal("compose 不可用时必须报错")
	}
}

func TestExtractVersion(t *testing.T) {
	cases := map[string]string{
		"2.29.7":                         "2.29.7",
		"Docker Compose version v2.24.3": "2.24.3",
		"docker-compose version 1.29.2, build 5becea4c": "1.29.2",
		"乱七八糟": "",
	}
	for in, want := range cases {
		if got := extractVersion(in); got != want {
			t.Errorf("extractVersion(%q)=%q，期望 %q", in, got, want)
		}
	}
}

// 变体 A 载荷缺失时必须停在安装前，不能继续 dpkg。
func TestInstallFailsWhenDebsMissing(t *testing.T) {
	root := t.TempDir()
	r := &stubRunner{out: map[string]string{}, err: map[string]error{}}
	m := &buildplan.Manifest{Variant: buildplan.VariantUbuntuDebian, Arch: "amd64"}
	_, err := Install(context.Background(), Options{
		Layout:    buildplan.Layout{Root: root},
		Manifest:  m,
		Runner:    r,
		NoSystemd: true,
	})
	if err == nil {
		t.Fatal("缺 deb 载荷必须报错")
	}
	if !strings.Contains(err.Error(), "载荷缺失") {
		t.Fatalf("错误信息应说明载荷缺失: %v", err)
	}
	for _, c := range r.calls {
		if strings.HasPrefix(c, "dpkg -i") {
			t.Fatalf("载荷缺失时不应执行 dpkg -i，实际调用了 %s", c)
		}
	}
}

func TestInstallFailsWhenStaticMissing(t *testing.T) {
	root := t.TempDir()
	r := &stubRunner{out: map[string]string{}, err: map[string]error{}}
	_, err := Install(context.Background(), Options{
		Layout:    buildplan.Layout{Root: root},
		Manifest:  &buildplan.Manifest{Variant: buildplan.VariantKylinUOS, Arch: "amd64"},
		Runner:    r,
		NoSystemd: true,
	})
	if err == nil || !strings.Contains(err.Error(), "载荷缺失") {
		t.Fatalf("缺 static 包必须报错: %v", err)
	}
}

func TestVerifyDebManifestDetectsTamper(t *testing.T) {
	dir := t.TempDir()
	debA := filepath.Join(dir, "docker-ce_27.5.1_amd64.deb")
	debB := filepath.Join(dir, "libseccomp2_2.5.3_amd64.deb")
	for _, p := range []string{debA, debB} {
		if err := os.WriteFile(p, []byte(filepath.Base(p)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manifest := filepath.Join(dir, "DEBS-MANIFEST.txt")
	hash := func(path string) (string, error) { return "h-" + filepath.Base(path), nil }
	content := "h-docker-ce_27.5.1_amd64.deb  docker-ce_27.5.1_amd64.deb\n" +
		"h-libseccomp2_2.5.3_amd64.deb  libseccomp2_2.5.3_amd64.deb\n"
	if err := os.WriteFile(manifest, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyDebManifest(manifest, []string{debA, debB}, hash); err != nil {
		t.Fatalf("清单匹配时应通过: %v", err)
	}

	// 换掉其中一个包的哈希 → 必须能定位到文件名
	bad := "h-docker-ce_27.5.1_amd64.deb  docker-ce_27.5.1_amd64.deb\n" +
		"ffff  libseccomp2_2.5.3_amd64.deb\n"
	if err := os.WriteFile(manifest, []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	err := verifyDebManifest(manifest, []string{debA, debB}, hash)
	if err == nil || !strings.Contains(err.Error(), "libseccomp2") {
		t.Fatalf("应定位到具体 deb: %v", err)
	}
}

func TestVerifyDebManifestRejectsUnlistedDeb(t *testing.T) {
	dir := t.TempDir()
	deb := filepath.Join(dir, "extra.deb")
	if err := os.WriteFile(deb, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, "DEBS-MANIFEST.txt")
	if err := os.WriteFile(manifest, []byte("h-docker-ce  docker-ce_27.deb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := func(string) (string, error) { return "h", nil }
	err := verifyDebManifest(manifest, []string{deb}, hash)
	if err == nil || !strings.Contains(err.Error(), "未在 DEBS-MANIFEST") {
		t.Fatalf("未登记的 deb 必须报错: %v", err)
	}
}

func TestWaitDaemonTimesOut(t *testing.T) {
	r := &stubRunner{out: map[string]string{}, err: map[string]error{}}
	start := time.Now()
	_, err := WaitDaemon(context.Background(), r, 50*time.Millisecond, nil)
	if err == nil {
		t.Fatal("dockerd 一直起不来必须超时")
	}
	if !strings.Contains(err.Error(), "超时") {
		t.Fatalf("错误信息应说明超时: %v", err)
	}
	if !strings.Contains(err.Error(), "journalctl") {
		t.Fatalf("应给出排障指引: %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("超时判定明显偏慢")
	}
}

func TestWaitDaemonReturnsVersionOnceReady(t *testing.T) {
	r := &stubRunner{out: map[string]string{"docker version --format {{.Server.Version}}": "27.5.1\n"}}
	v, err := WaitDaemon(context.Background(), r, 2*time.Second, nil)
	if err != nil {
		t.Fatalf("就绪时应返回: %v", err)
	}
	if v != "27.5.1" {
		t.Fatalf("版本不对: %q", v)
	}
}

func TestParseMajorMinor(t *testing.T) {
	if maj, min, ok := parseMajorMinor("2.20.1"); !ok || maj != 2 || min != 20 {
		t.Fatalf("解析 2.20.1 失败: %d %d %v", maj, min, ok)
	}
	if _, _, ok := parseMajorMinor("2"); ok {
		t.Fatal("单段版本号应判为不可解析")
	}
}
