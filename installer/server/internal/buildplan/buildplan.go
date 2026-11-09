// Package buildplan 负责「读懂安装包自己」：解析 manifest.json、按设计 §2.3
// 给出所有落盘路径、按设计 §5.2 判定本机 OS 与包变体是否匹配、按设计 §4.4 的
// L-a 层逐文件复核 sha256。
//
// 命名说明：设计稿 §2.1 里 installer/build/ 是**构建机脚本**目录（shell），
// 本包是安装器运行期的「安装计划」代码，两者同名会互相污染（也因为
// .gitignore 的 build/ 规则踩过一次坑），故 Go 侧取名为 buildplan。
package buildplan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// 安装器在现场的固定路径（设计 §2.3）。
const (
	DefaultRootDir      = "/opt/tianji-installer" // 安装器 + payload
	DefaultDeployRoot   = "/opt/tianji"           // 部署根（compose + .env + volumes）
	DefaultStateFile    = "/var/lib/tianji-install/state.json"
	DefaultLogRoot      = "/var/log/tianji-install" // 下挂 <UTC时间戳>/
	DefaultUnitPath     = "/etc/systemd/system/tianji-stack.service"
	DefaultSysctlDir    = "/etc/sysctl.d"
	DefaultLimitsDir    = "/etc/security/limits.d"
	DefaultSystemdUnit  = "/etc/systemd/system/docker.service"
	ManifestName        = "manifest.json"
	VersionName         = "VERSION"
	FormatVersionWanted = 1
)

// 变体标识，与设计 §4.1 一致。
const (
	VariantUbuntuDebian = "ubuntu-debian"
	VariantKylinUOS     = "kylin-uos"
)

// FileEntry 是 manifest.json.files 的一项。
type FileEntry struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// Manifest 对应设计 §2.2 的 manifest.json。
type Manifest struct {
	FormatVersion int    `json:"format_version"`
	Product       string `json:"product"`
	Version       string `json:"version"`
	Variant       string `json:"variant"`
	Arch          string `json:"arch"`
	MinKernel     string `json:"min_kernel"`
	Docker        struct {
		Channel string `json:"channel"`
		Version string `json:"version"`
	} `json:"docker"`
	ImagesTar struct {
		Filename   string `json:"filename"`
		SHA256     string `json:"sha256"`
		ImageCount int    `json:"image_count"`
	} `json:"images_tar"`
	Files []FileEntry `json:"files"`
	Build struct {
		GitHead    string `json:"git_head"`
		BuiltAtUTC string `json:"built_at_utc"`
		Builder    string `json:"builder"`
	} `json:"build"`
}

// Validate 做结构校验。缺字段一律报错——manifest 是后面所有校验的锚，
// 锚本身残缺时继续安装等于放弃 fail-closed。
func (m *Manifest) Validate() error {
	if m == nil {
		return errors.New("manifest 为空")
	}
	if m.FormatVersion != FormatVersionWanted {
		return fmt.Errorf("manifest.format_version=%d，本安装器只认 %d（包与安装器版本错配）",
			m.FormatVersion, FormatVersionWanted)
	}
	if strings.TrimSpace(m.Product) != "tianji-archive" {
		return fmt.Errorf("manifest.product=%q，不是天玑档案的安装包", m.Product)
	}
	if strings.TrimSpace(m.Version) == "" {
		return errors.New("manifest.version 缺失")
	}
	switch m.Variant {
	case VariantUbuntuDebian, VariantKylinUOS:
	default:
		return fmt.Errorf("manifest.variant=%q 不认识（只支持 %s / %s）",
			m.Variant, VariantUbuntuDebian, VariantKylinUOS)
	}
	if m.Arch != "amd64" {
		return fmt.Errorf("manifest.arch=%q，首版只承诺 amd64", m.Arch)
	}
	if m.ImagesTar.Filename == "" {
		return errors.New("manifest.images_tar.filename 缺失")
	}
	if m.ImagesTar.SHA256 == "" {
		// 设计 §7.2：images_tar.sha256 必须与 offline/SHA256SUMS 同源，由构建机写入。
		// 安装器不得「自己算一遍就当真」，所以这里缺了就直接拒绝启动。
		return errors.New("manifest.images_tar.sha256 缺失（镜像包无法溯源，拒绝安装）")
	}
	if m.ImagesTar.ImageCount <= 0 {
		return fmt.Errorf("manifest.images_tar.image_count=%d 非法", m.ImagesTar.ImageCount)
	}
	if len(m.Files) == 0 {
		return errors.New("manifest.files 为空（没有可校验的载荷）")
	}
	for i, f := range m.Files {
		if f.Path == "" || f.SHA256 == "" {
			return fmt.Errorf("manifest.files[%d] 缺 path 或 sha256", i)
		}
		if filepath.IsAbs(f.Path) || strings.Contains(f.Path, "..") {
			return fmt.Errorf("manifest.files[%d].path=%q 必须是 payload 内相对路径", i, f.Path)
		}
	}
	return nil
}

// LoadManifest 读取并校验 manifest.json。
func LoadManifest(path string) (*Manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读 manifest 失败: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("解析 manifest 失败: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Layout 给出 payload 解压目录下的相对布局（设计 §2.2）与现场落盘路径（§2.3）。
//
// Root 之外的三项可以覆盖，纯粹为了本机/容器内验证时不必写真实系统目录；
// 生产环境一律用默认值。
type Layout struct {
	Root       string // /opt/tianji-installer
	DeployRoot string // /opt/tianji
	StateFile  string // /var/lib/tianji-install/state.json
	LogRoot    string // /var/log/tianji-install
	UnitPath   string // /etc/systemd/system/tianji-stack.service
}

// DefaultLayout 返回生产默认布局。
func DefaultLayout() Layout {
	return Layout{
		Root:       DefaultRootDir,
		DeployRoot: DefaultDeployRoot,
		StateFile:  DefaultStateFile,
		LogRoot:    DefaultLogRoot,
		UnitPath:   DefaultUnitPath,
	}
}

// Normalize 把空字段填成默认值，避免调用方漏填导致路径变成相对路径。
func (l Layout) Normalize() Layout {
	if l.Root == "" {
		l.Root = DefaultRootDir
	}
	if l.DeployRoot == "" {
		l.DeployRoot = DefaultDeployRoot
	}
	if l.StateFile == "" {
		l.StateFile = DefaultStateFile
	}
	if l.LogRoot == "" {
		l.LogRoot = DefaultLogRoot
	}
	if l.UnitPath == "" {
		l.UnitPath = DefaultUnitPath
	}
	return l
}

// ManifestPath 返回 manifest.json 的绝对路径。
func (l Layout) ManifestPath() string { return filepath.Join(l.Root, ManifestName) }

// VersionPath 返回 VERSION 的绝对路径。
func (l Layout) VersionPath() string { return filepath.Join(l.Root, VersionName) }

// BinPath 返回安装器二进制路径。
func (l Layout) BinPath() string { return filepath.Join(l.Root, "bin", "tianji-installer") }

// DebsDir 返回变体 A 的 deb 闭包目录（按 codename 分目录，见设计 §4.2）。
func (l Layout) DebsDir(codename string) string {
	if codename == "" {
		return filepath.Join(l.Root, "docker", "debs")
	}
	return filepath.Join(l.Root, "docker", "debs", codename)
}

// StaticDir 返回变体 B 的 docker static 载荷目录。
func (l Layout) StaticDir() string { return filepath.Join(l.Root, "docker", "static") }

// ComposePluginPath 返回 compose v2 单二进制的路径（变体 B 用）。
func (l Layout) ComposePluginPath() string {
	return filepath.Join(l.Root, "docker", "compose", "docker-compose")
}

// CommonDir 返回公共载荷目录。
func (l Layout) CommonDir() string { return filepath.Join(l.Root, "common") }

// ComposePath 返回离线 compose 文件路径。
func (l Layout) ComposePath() string {
	return filepath.Join(l.CommonDir(), "compose", "docker-compose.offline.yml")
}

// EnvTemplatePath 返回 .env 模板路径。
func (l Layout) EnvTemplatePath() string {
	return filepath.Join(l.CommonDir(), "env", ".env.tpl")
}

// ScriptsDir 返回公共脚本目录（load-images.sh / smoke.sh）。
func (l Layout) ScriptsDir() string { return filepath.Join(l.CommonDir(), "scripts") }

// ImagesListPath 返回 images.txt 路径。
func (l Layout) ImagesListPath() string {
	return filepath.Join(l.ScriptsDir(), "images.txt")
}

// SysctlDir 返回 sysctl 配置目录（payload 内自带）。
func (l Layout) SysctlDir() string { return filepath.Join(l.CommonDir(), "sysctl") }

// SeaweedFSDir 返回 SeaweedFS 入口与模板目录。
func (l Layout) SeaweedFSDir() string { return filepath.Join(l.CommonDir(), "seaweedfs") }

// DocsDir 返回随包文档目录。
func (l Layout) DocsDir() string { return filepath.Join(l.CommonDir(), "docs") }

// ImagesTarPath 返回镜像 tar 的期望位置。镜像 tar 与 setup.run 同目录分发
// （设计 §7.1），现场通常把两者放在同一目录，再由用户确认实际路径。
func (l Layout) DefaultImagesTarPath(filename string) string {
	return filepath.Join(l.Root, filename)
}

// EnvPath 返回部署根的 .env 路径。
func (l Layout) EnvPath() string { return filepath.Join(l.DeployRoot, ".env") }

// DeployedComposePath 返回部署根中实际使用的 compose 文件路径。
func (l Layout) DeployedComposePath() string {
	return filepath.Join(l.DeployRoot, "docker-compose.offline.yml")
}

// VolumesDir 返回业务数据目录（永不自动删除）。
func (l Layout) VolumesDir() string { return filepath.Join(l.DeployRoot, "volumes") }

// OSInfo 是从 /etc/os-release 读到的四元组中的前三项（glibc 另由 preflight 读）。
type OSInfo struct {
	ID         string `json:"id"`
	VersionID  string `json:"versionId"`
	Codename   string `json:"codename"`
	PrettyName string `json:"prettyName"`
}

// ParseOSRelease 解析 /etc/os-release 的内容（键值对，值可带引号）。
func ParseOSRelease(content string) OSInfo {
	kv := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.Index(line, "=")
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		val = strings.Trim(val, `"'`)
		kv[key] = val
	}
	return OSInfo{
		ID:         strings.ToLower(kv["ID"]),
		VersionID:  kv["VERSION_ID"],
		Codename:   strings.ToLower(kv["VERSION_CODENAME"]),
		PrettyName: kv["PRETTY_NAME"],
	}
}

// MatchLevel 是 OS 与包变体的匹配结论（设计 §5.2）。
type MatchLevel string

const (
	// MatchExact 命中登记过的组合，可直接继续。
	MatchExact MatchLevel = "exact"
	// MatchUnverified 同族但版本未登记，需要勾选风险确认才继续。
	MatchUnverified MatchLevel = "unverified"
	// MatchReject 异族或架构不符，拒绝安装（fail-closed）。
	MatchReject MatchLevel = "reject"
)

// Match 是匹配结果。
type Match struct {
	Level MatchLevel `json:"level"`
	// RequireConfirm 为 true 时向导必须出现「我已确认该组合未经验证」勾选。
	RequireConfirm bool   `json:"requireConfirm"`
	Reason         string `json:"reason"`
	// SuggestedVariant 仅 MatchReject 时有值：告诉用户该换哪个包。
	SuggestedVariant string `json:"suggestedVariant,omitempty"`
}

// MatchOS 按设计 §5.1 的矩阵判定 os 是否适用于 variant。
func MatchOS(os OSInfo, variant string) Match {
	switch variant {
	case VariantUbuntuDebian:
		switch os.ID {
		case "ubuntu":
			if os.VersionID == "22.04" || os.VersionID == "24.04" {
				return Match{Level: MatchExact, Reason: "Ubuntu " + os.VersionID + "（" + os.Codename + "）已登记"}
			}
			return Match{Level: MatchUnverified, RequireConfirm: true,
				Reason: "Ubuntu " + os.VersionID + " 未登记（矩阵只覆盖 22.04 / 24.04）"}
		case "debian":
			if os.VersionID == "12" || os.Codename == "bookworm" {
				return Match{Level: MatchExact, Reason: "Debian 12（bookworm）已登记"}
			}
			return Match{Level: MatchUnverified, RequireConfirm: true,
				Reason: "Debian " + os.VersionID + " 未登记（矩阵只覆盖 12）"}
		default:
			return Match{Level: MatchReject, SuggestedVariant: VariantKylinUOS,
				Reason: "当前系统 ID=" + orUnknown(os.ID) + "，不是 Ubuntu/Debian，deb 依赖闭包必然对不上"}
		}
	case VariantKylinUOS:
		switch os.ID {
		case "kylin", "uos", "uniontech":
			if os.VersionID == "10" || os.VersionID == "20" || strings.HasPrefix(os.VersionID, "10.") {
				return Match{Level: MatchExact, Reason: os.ID + " " + os.VersionID + " 已登记"}
			}
			return Match{Level: MatchUnverified, RequireConfirm: true,
				Reason: os.ID + " " + orUnknown(os.VersionID) + " 未登记（版本未知的国产 OS 走 static 变体，风险自担）"}
		default:
			return Match{Level: MatchReject, SuggestedVariant: VariantUbuntuDebian,
				Reason: "当前系统 ID=" + orUnknown(os.ID) + " 不是麒麟/统信；请改用 ubuntu-debian 变体安装包"}
		}
	}
	return Match{Level: MatchReject, Reason: "未知包变体 " + variant}
}

func orUnknown(s string) string {
	if s == "" {
		return "（空）"
	}
	return s
}

// FileCheck 是单个载荷文件的校验结果。
type FileCheck struct {
	Path     string `json:"path"`
	Expected string `json:"expected"`
	Actual   string `json:"actual"`
	OK       bool   `json:"ok"`
	Err      string `json:"err,omitempty"`
}

// HashFile 计算文件的 sha256（流式，1.5GB 的镜像 tar 也不会吃内存）。
func HashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// VerifyPayload 执行设计 §4.4 的 L-a 层：逐文件复核 manifest 里登记过的 sha256。
//
// 返回的切片与 m.Files 顺序一一对应，便于日志逐行对齐；调用方用 Failed()
// 判断是否有不匹配。**不**在这里做签名校验（L-b，见 README 的遗留问题登记），
// 也不在这里校验镜像 tar（由 images 包做，因为它还要负责 load）。
func VerifyPayload(root string, m *Manifest) []FileCheck {
	checks := make([]FileCheck, 0, len(m.Files))
	for _, entry := range m.Files {
		c := FileCheck{Path: entry.Path, Expected: entry.SHA256}
		full := filepath.Join(root, filepath.FromSlash(entry.Path))
		actual, err := HashFile(full)
		switch {
		case err != nil:
			c.Err = err.Error()
		default:
			c.Actual = actual
			c.OK = strings.EqualFold(actual, entry.SHA256)
		}
		checks = append(checks, c)
	}
	return checks
}

// Failed 返回不匹配或读不到的项。
func Failed(checks []FileCheck) []FileCheck {
	var bad []FileCheck
	for _, c := range checks {
		if !c.OK {
			bad = append(bad, c)
		}
	}
	return bad
}

// StepNames 是设计 §6.2 的十步与向导页面的对应关系（供 UI 与日志渲染）。
// 状态机本体在 internal/state，本函数只是展示用的中文标签，故意放在这里，
// 免得 state 包（纯逻辑）混入 UI 文案。
func StepNames() map[string]string {
	return map[string]string{
		"S1_PREFLIGHT": "环境体检",
		"S2_VERIFY":    "包完整性",
		"S3_DOCKER":    "安装 Docker",
		"S4_IMAGES":    "导入镜像",
		"S5_ENV":       "渲染配置",
		"S6_UP":        "启动服务栈",
		"S7_MIGRATE":   "数据库迁移",
		"S8_SEED":      "初始化数据",
		"S9_SMOKE":     "四项冒烟",
		"S10_DONE":     "完成",
	}
}
