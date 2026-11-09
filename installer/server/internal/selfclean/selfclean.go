// Package selfclean 负责设计 §3.2 最后一行与 §6.1 收尾的 selfclean：
// 释放监听端口、清理临时目录，并保证 Ctrl-C / SIGTERM 时也执行。
//
// 为什么单独成包：安装器是「装完就该消失」的进程，任何残留的 18080 监听都会让
// 用户下次重装时看到「端口被占用」，进而怀疑上一个人没装完。清理逻辑必须只有
// 一份，且必须在 defer 与信号处理两处都被调用——两处各写一遍必然有一处漏。
package selfclean

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// Step 是一次清理动作。
type Step struct {
	Name string
	Err  error
}

// Cleaner 收集需要清理的资源，最后一次性执行（幂等）。
type Cleaner struct {
	mu        sync.Mutex
	listeners []namedCloser
	funcs     []namedFunc
	dirs      []string
	ran       bool
	results   []Step
}

type namedCloser struct {
	name string
	c    io.Closer
}

type namedFunc struct {
	name string
	fn   func() error
}

// New 构造 Cleaner。
func New() *Cleaner { return &Cleaner{} }

// AddListener 登记一个监听器（http.Server、net.Listener 等）。
func (c *Cleaner) AddListener(name string, l io.Closer) {
	if l == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.listeners = append(c.listeners, namedCloser{name: name, c: l})
}

// AddFunc 登记一个清理函数。
func (c *Cleaner) AddFunc(name string, fn func() error) {
	if fn == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.funcs = append(c.funcs, namedFunc{name: name, fn: fn})
}

// AddTempDir 登记一个要递归删除的临时目录。
func (c *Cleaner) AddTempDir(dir string) {
	if dir == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dirs = append(c.dirs, dir)
}

// Run 执行全部清理。可重复调用：只有第一次真正执行，后续返回同一份结果。
//
// 顺序：先关监听（让端口立刻可用），再跑函数（可能依赖监听已关），
// 最后删目录（函数可能还要读目录里的文件）。目录按登记逆序删（后建先删）。
func (c *Cleaner) Run() []Step {
	c.mu.Lock()
	if c.ran {
		out := c.results
		c.mu.Unlock()
		return out
	}
	c.ran = true
	listeners := c.listeners
	funcs := c.funcs
	dirs := c.dirs
	c.mu.Unlock()

	var results []Step
	for _, l := range listeners {
		err := l.c.Close()
		// 已关闭的监听再关会返回 "use of closed network connection"，这不是问题。
		if err != nil && !isAlreadyClosed(err) {
			results = append(results, Step{Name: "关闭 " + l.name, Err: err})
		} else {
			results = append(results, Step{Name: "关闭 " + l.name})
		}
	}
	for _, f := range funcs {
		results = append(results, Step{Name: f.name, Err: f.fn()})
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		dir := dirs[i]
		if err := os.RemoveAll(dir); err != nil {
			results = append(results, Step{Name: "删除 " + dir, Err: err})
		} else {
			results = append(results, Step{Name: "删除 " + dir})
		}
	}

	c.mu.Lock()
	c.results = results
	c.mu.Unlock()
	return results
}

func isAlreadyClosed(err error) bool {
	if err == nil {
		return true
	}
	msg := err.Error()
	return msg == "use of closed network connection" ||
		msg == "http: Server closed" ||
		filepath.Base(msg) == "already closed"
}

// Summarize 把清理结果压成一行人话，供 99-summary.txt 落盘。
func Summarize(steps []Step) string {
	var failed []string
	for _, s := range steps {
		if s.Err != nil {
			failed = append(failed, s.Name+": "+s.Err.Error())
		}
	}
	if len(failed) == 0 {
		return fmt.Sprintf("清理完成（%d 项，无异常）", len(steps))
	}
	out := fmt.Sprintf("清理完成（%d 项，%d 项异常）：", len(steps), len(failed))
	for i, f := range failed {
		if i > 0 {
			out += "; "
		}
		out += f
	}
	return out
}

// HandleSignals 在 ctx 取消或收到信号时调用 cleanup，返回的函数用于主动停止监听。
//
// 注意：cleanup 内部必须幂等（Cleaner.Run 已保证），因为 defer 与信号路径
// 都会触发它，两路同时到达时不能互相干扰。
func HandleSignals(ctx context.Context, out io.Writer, cleanup func(), sigs ...os.Signal) (stop func()) {
	if len(sigs) == 0 {
		sigs = []os.Signal{syscall.SIGINT, syscall.SIGTERM}
	}
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, sigs...)

	done := make(chan struct{})
	go func() {
		select {
		case sig := <-ch:
			if out != nil {
				fmt.Fprintf(out, "\n收到信号 %s，正在清理（端口释放 / 临时目录）…\n", sig)
			}
			cleanup()
			if out != nil {
				fmt.Fprintln(out, "清理完成，安装器退出。state.json 已保留，可 --resume 继续。")
			}
			os.Exit(130)
		case <-done:
		case <-ctx.Done():
		}
	}()

	return func() {
		signal.Stop(ch)
		close(done)
	}
}

// Countdown 在 d 内每秒回调一次剩余时间，返回 true 表示走完，false 表示被跳过。
//
// skip 非 nil 时（例如向导点了「立即结束」）会提前返回 false。
func Countdown(ctx context.Context, d time.Duration, skip <-chan struct{}, tick func(remaining time.Duration)) bool {
	if tick == nil {
		tick = func(time.Duration) {}
	}
	// nil ctx 是调用方的疏忽，但倒计时不该因此 panic（收尾阶段的进程崩掉
	// 比少打一行日志严重得多），这里兜底成 Background。
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := time.Now().Add(d)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			tick(0)
			return true
		}
		tick(remaining)
		wait := time.Second
		if remaining < wait {
			wait = remaining
		}
		select {
		case <-ctx.Done():
			return false
		case <-skip:
			return false
		case <-time.After(wait):
		}
	}
}
