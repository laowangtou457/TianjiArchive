// Package audit 负责安装日志。设计依据：docs/INSTALLER-DESIGN.md §6.3。
//
// 两条硬要求：
//  1. append-only：重跑生成新的时间戳目录，绝不改写历史日志——现场出问题时，
//     日志是唯一可远程索取的证据。
//  2. 敏感值打码：写日志前统一过一遍 MaskSecret，避免把凭据外发时泄露（风险 R14）。
package audit

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DefaultRoot 是日志根目录（设计 §2.3：永久保留）。
const DefaultRoot = "/var/log/tianji-install"

// Logger 负责一次安装会话的全部日志落盘。
type Logger struct {
	dir string

	mu    sync.Mutex
	files map[string]*os.File
}

// New 创建本次会话的日志目录：<root>/<UTC 时间戳>/。
// root 为空时用 DefaultRoot；测试可传临时目录。
func New(root string) (*Logger, error) {
	if root == "" {
		root = DefaultRoot
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	dir := filepath.Join(root, stamp)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("创建日志目录失败: %w", err)
	}
	return &Logger{dir: dir, files: make(map[string]*os.File)}, nil
}

// Dir 返回本次会话的日志目录，用于在完成页告知用户。
func (l *Logger) Dir() string { return l.dir }

// Path 返回某条日志文件的完整路径（不创建文件）。
func (l *Logger) Path(name string) string { return filepath.Join(l.dir, name) }

// Append 追加一行到指定日志文件，自动加时间戳前缀并做凭据打码。
// 同一文件多次调用复用同一个 *os.File，避免频繁开关。
func (l *Logger) Append(name, line string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	f, ok := l.files[name]
	if !ok {
		var err error
		f, err = os.OpenFile(filepath.Join(l.dir, name), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
		if err != nil {
			return fmt.Errorf("打开日志 %s 失败: %w", name, err)
		}
		l.files[name] = f
	}
	stamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	if _, err := fmt.Fprintf(f, "[%s] %s\n", stamp, MaskSecret(line)); err != nil {
		return fmt.Errorf("写入日志 %s 失败: %w", name, err)
	}
	return nil
}

// Writer 返回一个把字节流写入指定日志文件的 io.Writer，
// 供命令执行时直接 tee 原始输出（dpkg / docker load 的进度都要留证）。
func (l *Logger) Writer(name string) io.Writer {
	l.mu.Lock()
	defer l.mu.Unlock()

	f, ok := l.files[name]
	if !ok {
		var err error
		f, err = os.OpenFile(filepath.Join(l.dir, name), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
		if err != nil {
			// 日志不可写不应阻断安装主流程，退化为丢弃。
			return io.Discard
		}
		l.files[name] = f
	}
	return &maskingWriter{dst: f}
}

// Close 关闭所有已打开的日志文件。
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	var firstErr error
	for name, f := range l.files {
		if err := f.Close(); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("关闭日志 %s 失败: %w", name, err)
		}
		delete(l.files, name)
	}
	return firstErr
}

// maskingWriter 在写入前做凭据打码。
type maskingWriter struct {
	dst io.Writer
}

func (w *maskingWriter) Write(p []byte) (int, error) {
	masked := MaskSecret(string(p))
	if _, err := w.dst.Write([]byte(masked)); err != nil {
		return 0, err
	}
	// 返回原始长度：打码会改变字节数，回原长度才能让调用方认为「全部写入」。
	return len(p), nil
}

// secretKeys 是需要打码的键名。命中规则是 `KEY=value` 形式（.env 渲染日志的主要形态）。
var secretKeys = []string{
	"POSTGRES_PASSWORD",
	"MINIO_ACCESS_KEY",
	"MINIO_SECRET_KEY",
	"REDIS_PASSWORD",
	"JWT_ACCESS_SECRET",
	"JWT_REFRESH_SECRET",
}

// MaskSecret 把形如 KEY=value 的凭据值替换成「前 4 后 4」形式（设计 §6.3 05-env.log）。
// 短值全部打码，避免「前 4 后 4」拼回原值。
func MaskSecret(line string) string {
	out := line
	for _, key := range secretKeys {
		out = maskKey(out, key)
	}
	return out
}

func maskKey(line, key string) string {
	needle := key + "="
	var b strings.Builder
	rest := line
	for {
		idx := strings.Index(rest, needle)
		if idx < 0 {
			b.WriteString(rest)
			return b.String()
		}
		b.WriteString(rest[:idx+len(needle)])
		rest = rest[idx+len(needle):]

		// 值到行尾或空白为止（.env 里值不含空格）
		end := strings.IndexAny(rest, " \t\r\n")
		value := rest
		tail := ""
		if end >= 0 {
			value = rest[:end]
			tail = rest[end:]
		}
		b.WriteString(maskValue(value))
		rest = tail
	}
}

func maskValue(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return v
	}
	if strings.HasPrefix(v, "__") && strings.HasSuffix(v, "__") {
		return v // 未渲染的占位符，不是凭据
	}
	if len(v) < 12 {
		return "****"
	}
	return v[:4] + "****" + v[len(v)-4:]
}
