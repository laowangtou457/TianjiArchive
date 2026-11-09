// Package images 负责设计 §6.1 第 ④ 步：镜像 tar 的溯源校验 + docker load +
// 按 images.txt 逐个 inspect（8/8）。
//
// 铁律：tar 的 sha256 必须与 manifest.json 里构建机写下的值一致才开始 load。
// 「少两个镜像也把栈起起来」是被明确禁止的降级（设计 §6.1 第 441 行注释），
// 因为那样失败会延后到用户第一次上传文件时才暴露，属于最坏的失败方式。
package images

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
)

// Options 是镜像导入的全部输入。
type Options struct {
	// TarPath 是现场实际的镜像 tar 路径（可能与包内默认位置不同，由用户确认）。
	TarPath string
	// ListPath 是 images.txt 路径（纯文本，一行一个镜像，// 与 # 开头为注释）。
	ListPath string
	// ExpectedSHA256 来自 manifest.json.images_tar.sha256，空值视为配置错误。
	ExpectedSHA256 string
	// ExpectedCount 来自 manifest.json.images_tar.image_count，>0 时与清单条数比对。
	ExpectedCount int
	Runner        execx.Runner
	// Hash 可注入（单测里避免真算 1.5GB），nil 时用 buildplan.HashFile。
	Hash func(path string) (string, error)
	// Logf 用于把进度写进该步骤的日志文件，nil 时静默。
	Logf func(format string, args ...any)
}

// ImageCheck 是单个镜像的 inspect 结果。
type ImageCheck struct {
	Name string `json:"name"`
	ID   string `json:"id,omitempty"`
	OK   bool   `json:"ok"`
	Err  string `json:"err,omitempty"`
}

// Result 是镜像导入的完整结果，直接序列化给向导展示。
type Result struct {
	TarPath        string       `json:"tarPath"`
	SHA256Expected string       `json:"sha256Expected"`
	SHA256Actual   string       `json:"sha256Actual"`
	LoadOutput     string       `json:"loadOutput,omitempty"`
	Checks         []ImageCheck `json:"checks"`
}

// LoadedCount 返回成功 inspect 到的镜像数。
func (r *Result) LoadedCount() int {
	n := 0
	for _, c := range r.Checks {
		if c.OK {
			n++
		}
	}
	return n
}

// Missing 返回缺失的镜像名。
func (r *Result) Missing() []string {
	var out []string
	for _, c := range r.Checks {
		if !c.OK {
			out = append(out, c.Name)
		}
	}
	return out
}

func (o Options) logf(format string, args ...any) {
	if o.Logf != nil {
		o.Logf(format, args...)
	}
}

func (o *Options) normalize() {
	if o.Hash == nil {
		o.Hash = buildplan.HashFile
	}
	if o.Runner == nil {
		o.Runner = execx.OSRunner{}
	}
}

// ReadList 解析 images.txt：忽略空行与 `#` 注释，保留出现顺序（= docker save 顺序）。
func ReadList(content string) []string {
	var out []string
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out = append(out, line)
	}
	return out
}

// Load 执行完整的镜像导入流程。任一步失败都返回 error，调用方不得继续起栈。
func Load(ctx context.Context, opts Options) (*Result, error) {
	opts.normalize()

	if strings.TrimSpace(opts.TarPath) == "" {
		return nil, errors.New("镜像 tar 路径为空（请确认 tianji-offline-images.tar 已与安装包放在一起）")
	}
	if strings.TrimSpace(opts.ExpectedSHA256) == "" {
		return nil, errors.New("manifest 未提供镜像 tar 的 sha256，拒绝导入（无法溯源）")
	}
	if strings.TrimSpace(opts.ListPath) == "" {
		return nil, errors.New("images.txt 路径为空")
	}

	listRaw, err := os.ReadFile(opts.ListPath)
	if err != nil {
		return nil, fmt.Errorf("读镜像清单失败: %w", err)
	}
	wanted := ReadList(string(listRaw))
	if len(wanted) == 0 {
		return nil, fmt.Errorf("镜像清单 %s 为空", filepath.Base(opts.ListPath))
	}
	if opts.ExpectedCount > 0 && len(wanted) != opts.ExpectedCount {
		return nil, fmt.Errorf("镜像清单条数 %d 与 manifest.image_count=%d 不符（包被人换过？）",
			len(wanted), opts.ExpectedCount)
	}

	res := &Result{TarPath: opts.TarPath, SHA256Expected: opts.ExpectedSHA256}

	// ① 溯源校验：先算再 load，顺序不能反。
	opts.logf("校验镜像 tar 完整性（sha256）…")
	actual, err := opts.Hash(opts.TarPath)
	if err != nil {
		return nil, fmt.Errorf("计算镜像 tar 的 sha256 失败（文件不存在或不可读）: %w", err)
	}
	res.SHA256Actual = actual
	if !strings.EqualFold(actual, opts.ExpectedSHA256) {
		return nil, fmt.Errorf("镜像 tar 校验失败，已停止导入\n  期望: %s\n  实际: %s\n  处置: 重新拷贝 tianji-offline-images.tar（U 盘传输损坏是最常见原因）",
			opts.ExpectedSHA256, actual)
	}
	opts.logf("镜像 tar 校验通过: %s", actual)

	// ② docker load
	opts.logf("执行 docker load（1.5GB 级，通常 1~3 分钟）…")
	loadRes, err := opts.Runner.Run(ctx, "docker", "load", "-i", opts.TarPath)
	res.LoadOutput = loadRes.Combined()
	opts.logf("%s", strings.TrimRight(res.LoadOutput, "\n"))
	if err != nil {
		return res, fmt.Errorf("docker load 失败: %w", err)
	}

	// ③ 逐镜像 inspect
	opts.logf("按清单逐个核对镜像（%d 个）…", len(wanted))
	for _, name := range wanted {
		check := ImageCheck{Name: name}
		inspect, iErr := opts.Runner.Run(ctx, "docker", "image", "inspect", "--format", "{{.Id}}", name)
		switch {
		case iErr != nil:
			check.Err = strings.TrimSpace(inspect.Tail(3))
			if check.Err == "" {
				check.Err = iErr.Error()
			}
		default:
			check.ID = strings.TrimSpace(inspect.Stdout)
			check.OK = check.ID != ""
			if !check.OK {
				check.Err = "inspect 输出为空"
			}
		}
		if check.OK {
			opts.logf("  OK   %s  %s", name, shortID(check.ID))
		} else {
			opts.logf("  FAIL %s  %s", name, check.Err)
		}
		res.Checks = append(res.Checks, check)
	}

	if missing := res.Missing(); len(missing) > 0 {
		return res, fmt.Errorf("镜像导入不完整：%d/%d 到位，缺 %s",
			res.LoadedCount(), len(wanted), strings.Join(missing, ", "))
	}
	opts.logf("镜像导入完成：%d/%d", res.LoadedCount(), len(wanted))
	return res, nil
}

func shortID(id string) string {
	id = strings.TrimPrefix(id, "sha256:")
	if len(id) > 12 {
		return id[:12]
	}
	return id
}
