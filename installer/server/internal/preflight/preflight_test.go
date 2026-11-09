package preflight

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stubRunner 用固定输出模拟命令，避免单测依赖真实内核状态。
type stubRunner struct {
	out map[string]string
	err map[string]error
}

func (s stubRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	key := name + " " + strings.Join(args, " ")
	if err, ok := s.err[key]; ok {
		return "", err
	}
	if v, ok := s.out[key]; ok {
		return v, nil
	}
	return "", os.ErrNotExist
}

func fixtureRoot(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, content := range files {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("建目录失败: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("写 fixture 失败: %v", err)
		}
	}
	return root
}

func goodOSRelease() string {
	return `NAME="Ubuntu"
ID=ubuntu
VERSION_ID="22.04"
VERSION_CODENAME=jammy
`
}

func goodRunner() stubRunner {
	return stubRunner{
		out: map[string]string{
			"uname -r":                                    "5.15.0-91-generic\n",
			"uname -m":                                    "x86_64\n",
			"stat -fc %T /sys/fs/cgroup":                  "cgroup2fs\n",
			"sysctl -n vm.max_map_count":                  "262144\n",
			"sh -c ulimit -l; ulimit -n":                  "unlimited\n65535\n",
			"iptables -V":                                 "iptables v1.8.7\n",
			"df -B1 --output=avail /var":                  "Avail\n107374182400\n",
			"docker version --format {{.Server.Version}}": "",
		},
	}
}

func TestCheckAllGreenOnHealthyHost(t *testing.T) {
	root := fixtureRoot(t, map[string]string{
		"etc/os-release":                         goodOSRelease(),
		"proc/filesystems":                       "nodev\tsysfs\nnodev\toverlay\n",
		"proc/meminfo":                           "MemTotal:       16384000 kB\n",
		"sys/module/apparmor/parameters/enabled": "N\n",
	})
	rep := Check(context.Background(), Options{Variant: "ubuntu-debian", RootDir: root, Runner: goodRunner()})

	if !rep.OK() {
		t.Fatalf("健康主机不应有 FAIL: %+v", rep.Failed())
	}
	if len(rep.Warnings()) != 0 {
		t.Fatalf("健康主机不应有 WARN: %+v", rep.Warnings())
	}
	if rep.Facts["os_id"] != "ubuntu" || rep.Facts["kernel"] != "5.15.0-91-generic" {
		t.Fatalf("facts 采集不对: %+v", rep.Facts)
	}
	if got := len(rep.Items); got < 13 {
		t.Fatalf("应覆盖 K0~K13，实际只有 %d 项", got)
	}
}

// 关键回归：vm.max_map_count 不足必须 FAIL，这是 ES 起不来的头号原因。
func TestCheckFailsWhenMaxMapCountTooLow(t *testing.T) {
	root := fixtureRoot(t, map[string]string{
		"etc/os-release":   goodOSRelease(),
		"proc/filesystems": "nodev\toverlay\n",
		"proc/meminfo":     "MemTotal:       16384000 kB\n",
	})
	r := goodRunner()
	r.out["sysctl -n vm.max_map_count"] = "65530\n"

	rep := Check(context.Background(), Options{Variant: "ubuntu-debian", RootDir: root, Runner: r})
	if rep.OK() {
		t.Fatal("vm.max_map_count=65530 应判定 FAIL")
	}
	failed := rep.Failed()
	if len(failed) != 1 || failed[0].ID != "K5" {
		t.Fatalf("应只 K5 失败，实际 %+v", failed)
	}
	if !strings.Contains(failed[0].Hint, "ES") {
		t.Fatalf("K5 的提示必须说明 ES 会崩: %q", failed[0].Hint)
	}
}

func TestCheckFailsOnWrongArchitecture(t *testing.T) {
	root := fixtureRoot(t, map[string]string{
		"etc/os-release":   goodOSRelease(),
		"proc/filesystems": "nodev\toverlay\n",
		"proc/meminfo":     "MemTotal:       16384000 kB\n",
	})
	r := goodRunner()
	r.out["uname -m"] = "aarch64\n"

	rep := Check(context.Background(), Options{Variant: "ubuntu-debian", RootDir: root, Runner: r})
	var found bool
	for _, it := range rep.Failed() {
		if it.ID == "K2" {
			found = true
		}
	}
	if !found {
		t.Fatal("非 x86_64 架构必须 FAIL")
	}
}

func TestCheckWarnsOnSmallDiskAndMemory(t *testing.T) {
	root := fixtureRoot(t, map[string]string{
		"etc/os-release":   goodOSRelease(),
		"proc/filesystems": "nodev\toverlay\n",
		"proc/meminfo":     "MemTotal:        4194304 kB\n", // 4GB → FAIL
	})
	r := goodRunner()
	r.out["df -B1 --output=avail /var"] = "Avail\n40000000000\n" // ~37GB → WARN

	rep := Check(context.Background(), Options{Variant: "ubuntu-debian", RootDir: root, Runner: r})
	if rep.OK() {
		t.Fatal("4GB 内存应 FAIL")
	}
	var hasMem, hasDiskWarn bool
	for _, it := range rep.Items {
		if it.ID == "K10" && it.Level == LevelFail {
			hasMem = true
		}
		if it.ID == "K9" && it.Level == LevelWarn {
			hasDiskWarn = true
		}
	}
	if !hasMem {
		t.Fatal("K10 内存不足应 FAIL")
	}
	if !hasDiskWarn {
		t.Fatal("K9 磁盘 37GB 应 WARN")
	}
}

func TestVariantBSkipsDpkgLock(t *testing.T) {
	root := fixtureRoot(t, map[string]string{
		"etc/os-release":   "ID=kylin\nVERSION_ID=V10\nVERSION_CODENAME=kylin\n",
		"proc/filesystems": "nodev\toverlay\n",
		"proc/meminfo":     "MemTotal:       16384000 kB\n",
	})
	rep := Check(context.Background(), Options{Variant: "kylin-uos", RootDir: root, Runner: goodRunner()})
	for _, it := range rep.Items {
		if it.ID == "K11" && it.Level != LevelSkip {
			t.Fatalf("变体 B 的 K11 应为 SKIP，实际 %s", it.Level)
		}
	}
}

func TestReadOSReleaseHandlesQuotesAndComments(t *testing.T) {
	root := fixtureRoot(t, map[string]string{
		"etc/os-release": "# comment\nNAME=\"Ubuntu Server\"\nID=ubuntu\nVERSION_ID='22.04'\n",
	})
	got, err := ReadOSRelease(filepath.Join(root, "etc/os-release"))
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if got["ID"] != "ubuntu" || got["VERSION_ID"] != "22.04" || got["NAME"] != "Ubuntu Server" {
		t.Fatalf("解析结果不对: %+v", got)
	}
}

func TestParseKernel(t *testing.T) {
	cases := []struct {
		in           string
		major, minor int
	}{
		{"5.15.0-91-generic", 5, 15},
		{"4.19.90", 4, 19},
		{"garbage", 0, 0},
	}
	for _, c := range cases {
		major, minor := parseKernel(c.in)
		if major != c.major || minor != c.minor {
			t.Fatalf("%s 解析成 %d.%d，期望 %d.%d", c.in, major, minor, c.major, c.minor)
		}
	}
}
