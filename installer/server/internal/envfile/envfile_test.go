package envfile

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const sampleTemplate = `POSTGRES_PASSWORD=__POSTGRES_PASSWORD__
S3_PUBLIC_ENDPOINT=__S3_PUBLIC_ENDPOINT__
S3_PUBLIC_PORT=8333
WEB_PORT=8080
`

func TestRenderReplacesAndChecksRequired(t *testing.T) {
	values := map[string]string{
		"POSTGRES_PASSWORD":  "pwd_change_me_1234",
		"S3_PUBLIC_ENDPOINT": "192.168.10.50",
	}
	out, unused, err := Render(sampleTemplate, values, []string{"POSTGRES_PASSWORD", "S3_PUBLIC_ENDPOINT"})
	if err != nil {
		t.Fatalf("Render 失败: %v", err)
	}
	if strings.Contains(out, "__POSTGRES_PASSWORD__") {
		t.Fatal("占位符未被替换")
	}
	if !strings.Contains(out, "S3_PUBLIC_ENDPOINT=192.168.10.50") {
		t.Fatalf("端点未渲染正确: %s", out)
	}
	if len(unused) != 0 {
		t.Fatalf("不应有未使用的键: %v", unused)
	}
}

// 关键回归：必须挡下「向导给了值但模板里没有该键」的漏接，否则 .env 会缺项。
func TestRenderMissingRequiredFails(t *testing.T) {
	values := map[string]string{"POSTGRES_PASSWORD": "x"}
	_, _, err := Render(sampleTemplate, values, []string{"POSTGRES_PASSWORD", "S3_PUBLIC_ENDPOINT"})
	if err == nil {
		t.Fatal("缺少必填键应报错")
	}
	if !errors.Is(err, ErrUnresolvedPlaceholder) {
		t.Fatalf("错误类型应为 ErrUnresolvedPlaceholder，实际 %v", err)
	}
}

func TestRenderReportsUnusedValues(t *testing.T) {
	values := map[string]string{
		"POSTGRES_PASSWORD":  "pwd",
		"S3_PUBLIC_ENDPOINT": "1.2.3.4",
		"NOT_IN_TEMPLATE":    "x",
	}
	_, unused, err := Render(sampleTemplate, values, nil)
	if err != nil {
		t.Fatalf("Render 失败: %v", err)
	}
	if len(unused) != 1 || unused[0] != "NOT_IN_TEMPLATE" {
		t.Fatalf("应报告未使用的键，实际 %v", unused)
	}
}

func TestRenderRejectsLeftoverPlaceholder(t *testing.T) {
	tmpl := "A=__A__\nB=__B__\n"
	_, _, err := Render(tmpl, map[string]string{"A": "1"}, nil)
	if err == nil {
		t.Fatal("残留占位符应报错")
	}
}

func TestUnresolvedPlaceholders(t *testing.T) {
	got := UnresolvedPlaceholders("X=__FOO_BAR__\nY=ok\nZ=__BAZ2__\n")
	if len(got) != 2 || got[0] != "BAZ2" || got[1] != "FOO_BAR" {
		t.Fatalf("扫描结果不对: %v", got)
	}
	if got := UnresolvedPlaceholders("nothing here"); len(got) != 0 {
		t.Fatalf("不应误报: %v", got)
	}
}

// 关键回归（风险 R8）：已存在的 .env 必须拒绝覆盖，除非显式 Force。
func TestWriteRefusesOverwrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("OLD=1\n"), 0o600); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}
	if _, err := Write(path, "NEW=1\n", WriteOptions{}); err == nil {
		t.Fatal("已存在且未 Force 时应报错")
	} else if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("错误类型应为 ErrAlreadyExists，实际 %v", err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "OLD=1\n" {
		t.Fatal("拒绝覆盖时原文件必须保持不动")
	}
}

func TestWriteForceBacksUp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("OLD=1\n"), 0o600); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}
	res, err := Write(path, "NEW=1\n", WriteOptions{Force: true})
	if err != nil {
		t.Fatalf("Force 覆盖应成功: %v", err)
	}
	if !res.Overwritten || res.BackupPath == "" {
		t.Fatalf("应记录覆盖与备份路径: %+v", res)
	}
	backup, err := os.ReadFile(res.BackupPath)
	if err != nil {
		t.Fatalf("读备份失败: %v", err)
	}
	if string(backup) != "OLD=1\n" {
		t.Fatalf("备份内容不对: %q", backup)
	}
	now, _ := os.ReadFile(path)
	if string(now) != "NEW=1\n" {
		t.Fatalf("新内容不对: %q", now)
	}
	info, _ := os.Stat(path)
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf(".env 权限应为 0600，实际 %o", info.Mode().Perm())
	}
}

func TestParseValues(t *testing.T) {
	content := "# comment\n\nA=1\nB = 2 \nBROKEN_LINE\nC=\n"
	got := ParseValues(content)
	if got["A"] != "1" || got["B"] != "2" || got["C"] != "" {
		t.Fatalf("解析结果不对: %+v", got)
	}
	if _, ok := got["# comment"]; ok {
		t.Fatal("注释不应被解析")
	}
}
