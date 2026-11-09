// 变体 B（kylin-uos）的静态安装落点。
//
// 为什么单独一个文件：这些路径是「协议」——安装步骤往哪写、卸载步骤从哪删、
// 单测拿什么覆盖，三处必须同一份定义。散在 dockerinstall 里写死常量，
// 卸载代码就会漏掉某一项（本轮 smoke.sh 的路径缺陷就是这么来的）。
package buildplan

import "path/filepath"

// 变体 B 的默认落点（设计 §6 第 1~3 条）。
const (
	// DefaultStaticDockerDir：**不放 /usr/local/bin、不放 /usr/bin**。
	//   - /usr/local/bin 会与未来可能装的发行版 docker 争 PATH（谁先谁后说不清）；
	//   - /usr/bin 在装了 kysec-utils 的麒麟上可能落进文件保护范围。
	// 静态二进制本来就不需要 PATH：unit 用绝对路径起 dockerd，安装器用绝对路径调 CLI。
	DefaultStaticDockerDir = "/usr/local/lib/tianji/docker-static"
	// DefaultComposePluginDir：实测被 docker CLI 识别；不要用 /usr/libexec/docker/cli-plugins
	// （RPM 系自带的 docker 会争抢该目录）。
	DefaultComposePluginDir = "/usr/local/lib/docker/cli-plugins"
	// DefaultComposePluginName 是 docker CLI 发现的文件名，必须叫这个。
	DefaultComposePluginName = "docker-compose"
	// DefaultDockerUnitPath 是我们自己写的 docker.service（不是发行版包里的那份）。
	DefaultDockerUnitPath = "/etc/systemd/system/docker.service"
	// DefaultInstallRecord 记录「安装器亲手写了哪些文件」，卸载只删这份清单里的东西。
	DefaultInstallRecord = "/var/lib/tianji-install/installed-files.json"
	// WaitReadyScript 等 dockerd 就绪的脚本名（systemd ExecStartPost 调它）。
	WaitReadyScript = "wait-ready.sh"
)

// StaticDockerBinDir 返回静态 docker 二进制的解压目标目录。
func (l Layout) StaticDockerBinDir() string {
	if l.StaticDockerDir != "" {
		return l.StaticDockerDir
	}
	return DefaultStaticDockerDir
}

// StaticDockerBin 返回静态目录下某个二进制的绝对路径（docker / dockerd / containerd / runc）。
func (l Layout) StaticDockerBin(name string) string {
	return filepath.Join(l.StaticDockerBinDir(), name)
}

// ComposePluginTargetDir 返回 compose 插件的安装目录。
func (l Layout) ComposePluginTargetDir() string {
	if l.ComposePluginDir != "" {
		return l.ComposePluginDir
	}
	return DefaultComposePluginDir
}

// ComposePluginTarget 返回 compose 插件安装后的完整路径。
func (l Layout) ComposePluginTarget() string {
	return filepath.Join(l.ComposePluginTargetDir(), DefaultComposePluginName)
}

// DockerUnitPath 返回我们写的 docker.service 路径。
func (l Layout) DockerUnitPath() string {
	if l.DockerUnit != "" {
		return l.DockerUnit
	}
	return DefaultDockerUnitPath
}

// InstallRecordPath 返回「安装器写过什么」的记录文件路径。
func (l Layout) InstallRecordPath() string {
	if l.RecordFile != "" {
		return l.RecordFile
	}
	return DefaultInstallRecord
}

// DockerCLI 返回本变体该用哪个 docker 命令名。
//
// 变体 A 由 deb 装到 /usr/bin/docker，走 PATH（"docker"）；
// 变体 B 是静态二进制，**必须走绝对路径**——我们刻意不往 PATH 里放东西，
// 否则「安装器能用 docker，但宿主机上 `docker ps` 找不到命令」这种半截状态
// 会让人以为安装失败。绝对路径同时让日志里每条命令都可核对。
func (l Layout) DockerCLI(variant string) string {
	if variant == VariantKylinUOS {
		return l.StaticDockerBin("docker")
	}
	return "docker"
}
