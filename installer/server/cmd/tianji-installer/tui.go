package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/state"
)

// runTUI 是设计 §3.1 裁定必须保留的降级入口：管理员只有 SSH、没有第二台机器时用。
//
// 与 Web 向导共享同一个 session，因此不存在「两套安装逻辑」——
// 这里只负责把 RunStep 的结果画到终端上。
func runTUI(sess *session) int {
	out := os.Stdout
	in := bufio.NewReader(os.Stdin)

	// TUI 模式没有 Web 地址，打印终端专用抬头（复用 printBanner 会印出
	// 「http://(TUI 模式…)」，现场看着像故障）。
	printTUIHeader(sess)
	names := buildplan.StepNames()

	for {
		next := sess.st.NextStep()
		if next == state.StepDone {
			ok, err := prompt(in, out, "全部步骤已完成。现在写入汇总并结束？[Y/n] ")
			if !ok {
				return 0
			}
			if err != nil {
				fmt.Fprintln(os.Stderr, "读取输入失败:", err)
				return 1
			}
			if err := sess.RunStep(context.Background(), state.StepDone); err != nil {
				fmt.Fprintln(os.Stderr, "汇总写入失败:", err)
				return 1
			}
			fmt.Fprintln(out, "\n安装完成。访问地址见 99-summary.txt。")
			return 0
		}

		fmt.Fprintf(out, "\n下一步：%s（%s）\n", names[string(next)], next)
		if next == state.StepEnv {
			fmt.Fprintln(out, "提示：渲染 .env 需要先填写部署表单。TUI 模式请用参数提供，或改用 Web 向导。")
		}
		fmt.Fprint(out, "回车执行 / s 跳过并退出 / q 退出 / r 重跑本步之前全部（重置状态）: ")
		line, err := in.ReadString('\n')
		if err != nil {
			fmt.Fprintln(out, "\n已退出。")
			return 0
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "q", "quit":
			fmt.Fprintln(out, "已退出。state.json 已保留，可 --resume 继续。")
			return 0
		case "s", "skip":
			fmt.Fprintln(out, "已跳过。state.json 已保留，可 --resume 继续。")
			return 0
		case "r", "reset":
			if err := sess.st.Reset(next); err != nil {
				fmt.Fprintln(os.Stderr, "重置失败:", err)
			} else if err := sess.st.Save(sess.layout.StateFile); err != nil {
				fmt.Fprintln(os.Stderr, "保存状态失败:", err)
			} else {
				fmt.Fprintf(out, "已把 %s 及之后的步骤重置为未完成。\n", next)
			}
			continue
		}

		if err := sess.RunStep(context.Background(), next); err != nil {
			var confirmErr *confirmRequiredError
			if ok, _ := asConfirm(err, &confirmErr); ok {
				fmt.Fprintf(out, "!! %s\n", confirmErr.Error())
				yes, _ := prompt(in, out, "确认继续（风险自担）？[y/N] ")
				if !yes {
					return 0
				}
				sess.Confirm()
				continue
			}
			var formErr *formRequiredError
			if ok, _ := asForm(err, &formErr); ok {
				fmt.Fprintf(out, "!! %s\n请改用 Web 向导填写表单：tianji-installer --web\n", formErr.Error())
				return 1
			}
			fmt.Fprintf(out, "\n!! %s 失败：%v\n", next, err)
			fmt.Fprintf(out, "   该步日志：%s\n", sess.log.Path(stepLogFile[next]))
			fmt.Fprintln(out, "   修好之后执行 --resume 从这一步继续（已完成的步骤不会重跑）。")
			return 1
		}
		fmt.Fprintf(out, "OK   %s 完成\n", names[string(next)])
	}
}

// prompt 读取一行 y/n 确认。空行按默认值处理。
func prompt(in *bufio.Reader, out *os.File, text string) (bool, error) {
	fmt.Fprint(out, text)
	line, err := in.ReadString('\n')
	if err != nil && line == "" {
		return false, err
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	if strings.HasSuffix(text, "[Y/n] ") {
		return answer != "n" && answer != "no", nil
	}
	return answer == "y" || answer == "yes", nil
}

// asConfirm / asForm 是 errors.As 的薄封装，只为在 TUI 分支里写得短一点。
func asConfirm(err error, target **confirmRequiredError) (bool, error) {
	e, ok := err.(*confirmRequiredError)
	if ok {
		*target = e
	}
	return ok, nil
}

func asForm(err error, target **formRequiredError) (bool, error) {
	e, ok := err.(*formRequiredError)
	if ok {
		*target = e
	}
	return ok, nil
}

// printTUIHeader 打印终端向导抬头（TUI 模式没有 Web 地址，不能用 printBanner）。
func printTUIHeader(sess *session) {
	out := os.Stdout
	line := strings.Repeat("=", 72)
	fmt.Fprintln(out, line)
	fmt.Fprintln(out, "  天玑档案管理系统 · 服务器端安装器（终端向导）")
	fmt.Fprintf(out, "  版本 %s   变体 %s   架构 %s\n", sess.manifest.Version, sess.manifest.Variant, sess.manifest.Arch)
	fmt.Fprintf(out, "  系统 %s（ID=%s VERSION_ID=%s）\n", sess.osInfo.PrettyName, sess.osInfo.ID, sess.osInfo.VersionID)
	fmt.Fprintln(out, line)
	fmt.Fprintf(out, "  部署根：%s\n", sess.layout.DeployRoot)
	fmt.Fprintf(out, "  日志  ：%s\n", sess.log.Dir())
	fmt.Fprintf(out, "  状态  ：%s\n", sess.layout.StateFile)
	fmt.Fprintln(out, line)
	fmt.Fprintln(out, "  提示：需要图形化分步向导时，改用 tianji-installer --web（本机浏览器打开 127.0.0.1:18080）")
	fmt.Fprintln(out, line)
}
