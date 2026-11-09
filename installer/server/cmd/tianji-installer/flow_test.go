package main

import (
	"os"
	"path/filepath"
	"testing"
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
