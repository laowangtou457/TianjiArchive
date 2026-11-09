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
		{"ubuntu18-unverified", OSInfo{ID: "ubuntu", VersionID: "18.04"}, VariantUbuntuDebian, MatchUnverified, true, ""},
		{"centos-reject", OSInfo{ID: "centos", VersionID: "7"}, VariantUbuntuDebian, MatchReject, false, VariantKylinUOS},
		{"kylin10", OSInfo{ID: "kylin", VersionID: "10"}, VariantKylinUOS, MatchExact, false, ""},
		{"uos20", OSInfo{ID: "uos", VersionID: "20"}, VariantKylinUOS, MatchExact, false, ""},
		{"kylin-unknown-ver", OSInfo{ID: "kylin", VersionID: "V11"}, VariantKylinUOS, MatchUnverified, true, ""},
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
