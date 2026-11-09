package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"tianji-archive/installer/internal/state"
	"tianji-archive/installer/web"
)

// api 是 Web 向导的后端。所有写操作都经过 token 与 Origin 两道校验。
type api struct {
	sess  *session
	token string
	stop  chan struct{}
}

// runWeb 启动本机临时 Web 向导，返回进程退出码。
func runWeb(sess *session) int {
	a := &api{sess: sess, token: sess.cfg.token, stop: make(chan struct{})}

	mux := http.NewServeMux()
	mux.HandleFunc("/", a.guard(a.handleStatic))
	mux.HandleFunc("/api/status", a.guard(a.handleStatus))
	mux.HandleFunc("/api/step", a.guard(a.handleStep))
	mux.HandleFunc("/api/run-all", a.guard(a.handleRunAll))
	mux.HandleFunc("/api/env", a.guard(a.handleEnv))
	mux.HandleFunc("/api/images-tar", a.guard(a.handleImagesTar))
	mux.HandleFunc("/api/confirm", a.guard(a.handleConfirm))
	mux.HandleFunc("/api/log", a.guard(a.handleLog))
	mux.HandleFunc("/api/uninstall", a.guard(a.handleUninstall))
	mux.HandleFunc("/api/finish", a.guard(a.handleFinish))

	listener, addr, err := bindFirst(sess.cfg.listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "绑定监听端口失败:", err)
		return 1
	}
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	// 端口必须随进程一起释放，否则下次重装会看到「18080 被占用」。
	sess.cleaner.AddListener("安装向导监听 "+addr, srv)
	cleanup := installCleanup(sess)
	defer cleanup()

	printBanner(sess, addr)

	go func() {
		if serveErr := srv.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, "向导服务异常退出:", serveErr)
			close(a.stop)
		}
	}()

	<-a.stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	return 0
}

// bindFirst 依次尝试 18080→18081→18082（设计 §3.2）。
// 三个端口都被占时**不**随便再往后找：说明这台机器上已有别的安装器实例在跑，
// 让用户先去处理那个实例，比悄悄绑到 18099 更不容易出错。
func bindFirst(want string) (net.Listener, string, error) {
	host, portStr, err := net.SplitHostPort(want)
	if err != nil {
		host, portStr = want, "18080"
	}
	base, convErr := strconv.Atoi(portStr)
	if convErr != nil {
		base = 18080
	}
	var lastErr error
	for offset := 0; offset < 3; offset++ {
		addr := net.JoinHostPort(host, strconv.Itoa(base+offset))
		l, listenErr := net.Listen("tcp", addr)
		if listenErr == nil {
			return l, addr, nil
		}
		lastErr = listenErr
	}
	return nil, "", fmt.Errorf("%s~%d 三个端口都被占用（最后的错误: %v）", want, base+2, lastErr)
}

// printBanner 在服务器终端大字打印访问地址与 token（设计 §3.2）。
func printBanner(sess *session, addr string) {
	out := os.Stdout
	line := strings.Repeat("=", 72)
	fmt.Fprintln(out, line)
	fmt.Fprintf(out, "  天玑档案管理系统 · 服务器端安装向导\n")
	fmt.Fprintf(out, "  版本 %s   变体 %s   架构 %s\n", sess.manifest.Version, sess.manifest.Variant, sess.manifest.Arch)
	fmt.Fprintln(out, line)
	url := "http://" + addr + "/"
	if sess.cfg.token != "" {
		url += "?t=" + sess.cfg.token
	}
	fmt.Fprintf(out, "  请在浏览器打开：\n\n      %s\n\n", url)
	if sess.cfg.token != "" {
		fmt.Fprintf(out, "  一次性访问令牌（%s 内有效）：\n      %s\n\n", sess.cfg.tokenTTL, sess.cfg.token)
		fmt.Fprintln(out, "  提示：绑定非回环地址时必须带令牌，否则任何人都能替你装 Docker、改 sysctl。")
	} else {
		fmt.Fprintln(out, "  当前仅监听回环地址。若要从别的机器访问，请加 --listen 0.0.0.0:18080")
		fmt.Fprintln(out, "  （那样会强制启用一次性令牌），或在本机执行：")
		fmt.Fprintf(out, "      ssh -L 18080:127.0.0.1:18080 <本机用户>@<服务器IP>\n")
	}
	fmt.Fprintln(out, line)
	fmt.Fprintf(out, "  日志目录：%s\n", sess.log.Dir())
	fmt.Fprintf(out, "  状态文件：%s\n", sess.layout.StateFile)
	fmt.Fprintln(out, line)
}

// guard 做认证与来源校验。
func (a *api) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.authorized(r) {
			writeJSON(w, http.StatusForbidden, resp{Error: "403：缺少或错误的访问令牌（绑定非回环地址时必须带 ?t=<token>）"})
			return
		}
		if r.Method == http.MethodPost && !originOK(r) {
			writeJSON(w, http.StatusForbidden, resp{Error: "403：Origin 与 Host 不一致，已拒绝跨站写操作"})
			return
		}
		h(w, r)
	}
}

func (a *api) authorized(r *http.Request) bool {
	if a.token == "" {
		return true // 回环模式：设计 §3.3 的最安全默认
	}
	token := r.URL.Query().Get("t")
	if token == "" {
		token = r.Header.Get("X-Tianji-Token")
	}
	return token == a.token
}

// originOK：浏览器跨站 POST 会带 Origin，必须与 Host 同源。
func originOK(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // 非浏览器客户端或同源 GET→POST
	}
	return strings.EqualFold(origin, "http://"+r.Host) || strings.EqualFold(origin, "https://"+r.Host)
}

type resp struct {
	OK           bool     `json:"ok"`
	Error        string   `json:"error,omitempty"`
	NeedsConfirm bool     `json:"needsConfirm,omitempty"`
	NeedsForm    bool     `json:"needsForm,omitempty"`
	Problems     []string `json:"problems,omitempty"`
	Data         any      `json:"data,omitempty"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// handleStatic 提供内嵌前端。加 CSP 是为了让「不加载任何外部资源」这条
// 约束在浏览器层面也成立（现场无公网，CDN 引用会白屏且难查）。
func (a *api) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, http.StatusMethodNotAllowed, resp{Error: "只支持 GET"})
		return
	}
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	sub, err := fs.Sub(web.FS, ".")
	if err != nil {
		http.Error(w, "内嵌资源不可用: "+err.Error(), http.StatusInternalServerError)
		return
	}
	http.FileServer(http.FS(sub)).ServeHTTP(w, r)
}

func (a *api) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, resp{OK: true, Data: a.sess.Snapshot()})
}

func (a *api) handleStep(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, resp{Error: "只支持 POST"})
		return
	}
	var body struct {
		Step string `json:"step"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, resp{Error: "请求体不是合法 JSON: " + err.Error()})
		return
	}
	step, ok := lookupStep(body.Step)
	if !ok {
		writeJSON(w, http.StatusBadRequest, resp{Error: "未知步骤 " + body.Step})
		return
	}
	ctx := r.Context()
	if err := a.sess.RunStep(ctx, step); err != nil {
		writeJSON(w, http.StatusConflict, classify(err))
		return
	}
	writeJSON(w, http.StatusOK, resp{OK: true, Data: a.sess.Snapshot()})
}

// handleRunAll 从断点一路跑到完成（前端轮询 status 显示进度）。
func (a *api) handleRunAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, resp{Error: "只支持 POST"})
		return
	}
	// 用独立 ctx：前端断开不应中断安装（用户可能只是切了标签页）。
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	if err := a.sess.RunAll(ctx, nil); err != nil {
		writeJSON(w, http.StatusConflict, classify(err))
		return
	}
	writeJSON(w, http.StatusOK, resp{OK: true, Data: a.sess.Snapshot()})
}

// classify 把内部错误映射成前端能区分处理的响应。
func classify(err error) resp {
	var confirmErr *confirmRequiredError
	if errors.As(err, &confirmErr) {
		return resp{Error: confirmErr.Error(), NeedsConfirm: true}
	}
	var formErr *formRequiredError
	if errors.As(err, &formErr) {
		return resp{Error: formErr.Error(), NeedsForm: true, Problems: formErr.problems}
	}
	return resp{Error: err.Error()}
}

func (a *api) handleEnv(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, resp{Error: "只支持 POST"})
		return
	}
	var values envValues
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&values); err != nil {
		writeJSON(w, http.StatusBadRequest, resp{Error: "表单解析失败: " + err.Error()})
		return
	}
	if problems := a.sess.SetValues(values); len(problems) > 0 {
		writeJSON(w, http.StatusBadRequest, resp{Error: "表单校验未通过", Problems: problems, NeedsForm: true})
		return
	}
	writeJSON(w, http.StatusOK, resp{OK: true, Data: a.sess.Snapshot()})
}

func (a *api) handleImagesTar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, resp{Error: "只支持 POST"})
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, resp{Error: "请求体不是合法 JSON"})
		return
	}
	a.sess.SetImagesTar(body.Path)
	writeJSON(w, http.StatusOK, resp{OK: true, Data: a.sess.Snapshot()})
}

func (a *api) handleConfirm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, resp{Error: "只支持 POST"})
		return
	}
	a.sess.Confirm()
	writeJSON(w, http.StatusOK, resp{OK: true, Data: a.sess.Snapshot()})
}

// handleLog 返回某步日志的尾部，供前端 1 秒轮询实现「实时滚动」。
// 只允许读取白名单文件名，避免路径穿越。
func (a *api) handleLog(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if !allowedLogName(name) {
		writeJSON(w, http.StatusBadRequest, resp{Error: "不允许读取日志 " + name})
		return
	}
	tail := 300
	if v := r.URL.Query().Get("tail"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 5000 {
			tail = n
		}
	}
	raw, err := os.ReadFile(a.sess.log.Path(name))
	if err != nil {
		// 还没开始写：返回空内容而不是 404，前端不用区分。
		writeJSON(w, http.StatusOK, resp{OK: true, Data: map[string]any{"name": name, "content": ""}})
		return
	}
	writeJSON(w, http.StatusOK, resp{OK: true, Data: map[string]any{
		"name":    name,
		"content": lastLines(string(raw), tail),
	}})
}

func allowedLogName(name string) bool {
	for _, v := range stepLogFile {
		if name == v {
			return true
		}
	}
	return false
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func (a *api) handleUninstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, resp{Error: "只支持 POST"})
		return
	}
	var body struct {
		PurgeVolumes bool `json:"purgeVolumes"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
	var sb strings.Builder
	if err := a.sess.Uninstall(r.Context(), body.PurgeVolumes, &sb); err != nil {
		writeJSON(w, http.StatusConflict, resp{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, resp{OK: true, Data: sb.String()})
}

// handleFinish 完成页的「关闭安装器」：倒计时后释放端口并退出进程。
func (a *api) handleFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, resp{Error: "只支持 POST"})
		return
	}
	writeJSON(w, http.StatusOK, resp{OK: true, Data: map[string]any{
		"graceSeconds": int(a.sess.cfg.shutdownGrace.Seconds()),
	}})
	go func() {
		time.Sleep(a.sess.cfg.shutdownGrace)
		close(a.stop)
	}()
}

// lookupStep 把字符串映射成 state.Step，只接受状态机里存在的步骤。
func lookupStep(name string) (state.Step, bool) {
	for _, s := range state.Steps {
		if string(s) == name {
			return s, true
		}
	}
	return "", false
}
