package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tianji-archive/installer/internal/audit"
	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/dockerinstall"
	"tianji-archive/installer/internal/envfile"
	"tianji-archive/installer/internal/execx"
	"tianji-archive/installer/internal/images"
	"tianji-archive/installer/internal/preflight"
	"tianji-archive/installer/internal/selfclean"
	"tianji-archive/installer/internal/stack"
	"tianji-archive/installer/internal/state"
)

// stepLogFile 是设计 §6.3 的日志文件名与步骤的对应关系。
// 文件名带序号，是为了让现场把日志目录整体打包发给开发时，顺序天然可读。
var stepLogFile = map[state.Step]string{
	state.StepPreflight: "01-preflight.log",
	state.StepVerify:    "02-verify.log",
	state.StepDocker:    "03-docker-install.log",
	state.StepImages:    "04-images-load.log",
	state.StepEnv:       "05-env.log",
	state.StepUp:        "06-up.log",
	state.StepMigrate:   "07-migrate.log",
	state.StepSeed:      "08-seed.log",
	state.StepSmoke:     "09-smoke.log",
	state.StepDone:      "99-summary.txt",
}

// stepTimeout 是每步的上限。设上限的原因：现场无人值守时，一个卡住的 dpkg
// 或 docker load 会让向导页面永远转圈，比报错更糟。超时会明确说「卡在哪一步」。
func stepTimeout(step state.Step) time.Duration {
	switch step {
	case state.StepPreflight:
		return 3 * time.Minute
	case state.StepVerify:
		// 1.5GB 镜像 tar 的 sha256 在慢盘上可能几分钟。
		return 30 * time.Minute
	case state.StepDocker:
		return 15 * time.Minute
	case state.StepImages:
		return 40 * time.Minute
	case state.StepEnv:
		return 2 * time.Minute
	case state.StepUp:
		return 12 * time.Minute
	case state.StepMigrate, state.StepSeed:
		return 10 * time.Minute
	case state.StepSmoke:
		return 15 * time.Minute
	default:
		return 5 * time.Minute
	}
}

// envValues 是向导第 ④ 步表单的内容，也是唯一的 .env 数据来源。
//
// 8 项高敏参数：S3 局域网端点 + 6 项凭据 + CORS 白名单。设计 §3.4 要求
// 前 6 项必须由用户显式填写，不允许安装器「帮你生成一个随机密码」——
// 管理员需要知道密码才能登录，随机生成的密码在无人值守场景等于把自己锁在门外。
type envValues struct {
	// Endpoint 是 S3_PUBLIC_ENDPOINT：局域网浏览器做预签名直传时用的地址。
	// 填 127.0.0.1 会造成「能登录、能检索、一上传就失败」（风险 R9）。
	Endpoint         string `json:"endpoint"`
	PostgresPassword string `json:"postgresPassword"`
	MinioAccessKey   string `json:"minioAccessKey"`
	MinioSecretKey   string `json:"minioSecretKey"`
	JwtAccessSecret  string `json:"jwtAccessSecret"`
	JwtRefreshSecret string `json:"jwtRefreshSecret"`
	RedisPassword    string `json:"redisPassword"`
	CorsOrigins      string `json:"corsOrigins"`
	Overwrite        bool   `json:"overwrite"`
}

// requiredEnvKeys 是 .env.tpl 里被占位化的键（与 installer/build/build-server-package.sh
// 的 PLACEHOLDER_KEYS 严格对应）。漏一个都会让栈带着空密码起来。
var requiredEnvKeys = []string{
	"S3_PUBLIC_ENDPOINT",
	"POSTGRES_PASSWORD",
	"MINIO_ACCESS_KEY",
	"MINIO_SECRET_KEY",
	"JWT_ACCESS_SECRET",
	"JWT_REFRESH_SECRET",
	"REDIS_PASSWORD",
	"CORS_ORIGINS",
}

// toMap 把表单转成 envfile.Render 需要的 map，并补全派生字段。
func (v envValues) toMap() map[string]string {
	cors := strings.TrimSpace(v.CorsOrigins)
	if cors == "" {
		// 默认白名单 = 本次部署的访问地址 + localhost（管理员本机调试用）。
		cors = "http://" + v.Endpoint + ":8080,http://localhost:8080"
	}
	return map[string]string{
		"S3_PUBLIC_ENDPOINT": v.Endpoint,
		"POSTGRES_PASSWORD":  v.PostgresPassword,
		"MINIO_ACCESS_KEY":   v.MinioAccessKey,
		"MINIO_SECRET_KEY":   v.MinioSecretKey,
		"JWT_ACCESS_SECRET":  v.JwtAccessSecret,
		"JWT_REFRESH_SECRET": v.JwtRefreshSecret,
		"REDIS_PASSWORD":     v.RedisPassword,
		"CORS_ORIGINS":       cors,
	}
}

// validate 检查表单。返回的问题全部是「人能照着改」的具体话术。
func (v envValues) validate() []string {
	var problems []string
	host := strings.TrimSpace(v.Endpoint)
	switch {
	case host == "":
		problems = append(problems, "局域网地址（S3_PUBLIC_ENDPOINT）必填：留空会让预签名 URL 指向 127.0.0.1，局域网浏览器一上传就失败")
	case host == "127.0.0.1" || strings.EqualFold(host, "localhost"):
		problems = append(problems, "局域网地址不能是 127.0.0.1 / localhost：这是风险 R9 的典型症状（能登录、能检索、一上传就失败）")
	default:
		if net.ParseIP(host) == nil {
			// 允许主机名，但必须是单段无空格的可解析形式
			if strings.ContainsAny(host, " /\\?&") || strings.Contains(host, ":") {
				// 带端口也不行：这一项只填地址，端口由 S3_PUBLIC_PORT 管
				problems = append(problems, "局域网地址只填 IP 或主机名，不要带端口/路径/空格")
			}
		}
	}
	check := func(name, val string, min int) {
		if len(strings.TrimSpace(val)) < min {
			problems = append(problems, fmt.Sprintf("%s 至少 %d 个字符（当前 %d）", name, min, len(strings.TrimSpace(val))))
		}
	}
	check("PostgreSQL 密码", v.PostgresPassword, 12)
	check("MinIO 访问密钥", v.MinioAccessKey, 6)
	check("MinIO 私钥", v.MinioSecretKey, 12)
	check("JWT 访问令牌密钥", v.JwtAccessSecret, 32)
	check("JWT 刷新令牌密钥", v.JwtRefreshSecret, 32)
	check("Redis 密码", v.RedisPassword, 8)
	if strings.TrimSpace(v.JwtAccessSecret) != "" && v.JwtAccessSecret == v.JwtRefreshSecret {
		problems = append(problems, "两个 JWT 密钥不能相同（否则刷新令牌可以当访问令牌用）")
	}
	return problems
}

// session 是一次安装会话的全部状态。三个前端（Web / TUI / verify-only）共享它，
// 因此不存在「两套安装逻辑」（设计 §3.1 裁定）。
type session struct {
	cfg      config
	layout   buildplan.Layout
	manifest *buildplan.Manifest
	st       *state.State
	log      *audit.Logger
	runner   execx.Runner
	cleaner  *selfclean.Cleaner

	// stepMu 串行化「跑步骤」这一动作（两个浏览器标签不能同时装 Docker）。
	// mu 只保护下面的结果字段，读写都很短。
	stepMu sync.Mutex
	mu     sync.Mutex

	// persist 为 false 时**不写** state.json（--verify-only 用）。
	// 理由：只校验包不该消耗状态机，否则「先 --verify-only 再正式装」会让
	// S2 被标记为 DONE 而跳过——等于把完整性校验静默关掉了。
	persist     bool
	values      envValues
	imagesTar   string
	osInfo      buildplan.OSInfo
	preflight   *preflight.Report
	osMatch     buildplan.Match
	verify      []buildplan.FileCheck
	imagesRes   *images.Result
	dockerRes   *dockerinstall.Result
	services    []stack.ServiceHealth
	smoke       []stack.SmokeItem
	envResult   *envfile.WriteResult
	confirmed   bool // 用户已勾选「未验证组合，风险自担」
	lastErr     string
	lastStep    state.Step
	startedAt   time.Time
	stepTimings map[state.Step]time.Duration
}

// newSession 装配会话：读 manifest、载入/新建 state.json、开日志目录。
func newSession(cfg config) (*session, error) {
	layout := buildplan.Layout{
		Root:       cfg.rootDir,
		DeployRoot: cfg.deployRoot,
		StateFile:  cfg.stateFile,
		LogRoot:    cfg.logRoot,
		UnitPath:   cfg.unitPath,
	}.Normalize()

	mf, err := buildplan.LoadManifest(layout.ManifestPath())
	if err != nil {
		return nil, fmt.Errorf("%w\n提示：安装器必须在 setup.run 自解压后的目录内运行（%s）", err, layout.Root)
	}

	logger, err := audit.New(layout.LogRoot)
	if err != nil {
		return nil, err
	}

	persist := !cfg.verifyOnly
	st, err := state.Load(layout.StateFile)
	if err != nil {
		return nil, err
	}
	if st == nil {
		st = state.New(mf.Product, mf.Version, mf.Variant, mf.Arch)
		if persist {
			if err := st.Save(layout.StateFile); err != nil {
				return nil, err
			}
		}
	}

	s := &session{
		cfg:         cfg,
		persist:     persist,
		layout:      layout,
		manifest:    mf,
		st:          st,
		log:         logger,
		runner:      execx.OSRunner{},
		cleaner:     selfclean.New(),
		imagesTar:   cfg.imagesTar,
		startedAt:   time.Now(),
		stepTimings: make(map[state.Step]time.Duration),
	}
	if s.imagesTar == "" {
		s.imagesTar = s.locateImagesTar(mf.ImagesTar.Filename)
	}
	// 断点重入时把表单值从已落盘的 .env 读回来。
	// 两个理由：① 用户不该为一个已经填过的 8 项凭据再抄一遍；
	// ② S10 汇总里的访问地址取自 values.Endpoint，读不回来就会印出「http://:8080」——
	// 这种「装完了但地址是空的」比报错更让人以为安装失败。
	if values, ok := loadEnvValues(s.layout.DeployRoot); ok {
		s.values = values
	}
	if raw, readErr := os.ReadFile("/etc/os-release"); readErr == nil {
		s.osInfo = buildplan.ParseOSRelease(string(raw))
		s.osMatch = buildplan.MatchOS(s.osInfo, mf.Variant)
	}
	return s, nil
}

// loadEnvValues 从部署根的 .env 读回向导表单值（断点重入用）。
//
// 只在 8 个占位键全部存在时才算读回成功：缺一个就说明这份 .env 不是本安装器
// 渲染的（或被人手改过），此时宁可让用户重新填，也不要用半份值去覆盖现场配置。
// CORS_ORIGINS 不参与判定——toMap 里有「留空即按 Endpoint 派生」的默认行为。
func loadEnvValues(deployRoot string) (envValues, bool) {
	raw, err := os.ReadFile(filepath.Join(deployRoot, ".env"))
	if err != nil {
		return envValues{}, false
	}
	kv := envfile.ParseValues(string(raw))
	for _, key := range requiredEnvKeys {
		if strings.TrimSpace(kv[key]) == "" {
			return envValues{}, false
		}
	}
	return envValues{
		Endpoint:         kv["S3_PUBLIC_ENDPOINT"],
		PostgresPassword: kv["POSTGRES_PASSWORD"],
		MinioAccessKey:   kv["MINIO_ACCESS_KEY"],
		MinioSecretKey:   kv["MINIO_SECRET_KEY"],
		JwtAccessSecret:  kv["JWT_ACCESS_SECRET"],
		JwtRefreshSecret: kv["JWT_REFRESH_SECRET"],
		RedisPassword:    kv["REDIS_PASSWORD"],
		CorsOrigins:      kv["CORS_ORIGINS"],
	}, true
}

// locateImagesTar 按「显式指定 → 安装器目录 → 可执行文件同目录 → 当前目录」找镜像 tar。
// 设计 §7.1 要求 setup.run 与 images.tar 同目录分发，所以这几个位置覆盖了现场全部摆放方式。
func (s *session) locateImagesTar(filename string) string {
	candidates := []string{s.layout.DefaultImagesTarPath(filename)}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), filename))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, filename))
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c
		}
	}
	return candidates[0]
}

// snapshot 是给前端的一次性只读快照（JSON 直接序列化）。
type snapshot struct {
	Product       string                `json:"product"`
	Version       string                `json:"version"`
	Variant       string                `json:"variant"`
	Arch          string                `json:"arch"`
	RootDir       string                `json:"rootDir"`
	DeployRoot    string                `json:"deployRoot"`
	LogDir        string                `json:"logDir"`
	StateFile     string                `json:"stateFile"`
	ImagesTar     string                `json:"imagesTar"`
	OS            buildplan.OSInfo      `json:"os"`
	OSMatch       buildplan.Match       `json:"osMatch"`
	Confirmed     bool                  `json:"confirmed"`
	NextStep      string                `json:"nextStep"`
	Steps         []stepView            `json:"steps"`
	Preflight     *preflight.Report     `json:"preflight,omitempty"`
	Verify        []buildplan.FileCheck `json:"verify,omitempty"`
	Docker        *dockerinstall.Result `json:"docker,omitempty"`
	DockerVersion string                `json:"dockerVersion,omitempty"`
	ImageCount    int                   `json:"imageCount,omitempty"`
	Images        *images.Result        `json:"images,omitempty"`
	EnvPath       string                `json:"envPath"`
	EnvWritten    bool                  `json:"envWritten"`
	Services      []stack.ServiceHealth `json:"services,omitempty"`
	Smoke         []stack.SmokeItem     `json:"smoke,omitempty"`
	Values        envValues             `json:"values"`
	LastError     string                `json:"lastError,omitempty"`
	LastStep      string                `json:"lastStep,omitempty"`
	AccessURL     string                `json:"accessUrl"`
	S3Endpoint    string                `json:"s3Endpoint"`
	StartedAt     time.Time             `json:"startedAt"`
	ElapsedMS     int64                 `json:"elapsedMs"`
	Timings       map[string]string     `json:"timings,omitempty"`
	Installed     bool                  `json:"installed"`
	Build         buildplan.Manifest    `json:"build"`
	ImageExpected int                   `json:"imageExpected"`
	UninstallHint string                `json:"uninstallHint"`
	HasToken      bool                  `json:"hasToken"`
}

type stepView struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

// Snapshot 汇总当前进度。
func (s *session) Snapshot() snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()

	names := buildplan.StepNames()
	var steps []stepView
	for _, step := range state.Steps {
		rec := s.st.Steps[step]
		v := stepView{ID: string(step), Title: names[string(step)], Status: string(state.StatusPending)}
		if rec != nil {
			v.Status = string(rec.Status)
			v.Message = rec.Message
		}
		steps = append(steps, v)
	}
	timings := make(map[string]string, len(s.stepTimings))
	for k, v := range s.stepTimings {
		timings[string(k)] = v.Round(time.Millisecond).String()
	}

	snap := snapshot{
		Product:       s.manifest.Product,
		Version:       s.manifest.Version,
		Variant:       s.manifest.Variant,
		Arch:          s.manifest.Arch,
		RootDir:       s.layout.Root,
		DeployRoot:    s.layout.DeployRoot,
		LogDir:        s.log.Dir(),
		StateFile:     s.layout.StateFile,
		ImagesTar:     s.imagesTar,
		OS:            s.osInfo,
		OSMatch:       s.osMatch,
		Confirmed:     s.confirmed,
		NextStep:      string(s.st.NextStep()),
		Steps:         steps,
		Preflight:     s.preflight,
		Verify:        s.verify,
		Docker:        s.dockerRes,
		Images:        s.imagesRes,
		EnvPath:       s.layout.EnvPath(),
		Services:      s.services,
		Smoke:         s.smoke,
		Values:        s.values,
		LastError:     s.lastErr,
		LastStep:      string(s.lastStep),
		AccessURL:     "http://" + displayHost(s.values.Endpoint) + ":8080",
		S3Endpoint:    "http://" + displayHost(s.values.Endpoint) + ":8333",
		StartedAt:     s.startedAt,
		ElapsedMS:     time.Since(s.startedAt).Milliseconds(),
		Timings:       timings,
		Build:         *s.manifest,
		ImageExpected: s.manifest.ImagesTar.ImageCount,
		HasToken:      s.cfg.token != "",
		UninstallHint: "sh " + s.cfg.runFile + " --uninstall",
	}
	if s.envResult != nil {
		snap.EnvWritten = true
	}
	if s.dockerRes != nil {
		snap.DockerVersion = s.dockerRes.DaemonVersion
	}
	if _, err := os.Stat(s.layout.EnvPath()); err == nil {
		snap.EnvWritten = true
	}
	if s.imagesRes != nil {
		snap.ImageCount = s.imagesRes.LoadedCount()
	}
	snap.Installed = s.services != nil && len(s.services) > 0
	return snap
}

func displayHost(endpoint string) string {
	if strings.TrimSpace(endpoint) == "" {
		return "<服务器IP>"
	}
	return strings.TrimSpace(endpoint)
}

// SetValues 接收向导表单（只做暂存，落盘发生在 S5）。
func (s *session) SetValues(v envValues) []string {
	if problems := v.validate(); len(problems) > 0 {
		return problems
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values = v
	if s.cfg.overwrite || v.Overwrite {
		s.cfg.overwrite = true
	}
	return nil
}

// Confirm 记录「未验证组合风险自担」的勾选。
func (s *session) Confirm() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.confirmed = true
}

// SetImagesTar 允许用户改镜像 tar 路径（现场放到别处时）。
func (s *session) SetImagesTar(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if strings.TrimSpace(path) != "" {
		s.imagesTar = strings.TrimSpace(path)
	}
}

// confirmRequiredError 表示「需要用户显式勾选风险确认」。
// Web 层据此返回 409 + needsConfirm，而不是笼统的 500。
type confirmRequiredError struct{ reason string }

func (e *confirmRequiredError) Error() string { return e.reason }

// RunStep 执行一步并把结果写进 state.json 与日志。
//
// 纪律（设计 §6.2）：只有成功才 Complete；失败只 Fail 且不前进。
func (s *session) RunStep(ctx context.Context, step state.Step) error {
	s.stepMu.Lock()
	defer s.stepMu.Unlock()

	// 已 DONE 的步骤不重跑（S5_ENV 例外：.env 变更后必须重渲）。设计 §6.2 规则 2。
	if s.st.IsDone(step) && step != state.StepEnv && step != state.StepDone {
		return nil
	}
	// --resume 语义：前面没做完就不许跳步，避免「先起栈再装 Docker」这种顺序错误。
	// 例外：--verify-only 必须能独立跑（设计 §4.4「安装器 --verify-only 可独立跑」），
	// 否则「只想确认介质有没有坏」就得先满足全部体检条件。
	if want := s.st.NextStep(); step != state.StepDone && want != step {
		if !(s.cfg.verifyOnly && step == state.StepVerify) {
			return fmt.Errorf("步骤顺序错误：当前应执行 %s，而不是 %s（用 --resume 从断点继续）", want, step)
		}
	}

	logName, ok := stepLogFile[step]
	if !ok {
		return fmt.Errorf("未知步骤 %s", step)
	}
	writer := s.log.Writer(logName)
	s.st.Begin(step)
	if s.persist {
		if err := s.st.Save(s.layout.StateFile); err != nil {
			return err
		}
	}

	stamp := time.Now()
	fmt.Fprintf(writer, "=== %s %s 开始 ===\n", step, buildplan.StepNames()[string(step)])
	err := s.execute(ctx, step, writer)
	elapsed := time.Since(stamp)

	s.mu.Lock()
	s.stepTimings[step] = elapsed
	s.lastStep = step
	if err != nil {
		s.lastErr = err.Error()
	} else {
		s.lastErr = ""
	}
	s.mu.Unlock()

	if err != nil {
		fmt.Fprintf(writer, "=== %s 失败（%s）: %v ===\n", step, elapsed.Round(time.Millisecond), err)
		s.st.Fail(step, 1, err.Error(), "")
		if s.persist {
			_ = s.st.Save(s.layout.StateFile)
		}
		_ = s.log.Append("99-summary.txt", fmt.Sprintf("%s FAIL (%s) %v", step, elapsed.Round(time.Millisecond), err))
		return err
	}
	fmt.Fprintf(writer, "=== %s 完成（%s）===\n", step, elapsed.Round(time.Millisecond))
	s.st.Complete(step, fmt.Sprintf("%s 用时 %s", buildplan.StepNames()[string(step)], elapsed.Round(time.Millisecond)))
	if s.persist {
		_ = s.st.Save(s.layout.StateFile)
	}
	_ = s.log.Append("99-summary.txt", fmt.Sprintf("%s DONE (%s)", step, elapsed.Round(time.Millisecond)))
	return nil
}

// execute 分派到具体步骤实现。
func (s *session) execute(ctx context.Context, step state.Step, w io.Writer) error {
	cctx, cancel := context.WithTimeout(ctx, stepTimeout(step))
	defer cancel()

	switch step {
	case state.StepPreflight:
		return s.stepPreflight(cctx, w)
	case state.StepVerify:
		return s.stepVerify(cctx, w)
	case state.StepDocker:
		return s.stepDocker(cctx, w)
	case state.StepImages:
		return s.stepImages(cctx, w)
	case state.StepEnv:
		return s.stepEnv(cctx, w)
	case state.StepUp:
		return s.stepUp(cctx, w)
	case state.StepMigrate:
		return s.stepMigrate(cctx, w)
	case state.StepSeed:
		return s.stepSeed(cctx, w)
	case state.StepSmoke:
		return s.stepSmoke(cctx, w)
	case state.StepDone:
		return s.stepDone(w)
	default:
		return fmt.Errorf("未知步骤 %s", step)
	}
}

// execAdapter 把 execx.Runner 适配成 preflight.Runner（后者只要 stdout 字符串）。
type execAdapter struct{ r execx.Runner }

func (a execAdapter) Run(ctx context.Context, name string, args ...string) (string, error) {
	out, err := a.r.Run(ctx, name, args...)
	return out.Combined(), err
}

func (s *session) stepPreflight(ctx context.Context, w io.Writer) error {
	logf := func(format string, args ...any) { fmt.Fprintf(w, format+"\n", args...) }

	rep := preflight.Check(ctx, preflight.Options{
		Variant: s.manifest.Variant,
		RootDir: "/",
		Runner:  execAdapter{r: execx.OSRunner{}},
	})
	for _, it := range rep.Items {
		fmt.Fprintf(w, "[%s] %-4s %s —— %s\n", it.ID, it.Level, it.Title, it.Detail)
		if it.Hint != "" {
			fmt.Fprintf(w, "        建议: %s\n", it.Hint)
		}
		if it.Raw != "" {
			fmt.Fprintf(w, "        实测: %s\n", strings.TrimSpace(it.Raw))
		}
	}
	s.mu.Lock()
	s.preflight = rep
	s.mu.Unlock()

	if bad := rep.Failed(); len(bad) > 0 {
		lines := make([]string, 0, len(bad))
		for _, it := range bad {
			lines = append(lines, fmt.Sprintf("[%s] %s：%s（%s）", it.ID, it.Title, it.Detail, it.Hint))
		}
		return fmt.Errorf("环境体检有 %d 项不通过，已阻断：\n  - %s", len(bad), strings.Join(lines, "\n  - "))
	}

	// OS 与包变体的匹配（设计 §5.2）
	match := s.osMatch
	logf("系统识别: ID=%s VERSION_ID=%s codename=%s（%s）", s.osInfo.ID, s.osInfo.VersionID, s.osInfo.Codename, s.osInfo.PrettyName)
	switch match.Level {
	case buildplan.MatchReject:
		return fmt.Errorf("本机系统与安装包变体不匹配：%s\n处置：改用 %s 变体的安装包", match.Reason, match.SuggestedVariant)
	case buildplan.MatchUnverified:
		s.mu.Lock()
		confirmed := s.confirmed
		s.mu.Unlock()
		if !confirmed {
			return &confirmRequiredError{reason: match.Reason + "。请在向导勾选「我已确认，风险自担」后继续"}
		}
		logf("WARN: 未验证组合，用户已确认风险自担")
	default:
		logf("匹配结论: %s", match.Reason)
	}

	// 已有业务栈时进入「已安装」分支（设计 §3.2）
	if existing := s.existingContainers(ctx); len(existing) > 0 {
		logf("WARN: 检测到已有天玑容器：%s（将进入「已安装」分支，不默认重新 up）", strings.Join(existing, ", "))
	}
	return nil
}

// existingContainers 探测是否已有 tianji 容器。
func (s *session) existingContainers(ctx context.Context) []string {
	out, err := s.runner.Run(ctx, "docker", "ps", "-a", "--filter", "label=com.docker.compose.project=tianji-archive", "--format", "{{.Names}}")
	if err != nil {
		return nil
	}
	var names []string
	for _, line := range strings.Split(out.Stdout, "\n") {
		if v := strings.TrimSpace(line); v != "" {
			names = append(names, v)
		}
	}
	return names
}

func (s *session) stepVerify(ctx context.Context, w io.Writer) error {
	fmt.Fprintf(w, "payload 根目录: %s\n", s.layout.Root)
	checks := buildplan.VerifyPayload(s.layout.Root, s.manifest)
	for _, c := range checks {
		if c.OK {
			fmt.Fprintf(w, "OK   %s  %s\n", c.Path, c.Actual)
			continue
		}
		if c.Err != "" {
			fmt.Fprintf(w, "FAIL %s  读取失败: %s\n", c.Path, c.Err)
			continue
		}
		fmt.Fprintf(w, "FAIL %s\n  期望 %s\n  实际 %s\n", c.Path, c.Expected, c.Actual)
	}
	s.mu.Lock()
	s.verify = checks
	tar := s.imagesTar
	s.mu.Unlock()

	if bad := buildplan.Failed(checks); len(bad) > 0 {
		return fmt.Errorf("%d/%d 个载荷文件校验失败（包损坏或被替换），已阻断", len(bad), len(checks))
	}
	fmt.Fprintf(w, "载荷文件 %d/%d 全部匹配\n", len(checks), len(checks))

	// 镜像 tar 溯源（与 manifest 的 sha256 同源）
	fmt.Fprintf(w, "镜像 tar: %s\n", tar)
	actual, err := buildplan.HashFile(tar)
	if err != nil {
		return fmt.Errorf("镜像 tar 不可读（%s）：%v\n处置：把 %s 与安装包放在同一目录，或用 --images-tar 指定路径",
			tar, err, s.manifest.ImagesTar.Filename)
	}
	if !strings.EqualFold(actual, s.manifest.ImagesTar.SHA256) {
		return fmt.Errorf("镜像 tar 校验失败，已阻断\n  期望 %s\n  实际 %s\n处置：重新拷贝镜像包（U 盘传输损坏最常见）",
			s.manifest.ImagesTar.SHA256, actual)
	}
	fmt.Fprintf(w, "镜像 tar 校验通过: %s\n", actual)
	return nil
}

func (s *session) stepDocker(ctx context.Context, w io.Writer) error {
	opts := dockerinstall.Options{
		Layout:    s.layout,
		Manifest:  s.manifest,
		Runner:    s.runner,
		Codename:  s.osInfo.Codename,
		NoSystemd: s.cfg.noSystemd || !execx.Has("systemctl"),
		Hash:      buildplan.HashFile,
		Logf:      func(format string, args ...any) { fmt.Fprintf(w, format+"\n", args...) },
	}
	res, err := dockerinstall.Install(ctx, opts)
	s.mu.Lock()
	s.dockerRes = res
	s.mu.Unlock()
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "方式=%s dockerd=%s compose=%s\n", res.Method, res.DaemonVersion, res.ComposeVersion)
	return nil
}

func (s *session) stepImages(ctx context.Context, w io.Writer) error {
	s.mu.Lock()
	tar := s.imagesTar
	s.mu.Unlock()

	res, err := images.Load(ctx, images.Options{
		TarPath:        tar,
		ListPath:       s.layout.ImagesListPath(),
		ExpectedSHA256: s.manifest.ImagesTar.SHA256,
		ExpectedCount:  s.manifest.ImagesTar.ImageCount,
		Runner:         s.runner,
		Hash:           buildplan.HashFile,
		Logf:           func(format string, args ...any) { fmt.Fprintf(w, format+"\n", args...) },
	})
	s.mu.Lock()
	s.imagesRes = res
	s.mu.Unlock()
	return err
}

func (s *session) stepEnv(ctx context.Context, w io.Writer) error {
	s.mu.Lock()
	values := s.values
	overwrite := s.cfg.overwrite || values.Overwrite
	s.mu.Unlock()

	if problems := values.validate(); len(problems) > 0 {
		return fmt.Errorf("部署表单还有 %d 项未填好：\n  - %s", len(problems), strings.Join(problems, "\n  - "))
	}

	// ① 部署根就绪：compose 文件、seaweedfs 入口与模板、volumes 目录
	if err := s.prepareDeployRoot(w); err != nil {
		return err
	}

	// ② 渲染 .env
	tplRaw, err := os.ReadFile(s.layout.EnvTemplatePath())
	if err != nil {
		return fmt.Errorf("读 .env 模板失败（包不完整）: %w", err)
	}
	content, unused, err := envfile.Render(string(tplRaw), values.toMap(), requiredEnvKeys)
	if err != nil {
		return err
	}
	if len(unused) > 0 {
		fmt.Fprintf(w, "WARN: 模板里没有这些键（模板与安装器版本不一致？）: %s\n", strings.Join(unused, ", "))
	}
	res, err := envfile.Write(s.layout.EnvPath(), content, envfile.WriteOptions{
		Force:     overwrite,
		BackupDir: s.log.Dir(),
	})
	if err != nil {
		if errors.Is(err, envfile.ErrAlreadyExists) {
			return fmt.Errorf("%s 已存在且未指定覆盖。为避免静默丢弃现场配置，这里拒绝直接覆盖。\n"+
				"处置：确认可以重写时，用 --overwrite 重启安装器，或在向导里勾选「覆盖已有 .env」", s.layout.EnvPath())
		}
		return err
	}
	s.mu.Lock()
	s.envResult = res
	s.mu.Unlock()

	// ③ 日志里只出现 key 与前 4 后 4（audit 的 maskingWriter 已做打码）
	fmt.Fprintf(w, ".env 已写入 %s（%d 字节）\n", res.Path, res.Bytes)
	if res.Overwritten {
		fmt.Fprintf(w, "原文件已备份到 %s\n", res.BackupPath)
	}
	for _, line := range strings.Split(content, "\n") {
		if strings.Contains(line, "=") {
			fmt.Fprintf(w, "  %s\n", audit.MaskSecret(line))
		}
	}
	return nil
}

// prepareDeployRoot 把 compose 与 SeaweedFS 入口落到部署根。
//
// 为什么必须复制而不是就地引用 payload：compose 里是 `./volumes/x`、`./seaweedfs/x`
// 这类相对路径，相对的是 **compose 文件所在目录**。若直接引用 /opt/tianji-installer
// 下的 copy，业务数据会落到安装器目录里，卸载时容易误删（设计 §2.3 明确 volumes 永不删）。
func (s *session) prepareDeployRoot(w io.Writer) error {
	if err := os.MkdirAll(s.layout.DeployRoot, 0o750); err != nil {
		return fmt.Errorf("创建部署根 %s 失败: %w", s.layout.DeployRoot, err)
	}
	if err := copyFile(s.layout.ComposePath(), s.layout.DeployedComposePath(), 0o640); err != nil {
		return fmt.Errorf("复制 compose 文件失败: %w", err)
	}
	fmt.Fprintf(w, "compose 文件 → %s\n", s.layout.DeployedComposePath())

	seaweedDir := filepath.Join(s.layout.DeployRoot, "seaweedfs")
	if err := os.MkdirAll(seaweedDir, 0o750); err != nil {
		return fmt.Errorf("创建 %s 失败: %w", seaweedDir, err)
	}
	for _, name := range []string{"entrypoint.sh", "s3.json.tpl"} {
		src := filepath.Join(s.layout.SeaweedFSDir(), name)
		mode := os.FileMode(0o640)
		if name == "entrypoint.sh" {
			// compose 里以 ro 挂进容器并由 /bin/sh 执行，必须有 +x
			mode = 0o750
		}
		if err := copyFile(src, filepath.Join(seaweedDir, name), mode); err != nil {
			return fmt.Errorf("复制 seaweedfs/%s 失败: %w", name, err)
		}
	}
	fmt.Fprintf(w, "seaweedfs 入口与模板 → %s\n", seaweedDir)

	for _, dir := range []string{"postgres", "wal_archive", "esdata", "seaweedfs", "redis", "backup"} {
		full := filepath.Join(s.layout.VolumesDir(), dir)
		if err := os.MkdirAll(full, 0o750); err != nil {
			return fmt.Errorf("创建卷目录 %s 失败: %w", full, err)
		}
	}
	fmt.Fprintf(w, "卷目录已就绪: %s\n", s.layout.VolumesDir())
	return nil
}

// newStack 用当前配置构造 stack 对象。
func (s *session) newStack(w io.Writer) *stack.Stack {
	s.mu.Lock()
	endpoint := s.values.Endpoint
	s.mu.Unlock()
	_ = endpoint
	return stack.New(stack.Options{
		Layout:        s.layout,
		ComposeFile:   s.layout.DeployedComposePath(),
		EnvFile:       s.layout.EnvPath(),
		Runner:        s.runner,
		APIBaseURL:    "http://127.0.0.1:3000",
		ESBaseURL:     "http://127.0.0.1:9200",
		HealthTimeout: 8 * time.Minute,
		Logf:          func(format string, args ...any) { fmt.Fprintf(w, format+"\n", args...) },
	})
}

func (s *session) stepUp(ctx context.Context, w io.Writer) error {
	st := s.newStack(w)
	if err := st.Up(ctx); err != nil {
		return err
	}
	services, err := st.WaitHealthy(ctx)
	s.mu.Lock()
	s.services = services
	s.mu.Unlock()
	if err != nil {
		return err
	}
	for _, svc := range services {
		fmt.Fprintf(w, "  %-14s state=%-10s health=%s\n", svc.Service, orDash(svc.State), orDash(svc.Health))
	}
	return nil
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func (s *session) stepMigrate(ctx context.Context, w io.Writer) error {
	return s.newStack(w).Migrate(ctx)
}

func (s *session) stepSeed(ctx context.Context, w io.Writer) error {
	return s.newStack(w).Seed(ctx)
}

func (s *session) stepSmoke(ctx context.Context, w io.Writer) error {
	st := s.newStack(w)
	items, err := st.Smoke(ctx)
	s.mu.Lock()
	s.smoke = items
	s.mu.Unlock()
	for _, it := range items {
		status := "FAIL"
		if it.Passed {
			status = "PASS"
		}
		fmt.Fprintf(w, "%s %s —— %s\n", status, it.Name, it.Detail)
		if it.Output != "" {
			fmt.Fprintf(w, "--- 原始输出 ---\n%s\n", it.Output)
		}
	}
	return err
}

// stepDone 写 99-summary.txt 汇总（设计 §6.3）。
func (s *session) stepDone(w io.Writer) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	fmt.Fprintf(w, "天玑档案管理系统 · 服务器端安装结果\n")
	fmt.Fprintf(w, "版本: %s  变体: %s  架构: %s\n", s.manifest.Version, s.manifest.Variant, s.manifest.Arch)
	fmt.Fprintf(w, "开始: %s  结束: %s  总耗时: %s\n\n",
		s.startedAt.Format(time.RFC3339), time.Now().Format(time.RFC3339),
		time.Since(s.startedAt).Round(time.Second))
	for _, step := range state.Steps {
		rec := s.st.Steps[step]
		status := "PENDING"
		msg := ""
		if rec != nil {
			status = string(rec.Status)
			msg = rec.Message
		}
		fmt.Fprintf(w, "%-14s %-8s %-10s %s\n", step, status, s.stepTimings[step].Round(time.Second), msg)
	}
	fmt.Fprintf(w, "\n访问地址: http://%s:8080\n", displayHost(s.values.Endpoint))
	fmt.Fprintf(w, "S3 端点 : http://%s:8333\n", displayHost(s.values.Endpoint))
	fmt.Fprintf(w, "部署根  : %s\n", s.layout.DeployRoot)
	fmt.Fprintf(w, "日志    : %s\n", s.log.Dir())
	fmt.Fprintf(w, "状态    : %s\n", s.layout.StateFile)
	fmt.Fprintf(w, "卸载    : sh %s --uninstall （保留业务数据）\n", s.cfg.runFile)
	return nil
}

// RunAll 从当前断点一路跑到完成（向导「一键执行」与 --resume 共用）。
func (s *session) RunAll(ctx context.Context, progress func(step state.Step, err error)) error {
	for {
		step := s.st.NextStep()
		if step == state.StepDone {
			if err := s.RunStep(ctx, state.StepDone); err != nil {
				return err
			}
			return nil
		}
		// 前置：S5 之前必须有表单值
		if step == state.StepEnv {
			s.mu.Lock()
			values := s.values
			s.mu.Unlock()
			if problems := values.validate(); len(problems) > 0 {
				return &formRequiredError{problems: problems}
			}
		}
		if err := s.RunStep(ctx, step); err != nil {
			if progress != nil {
				progress(step, err)
			}
			return err
		}
		if progress != nil {
			progress(step, nil)
		}
	}
}

// formRequiredError 表示「还差表单值」，Web 层返回 409 让前端跳回第 ④ 步。
type formRequiredError struct{ problems []string }

func (e *formRequiredError) Error() string {
	return "部署表单未填写：" + strings.Join(e.problems, "；")
}

// Uninstall 执行卸载：compose down（默认保留 volumes）。
func (s *session) Uninstall(ctx context.Context, purgeVolumes bool, w io.Writer) error {
	fmt.Fprintf(w, "执行卸载：%s\n", s.layout.DeployRoot)
	if _, err := os.Stat(s.layout.DeployedComposePath()); err != nil {
		return fmt.Errorf("部署根没有 compose 文件（%s），本机可能未安装：%w", s.layout.DeployedComposePath(), err)
	}
	st := s.newStack(w)
	args := st.ComposeArgs("down", "--remove-orphans")
	out, err := s.runner.Run(ctx, "docker", args...)
	fmt.Fprintf(w, "%s\n", strings.TrimRight(out.Combined(), "\n"))
	if err != nil {
		return fmt.Errorf("compose down 失败: %w", err)
	}
	if !purgeVolumes {
		fmt.Fprintln(w, "业务数据已保留（volumes/ 未删除）")
		return nil
	}
	if err := os.RemoveAll(s.layout.VolumesDir()); err != nil {
		return fmt.Errorf("删除 volumes 失败: %w", err)
	}
	fmt.Fprintf(w, "已删除业务数据目录 %s（不可恢复）\n", s.layout.VolumesDir())
	return nil
}

// copyFile 复制文件并设置权限（先建目录，权限在 Windows 上不生效但不影响逻辑）。
func copyFile(src, dest string, mode os.FileMode) error {
	raw, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o750); err != nil {
		return err
	}
	return os.WriteFile(dest, raw, mode)
}
