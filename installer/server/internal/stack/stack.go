// Package stack 负责设计 §6.1 第 ⑤⑥ 步：compose up → health 门禁 → migration →
// seed → 四项冒烟。
//
// 四项冒烟与 offline/smoke.sh 严格同口径（判据、字符串、顺序都一样），
// 因为现场排查时两套标准会让人怀疑「到底哪个才算过」。差别只有一处：
// smoke.sh 用 curl，这里用 Go 的 net/http —— 目标机不保证有 curl（精简系统常见），
// 而安装器自己是静态二进制，自带 HTTP 能力。
package stack

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
)

// APIContainer 是 compose 里的 api 服务名（docker-compose.offline.yml）。
const APIContainer = "api"

// 与 smoke.sh:15-16 完全一致的判据字符串。
const (
	healthStatusToken    = `"status":"ok"`
	healthObjectStoreTok = `"name":"objectStorage","ok":true`
	passMarker           = "IS_PASS: YES"
	ikExpectedToken      = "中华人民共和国"
)

// Options 是起栈与冒烟的全部输入。
type Options struct {
	Layout      buildplan.Layout
	ComposeFile string
	EnvFile     string
	Runner      execx.Runner
	// HealthTimeout 是 up 之后等待所有服务 healthy 的上限，默认 5 分钟。
	HealthTimeout time.Duration
	// APIBaseURL / ESBaseURL 是宿主侧访问地址，默认 http://127.0.0.1:3000 与 :9200。
	APIBaseURL string
	ESBaseURL  string
	HTTP       *http.Client
	Logf       func(format string, args ...any)
}

// ServiceHealth 是 compose ps 的一行。
type ServiceHealth struct {
	Service string `json:"Service"`
	Name    string `json:"Name"`
	State   string `json:"State"`
	Health  string `json:"Health"`
	Status  string `json:"Status"`
}

// SmokeItem 是一项冒烟结果。
type SmokeItem struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail"`
	Output string `json:"output,omitempty"`
}

// Stack 把 Options 收敛成可复用对象（同一份配置要跑 4 个步骤）。
type Stack struct {
	opts Options
}

// New 构造 Stack，并补齐默认值。
func New(opts Options) *Stack {
	if opts.Runner == nil {
		opts.Runner = execx.OSRunner{}
	}
	if opts.HealthTimeout <= 0 {
		opts.HealthTimeout = 5 * time.Minute
	}
	if opts.APIBaseURL == "" {
		opts.APIBaseURL = "http://127.0.0.1:3000"
	}
	if opts.ESBaseURL == "" {
		opts.ESBaseURL = "http://127.0.0.1:9200"
	}
	if opts.HTTP == nil {
		opts.HTTP = &http.Client{Timeout: 20 * time.Second}
	}
	if opts.ComposeFile == "" {
		opts.ComposeFile = opts.Layout.DeployedComposePath()
	}
	if opts.EnvFile == "" {
		opts.EnvFile = opts.Layout.EnvPath()
	}
	if opts.Logf == nil {
		opts.Logf = func(string, ...any) {}
	}
	return &Stack{opts: opts}
}

func (s *Stack) logf(format string, args ...any) { s.opts.Logf(format, args...) }

// compose 拼出 `docker compose -f <file> --env-file <env> <sub...>`。
//
// --env-file 必须放在子命令之前（compose 的全局 flag），放在后面会被当成
// 子命令参数忽略，症状是 .env 里的变量全部缺失、栈起来但连不上数据库。
func (s *Stack) compose(sub ...string) []string {
	args := []string{"compose"}
	if s.opts.ComposeFile != "" {
		args = append(args, "-f", s.opts.ComposeFile)
	}
	if s.opts.EnvFile != "" {
		args = append(args, "--env-file", s.opts.EnvFile)
	}
	args = append(args, sub...)
	return args
}

// ComposeArgs 暴露统一的 compose 参数前缀。
// 卸载（compose down）不属于「安装流程」，但参数前缀必须同源，否则
// 「装的时候用了 --env-file、卸的时候没用」会让 compose 报缺变量。
func (s *Stack) ComposeArgs(sub ...string) []string { return s.compose(sub...) }

// Up 执行 docker compose up -d。
func (s *Stack) Up(ctx context.Context) error {
	s.logf("执行 docker compose up -d（首次启动要拉齐 8 个容器，1~3 分钟）…")
	res, err := s.opts.Runner.Run(ctx, "docker", s.compose("up", "-d")...)
	s.logf("%s", strings.TrimRight(res.Combined(), "\n"))
	if err != nil {
		return fmt.Errorf("docker compose up 失败: %w", err)
	}
	return nil
}

// WaitHealthy 轮询 compose ps，直到所有服务 running/healthy 或超时。
//
// 只认 State=running 且 Health ∈ {healthy, ""(无 healthcheck)}：
// 「容器在跑但 healthcheck 还没过」是最容易误判的状态，必须等。
func (s *Stack) WaitHealthy(ctx context.Context) ([]ServiceHealth, error) {
	deadline := time.Now().Add(s.opts.HealthTimeout)
	var last []ServiceHealth
	for {
		services, err := s.ps(ctx)
		if err == nil {
			last = services
			if len(services) > 0 {
				if bad := unhealthy(services); len(bad) == 0 {
					s.logf("全部 %d 个服务就绪", len(services))
					return services, nil
				} else {
					s.logf("仍有 %d 个服务未就绪：%s", len(bad), describe(bad))
				}
			}
		} else {
			s.logf("compose ps 暂不可用：%v", err)
		}
		if time.Now().After(deadline) {
			return last, fmt.Errorf("等待服务栈就绪超时（%s）：%s\n处置：docker compose -f %s ps 与 docker compose logs --tail=100 查看具体服务",
				s.opts.HealthTimeout, describe(unhealthy(last)), s.opts.ComposeFile)
		}
		select {
		case <-ctx.Done():
			return last, ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
}

// ps 解析 `docker compose ps --format json`。
// compose v2.21+ 输出一个 JSON 数组，更早的版本输出每行一个 JSON 对象，两种都吃。
func (s *Stack) ps(ctx context.Context) ([]ServiceHealth, error) {
	res, err := s.opts.Runner.Run(ctx, "docker", s.compose("ps", "--format", "json")...)
	if err != nil {
		return nil, fmt.Errorf("compose ps 失败: %w", err)
	}
	raw := strings.TrimSpace(res.Stdout)
	if raw == "" {
		return nil, errors.New("compose ps 输出为空（服务栈可能尚未创建）")
	}
	var arr []ServiceHealth
	if err := json.Unmarshal([]byte(raw), &arr); err == nil {
		return arr, nil
	}
	var out []ServiceHealth
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var one ServiceHealth
		if err := json.Unmarshal([]byte(line), &one); err != nil {
			return nil, fmt.Errorf("解析 compose ps 行失败: %w（原始: %s）", err, truncate(line, 200))
		}
		out = append(out, one)
	}
	if len(out) == 0 {
		return nil, errors.New("compose ps 无有效行")
	}
	return out, nil
}

func unhealthy(list []ServiceHealth) []ServiceHealth {
	var bad []ServiceHealth
	for _, s := range list {
		state := strings.ToLower(s.State)
		health := strings.ToLower(s.Health)
		if state != "" && state != "running" {
			bad = append(bad, s)
			continue
		}
		switch health {
		case "", "healthy":
			// 无 healthcheck 或已健康
		default:
			bad = append(bad, s)
		}
	}
	return bad
}

func describe(list []ServiceHealth) string {
	if len(list) == 0 {
		return "（无）"
	}
	parts := make([]string, 0, len(list))
	for _, s := range list {
		label := s.Service
		if label == "" {
			label = s.Name
		}
		parts = append(parts, fmt.Sprintf("%s[state=%s health=%s]", label, orDash(s.State), orDash(s.Health)))
	}
	return strings.Join(parts, " ")
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// Migrate 执行数据库迁移（幂等，可重跑）。命令形式与 offline/smoke.sh 一致。
func (s *Stack) Migrate(ctx context.Context) error {
	s.logf("执行数据库迁移 …")
	res, err := s.opts.Runner.Run(ctx, "docker",
		s.compose("exec", "-T", APIContainer, "pnpm", "--filter", "@tianji/api", "migration:run")...)
	s.logf("%s", strings.TrimRight(res.Combined(), "\n"))
	if err != nil {
		return fmt.Errorf("数据库迁移失败: %w", err)
	}
	return nil
}

// Seed 执行种子数据（幂等，可重跑）。
func (s *Stack) Seed(ctx context.Context) error {
	s.logf("执行种子数据 …")
	res, err := s.opts.Runner.Run(ctx, "docker",
		s.compose("exec", "-T", APIContainer, "pnpm", "--filter", "@tianji/api", "seed")...)
	s.logf("%s", strings.TrimRight(res.Combined(), "\n"))
	if err != nil {
		return fmt.Errorf("种子数据失败: %w", err)
	}
	return nil
}

// Smoke 跑四项冒烟，任一失败即返回 error（但不短路：四项都跑完更利于一次性定位）。
func (s *Stack) Smoke(ctx context.Context) ([]SmokeItem, error) {
	items := make([]SmokeItem, 0, 4)

	// ① /api/health
	body, status, err := s.httpGet(ctx, s.opts.APIBaseURL+"/api/health")
	item := SmokeItem{Name: "1/4 健康检查 /api/health", Output: truncate(body, 4000)}
	switch {
	case err != nil:
		item.Detail = "接口不可达（后端未就绪或 3000 未发布）: " + err.Error()
	case status != http.StatusOK:
		item.Detail = fmt.Sprintf("HTTP %d", status)
	case !strings.Contains(body, healthStatusToken):
		item.Detail = "status 不是 ok（仍 degraded）；看 body 里 deps 的哪一项 false"
	case !strings.Contains(body, healthObjectStoreTok):
		item.Detail = "objectStorage 未就绪（SeaweedFS/凭据/端口 8333 三处排查）"
	default:
		item.Passed = true
		item.Detail = "status=ok 且 objectStorage.ok=true"
	}
	items = append(items, item)

	// ② S3 九项探针
	items = append(items, s.execSmoke(ctx, "2/4 S3 兼容性探针", "s3:probe"))

	// ③ 样品书籍全链路
	items = append(items, s.execSmoke(ctx, "3/4 样品书籍全链路", "demo:books"))

	// ④ IK 分词
	ikBody, ikStatus, ikErr := s.httpPostJSON(ctx, s.opts.ESBaseURL+"/_analyze",
		`{"analyzer":"ik_max_word","text":"中华人民共和国档案管理系统"}`)
	ikItem := SmokeItem{Name: "4/4 IK 中文分词", Output: truncate(ikBody, 2000)}
	switch {
	case ikErr != nil:
		ikItem.Detail = "ES _analyze 不可达: " + ikErr.Error()
	case ikStatus != http.StatusOK:
		ikItem.Detail = fmt.Sprintf("HTTP %d", ikStatus)
	case !strings.Contains(ikBody, ikExpectedToken):
		ikItem.Detail = "IK 未切出预期词条（可能装的是标准分词器，镜像不对）"
	default:
		ikItem.Passed = true
		ikItem.Detail = "IK 切出「" + ikExpectedToken + "」"
	}
	items = append(items, ikItem)

	var failed []string
	for _, it := range items {
		if it.Passed {
			s.logf("PASS %s —— %s", it.Name, it.Detail)
			continue
		}
		s.logf("FAIL %s —— %s", it.Name, it.Detail)
		failed = append(failed, it.Name+"："+it.Detail)
	}
	if len(failed) > 0 {
		return items, fmt.Errorf("冒烟 %d/4 失败\n  - %s", len(failed), strings.Join(failed, "\n  - "))
	}
	return items, nil
}

func (s *Stack) execSmoke(ctx context.Context, name, script string) SmokeItem {
	item := SmokeItem{Name: name}
	res, err := s.opts.Runner.Run(ctx, "docker",
		s.compose("exec", "-T", APIContainer, "pnpm", "--filter", "@tianji/api", script)...)
	output := res.Combined()
	item.Output = truncate(output, 6000)
	switch {
	case err != nil:
		item.Detail = "命令失败: " + err.Error()
	case !strings.Contains(output, passMarker):
		item.Detail = "输出中没有 " + passMarker
	default:
		item.Passed = true
		item.Detail = "输出含 " + passMarker
	}
	return item
}

func (s *Stack) httpGet(ctx context.Context, url string) (string, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", 0, err
	}
	resp, err := s.opts.HTTP.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", resp.StatusCode, err
	}
	return string(raw), resp.StatusCode, nil
}

func (s *Stack) httpPostJSON(ctx context.Context, url, body string) (string, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.opts.HTTP.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", resp.StatusCode, err
	}
	return string(raw), resp.StatusCode, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + fmt.Sprintf("\n…（已截断，原始输出见日志文件，共 %d 字节）", len(s))
}
