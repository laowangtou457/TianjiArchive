package preflight

import (
	"context"
	"errors"
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
	// 无参数命令若不 TrimSpace，键会变成 "getenforce "（末尾多一个空格），
	// 于是「明明给了输出却当成命令不存在」——这种假失败会误导用例本身。
	key := strings.TrimSpace(name + " " + strings.Join(args, " "))
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
			"modprobe overlay":                            "",
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

// TestCheckWarnsWhenMaxMapCountTooLow —— K5 的口径用例。
//
// vm.max_map_count 不足不再判 FAIL（真机 e2e 2026-11-10 裁定）：payload 里带
// /etc/sysctl.d/99-tianji.conf，S3_DOCKER 会落盘并生效、回读核对。S1 把一个会被
// 自动修复的项判成阻断是自相矛盾。但降级必须是 WARN 而不是放行——Hint 要说明
// S3 会修、修不好会在 S3 阻断，让用户显式确认，而不是静默通过。
func TestCheckWarnsWhenMaxMapCountTooLow(t *testing.T) {
	root := fixtureRoot(t, map[string]string{
		"etc/os-release":   goodOSRelease(),
		"proc/filesystems": "nodev\toverlay\n",
		"proc/meminfo":     "MemTotal:       16384000 kB\n",
	})
	r := goodRunner()
	r.out["sysctl -n vm.max_map_count"] = "65530\n"

	rep := Check(context.Background(), Options{Variant: "ubuntu-debian", RootDir: root, Runner: r})
	if !rep.OK() {
		t.Fatalf("vm.max_map_count=65530 应判定 WARN（不再阻断），实际有 FAIL: %+v", rep.Failed())
	}
	var k5 Item
	for _, it := range rep.Warnings() {
		if it.ID == "K5" {
			k5 = it
		}
	}
	if k5.ID != "K5" {
		t.Fatalf("应有一条 K5 WARN，实际 WARN 项: %+v", rep.Warnings())
	}
	if !strings.Contains(k5.Detail, "S3_DOCKER 将自动修复") {
		t.Errorf("K5 结论要说明 S3 会自动修复: %q", k5.Detail)
	}
	if !strings.Contains(k5.Hint, "ES") || !strings.Contains(k5.Hint, "99-tianji.conf") {
		t.Errorf("K5 提示要说明 ES 会崩、S3 将写入 99-tianji.conf: %q", k5.Hint)
	}
	if !strings.Contains(k5.Hint, "S3 阻断") {
		t.Errorf("K5 提示要说明修不好会在 S3 阻断（不是静默放行）: %q", k5.Hint)
	}
	if got := rep.Facts["vm.max_map_count"]; got != "65530" {
		t.Errorf("Facts[vm.max_map_count] = %q，期望 65530", got)
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

// mutatorRunner 是带副作用的 stub：`modprobe overlay` 被调用时改写 fixture 里的
// /proc/filesystems。用它证明 K3 的判定时序——文件必须是在 modprobe **之后**读的，
// 旧写法（先读文件再 modprobe）在全新机器上读到的是「模块未加载」的旧状态。
type mutatorRunner struct {
	stubRunner
	fsPath       string // fixture 的 proc/filesystems 绝对路径
	fsAfterProbe string // modprobe 成功后要写入的新内容
	modprobes    int
}

func (m *mutatorRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	if name == "modprobe" {
		m.modprobes++
		// fsAfterProbe 为空串表示「没有新状态可写」——保持 modprobe 自身的
		// 返回值语义，不因 fixture 不存在而引入旁路错误。
		if m.fsAfterProbe != "" {
			if err := os.WriteFile(m.fsPath, []byte(m.fsAfterProbe), 0o644); err != nil {
				return "", err
			}
		}
	}
	return m.stubRunner.Run(ctx, name, args...)
}

// TestCheckOverlay2Ordering 表驱动覆盖 K3 的全部判定分支，重点是「先 modprobe，
// 再读 /proc/filesystems」——真机实测（麒麟 V10 SP3）：全新机器 overlay 模块默认
// 不加载，/proc/filesystems 只在 modprobe 之后才列出 `nodev overlay`。
// 支持口径：modprobe 退出码 0，或 modprobe 后 /proc/filesystems 含 overlay。
func TestCheckOverlay2Ordering(t *testing.T) {
	const fsWithOverlay = "nodev\tsysfs\nnodev\toverlay\n"
	const fsWithoutOverlay = "nodev\tsysfs\n\txfs\n"
	probeErr := errors.New("exit status 1") // modprobe 加载失败（内核没这个模块）

	cases := []struct {
		name       string
		fsBefore   string // modprobe 前 /proc/filesystems 的内容
		fsAfter    string // modprobe 调用时被改写成的内容（空串=不改写）
		probeErr   error  // modprobe 的返回错误（nil=成功）
		want       Level
		wantDetail string // 结论必须包含的字样
	}{
		{
			// 全新机器的真实形态：文件里没有 overlay，但 modprobe 能载入 → 必须判定支持。
			name:       "fresh machine: modprobe ok, file had no overlay",
			fsBefore:   fsWithoutOverlay,
			fsAfter:    fsWithOverlay,
			want:       LevelPass,
			wantDetail: "modprobe 成功",
		},
		{
			name:       "module already loaded: file lists overlay",
			fsBefore:   fsWithOverlay,
			fsAfter:    fsWithOverlay,
			want:       LevelPass,
			wantDetail: "modprobe",
		},
		{
			name:       "modprobe fails and file has no overlay: kernel lacks overlayfs",
			fsBefore:   fsWithoutOverlay,
			fsAfter:    fsWithoutOverlay,
			probeErr:   probeErr,
			want:       LevelFail,
			wantDetail: "内核不支持 overlayfs",
		},
		{
			// modprobe 失败但模块其实已加载/内建：以文件为准，不能误报 FAIL。
			name:       "modprobe fails but overlay is listed: still supported",
			fsBefore:   fsWithOverlay,
			fsAfter:    fsWithOverlay,
			probeErr:   probeErr,
			want:       LevelPass,
			wantDetail: "模块已加载/内建",
		},
		{
			// 两路证据都拿不到（文件读不到 + modprobe 失败）：判不了就 WARN，不许放行也不许误杀。
			name:       "both probes unavailable: WARN not FAIL",
			fsBefore:   "",
			fsAfter:    "",
			probeErr:   probeErr,
			want:       LevelWarn,
			wantDetail: "无法判定",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// fsBefore 为空串时不写该 fixture（模拟 /proc/filesystems 读不到）。
			files := map[string]string{
				"etc/os-release": goodOSRelease(),
				"proc/meminfo":   "MemTotal:       16384000 kB\n",
			}
			if tc.fsBefore != "" {
				files["proc/filesystems"] = tc.fsBefore
			}
			root := fixtureRoot(t, files)
			fsPath := filepath.Join(root, "proc", "filesystems")

			r := goodRunner()
			mr := &mutatorRunner{stubRunner: r, fsPath: fsPath, fsAfterProbe: tc.fsAfter}
			if tc.probeErr != nil {
				// goodRunner 里 modprobe 是成功的，覆盖成失败。
				mr.err = map[string]error{"modprobe overlay": tc.probeErr}
			}

			rep := Check(context.Background(), Options{Variant: "ubuntu-debian", RootDir: root, Runner: mr})
			var k3 Item
			for _, it := range rep.Items {
				if it.ID == "K3" {
					k3 = it
				}
			}
			if k3.ID != "K3" {
				t.Fatalf("没有 K3 项: %+v", rep.Items)
			}
			if k3.Level != tc.want {
				t.Fatalf("K3 = %v，期望 %v；Detail=%s\nRaw:\n%s", k3.Level, tc.want, k3.Detail, k3.Raw)
			}
			if !strings.Contains(k3.Detail, tc.wantDetail) {
				t.Errorf("K3 结论 %q 应包含 %q", k3.Detail, tc.wantDetail)
			}
			if mr.modprobes != 1 {
				t.Errorf("modprobe 应恰好被调用 1 次，实际 %d 次（时序 discipline 被破坏？）", mr.modprobes)
			}
			// 时序证明：fsAfterProbe 改写只发生在 modprobe 调用时；若实现是
			// 「先读文件再 modprobe」，读到的是 fsBefore，Raw 里不会出现 true。
			if tc.fsAfter != "" && tc.fsBefore != tc.fsAfter {
				if !strings.Contains(k3.Raw, "含 overlay（modprobe 之后读取）: true") {
					t.Errorf("Raw 应记录 modprobe 之后读到的 overlay=true（证明读取时序）:\n%s", k3.Raw)
				}
			}
		})
	}
}
