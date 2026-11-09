package main

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/dockerinstall"
	"tianji-archive/installer/internal/execx"
	"tianji-archive/installer/internal/installed"
)

// cmdRunner 是 flow 层用例的假 runner：只记账，不碰真系统。
type cmdRunner struct {
	calls []string
	out   map[string]string
	errs  map[string]error
}

func (r *cmdRunner) Run(_ context.Context, name string, args ...string) (execx.Result, error) {
	key := strings.TrimSpace(name + " " + strings.Join(args, " "))
	r.calls = append(r.calls, key)
	res := execx.Result{Command: key, Stdout: r.out[key]}
	if err, ok := r.errs[key]; ok {
		res.ExitCode = 1
		return res, err
	}
	return res, nil
}

func (r *cmdRunner) called(substr string) bool {
	for _, c := range r.calls {
		if strings.Contains(c, substr) {
			return true
		}
	}
	return false
}

// newVBFlowFixture 造一个变体 B 的会话：落点全在 temp 目录，卸载时不会碰真系统。
func newVBFlowFixture(t *testing.T) (*session, *cmdRunner, buildplan.Layout) {
	t.Helper()
	root := t.TempDir()
	layout := buildplan.Layout{
		Root:             filepath.Join(root, "installer"),
		DeployRoot:       filepath.Join(root, "deploy"),
		StateFile:        filepath.Join(root, "state", "state.json"),
		LogRoot:          filepath.Join(root, "log"),
		UnitPath:         filepath.Join(root, "etc", "tianji-stack.service"),
		StaticDockerDir:  filepath.Join(root, "usr", "local", "lib", "tianji", "docker-static"),
		ComposePluginDir: filepath.Join(root, "usr", "local", "lib", "docker", "cli-plugins"),
		DockerUnit:       filepath.Join(root, "etc", "systemd", "system", "docker.service"),
		RecordFile:       filepath.Join(root, "state", "installed-files.json"),
	}.Normalize()

	runner := &cmdRunner{out: map[string]string{}, errs: map[string]error{}}
	s := &session{
		layout:    layout,
		manifest:  &buildplan.Manifest{Variant: buildplan.VariantKylinUOS, Version: "1.0.0"},
		runner:    runner,
		dockerBin: layout.DockerCLI(buildplan.VariantKylinUOS),
	}
	return s, runner, layout
}

// TestDockerBinIsAbsoluteForVariantB：变体 B 全流程必须用静态目录的 docker，
// 不许有的步骤走 PATH —— 那种半截状态在现场表现为「安装器能跑，docker 命令找不到」。
func TestDockerBinIsAbsoluteForVariantB(t *testing.T) {
	s, _, layout := newVBFlowFixture(t)
	if got := s.dockerBinOf(); got != layout.StaticDockerBin("docker") {
		t.Fatalf("变体 B 应使用 %s，实际 %s", layout.StaticDockerBin("docker"), got)
	}
	// 变体 A 仍是 PATH 里的 docker（deb 装到 /usr/bin）
	if got := layout.DockerCLI(buildplan.VariantUbuntuDebian); got != "docker" {
		t.Fatalf("变体 A 应使用 PATH 的 docker，实际 %s", got)
	}
	empty := &session{}
	if got := empty.dockerBinOf(); got != "docker" {
		t.Fatalf("空会话应回落 docker，实际 %s", got)
	}
}

// TestSaveInstallRecordMergesAndPersists：清单落盘、可增量合并、非法路径报错。
func TestSaveInstallRecordMergesAndPersists(t *testing.T) {
	s, _, layout := newVBFlowFixture(t)

	res := &dockerinstall.Result{Installed: []installed.Entry{
		{Path: layout.StaticDockerBinDir(), Kind: installed.KindDir, Why: "静态目录"},
	}}
	if err := s.saveInstallRecord(res); err != nil {
		t.Fatalf("首次落盘失败: %v", err)
	}
	// 重跑 S3（断点重入）时同一批路径会再登记一次：必须幂等。
	res2 := &dockerinstall.Result{Installed: []installed.Entry{
		{Path: layout.StaticDockerBinDir(), Kind: installed.KindDir, Why: "静态目录"},
		{Path: layout.DockerUnitPath(), Kind: installed.KindFile, Why: "unit"},
	}}
	if err := s.saveInstallRecord(res2); err != nil {
		t.Fatalf("第二次落盘失败: %v", err)
	}

	rec, err := installed.Load(layout.InstallRecordPath())
	if err != nil {
		t.Fatalf("读回失败: %v", err)
	}
	if rec == nil || len(rec.Entries) != 2 {
		t.Fatalf("应合并成 2 项（去重），实际 %+v", rec)
	}
	if rec.Variant != buildplan.VariantKylinUOS || rec.Version != "1.0.0" {
		t.Fatalf("清单要记变体与版本，实际 %+v", rec)
	}

	// 空结果不该写文件，也不该报错
	if err := s.saveInstallRecord(&dockerinstall.Result{}); err != nil {
		t.Fatalf("空结果不该报错: %v", err)
	}
}

// TestUninstallDeletesOnlyRecordedPaths：卸载的三条纪律一次锁死。
func TestUninstallDeletesOnlyRecordedPaths(t *testing.T) {
	s, runner, layout := newVBFlowFixture(t)

	// ① 安装器写下的：静态目录（内含一个文件）、compose 插件、unit
	binDir := layout.StaticDockerBinDir()
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "dockerd"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(layout.ComposePluginTargetDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.ComposePluginTarget(), []byte("c"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(layout.DockerUnitPath()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.DockerUnitPath(), []byte("unit"), 0o644); err != nil {
		t.Fatal(err)
	}

	// ② 别人放的：运维自己塞进静态目录旁边的文件，以及业务数据
	neighbour := filepath.Join(filepath.Dir(binDir), "operator-note.txt")
	if err := os.WriteFile(neighbour, []byte("勿删"), 0o644); err != nil {
		t.Fatal(err)
	}
	esdata := filepath.Join(layout.VolumesDir(), "esdata")
	if err := os.MkdirAll(esdata, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(esdata, "node.lock"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// ③ 部署根放一份 compose，让卸载走 compose down 分支
	if err := os.MkdirAll(layout.DeployRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.DeployedComposePath(), []byte("services: {}\n"), 0o640); err != nil {
		t.Fatal(err)
	}

	rec := installed.New(buildplan.VariantKylinUOS, "1.0.0")
	for _, e := range []installed.Entry{
		{Path: binDir, Kind: installed.KindDir, Why: "静态目录"},
		{Path: layout.ComposePluginTarget(), Kind: installed.KindFile, Why: "插件"},
		{Path: layout.DockerUnitPath(), Kind: installed.KindFile, Why: "unit"},
	} {
		if err := rec.Add(e.Path, e.Kind, e.Why); err != nil {
			t.Fatal(err)
		}
	}
	if err := rec.Save(layout.InstallRecordPath()); err != nil {
		t.Fatal(err)
	}

	var out strings.Builder
	if err := s.Uninstall(context.Background(), false, &out); err != nil {
		t.Fatalf("卸载失败: %v", err)
	}
	text := out.String()

	// compose down 必须用变体 B 的 docker 绝对路径
	if !runner.called(layout.StaticDockerBin("docker") + " compose") {
		t.Fatalf("compose down 应使用静态目录的 docker，实际调用 %v", runner.calls)
	}
	for _, gone := range []string{binDir, layout.ComposePluginTarget(), layout.DockerUnitPath()} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("清单里的 %s 应被删除（err=%v）", gone, err)
		}
	}
	if _, err := os.Stat(neighbour); err != nil {
		t.Fatalf("清单之外的文件不许动: %v", err)
	}
	if _, err := os.Stat(filepath.Join(esdata, "node.lock")); err != nil {
		t.Fatalf("业务数据必须保留: %v", err)
	}
	if _, err := os.Stat(layout.InstallRecordPath()); !os.IsNotExist(err) {
		t.Fatalf("清单本身应删掉（否则下次卸载对着一批不存在的路径再删一遍）: %v", err)
	}
	for _, want := range []string{"DEL", "已删除 3 项", "业务数据已保留"} {
		if !strings.Contains(text, want) {
			t.Fatalf("输出缺 %q：\n%s", want, text)
		}
	}
}

// TestUninstallWithoutRecordTouchesNothing：没有清单就什么都不删，且要说清楚原因。
func TestUninstallWithoutRecordTouchesNothing(t *testing.T) {
	s, _, layout := newVBFlowFixture(t)

	innocent := filepath.Join(filepath.Dir(layout.StaticDockerBinDir()), "someone-elses.bin")
	if err := os.MkdirAll(filepath.Dir(innocent), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(innocent, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}

	var out strings.Builder
	if err := s.Uninstall(context.Background(), false, &out); err != nil {
		t.Fatalf("没有清单时卸载不该报错: %v", err)
	}
	if _, err := os.Stat(innocent); err != nil {
		t.Fatalf("没有清单时一律不删（不许按约定路径猜）: %v", err)
	}
	if !strings.Contains(out.String(), "没有安装清单") {
		t.Fatalf("必须说明为什么没删：\n%s", out.String())
	}
}

// TestUninstallPurgeVolumesOnlyWhenAsked：删数据是显式动作，且不受清单影响。
func TestUninstallPurgeVolumesOnlyWhenAsked(t *testing.T) {
	s, _, layout := newVBFlowFixture(t)

	esdata := filepath.Join(layout.VolumesDir(), "esdata")
	if err := os.MkdirAll(esdata, 0o755); err != nil {
		t.Fatal(err)
	}

	var out strings.Builder
	if err := s.Uninstall(context.Background(), true, &out); err != nil {
		t.Fatalf("卸载失败: %v", err)
	}
	if _, err := os.Stat(layout.VolumesDir()); !os.IsNotExist(err) {
		t.Fatalf("显式要求删数据时应删掉 volumes（err=%v）", err)
	}
	if !strings.Contains(out.String(), "不可恢复") {
		t.Fatalf("删数据必须明确提示不可恢复：\n%s", out.String())
	}
}

// TestConfirmImagesTarAcceptsDefaultAndNewPath：S2 之前的路径确认交互。
func TestConfirmImagesTarAcceptsDefaultAndNewPath(t *testing.T) {
	s, _, _ := newVBFlowFixture(t)
	s.imagesTar = filepath.Join(t.TempDir(), "tianji-offline-images.tar")

	// 回车：保持当前路径
	var out strings.Builder
	in := bufio.NewReader(strings.NewReader("\n"))
	if err := confirmImagesTar(s, in, &out); err != nil {
		t.Fatalf("回车不该报错: %v", err)
	}
	if s.imagesTar != filepath.Join(filepath.Dir(s.imagesTar), "tianji-offline-images.tar") {
		t.Fatalf("回车应保持原路径，实际 %s", s.imagesTar)
	}

	// 输入新路径：立刻生效（现场把 tar 放在数据盘/U 盘挂载点时用）
	newPath := filepath.Join(t.TempDir(), "mnt", "usb", "tianji-offline-images.tar")
	out.Reset()
	in = bufio.NewReader(strings.NewReader(newPath + "\n"))
	if err := confirmImagesTar(s, in, &out); err != nil {
		t.Fatalf("输入新路径不该报错: %v", err)
	}
	if s.imagesTar != newPath {
		t.Fatalf("应改成用户输入的路径，实际 %s", s.imagesTar)
	}
	// 读不到就如实说读不到，不能编一个大小
	if !strings.Contains(out.String(), "读不到") {
		t.Fatalf("路径不存在时必须如实说明：\n%s", out.String())
	}

	// s：跳过，保持当前
	before := s.imagesTar
	out.Reset()
	in = bufio.NewReader(strings.NewReader("s\n"))
	if err := confirmImagesTar(s, in, &out); err != nil {
		t.Fatalf("跳过不该报错: %v", err)
	}
	if s.imagesTar != before {
		t.Fatalf("跳过不该改路径，实际 %s", s.imagesTar)
	}
}
