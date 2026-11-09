package preflight

// 变体 B 六项预检的回归用例。
//
// 三条纪律各有一组用例守着：
//  1. 「命令不存在」「命令超时」「输出异常」三类必须产出**可读的**结论，不能 panic、
//     不能静默变成 PASS（预检最贵的错误是把查不出来写成没问题）。
//  2. SELinux 只认 getenforce：配置写着 enforcing 而实际 Disabled 时必须是 PASS
//     （麒麟实测的坑，按配置文件判会误报）。
//  3. kysec：探测失败 ≠ 已关闭；强制态 + 执行控制开启才 FAIL。

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const kylinOSRelease = `NAME="Kylin Linux Advanced Server"
ID=kylin
VERSION_ID="V10"
VERSION="V10 (SP3)"
`

func kylinFixture(t *testing.T, extra map[string]string) string {
	t.Helper()
	files := map[string]string{
		"etc/os-release":   kylinOSRelease,
		"proc/filesystems": "nodev\tsysfs\nnodev\toverlay\n\txfs\n",
	}
	for k, v := range extra {
		files[k] = v
	}
	return fixtureRoot(t, files)
}

// itemByID 取某一项结果，取不到直接失败（少一项等于少一条防线）。
func itemByID(t *testing.T, rep *Report, id string) Item {
	t.Helper()
	for _, it := range rep.Items {
		if it.ID == id {
			return it
		}
	}
	t.Fatalf("报告里没有 %s 项，实际项：%+v", id, rep.Items)
	return Item{}
}

// kylinRunner 是「麒麟最小化安装」的实测形态：kysec-utils 未装、SELinux Disabled、
// firewalld 在跑、iptables 是 legacy。
func kylinRunner() stubRunner {
	return stubRunner{
		out: map[string]string{
			"stat -fc %T /sys/fs/cgroup":       "tmpfs\n",
			"getenforce":                       "Disabled\n",
			"sh -c command -v getstatus":       "",
			"iptables --version":               "iptables v1.8.4 (legacy)\n",
			"sh -c command -v iptables-legacy": "/usr/sbin/iptables-legacy\n",
			"sh -c command -v iptables-nft":    "",
			"uname -r":                         "4.19.90-89.11.v2401.ky10.x86_64\n",
			"modprobe overlay":                 "",
			"stat -f -c %T /var/lib":           "xfs\n",
			"firewall-cmd --state":             "running\n",
			"rpm -q container-selinux":         "",
		},
	}
}

// TestCheckVariantBKylinMinimalBaseline 复刻麒麟 V10 SP3 最小化安装的实测形态。
//
// 期望：没有 FAIL；kysec 判 PASS（确认未启用，不是「查不到就放行」）；firewalld 判 WARN。
func TestCheckVariantBKylinMinimalBaseline(t *testing.T) {
	root := kylinFixture(t, nil)
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: kylinRunner()})

	if len(rep.Failed()) != 0 {
		t.Fatalf("麒麟最小化基线不应有 FAIL: %+v", rep.Failed())
	}
	if got := rep.Facts["cgroup"]; got != "v1" {
		t.Errorf("cgroup = %q，期望 v1（tmpfs）", got)
	}
	if got := itemByID(t, rep, "B1"); got.Level != LevelPass {
		t.Errorf("B1 = %v，cgroup v1 应 PASS（仅记录）", got.Level)
	}
	if got := itemByID(t, rep, "B2"); got.Level != LevelPass {
		t.Errorf("B2 = %v，SELinux Disabled 应 PASS", got.Level)
	}
	// 口径：工具不存在 → **N/A**，不是「已关闭」。说「已关闭」等于替机器断言没测过的事。
	kysec := itemByID(t, rep, "B3")
	if kysec.Level != LevelNA {
		t.Errorf("B3 = %v，无 kysec-utils 且无 /etc/kysec 应判 N/A（不是 PASS/已关闭）", kysec.Level)
	}
	if !strings.Contains(kysec.Detail, "未安装") {
		t.Errorf("B3 结论要写明「未安装」，实际: %s", kysec.Detail)
	}
	if strings.Contains(kysec.Detail, "确认关闭") || strings.Contains(kysec.Detail, "已关闭") {
		t.Errorf("B3 不能写成「已关闭」——那是在断言没测过的事，实际: %s", kysec.Detail)
	}
	if got := itemByID(t, rep, "B6"); got.Level != LevelWarn {
		t.Errorf("B6 = %v，firewalld 在跑应 WARN", got.Level)
	}
	// ZONE_CONFLICT 是目前唯一成立的 OS 级证据（统信实测），必须写进结论。
	if got := itemByID(t, rep, "B6"); !strings.Contains(got.Detail, "ZONE_CONFLICT") {
		t.Errorf("B6 结论要点明 ZONE_CONFLICT（dockerd 二次启动失败），实际: %s", got.Detail)
	}
	// 但「加 trusted zone」那批实验已被证伪，只能作为「别这么做」的反面提醒出现，
	// 不能变成处置建议本身。
	if got := itemByID(t, rep, "B6"); !strings.Contains(got.Hint, "不要用「加 trusted zone」") {
		t.Errorf("B6 的处置必须明确否掉 trusted zone，实际: %s", got.Hint)
	}
	if got := itemByID(t, rep, "B6"); !strings.Contains(got.Hint, "disable --now") {
		t.Errorf("B6 的处置要给出 disable --now，实际: %s", got.Hint)
	}
	if got := itemByID(t, rep, "B5"); got.Level != LevelPass {
		t.Errorf("B5 = %v，overlay 可用应 PASS", got.Level)
	}
	if !rep.OK() {
		t.Error("OK() 应为 true（无 FAIL）")
	}
}

// TestCheckVariantBSelinuxIgnoresConfigFileLies 守 §4.3 的实测校正。
//
// 麒麟上 /etc/selinux/config 写着 SELINUX=enforcing，而实际状态是 Disabled。
// 按配置文件下结论会误报 Enforcing 并触发一整套不必要的处置（甚至改现场配置）。
func TestCheckVariantBSelinuxIgnoresConfigFileLies(t *testing.T) {
	root := kylinFixture(t, map[string]string{
		"etc/selinux/config": "SELINUX=enforcing\nSELINUXTYPE=targeted\n",
	})
	r := kylinRunner()
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	got := itemByID(t, rep, "B2")
	if got.Level != LevelPass {
		t.Fatalf("getenforce=Disabled 时必须 PASS，实际 %v（是不是去读了 /etc/selinux/config？）: %s", got.Level, got.Detail)
	}
	if !strings.Contains(got.Hint, "/etc/selinux/config") {
		t.Errorf("B2 的提示里应写明「不要读 /etc/selinux/config」，实际: %s", got.Hint)
	}
}

// TestCheckVariantBSelinuxEnforcingWithoutContainerSelinux 守 UOS 那条：Enforcing 但没有 container-selinux。
func TestCheckVariantBSelinuxEnforcingWithoutContainerSelinux(t *testing.T) {
	root := kylinFixture(t, nil)
	r := kylinRunner()
	r.out["getenforce"] = "Enforcing\n"
	r.err = map[string]error{"rpm -q container-selinux": errors.New("exit status 1")}
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	got := itemByID(t, rep, "B2")
	if got.Level != LevelWarn {
		t.Fatalf("Enforcing 且无 container-selinux 应 WARN，实际 %v", got.Level)
	}
	if !strings.Contains(got.Detail, "container-selinux") {
		t.Errorf("结论要点名 container-selinux，实际: %s", got.Detail)
	}
}

// TestCheckVariantBKysecProbeFailureIsNotPass —— 本文件最重要的一条。
//
// getstatus 走 D-Bus，守护没起时查询必然失败。把失败当「已关闭」就是假绿：
// 真机上 kysec 可能是强制态，安装时会被拒绝执行解包出来的 dockerd。
func TestCheckVariantBKysecProbeFailureIsNotPass(t *testing.T) {
	root := kylinFixture(t, map[string]string{"etc/kysec/db/.keep": ""})
	r := kylinRunner()
	r.out["sh -c command -v getstatus"] = "/usr/sbin/getstatus\n"
	r.err = map[string]error{"getstatus": errors.New("exit status 1")}
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	got := itemByID(t, rep, "B3")
	if got.Level == LevelPass {
		t.Fatalf("探测失败绝不能判 PASS（这正是「把失败当放行」）: %s", got.Detail)
	}
	if got.Level != LevelWarn {
		t.Errorf("B3 = %v，期望 WARN", got.Level)
	}
	if !strings.Contains(got.Detail+got.Hint, "探测失败") {
		t.Errorf("结论里必须出现「探测失败」字样，实际 Detail=%s Hint=%s", got.Detail, got.Hint)
	}
	if rep.Facts["kysec"] != "probe-failed" {
		t.Errorf("Facts[kysec] = %q，期望 probe-failed（与 disabled 区分）", rep.Facts["kysec"])
	}
}

// TestCheckVariantBKysecEnforcingIsFail 强制态 + 执行控制开启才 FAIL。
func TestCheckVariantBKysecEnforcingIsFail(t *testing.T) {
	root := kylinFixture(t, map[string]string{"etc/kysec/db/.keep": ""})
	r := kylinRunner()
	r.out["sh -c command -v getstatus"] = "/usr/sbin/getstatus\n"
	r.out["getstatus"] = "KySec status: enforcing\n  exectl: on\n  fpro: off\n  netctl: on\n"
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	got := itemByID(t, rep, "B3")
	if got.Level != LevelFail {
		t.Fatalf("enforcing + exectl on 应 FAIL，实际 %v: %s", got.Level, got.Detail)
	}
	if !strings.Contains(got.Hint, "setstatus") {
		t.Errorf("处置里应给出 setstatus 临时放宽这条路，实际: %s", got.Hint)
	}
	if rep.OK() {
		t.Error("有 FAIL 时 OK() 必须为 false")
	}
}

// TestCheckVariantBKysecEnforcingButExectlOff 强制态但执行控制关着 —— 不阻断运行静态二进制。
func TestCheckVariantBKysecEnforcingButExectlOff(t *testing.T) {
	root := kylinFixture(t, map[string]string{"etc/kysec/db/.keep": ""})
	r := kylinRunner()
	r.out["sh -c command -v getstatus"] = "/usr/sbin/getstatus\n"
	r.out["getstatus"] = "KySec status: enforcing\n  exectl: off\n"
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	got := itemByID(t, rep, "B3")
	if got.Level != LevelPass {
		t.Fatalf("enforcing 但 exectl off 应 PASS，实际 %v: %s", got.Level, got.Detail)
	}
	if rep.Facts["kysec_exectl"] != "off" {
		t.Errorf("Facts[kysec_exectl] = %q，期望 off", rep.Facts["kysec_exectl"])
	}
}

// TestCheckVariantBCommandMissingIsReported 命令不存在 → 结论写「命令不存在」，不是沉默。
func TestCheckVariantBCommandMissingIsReported(t *testing.T) {
	root := kylinFixture(t, nil)
	r := kylinRunner()
	delete(r.out, "iptables --version") // stubRunner 对未知命令返回 os.ErrNotExist
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	got := itemByID(t, rep, "B4")
	if got.Level != LevelWarn {
		t.Fatalf("缺 iptables 应 WARN，实际 %v", got.Level)
	}
	if !strings.Contains(got.Detail, "命令不存在") {
		t.Errorf("结论要能读出是「命令不存在」而不是含糊的失败，实际: %s", got.Detail)
	}
}

// TestCheckVariantBTimeoutWithoutOverlayWarns 超时必须与「失败」区分开。
//
// 口径（与 K3 同源，2026-11-10）：modprobe 超时/失败且 /proc/filesystems 也没有
// overlay → WARN（dockerd 会退回 vfs，磁盘放大 14~26 倍）；Raw 要留下「命令超时」。
func TestCheckVariantBTimeoutWithoutOverlayWarns(t *testing.T) {
	root := kylinFixture(t, map[string]string{
		// 全新机器的形态：overlay 模块没加载，文件里自然没有 overlay。
		"proc/filesystems": "nodev\tsysfs\n\txfs\n",
	})
	r := kylinRunner()
	r.err = map[string]error{"modprobe overlay": context.DeadlineExceeded}
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	got := itemByID(t, rep, "B5")
	if got.Level != LevelWarn {
		t.Fatalf("modprobe 超时且无 overlay 应 WARN（会退回 vfs），实际 %v", got.Level)
	}
	if !strings.Contains(got.Raw, "命令超时") {
		t.Errorf("Raw 里要留下「命令超时」，实际:\n%s", got.Raw)
	}
	if !strings.Contains(got.Hint, "vfs") {
		t.Errorf("提示要说明会退回 vfs 及其代价，实际: %s", got.Hint)
	}
	if got := rep.Facts["overlay_usable"]; got != "false" {
		t.Errorf("Facts[overlay_usable] = %q，期望 false", got)
	}
}

// TestCheckVariantBTimeoutWithOverlayPasses 超时但 overlay 已在：以文件为准，判 PASS。
//
// 旧写法在这里误报 WARN，且理由自相矛盾（同一份日志里「modprobe: ok」与
// 「含 overlay: false」并存）。模块已加载/内建时 modprobe 失败是正常现象。
func TestCheckVariantBTimeoutWithOverlayPasses(t *testing.T) {
	root := kylinFixture(t, nil) // fixture 默认含 `nodev overlay`
	r := kylinRunner()
	r.err = map[string]error{"modprobe overlay": context.DeadlineExceeded}
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	got := itemByID(t, rep, "B5")
	if got.Level != LevelPass {
		t.Fatalf("overlay 已列出时应 PASS（modprobe 失败不算数），实际 %v: %s", got.Level, got.Detail)
	}
	if !strings.Contains(got.Raw, "modprobe 之后读取") {
		t.Errorf("Raw 要注明读取时序（modprobe 之后），实际:\n%s", got.Raw)
	}
	if got := rep.Facts["overlay_usable"]; got != "true" {
		t.Errorf("Facts[overlay_usable] = %q，期望 true", got)
	}
}

// TestCheckVariantBFreshMachineOverlay 全新麒麟机器的 B5 用例。
//
// 真机实测：overlay 模块默认不加载，/proc/filesystems 里没有 overlay 行；
// 旧写法先读文件（没有）再 modprobe 且成功后不重读，于是 B5 必然误报 WARN。
// 新口径：modprobe 退出码 0 即支持，即使文件里没有 overlay。
func TestCheckVariantBFreshMachineOverlay(t *testing.T) {
	root := kylinFixture(t, map[string]string{
		"proc/filesystems": "nodev\tsysfs\n\txfs\n",
	})
	r := kylinRunner() // "modprobe overlay": "" → 退出码 0
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	got := itemByID(t, rep, "B5")
	if got.Level != LevelPass {
		t.Fatalf("modprobe 成功即支持，全新机器不应误报，实际 %v: %s", got.Level, got.Detail)
	}
	if !strings.Contains(got.Raw, "modprobe overlay: ok") {
		t.Errorf("Raw 要记录 modprobe 成功，实际:\n%s", got.Raw)
	}
	if got := rep.Facts["overlay_usable"]; got != "true" {
		t.Errorf("Facts[overlay_usable] = %q，期望 true", got)
	}
	if got := rep.Facts["overlay_in_proc_filesystems"]; got != "false" {
		t.Errorf("Facts[overlay_in_proc_filesystems] = %q，期望 false（modprobe 前后都不含）", got)
	}
}

// TestCheckVariantBWeirdOutputIsNotGreen 输出异常（认不出来）时一律不能 PASS。
func TestCheckVariantBWeirdOutputIsNotGreen(t *testing.T) {
	root := kylinFixture(t, map[string]string{"etc/kysec/db/.keep": ""})
	r := kylinRunner()
	r.out["stat -fc %T /sys/fs/cgroup"] = "ext4\n"
	r.out["getenforce"] = "Perplexed\n"
	r.out["sh -c command -v getstatus"] = "/usr/sbin/getstatus\n"
	r.out["getstatus"] = "unexpected output without the expected markers\n"
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	for _, id := range []string{"B1", "B2", "B3"} {
		got := itemByID(t, rep, id)
		if got.Level == LevelPass {
			t.Errorf("%s 输出异常却判了 PASS：%s", id, got.Detail)
		}
		if got.Level == "" {
			t.Errorf("%s 没有结论等级", id)
		}
	}
}

// TestCheckVariantBNonKylinIsNA 非麒麟系统：kysec 记 N/A，不是 PASS 也不是 FAIL。
func TestCheckVariantBNonKylinIsNA(t *testing.T) {
	root := fixtureRoot(t, map[string]string{
		"etc/os-release":   "NAME=\"UOS\"\nID=uos\nVERSION_ID=\"20\"\n",
		"proc/filesystems": "nodev\txfs\nnodev\toverlay\n",
	})
	r := kylinRunner()
	delete(r.out, "firewall-cmd --state") // 未装 firewalld
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: r})

	if got := itemByID(t, rep, "B3"); got.Level != LevelNA {
		t.Errorf("B3 = %v，非麒麟应 N/A", got.Level)
	}
	if got := itemByID(t, rep, "B6"); got.Level != LevelNA {
		t.Errorf("B6 = %v，未装 firewalld 应 N/A", got.Level)
	}
	if len(rep.Failed()) != 0 {
		t.Errorf("N/A 不应算 FAIL: %+v", rep.Failed())
	}
}

// TestCheckVariantBReportCarriesRawOutput 每项都要留原始输出（01-preflight.log 靠它）。
func TestCheckVariantBReportCarriesRawOutput(t *testing.T) {
	root := kylinFixture(t, nil)
	rep := CheckVariantB(context.Background(), VariantBOptions{RootDir: root, Runner: kylinRunner()})

	for _, it := range rep.Items {
		if it.Level == LevelNA {
			continue
		}
		if strings.TrimSpace(it.Raw) == "" {
			t.Errorf("%s（%s）没有原始输出，出问题时无法复核", it.ID, it.Title)
		}
		if strings.TrimSpace(it.Hint) == "" {
			t.Errorf("%s（%s）没有一句话处置建议", it.ID, it.Title)
		}
	}
	if len(rep.Items) != 6 {
		t.Errorf("应有 6 项（§4.1–§4.6），实际 %d 项", len(rep.Items))
	}
	if rep.Facts["os"] == "" {
		t.Error("Facts 里应记录发行版")
	}
	if _, err := os.Stat(filepath.Join(root, "etc/os-release")); err != nil {
		t.Fatalf("fixture 异常: %v", err)
	}
}
