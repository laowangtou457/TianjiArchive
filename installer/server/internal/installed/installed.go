// Package installed 记录「安装器亲手写了哪些文件」，供卸载时按清单删除。
//
// 为什么需要这份记录（设计 §6 第 4 条）：变体 B 不经过任何包管理器，
// 系统里没有 rpm/dpkg 的归属数据库可以反查「这个文件是谁装的」。如果卸载靠
// 「按约定猜路径」，猜宽了会删掉运维自己放的东西，猜窄了会留一堆孤儿文件
// 让下一次安装撞上「已存在」。所以安装时写下清单，卸载时**只删清单里的**。
//
// 两条硬纪律：
//  1. 清单之外一律不删。清单缺失时宁可报错让人看，也不做「大概删一下」。
//  2. 业务数据目录（volumes）永远不在清单里，卸载即便「连数据一起删」也走
//     flow 里显式的那一步，不通过本包。
package installed

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Kind 是清单项的类别，只影响删除顺序与日志措辞。
type Kind string

const (
	// KindFile 是单文件（unit、compose 插件、脚本）。
	KindFile Kind = "file"
	// KindDir 是目录（静态二进制目录）。删除顺序永远排在文件之后。
	KindDir Kind = "dir"
)

// Entry 是一项「我写的」东西。
type Entry struct {
	Path string `json:"path"`
	Kind Kind   `json:"kind"`
	Why  string `json:"why"`
}

// Record 是完整清单。
type Record struct {
	Product string  `json:"product"`
	Variant string  `json:"variant"`
	Version string  `json:"version"`
	Entries []Entry `json:"entries"`
}

// New 构造空清单。
func New(variant, version string) *Record {
	return &Record{Product: "tianji-archive", Variant: variant, Version: version}
}

// Add 追加一项。路径必须是绝对路径：相对路径在卸载时会被解析到「当前目录」，
// 这是最容易造成误删的一类输入，直接拒绝。
func (r *Record) Add(path string, kind Kind, why string) error {
	if r == nil {
		return errors.New("installed: 清单为空")
	}
	p := strings.TrimSpace(path)
	if p == "" {
		return errors.New("installed: 拒绝登记空路径")
	}
	if !filepath.IsAbs(p) {
		return fmt.Errorf("installed: 只登记绝对路径，收到 %q", p)
	}
	// 清单里出现 "/" 或根下第一层目录说明调用方算错了，这种项删起来就是灾难。
	if cleaned := filepath.Clean(p); cleaned == string(filepath.Separator) || cleaned == "/" {
		return fmt.Errorf("installed: 拒绝登记根目录 %q", p)
	}
	for i := range r.Entries {
		if r.Entries[i].Path == p {
			return nil // 幂等：重复登记不报错（S3 重跑时会发生）
		}
	}
	r.Entries = append(r.Entries, Entry{Path: p, Kind: kind, Why: why})
	return nil
}

// Save 落盘（0640：清单里没有敏感信息，但也不需要全局可读）。
func (r *Record) Save(path string) error {
	if r == nil {
		return errors.New("installed: 清单为空")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("创建清单目录失败: %w", err)
	}
	raw, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化清单失败: %w", err)
	}
	return os.WriteFile(path, append(raw, '\n'), 0o640)
}

// Load 读取清单。文件不存在时返回 (nil, nil)——「没装过」不是错误。
func Load(path string) (*Record, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("读安装清单失败: %w", err)
	}
	var r Record
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("解析安装清单失败（%s）: %w", path, err)
	}
	return &r, nil
}

// Removed 是一项删除结果。
type Removed struct {
	Path string
	Kind Kind
	// Err 为 nil 表示删掉了；os.ErrNotExist 视为「已经不在了」，也记 nil。
	Err error
	// Skipped 非空表示「按规矩没删」，值是原因（受保护 / 越界 / 干跑）。
	Skipped string
}

// RemoveOptions 控制卸载行为，全部可注入，便于单测在任意 OS 上跑。
type RemoveOptions struct {
	// DryRun 只算不删（向导里「我看看会删什么」用）。
	DryRun bool
	// Remove 默认 os.RemoveAll；注入后单测不需要真删。
	Remove func(path string) error
	// Protected 是永不删除的前缀（业务数据）。命中前缀的项直接 Skipped。
	Protected []string
}

func (o *RemoveOptions) normalize() {
	if o.Remove == nil {
		o.Remove = os.RemoveAll
	}
}

// isProtected 判断 path 是否落在受保护前缀下。
//
// 用「路径分段前缀」比较，不用 strings.HasPrefix：后者会把
// /opt/tianji-backup-bak 误判成 /opt/tianji 的子路径而拒绝删除/放行删除，
// 两种都是错。
func isProtected(path string, protected []string) bool {
	clean := filepath.Clean(path)
	for _, p := range protected {
		q := filepath.Clean(strings.TrimSpace(p))
		if q == "" {
			continue
		}
		if clean == q || strings.HasPrefix(clean, q+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// Uninstall 按清单删除，**只删清单里登记的**。返回逐项结果（顺序稳定，便于日志与断言）。
//
// 删除顺序：先文件后目录；同类按路径长度倒序（深的先删，浅的后删），
// 否则先删父目录会让后面的子项全变成「不存在」而看不出真实错因。
func (r *Record) Uninstall(opts RemoveOptions) []Removed {
	opts.normalize()
	if r == nil || len(r.Entries) == 0 {
		return nil
	}

	entries := make([]Entry, len(r.Entries))
	copy(entries, r.Entries)
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Kind != entries[j].Kind {
			return entries[i].Kind == KindFile
		}
		return len(entries[i].Path) > len(entries[j].Path)
	})

	out := make([]Removed, 0, len(entries))
	for _, e := range entries {
		item := Removed{Path: e.Path, Kind: e.Kind}
		switch {
		case strings.TrimSpace(e.Path) == "" || !filepath.IsAbs(e.Path):
			item.Skipped = "清单项不是绝对路径，拒绝删除"
		case isProtected(e.Path, opts.Protected):
			item.Skipped = "落在受保护前缀下（业务数据），不删"
		case opts.DryRun:
			item.Skipped = "干跑：未实际删除"
		default:
			if err := opts.Remove(e.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
				item.Err = err
			}
		}
		out = append(out, item)
	}
	return out
}

// Summary 把结果压成一行人话（写进 99-summary.txt 与卸载输出）。
func Summary(items []Removed) string {
	if len(items) == 0 {
		return "清单为空，没有需要删除的文件"
	}
	var removed, skipped, failed int
	for _, it := range items {
		switch {
		case it.Err != nil:
			failed++
		case it.Skipped != "":
			skipped++
		default:
			removed++
		}
	}
	s := fmt.Sprintf("已删除 %d 项", removed)
	if skipped > 0 {
		s += fmt.Sprintf("，跳过 %d 项", skipped)
	}
	if failed > 0 {
		s += fmt.Sprintf("，失败 %d 项", failed)
	}
	return s
}
