// Package state 维护安装状态机与断点重入。
//
// 设计依据：docs/安装器总体设计.md §6.2。核心规则是「只有 PASS 才写 DONE」，
// FAIL 只记录原因不前进，因此 --resume 永远从第一个非 DONE 的步骤继续，
// 不会出现「半装却被当成装完」的状态。
package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Step 是状态机里的一个可执行步骤。
type Step string

// 10 个可执行步骤 + 完成态。顺序即执行顺序，ResumeStep 依赖该顺序。
const (
	StepPreflight Step = "S1_PREFLIGHT"
	StepVerify    Step = "S2_VERIFY"
	StepDocker    Step = "S3_DOCKER"
	StepImages    Step = "S4_IMAGES"
	StepEnv       Step = "S5_ENV"
	StepUp        Step = "S6_UP"
	StepMigrate   Step = "S7_MIGRATE"
	StepSeed      Step = "S8_SEED"
	StepSmoke     Step = "S9_SMOKE"
	StepDone      Step = "S10_DONE"
)

// Steps 是状态机的固定顺序，顺序错了会导致重入跳过关键步骤，故集中定义。
var Steps = []Step{
	StepPreflight, StepVerify, StepDocker, StepImages, StepEnv,
	StepUp, StepMigrate, StepSeed, StepSmoke, StepDone,
}

// Status 是一个步骤的终态。空字符串表示「未开始」。
type Status string

// 步骤状态取值。
const (
	StatusPending Status = ""
	StatusDone    Status = "DONE"
	StatusFail    Status = "FAIL"
)

// StepRecord 记录单步结果。Output 是原始输出的尾部摘要，便于现场远程排障。
type StepRecord struct {
	Status     Status    `json:"status"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt,omitempty"`
	ExitCode   int       `json:"exitCode"`
	Message    string    `json:"message,omitempty"`
	Output     string    `json:"output,omitempty"`
}

// State 是 /var/lib/tianji-install/state.json 的完整内容。
type State struct {
	FormatVersion int                    `json:"formatVersion"`
	Product       string                 `json:"product"`
	Version       string                 `json:"version"`
	Variant       string                 `json:"variant"`
	Arch          string                 `json:"arch"`
	CreatedAt     time.Time              `json:"createdAt"`
	UpdatedAt     time.Time              `json:"updatedAt"`
	Steps         map[Step]*StepRecord   `json:"steps"`
	Facts         map[string]string      `json:"facts,omitempty"`
	Extra         map[string]interface{} `json:"extra,omitempty"`

	path string
}

// FormatVersion 是 state.json 的结构版本，结构变更时递增。
const FormatVersion = 1

// New 构造一个全新的状态机。
func New(product, version, variant, arch string) *State {
	now := time.Now().UTC()
	s := &State{
		FormatVersion: FormatVersion,
		Product:       product,
		Version:       version,
		Variant:       variant,
		Arch:          arch,
		CreatedAt:     now,
		UpdatedAt:     now,
		Steps:         make(map[Step]*StepRecord, len(Steps)),
		Facts:         make(map[string]string),
	}
	for _, step := range Steps {
		s.Steps[step] = &StepRecord{Status: StatusPending}
	}
	return s
}

// Load 从 path 读取状态；文件不存在返回 (nil, nil)，由调用方新建。
// 只容忍「不存在」，其他错误一律上抛——读不懂的状态文件不能猜着用。
func Load(path string) (*State, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取状态文件失败: %w", err)
	}
	var s State
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("解析状态文件失败: %w", err)
	}
	if s.FormatVersion != FormatVersion {
		return nil, fmt.Errorf("状态文件版本不兼容: 磁盘 %d, 期望 %d", s.FormatVersion, FormatVersion)
	}
	if s.Steps == nil {
		s.Steps = make(map[Step]*StepRecord, len(Steps))
	}
	for _, step := range Steps {
		if s.Steps[step] == nil {
			s.Steps[step] = &StepRecord{Status: StatusPending}
		}
	}
	s.path = path
	return &s, nil
}

// Path 返回状态文件路径。
func (s *State) Path() string { return s.path }

// Save 原子落盘：先写临时文件再 rename，避免断电留下半截 JSON。
func (s *State) Save(path string) error {
	if path == "" {
		path = s.path
	}
	if path == "" {
		return fmt.Errorf("未指定状态文件路径")
	}
	s.path = path
	s.UpdatedAt = time.Now().UTC()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("创建状态目录失败: %w", err)
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化状态失败: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return fmt.Errorf("写入临时状态文件失败: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("原子替换状态文件失败: %w", err)
	}
	return nil
}

// Begin 在步骤开始执行时打点（不改 Status，避免被误读为完成）。
func (s *State) Begin(step Step) {
	s.record(step).StartedAt = time.Now().UTC()
	s.UpdatedAt = time.Now().UTC()
}

// Complete 把步骤标记为 DONE。只有真正通过时才允许调用。
func (s *State) Complete(step Step, output string) {
	rec := s.record(step)
	rec.Status = StatusDone
	rec.FinishedAt = time.Now().UTC()
	rec.ExitCode = 0
	rec.Message = ""
	rec.Output = truncate(output, 4000)
	s.UpdatedAt = time.Now().UTC()
}

// Fail 把步骤标记为 FAIL 并保留原因与输出摘要；不前进。
func (s *State) Fail(step Step, exitCode int, message, output string) {
	rec := s.record(step)
	rec.Status = StatusFail
	rec.FinishedAt = time.Now().UTC()
	rec.ExitCode = exitCode
	rec.Message = message
	rec.Output = truncate(output, 4000)
	s.UpdatedAt = time.Now().UTC()
}

// Reset 把某步骤及其后续步骤全部清回未开始（用于「改了 .env 必须重跑 S5 及之后」）。
func (s *State) Reset(from Step) error {
	idx := indexOf(from)
	if idx < 0 {
		return fmt.Errorf("未知步骤: %s", from)
	}
	for _, step := range Steps[idx:] {
		s.Steps[step] = &StepRecord{Status: StatusPending}
	}
	s.UpdatedAt = time.Now().UTC()
	return nil
}

// Status 返回步骤状态；未记录视为未开始。
func (s *State) Status(step Step) Status {
	if rec, ok := s.Steps[step]; ok && rec != nil {
		return rec.Status
	}
	return StatusPending
}

// IsDone 判断步骤是否已完成。
func (s *State) IsDone(step Step) bool { return s.Status(step) == StatusDone }

// NextStep 返回第一个非 DONE 的步骤；全部完成时返回 StepDone。
// 这是 --resume 的唯一判据来源，禁止在别处另算一遍。
func (s *State) NextStep() Step {
	for _, step := range Steps {
		if !s.IsDone(step) {
			return step
		}
	}
	return StepDone
}

// AllDone 表示整机安装流程走完。
func (s *State) AllDone() bool { return s.NextStep() == StepDone }

// SetFact 记录一条现场事实（OS、内核、磁盘余量等），供日志与二次运行对比。
func (s *State) SetFact(key, value string) {
	if s.Facts == nil {
		s.Facts = make(map[string]string)
	}
	s.Facts[key] = value
}

func (s *State) record(step Step) *StepRecord {
	if s.Steps == nil {
		s.Steps = make(map[Step]*StepRecord, len(Steps))
	}
	if rec, ok := s.Steps[step]; ok && rec != nil {
		return rec
	}
	rec := &StepRecord{Status: StatusPending}
	s.Steps[step] = rec
	return rec
}

func indexOf(step Step) int {
	for i, s := range Steps {
		if s == step {
			return i
		}
	}
	return -1
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return "...(前略)..." + s[len(s)-limit:]
}
