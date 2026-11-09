package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tianji-archive/installer/internal/buildplan"
)

// validEnv 是「8 个占位键都有值」的最小 .env，用于正例。
const validEnv = `# 天玑档案 · 部署配置（安装器渲染）
TZ=Asia/Shanghai
POSTGRES_PASSWORD=PgSecret123456
MINIO_ACCESS_KEY=tianji_minio
MINIO_SECRET_KEY=MinioSecret123456
JWT_ACCESS_SECRET=e2e-access-secret-0123456789abcdefghij
JWT_REFRESH_SECRET=e2e-refresh-secret-0123456789abcdefg
REDIS_PASSWORD=RedisSecret123456
S3_PUBLIC_ENDPOINT=192.168.100.10
CORS_ORIGINS=http://192.168.100.10:8080
`

// TestLoadEnvValuesReadsRenderedEnv 覆盖「断点重入要能把表单值读回来」。
//
// 这条路径的实际后果很具体：读不回来时 S10 汇总会印出 `http://:8080`，
// 现场会以为安装失败；而重填 8 项凭据等于让人从工单里再抄一遍随机密码。
func TestLoadEnvValuesReadsRenderedEnv(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(validEnv), 0o600); err != nil {
		t.Fatalf("写测试 .env 失败: %v", err)
	}

	values, ok := loadEnvValues(dir)
	if !ok {
		t.Fatal("期望读回成功，实际失败")
	}
	if values.Endpoint != "192.168.100.10" {
		t.Errorf("Endpoint = %q，期望 192.168.100.10", values.Endpoint)
	}
	if values.PostgresPassword != "PgSecret123456" {
		t.Errorf("PostgresPassword = %q", values.PostgresPassword)
	}
	if values.CorsOrigins != "http://192.168.100.10:8080" {
		t.Errorf("CorsOrigins = %q", values.CorsOrigins)
	}
	// 读回来的值必须能过校验，否则「重入」等于把用户卡在 S5。
	if problems := values.validate(); len(problems) > 0 {
		t.Errorf("读回的值未通过校验：%v", problems)
	}
}

// TestLoadEnvValuesRejectsPartialEnv 覆盖「半份 .env 不许当完整值用」。
//
// 少了 REDIS_PASSWORD 时必须整体判失败：拿半份值去渲染会生成一个
// 密码为空的 .env，容器能起来但一连 Redis 就认证失败。
func TestLoadEnvValuesRejectsPartialEnv(t *testing.T) {
	dir := t.TempDir()
	partial := `POSTGRES_PASSWORD=PgSecret123456
MINIO_ACCESS_KEY=tianji_minio
MINIO_SECRET_KEY=MinioSecret123456
JWT_ACCESS_SECRET=e2e-access-secret-0123456789abcdefghij
JWT_REFRESH_SECRET=e2e-refresh-secret-0123456789abcdefg
S3_PUBLIC_ENDPOINT=192.168.100.10
`
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(partial), 0o600); err != nil {
		t.Fatalf("写测试 .env 失败: %v", err)
	}
	if _, ok := loadEnvValues(dir); ok {
		t.Fatal("缺 REDIS_PASSWORD 的 .env 不应被当成完整的表单值")
	}
}

// TestLoadEnvValuesMissingFileIsNotAnError 覆盖「首次安装没有 .env」的常态。
func TestLoadEnvValuesMissingFileIsNotAnError(t *testing.T) {
	if _, ok := loadEnvValues(t.TempDir()); ok {
		t.Fatal("没有 .env 时应返回 ok=false")
	}
}

// newDeployFixture 造一个最小的安装器目录，让 prepareDeployRoot 能跑完整流程
// （它要复制 compose 与 seaweedfs 两个文件，缺了就会在复制那一步失败）。
func newDeployFixture(t *testing.T) buildplan.Layout {
	t.Helper()
	root := t.TempDir()
	layout := buildplan.Layout{
		Root:       root,
		DeployRoot: filepath.Join(root, "deploy"),
	}.Normalize()

	files := map[string]string{
		layout.ComposePath(): "services: {}\n",
		filepath.Join(layout.SeaweedFSDir(), "entrypoint.sh"): "#!/bin/sh\n",
		filepath.Join(layout.SeaweedFSDir(), "s3.json.tpl"):   "{}\n",
	}
	for path, content := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatalf("建目录 %s 失败: %v", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
			t.Fatalf("写 %s 失败: %v", path, err)
		}
	}
	return layout
}

// TestVolumeOwnersTargetsAreRealVolumeDirs 防「改了表里的目录名但目录压根不建」。
//
// 这条是给未来改 compose 的人上的锁：volumeOwners 里写错一个名字，chown 会静默
// 作用在一个不存在的路径上（os.Chown 返回 ENOENT → 变成一条 WARN），而 S6 依旧
// 以 failed to obtain node locks 失败，排查时又要重来一遍。
func TestVolumeOwnersTargetsAreRealVolumeDirs(t *testing.T) {
	known := map[string]bool{}
	for _, dir := range volumeDirs {
		known[dir] = true
	}
	for _, vo := range volumeOwners {
		if !known[vo.Dir] {
			t.Errorf("volumeOwners 里的 %q 不在 volumeDirs 里：这条 chown 永远打不中目标", vo.Dir)
		}
		if vo.Why == "" {
			t.Errorf("%q 没写为什么需要属主：现场看到一行 chown 只会更困惑", vo.Dir)
		}
	}
}

// TestPrepareDeployRootAssignsEsVolumeOwner 锁死 S6_UP 的失败根因。
//
// 现场事实：installer 建的卷目录是 root:root 0750，而 elasticsearch 镜像以
// uid=1000 启动并不 chown，于是 ES 报
//
//	failed to obtain node locks … AccessDeniedException: .../node.lock
//
// S1–S5 全 DONE、S6 才炸。这条用例断言 esdata 与 wal_archive 被改成容器内 uid。
func TestPrepareDeployRootAssignsEsVolumeOwner(t *testing.T) {
	layout := newDeployFixture(t)

	type chownCall struct {
		path     string
		uid, gid int
	}
	var calls []chownCall
	s := &session{
		layout: layout,
		chown: func(path string, uid, gid int) error {
			calls = append(calls, chownCall{path, uid, gid})
			return nil
		},
	}

	var out strings.Builder
	if err := s.prepareDeployRoot(&out); err != nil {
		t.Fatalf("prepareDeployRoot 失败: %v", err)
	}

	got := map[string][2]int{}
	for _, c := range calls {
		got[filepath.Base(c.path)] = [2]int{c.uid, c.gid}
	}
	want := map[string][2]int{
		"esdata":      {1000, 1000},
		"wal_archive": {70, 70},
	}
	for dir, wantOwn := range want {
		own, ok := got[dir]
		if !ok {
			t.Errorf("卷目录 %s 没有被 chown（ES/postgres 会因写不了数据目录而失败）", dir)
			continue
		}
		if own != wantOwn {
			t.Errorf("卷目录 %s 属主 = %d:%d，期望 %d:%d", dir, own[0], own[1], wantOwn[0], wantOwn[1])
		}
		// 目录必须真的被创建，否则 chown 打在空气上
		full := filepath.Join(layout.VolumesDir(), dir)
		info, err := os.Stat(full)
		if err != nil {
			t.Errorf("卷目录 %s 不存在: %v", full, err)
			continue
		}
		if !info.IsDir() {
			t.Errorf("%s 不是目录", full)
		}
	}
	if !strings.Contains(out.String(), "卷属主") {
		t.Errorf("输出里应能看到属主设置结果，实际:\n%s", out.String())
	}
}

// TestPrepareDeployRootChownFailureIsWarnNotAbort 覆盖 chown 被拒时的行为。
//
// 为什么不 fail：NFS/CIFS 上 chown 会被拒而 runc 仍能起来，硬失败会把
// 「可能能用」的环境判死。但后果必须写到用户眼前——否则现场会去查磁盘满。
func TestPrepareDeployRootChownFailureIsWarnNotAbort(t *testing.T) {
	layout := newDeployFixture(t)
	s := &session{
		layout: layout,
		chown: func(string, int, int) error {
			return errors.New("operation not permitted")
		},
	}

	var out strings.Builder
	if err := s.prepareDeployRoot(&out); err != nil {
		t.Fatalf("chown 失败不应中断 StepEnv，实际: %v", err)
	}
	text := out.String()
	for _, want := range []string{"WARN", "failed to obtain node locks", "operation not permitted"} {
		if !strings.Contains(text, want) {
			t.Errorf("WARN 里缺少 %q，现场会看不出后果。实际输出:\n%s", want, text)
		}
	}
}
