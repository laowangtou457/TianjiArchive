package buildplan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validManifest() *Manifest {
	m := &Manifest{
		FormatVersion: 1,
		Product:       "tianji-archive",
		Version:       "1.0.0",
		Variant:       VariantUbuntuDebian,
		Arch:          "amd64",
		Files:         []FileEntry{{Path: "common/env/.env.tpl", SHA256: strings.Repeat("a", 64)}},
	}
	m.ImagesTar.Filename = "tianji-offline-images.tar"
	m.ImagesTar.SHA256 = strings.Repeat("b", 64)
	m.ImagesTar.ImageCount = 8
	return m
}

func TestValidateAcceptsGoodManifest(t *testing.T) {
	if err := validManifest().Validate(); err != nil {
		t.Fatalf("合法 manifest 不该报错: %v", err)
	}
}

// 关键回归（设计 §7.2）：镜像 tar 的 sha256 必须由构建机写入，安装器不得
// 「自己算一遍就当溯源」。缺这一项必须拒绝启动。
func TestValidateRejectsMissingImagesSHA(t *testing.T) {
	m := validManifest()
	m.ImagesTar.SHA256 = ""
	err := m.Validate()
	if err == nil {
		t.Fatal("缺 images_tar.sha256 必须报错")
	}
	if !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("错误信息应点明 sha256: %v", err)
	}
}

func TestValidateRejectsWrongFormatVersion(t *testing.T) {
	m := validManifest()
	m.FormatVersion = 2
	if err := m.Validate(); err == nil {
		t.Fatal("format_version=2 应被拒绝")
	}
}

func TestValidateRejectsUnknownVariant(t *testing.T) {
	m := validManifest()
	m.Variant = "centos"
	if err := m.Validate(); err == nil {
		t.Fatal("未知变体应被拒绝")
	}
}

// manifest 里的 path 会参与 filepath.Join，必须堵住 ../ 穿越。
func TestValidateRejectsPathTraversal(t *testing.T) {
	m := validManifest()
	m.Files[0].Path = "../../etc/passwd"
	err := m.Validate()
	if err == nil {
		t.Fatal("payload 路径含 .. 必须被拒绝")
	}
	if !strings.Contains(err.Error(), "相对路径") {
		t.Fatalf("错误提示应说明必须是相对路径: %v", err)
	}
}

func TestParseOSRelease(t *testing.T) {
	raw := `NAME="Ubuntu"
ID=ubuntu
VERSION_ID="22.04"
VERSION_CODENAME=jammy
PRETTY_NAME="Ubuntu 22.04.4 LTS"
# 注释行
`
	os := ParseOSRelease(raw)
	if os.ID != "ubuntu" || os.VersionID != "22.04" || os.Codename != "jammy" {
		t.Fatalf("解析结果不对: %+v", os)
	}
	if os.PrettyName != "Ubuntu 22.04.4 LTS" {
		t.Fatalf("PRETTY_NAME 引号未剥离: %q", os.PrettyName)
	}
}

func TestMatchOSMatrix(t *testing.T) {
	cases := []struct {
		name    string
		os      OSInfo
		variant string
		level   MatchLevel
		confirm bool
		suggest string
	}{
		{"ubuntu22-jammy", OSInfo{ID: "ubuntu", VersionID: "22.04", Codename: "jammy"}, VariantUbuntuDebian, MatchExact, false, ""},
		{"ubuntu24-noble", OSInfo{ID: "ubuntu", VersionID: "24.04", Codename: "noble"}, VariantUbuntuDebian, MatchExact, false, ""},
		{"debian12", OSInfo{ID: "debian", VersionID: "12", Codename: "bookworm"}, VariantUbuntuDebian, MatchExact, false, ""},
		// 归一化恒等性守卫：A 变体登记值无 V 前缀，normalizeVersionID 必须原样放行。
		{"ubuntu22-after-normalize", OSInfo{ID: "ubuntu", VersionID: "22.04"}, VariantUbuntuDebian, MatchExact, false, ""},
		{"debian12-after-normalize", OSInfo{ID: "debian", VersionID: "12"}, VariantUbuntuDebian, MatchExact, false, ""},
		{"ubuntu18-unverified", OSInfo{ID: "ubuntu", VersionID: "18.04"}, VariantUbuntuDebian, MatchUnverified, true, ""},
		{"centos-reject", OSInfo{ID: "centos", VersionID: "7"}, VariantUbuntuDebian, MatchReject, false, VariantKylinUOS},
		{"kylin10", OSInfo{ID: "kylin", VersionID: "10"}, VariantKylinUOS, MatchExact, false, ""},
		// 真机格式（麒麟 V10 SP3 实测 /etc/os-release：VERSION_ID="V10"，V 前缀；
		// SP 只进 PRETTY_NAME）。2026-11-10 e2e 撞出的「kylin V10 未登记」即此根因。
		{"kylinV10-real-format", OSInfo{ID: "kylin", VersionID: "V10"}, VariantKylinUOS, MatchExact, false, ""},
		{"kylin-v10-lowercase", OSInfo{ID: "kylin", VersionID: "v10"}, VariantKylinUOS, MatchExact, false, ""},
		{"uos20", OSInfo{ID: "uos", VersionID: "20"}, VariantKylinUOS, MatchExact, false, ""},
		// fail-closed 回归：V11 归一成 "11"，不在表内，仍必须走风险确认。
		{"kylin-unknown-ver", OSInfo{ID: "kylin", VersionID: "V11"}, VariantKylinUOS, MatchUnverified, true, ""},
		{"kylin-unknown-ver-plain", OSInfo{ID: "kylin", VersionID: "11"}, VariantKylinUOS, MatchUnverified, true, ""},
		{"ubuntu-with-static-pkg", OSInfo{ID: "ubuntu", VersionID: "22.04"}, VariantKylinUOS, MatchReject, false, VariantUbuntuDebian},
	}
	for _, c := range cases {
		got := MatchOS(c.os, c.variant)
		if got.Level != c.level {
			t.Errorf("%s: 期望 %s，实际 %s（%s）", c.name, c.level, got.Level, got.Reason)
		}
		if got.RequireConfirm != c.confirm {
			t.Errorf("%s: RequireConfirm 期望 %v，实际 %v", c.name, c.confirm, got.RequireConfirm)
		}
		if c.suggest != "" && got.SuggestedVariant != c.suggest {
			t.Errorf("%s: 建议变体期望 %s，实际 %s", c.name, c.suggest, got.SuggestedVariant)
		}
	}
}

func TestNormalizeVersionID(t *testing.T) {
	cases := []struct{ in, want string }{
		{"V10", "10"},      // 真麒麟大写 V 前缀
		{"v10", "10"},      // 容错小写
		{"20", "20"},       // 统信纯数字，恒等
		{"22.04", "22.04"}, // ubuntu，恒等
		{"12", "12"},       // debian，恒等
		{"V11", "11"},      // 未登记大版本归一后仍不在表内
		{"", ""},           // 空 → 空（由 orUnknown 兜底显示）
		{"  V10  ", "10"},  // 防御性去空白（ParseOSRelease 已 trim，双保险）
	}
	for _, c := range cases {
		if got := normalizeVersionID(c.in); got != c.want {
			t.Errorf("normalizeVersionID(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

func TestVerifyPayloadDetectsTamper(t *testing.T) {
	root := t.TempDir()
	rel := "common/env/.env.tpl"
	full := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	content := []byte("POSTGRES_PASSWORD=__POSTGRES_PASSWORD__\n")
	if err := os.WriteFile(full, content, 0o644); err != nil {
		t.Fatal(err)
	}
	hash, err := HashFile(full)
	if err != nil {
		t.Fatal(err)
	}

	m := validManifest()
	m.Files = []FileEntry{{Path: rel, SHA256: hash}}
	checks := VerifyPayload(root, m)
	if len(checks) != 1 || !checks[0].OK {
		t.Fatalf("正常文件应通过: %+v", checks)
	}

	// 改一个字节
	if err := os.WriteFile(full, append(content, 'X'), 0o644); err != nil {
		t.Fatal(err)
	}
	checks = VerifyPayload(root, m)
	if bad := Failed(checks); len(bad) != 1 {
		t.Fatalf("被篡改的文件必须被判为不匹配，实际 %+v", checks)
	}
}

func TestVerifyPayloadReportsMissingFile(t *testing.T) {
	m := validManifest()
	checks := VerifyPayload(t.TempDir(), m)
	if len(checks) != 1 || checks[0].OK || checks[0].Err == "" {
		t.Fatalf("文件不存在时应带 Err: %+v", checks)
	}
}

func TestLayoutPaths(t *testing.T) {
	l := Layout{Root: "/opt/tianji-installer", DeployRoot: "/opt/tianji"}.Normalize()
	if got := l.ManifestPath(); got != filepath.Join("/opt/tianji-installer", ManifestName) {
		t.Fatalf("ManifestPath 不对: %s", got)
	}
	if got := l.DebsDir("jammy"); !strings.HasSuffix(got, filepath.Join("docker", "debs", "jammy")) {
		t.Fatalf("DebsDir 应按 codename 分目录: %s", got)
	}
	// Normalize 必须把空字段补成默认值，避免路径变成相对路径（在错误的 CWD 下会写错地方）
	empty := Layout{}.Normalize()
	if empty.Root != DefaultRootDir || empty.StateFile != DefaultStateFile {
		t.Fatalf("Normalize 未填默认值: %+v", empty)
	}
}
