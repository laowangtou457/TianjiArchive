// Package execx 统一「执行外部命令」这一动作。
//
// 为什么要单独抽一层：dockerinstall / images / stack 三个模块都要跑 dpkg、
// docker、docker compose，三处各自拼 exec.Command 会导致①单测没法替换命令、
// ②输出捕获方式不一致、③日志里有的步骤有 stderr 有的没有。这里把三件事
// 一次做掉：捕获 stdout/stderr/退出码、把输出旁路到日志 Writer（向导页实时
// 滚动就靠这个 Writer）、把非零退出码包装成带「最后几行输出」的错误。
//
// 注意：preflight 包刻意**不**依赖本包。它只需要 stdout 一个字符串，用 (string, error)
// 的窄接口能让 13 项内核探测的单测写起来最省事（Go 的「接口要窄、由使用方定义」
// 原则）。执行类模块需要 stderr 与退出码，才用这里的 Result。
package execx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// Result 是一次命令执行的可观测量。
type Result struct {
	// Command 是「命令 + 空格分隔的参数」，仅用于日志与报错，不用于再次执行。
	Command  string
	Stdout   string
	Stderr   string
	ExitCode int
}

// Combined 返回 stdout 与 stderr 的合并文本（stderr 在后），用于整段落盘。
func (r Result) Combined() string {
	switch {
	case r.Stdout == "" && r.Stderr == "":
		return ""
	case r.Stderr == "":
		return r.Stdout
	case r.Stdout == "":
		return r.Stderr
	default:
		return r.Stdout + "\n" + r.Stderr
	}
}

// Tail 返回合并输出的最后 n 行。现场排障时，几百行 dpkg 输出里只有最后几行
// 有用，而错误信息必须能直接看懂，所以统一走这里。
func (r Result) Tail(n int) string {
	text := strings.TrimRight(r.Combined(), "\r\n")
	if text == "" || n <= 0 {
		return ""
	}
	lines := strings.Split(text, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// Error 表示命令以非零状态退出。调用方可用 errors.As(err, &execx.Error{}) 取回 Result。
type Error struct {
	Result Result
	cause  error
}

func (e *Error) Error() string {
	msg := fmt.Sprintf("命令失败（退出码 %d）: %s", e.Result.ExitCode, e.Result.Command)
	if tail := e.Result.Tail(8); tail != "" {
		msg += "\n--- 最后输出 ---\n" + tail
	}
	return msg
}

// Unwrap 让调用方可以判断底层是超时（context.DeadlineExceeded）还是找不到可执行文件。
func (e *Error) Unwrap() error { return e.cause }

// Runner 是执行器抽象。所有依赖外部命令的模块都接收它，单测传入桩实现。
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (Result, error)
}

// OSRunner 是真实执行器。
type OSRunner struct {
	// Env 非 nil 时追加到 os.Environ() 之后（后者覆盖前者，符合 exec 语义）。
	Env []string
	// Dir 是工作目录；空表示进程当前目录。
	Dir string
	// Sink 非 nil 时，stdout/stderr 会同时写入它（向导实时日志）。
	// 只旁路不替代捕获——Result 里仍然拿得到完整输出。
	Sink io.Writer
}

// Run 执行一条命令。
func (o OSRunner) Run(ctx context.Context, name string, args ...string) (Result, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = o.Dir
	if o.Env != nil {
		cmd.Env = append(os.Environ(), o.Env...)
	}

	var stdout, stderr bytes.Buffer
	if o.Sink != nil {
		cmd.Stdout = io.MultiWriter(&stdout, o.Sink)
		cmd.Stderr = io.MultiWriter(&stderr, o.Sink)
	} else {
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
	}

	command := name
	if len(args) > 0 {
		command = name + " " + strings.Join(args, " ")
	}
	res := Result{Command: command}

	err := cmd.Run()
	res.Stdout = stdout.String()
	res.Stderr = stderr.String()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			res.ExitCode = exitErr.ExitCode()
			return res, &Error{Result: res, cause: err}
		}
		// 找不到可执行文件 / 权限不足 / 上下文取消：退出码记 -1 以便区分。
		res.ExitCode = -1
		return res, &Error{Result: res, cause: err}
	}
	return res, nil
}

// LookPath 暴露 exec.LookPath，让上层判断 systemctl / dockerd 是否存在，
// 避免把「命令不存在」误判成「命令执行失败」。单测可以替换这个变量。
var LookPath = exec.LookPath

// Has 判断命令是否在 PATH 中。
func Has(name string) bool {
	_, err := LookPath(name)
	return err == nil
}
