// Package envfile 渲染 /opt/tianji/.env。设计依据：docs/安装器总体设计.md §3.4 ④。
//
// 最关键的一条纪律来自风险 R8：**已存在的 .env 绝不静默覆盖**。
// 覆盖会丢凭据与端口配置，现场表现为「重跑安装器后登录不了/上传失败」，
// 且用户会以为是安装器坏了。因此本包默认拒绝，必须显式 Force。
package envfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ErrAlreadyExists 表示目标 .env 已存在且未显式要求覆盖。
var ErrAlreadyExists = errors.New("目标 .env 已存在，拒绝静默覆盖")

// ErrUnresolvedPlaceholder 表示渲染后仍有 __KEY__ 形式的占位符。
// 这类 .env 会让容器以「看起来正常」的方式启动然后各种 500，必须提前拦住。
var ErrUnresolvedPlaceholder = errors.New("渲染后仍有未替换的占位符")

// Render 用 values 替换模板中的 __KEY__ 占位符。
//
// 只替换模板里真实出现的占位符；values 里多出的键会被忽略并返回提示，
// 这样可以发现「向导收集了但模板没接」的漏接（比静默丢弃安全）。
// required 列出必须被替换的键，缺一个就报错。
func Render(template string, values map[string]string, required []string) (string, []string, error) {
	out := template
	var unused []string

	seen := make(map[string]bool, len(values))
	for _, key := range sortedKeys(values) {
		token := "__" + key + "__"
		if !strings.Contains(template, token) {
			unused = append(unused, key)
			continue
		}
		seen[key] = true
		out = strings.ReplaceAll(out, token, values[key])
	}

	var missing []string
	for _, key := range required {
		if !seen[key] {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return "", unused, fmt.Errorf("%w: 缺少 %s", ErrUnresolvedPlaceholder, strings.Join(missing, ", "))
	}

	if left := UnresolvedPlaceholders(out); len(left) > 0 {
		return "", unused, fmt.Errorf("%w: %s", ErrUnresolvedPlaceholder, strings.Join(left, ", "))
	}
	return out, unused, nil
}

// UnresolvedPlaceholders 扫描形如 __NAME__ 的残留占位符（NAME 为大写、数字或单下划线）。
//
// 注意：名字内部允许单个下划线（如 FOO_BAR），但连续两个下划线就是结束符，
// 所以内层循环遇到 "__" 必须立刻停——否则会把结束符吃进名字里，永远匹配不到。
func UnresolvedPlaceholders(content string) []string {
	var found []string
	seen := make(map[string]bool)
	for i := 0; i+1 < len(content); i++ {
		if content[i] != '_' || content[i+1] != '_' {
			continue
		}
		j := i + 2
		for j < len(content) {
			c := content[j]
			if isUpper(c) || isDigit(c) {
				j++
				continue
			}
			if c == '_' {
				if j+1 < len(content) && content[j+1] == '_' {
					break // 命中结束符
				}
				j++
				continue
			}
			break
		}
		if j+1 < len(content) && content[j] == '_' && content[j+1] == '_' && j > i+2 {
			name := content[i+2 : j]
			if !seen[name] {
				seen[name] = true
				found = append(found, name)
			}
			i = j + 1
		}
	}
	sort.Strings(found)
	return found
}

// WriteOptions 控制落盘行为。
type WriteOptions struct {
	// Force 为 true 时允许覆盖已存在的文件，但一定会先备份。
	Force bool
	// BackupDir 为备份落点；为空时备份到同目录的 .env.bak.<时间戳>。
	BackupDir string
	// Mode 为空时用 0600（.env 含凭据）。
	Mode os.FileMode
}

// WriteResult 描述落盘结果，用于日志与完成页展示。
type WriteResult struct {
	Path        string
	BackupPath  string
	Overwritten bool
	Bytes       int
}

// Write 把渲染结果写入 path。
//
// 已存在且 !Force → 返回 ErrAlreadyExists（调用方据此提示用户加 --force）。
// 已存在且 Force → 先复制到备份路径，再原子替换，备份路径写进结果供日志留痕。
func Write(path, content string, opts WriteOptions) (*WriteResult, error) {
	if path == "" {
		return nil, errors.New("未指定 .env 路径")
	}
	mode := opts.Mode
	if mode == 0 {
		mode = 0o600
	}

	res := &WriteResult{Path: path, Bytes: len(content)}

	if info, err := os.Stat(path); err == nil {
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("%s 已存在但不是普通文件，拒绝处理", path)
		}
		if !opts.Force {
			return nil, fmt.Errorf("%w: %s（如确认要用向导值覆盖，请加 --force，安装器会先备份）", ErrAlreadyExists, path)
		}
		backup, err := backup(path, opts.BackupDir)
		if err != nil {
			return nil, err
		}
		res.BackupPath = backup
		res.Overwritten = true
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("检查 %s 失败: %w", path, err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("创建部署目录失败: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), mode); err != nil {
		return nil, fmt.Errorf("写临时文件失败: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, fmt.Errorf("原子替换 .env 失败: %w", err)
	}
	return res, nil
}

func backup(path, backupDir string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("读取待备份 .env 失败: %w", err)
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	if backupDir == "" {
		backupDir = filepath.Dir(path)
	}
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		return "", fmt.Errorf("创建备份目录失败: %w", err)
	}
	dest := filepath.Join(backupDir, fmt.Sprintf(".env.bak.%s", stamp))
	if err := os.WriteFile(dest, raw, 0o600); err != nil {
		return "", fmt.Errorf("写备份失败: %w", err)
	}
	return dest, nil
}

// ParseValues 解析 `KEY=VALUE` 文本为 map（用于从模板或现场 .env 读回值）。
// 忽略注释与空行；不处理引号与转义——.env 约定就是裸值。
func ParseValues(content string) map[string]string {
	out := make(map[string]string)
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimRight(line, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		idx := strings.Index(line, "=")
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		if key == "" || strings.ContainsAny(key, " \t") {
			continue
		}
		out[key] = strings.TrimSpace(line[idx+1:])
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func isUpper(c byte) bool { return c >= 'A' && c <= 'Z' }
func isDigit(c byte) bool { return c >= '0' && c <= '9' }
