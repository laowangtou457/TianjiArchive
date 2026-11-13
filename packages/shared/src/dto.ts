/**
 * 跨端 DTO 契约 —— 后端 Controller 出参与前端 api 层共用。
 * 约定：时间字段统一为 ISO 8601 UTC 字符串；分页响应 `{list,total,page,size}`。
 */

import type {
  AppraisalDecision,
  AppraisalTaskStatus,
  ApprovalAction,
  AuditAction,
  AuditResult,
  BorrowMode,
  BorrowStatus,
  ExtractStatus,
  FondsStatus,
  ItemStatus,
  OpenBatchStatus,
  OpenDecision,
  OpenFlag,
  OpenScope,
  PermissionGrant,
  PreviewKind,
  Retention,
  RoleCode,
  SecurityLevel,
  UserStatus,
  VolumeStatus,
  WorkflowAction,
  WorkflowBizType,
  WorkflowInstanceStatus,
  WorkflowTaskStatus,
} from './enums';
import type { DanghaoSegment, ResetCycle } from './danghao';
import type { PermissionSnapshot } from './permission';

// ============================================================================
// 通用
// ============================================================================
export interface PaginationQuery {
  page?: number;
  size?: number;
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

export interface IdQuery {
  id: string;
}

// ============================================================================
// 认证
// ============================================================================
export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  profile: PermissionSnapshot;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

// ============================================================================
// 全宗 F-01
// ============================================================================
export interface FondsDto {
  id: string;
  fondsNo: string;
  name: string;
  orgName: string | null;
  yearStart: number | null;
  yearEnd: number | null;
  status: FondsStatus;
  historyNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFondsDto {
  fondsNo: string;
  name: string;
  orgName?: string | null;
  yearStart?: number | null;
  yearEnd?: number | null;
  status?: FondsStatus;
  historyNote?: string | null;
}

export interface UpdateFondsDto extends Partial<CreateFondsDto> {
  id: string;
}

export interface OrgNodeDto {
  id: string;
  fondsId: string;
  parentId: string | null;
  code: string;
  name: string;
  children?: OrgNodeDto[];
}

export interface CreateOrgNodeDto {
  fondsId: string;
  parentId?: string | null;
  code: string;
  name: string;
}

// ============================================================================
// 门类 / 字段集 F-12
// ============================================================================
/** 著录字段类型 */
export type MetadataFieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'tags';

/** 动态著录表单字段定义（field_schema 的元素） */
export interface MetadataFieldDef {
  /** 字段键（对应实体列名或扩展字段） */
  key: string;
  /** 中文标签 */
  label: string;
  /** 类型 */
  type: MetadataFieldType;
  /** 是否必填 */
  required: boolean;
  /** 是否核心字段（DA/T 18/22 合规字段，不可裁剪、不可隐藏） */
  core?: boolean;
  /** 下拉选项（type=select/multiselect 时） */
  options?: Array<{ value: string; label: string }>;
  /** 最大长度 */
  maxLength?: number;
  /** 默认值 */
  defaultValue?: string | number | null;
  /** 占位提示 */
  placeholder?: string;
  /** 帮助说明 */
  helpText?: string;
  /** 排序权重 */
  order?: number;
  /** 适用于哪一级（VOLUME/ITEM/BOTH） */
  level?: 'VOLUME' | 'ITEM' | 'BOTH';
  /** 是否只读（如档号） */
  readonly?: boolean;
}

export interface CategoryDto {
  id: string;
  code: string;
  name: string;
  fieldSchema: MetadataFieldDef[];
  danghaoRuleId: string | null;
  sort: number;
  active: boolean;
  createdAt: string;
}

export interface CreateCategoryDto {
  code: string;
  name: string;
  fieldSchema?: MetadataFieldDef[];
  danghaoRuleId?: string | null;
  sort?: number;
  active?: boolean;
}

// ============================================================================
// 档号规则 F-02
// ============================================================================
export interface DanghaoRuleDto {
  id: string;
  fondsId: string;
  categoryId: string | null;
  segments: DanghaoSegment[];
  separator: string;
  resetCycle: ResetCycle;
  zeroPad: number;
  active: boolean;
  description: string;
  createdAt: string;
}

export interface CreateDanghaoRuleDto {
  fondsId: string;
  categoryId?: string | null;
  segments: DanghaoSegment[];
  separator?: string;
  resetCycle?: ResetCycle;
  zeroPad?: number;
  active?: boolean;
}

export interface UpdateDanghaoRuleDto extends Partial<CreateDanghaoRuleDto> {
  id: string;
}

/** 规则试算请求 */
export interface PreviewDanghaoRequest {
  fondsId: string;
  categoryId?: string | null;
  year: number;
  orgCode?: string;
  retentionCode?: string;
  volumeNo?: number;
  itemNo?: number;
  catalogNo?: string;
  /** 是否连算多个流水，展示序列递增效果 */
  count?: number;
}

export interface PreviewDanghaoResponse {
  /** 卷级档号 */
  volumeDanghao: string;
  /** 件级档号列表 */
  itemDanghaos: string[];
  /** 模板可读描述 */
  description: string;
  /** 序列作用域 key（便于排查） */
  volumeScopeKey: string;
  itemScopeKey: string;
}

// ============================================================================
// 案卷 / 件著录 F-03 / F-04
// ============================================================================
export interface VolumeDto {
  id: string;
  fondsId: string;
  categoryId: string | null;
  orgId: string | null;
  danghao: string;
  title: string;
  responsible: string | null;
  year: number;
  retention: Retention;
  securityLevel: SecurityLevel;
  itemCount: number;
  startDate: string | null;
  endDate: string | null;
  classNo: string | null;
  keywords: string[];
  note: string | null;
  status: VolumeStatus;
  extra: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVolumeDto {
  fondsId: string;
  categoryId?: string | null;
  orgId?: string | null;
  title: string;
  responsible?: string | null;
  year: number;
  retention: Retention;
  securityLevel?: SecurityLevel;
  startDate?: string | null;
  endDate?: string | null;
  classNo?: string | null;
  keywords?: string[];
  note?: string | null;
  catalogNo?: string | null;
  extra?: Record<string, unknown>;
}

export interface ItemDto {
  id: string;
  volumeId: string | null;
  fondsId: string;
  danghao: string;
  title: string;
  responsible: string | null;
  docNo: string | null;
  docDate: string | null;
  year: number;
  retention: Retention;
  securityLevel: SecurityLevel;
  categoryCode: string | null;
  classNo: string | null;
  keywords: string[];
  pages: number | null;
  note: string | null;
  status: ItemStatus;
  openFlag: OpenFlag;
  /** 开放范围（P3-B 开放管理落库；NONE=未开放，ENTRY=仅条目，FULLTEXT=原文开放） */
  openScope?: OpenScope;
  fullText: string | null;
  extra: Record<string, unknown>;
  fileCount?: number;
  createdBy: string | null;
  /** 归档人/归档时间（确认归档时写入） */
  archivedBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateItemDto {
  title: string;
  responsible: string;
  docNo?: string | null;
  docDate: string;
  year?: number;
  retention?: Retention;
  securityLevel?: SecurityLevel;
  categoryCode?: string | null;
  classNo?: string | null;
  keywords?: string[];
  pages?: number | null;
  note?: string | null;
  openFlag?: OpenFlag;
  extra?: Record<string, unknown>;
}

export interface UpdateItemDto extends Partial<CreateItemDto> {
  id: string;
  /** 乐观锁：客户端回传版本时间戳，服务端比对防覆盖 */
  updatedAt?: string;
}

/** 批量修改（NFR-7：≥500 条 <30s） */
export interface BatchUpdateItemsDto {
  ids: string[];
  patch: Partial<CreateItemDto>;
}

export interface BatchUpdateResult {
  requested: number;
  updated: number;
  failed: Array<{ id: string; reason: string }>;
}

/** 作废重编请求（档号唯一可变通道） */
export interface VoidReassignDto {
  reason: string;
  /** 是否立即重新生成档号，默认 true */
  reassign?: boolean;
}

export interface VoidReassignResult {
  id: string;
  oldDanghao: string;
  newDanghao: string | null;
  status: ItemStatus;
}

// ============================================================================
// 归档阶段流转（对齐泰坦收集链路：未处理→预归档→待审核→已归档，旁路无需归档）
// ============================================================================
/** 批量阶段流转请求 */
export interface StageTransitionDto {
  ids: string[];
  /** 审核不通过原因（REJECT_REVIEW 必填） */
  reason?: string;
}

/** 批量阶段流转结果 */
export interface StageTransitionResult {
  requested: number;
  updated: number;
  failed: Array<{ id: string; reason: string }>;
}

/** 单条阶段流转日志 */
export interface ItemStageLogDto {
  id: string;
  itemId: string;
  action: string;
  actionLabel: string;
  fromStatus: ItemStatus | null;
  toStatus: ItemStatus;
  reason: string | null;
  operatorId: string | null;
  operatorName: string | null;
  createdAt: string;
}

// ============================================================================
// 检索 F-05
// ============================================================================
export interface SearchHighlight {
  field: string;
  fragments: string[];
}

export interface SearchHit {
  id: string;
  danghao: string;
  title: string;
  responsible: string | null;
  year: number;
  retention: Retention;
  securityLevel: SecurityLevel;
  categoryCode: string | null;
  docDate: string | null;
  fondsId: string;
  status: ItemStatus;
  openFlag: OpenFlag;
  score: number | null;
  highlights: SearchHighlight[];
  fileCount: number;
  hasPreview: boolean;
}

export interface FacetBucket {
  key: string;
  label: string;
  count: number;
}

export interface SearchFacets {
  fonds: FacetBucket[];
  year: FacetBucket[];
  retention: FacetBucket[];
  securityLevel: FacetBucket[];
  category: FacetBucket[];
}

export interface FulltextSearchQuery extends PaginationQuery {
  q?: string;
  fonds?: string[];
  yearFrom?: number;
  yearTo?: number;
  level?: SecurityLevel[];
  retention?: Retention[];
  category?: string[];
  status?: ItemStatus[];
  openFlag?: OpenFlag[];
  sort?: 'relevance' | 'dateDesc' | 'dateAsc' | 'danghaoAsc';
}

export interface FulltextSearchResult extends PageResult<SearchHit> {
  took: number;
  facets: SearchFacets;
  /** 查询语句回显（便于"保存检索条件"） */
  echo: Record<string, unknown>;
  /**
   * 本次查询实际带入的同义词扩展词（空数组表示未触发扩展）。
   * 回给前端是为了让「为什么搜这个词能出那批档」可解释——
   * 档案检索要能向利用者说明召回依据，不能是黑箱。
   */
  expanded?: string[];
}

/** 条件检索单个条件 */
export interface ConditionFilter {
  field: string;
  operator: 'eq' | 'ne' | 'in' | 'like' | 'gte' | 'lte' | 'between' | 'isNull' | 'notNull';
  value?: unknown;
}

export interface ConditionalSearchQuery extends PaginationQuery {
  filters?: ConditionFilter[];
  /** 多条件逻辑关系，默认 AND */
  logic?: 'AND' | 'OR';
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export interface SavedSearchDto {
  id: string;
  name: string;
  query: Record<string, unknown>;
  shared: boolean;
  ownerId: string;
  createdAt: string;
}

export interface SearchHistoryDto {
  id: string;
  keyword: string | null;
  query: Record<string, unknown>;
  resultCount: number;
  tookMs: number;
  createdAt: string;
}

/**
 * 检索同义词组（对齐泰坦同义词维护）。
 * 一组内的词互为等价，检索时任意一个命中即带入其余词做扩展召回。
 */
export interface SearchSynonymDto {
  id: string;
  words: string[];
  note: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// 电子文件 F-08
// ============================================================================
export interface ElectronicFileDto {
  id: string;
  itemId: string;
  bucket: string;
  objectKey: string;
  filename: string;
  mime: string | null;
  size: number;
  sha256: string;
  previewKey: string | null;
  thumbKey: string | null;
  extractStatus: ExtractStatus;
  previewKind: PreviewKind;
  createdAt: string;
  integrityCheck?: IntegrityCheckResult | null;
}

export interface IntegrityCheckResult {
  /** 完整性（SHA-256 比对） */
  integrity: 'PASS' | 'FAIL';
  /** 真实性（P0 预留，默认 UNKNOWN） */
  authenticity: 'PASS' | 'FAIL' | 'UNKNOWN';
  /** 可用性（预览/抽取是否可用） */
  usability: 'PASS' | 'FAIL' | 'UNKNOWN';
  /** 安全性（病毒扫描预留） */
  security: 'PASS' | 'FAIL' | 'UNKNOWN';
  expectedSha256: string;
  actualSha256: string;
  checkedAt: string;
  message: string;
}

export interface PresignRequest {
  itemId: string;
  filename: string;
  mime: string;
  size: number;
  /** 是否走分片（size > 5MB 建议 true） */
  multipart?: boolean;
}

export interface PresignResponse {
  /** 单次直传（小文件）或分片上传 */
  uploadId: string | null;
  bucket: string;
  objectKey: string;
  /** 分片数 */
  partCount: number;
  chunkSize: number;
  /** 每片的预签名 URL（仅 PUT） */
  partUrls: Array<{ partNumber: number; url: string }>;
  /** 直传单片的预签名 URL（multipart=false 时） */
  putUrl: string | null;
  /** 预签名有效期（秒） */
  expiresIn: number;
}

export interface CompleteUploadRequest {
  itemId: string;
  bucket: string;
  objectKey: string;
  filename: string;
  mime: string;
  size: number;
  /** 客户端计算的 SHA-256，服务端会重算比对 */
  sha256: string;
  uploadId?: string | null;
  parts?: Array<{ partNumber: number; etag: string }>;
}

export interface PreviewResponse {
  /** 可访问的临时地址（预签名，短时效） */
  url: string;
  kind: PreviewKind;
  mime: string;
  filename: string;
  expiresIn: number;
  /** 是否有服务端水印 */
  watermarked: boolean;
  /**
   * 水印文案模板（来自参数 `preview.watermark_text`）。
   *
   * 前端渲染水印必须用这个值，**不得**在前端另写字面量——否则管理端改水印
   * 只对服务端生效、前端还是旧文案（D-6 的典型漏点）。
   * 无水印时为空串。
   */
  watermarkTemplate: string;
}

// ============================================================================
// 借阅 F-06
// ============================================================================
export interface BorrowOrderDto {
  id: string;
  orderNo: string;
  applicantId: string;
  applicantName: string;
  itemId: string;
  itemDanghao: string;
  itemTitle: string;
  itemSecurityLevel: SecurityLevel;
  purpose: string;
  mode: BorrowMode;
  expectReturn: string;
  /**
   * 借出日（YYYY-MM-DD）。未借出时为 null。
   * 作为「总借期」起算基准，前端用于展示已借天数与续借剩余额度。
   */
  borrowDate: string | null;
  actualReturn: string | null;
  status: BorrowStatus;
  renewCount: number;
  overdue: boolean;
  approvals: BorrowApprovalDto[];
  createdAt: string;
}

export interface BorrowApprovalDto {
  id: string;
  orderId: string;
  approverId: string;
  approverName: string;
  level: number;
  action: ApprovalAction;
  opinion: string | null;
  actedAt: string;
}

export interface CreateBorrowOrderDto {
  itemId: string;
  purpose: string;
  mode: BorrowMode;
  expectReturn: string;
}

export interface ApproveBorrowDto {
  action: ApprovalAction;
  opinion: string;
  /** 审批级别：1 一级（R1），2 二级（R4，秘密级必走） */
  level?: number;
}

export interface ReturnBorrowDto {
  remark?: string;
}

// ============================================================================
// 统计报表 F-07
// ============================================================================
export interface StockReportRow {
  key: string;
  label: string;
  volumeCount: number;
  itemCount: number;
  fileCount: number;
  totalBytes: number;
  ratio: number;
}

export interface StockReport {
  generatedAt: string;
  range: { from: string | null; to: string | null };
  totalItems: number;
  totalVolumes: number;
  totalFiles: number;
  totalBytes: number;
  byFonds: StockReportRow[];
  byYear: StockReportRow[];
  byCategory: StockReportRow[];
  byRetention: StockReportRow[];
}

export interface IntakeReportRow {
  year: number;
  month: number;
  volumeCount: number;
  itemCount: number;
  fileCount: number;
}

export interface IntakeReport {
  generatedAt: string;
  rows: IntakeReportRow[];
  totalItems: number;
}

export interface BorrowStatsRow {
  key: string;
  label: string;
  orderCount: number;
  itemCount: number;
  returnedCount: number;
  overdueCount: number;
}

export interface BorrowStatsReport {
  generatedAt: string;
  totalOrders: number;
  totalReturned: number;
  totalOverdue: number;
  byMonth: BorrowStatsRow[];
  byStatus: BorrowStatsRow[];
  topItems: Array<{ itemId: string; danghao: string; title: string; count: number }>;
}

// ============================================================================
// 用户 / 角色 F-09
// ============================================================================
export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  status: UserStatus;
  maxSecurityLevel: SecurityLevel;
  roles: Array<{ id: string; code: RoleCode; name: string }>;
  scopes: Array<{ id: string; scopeType: 'ALL' | 'FONDS' | 'ORG' | 'SELF'; scopeRefId: string | null }>;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface CreateUserDto {
  username: string;
  password: string;
  displayName: string;
  status?: UserStatus;
  maxSecurityLevel?: SecurityLevel;
  roleIds?: string[];
  scopes?: Array<{ scopeType: 'ALL' | 'FONDS' | 'ORG' | 'SELF'; scopeRefId?: string | null }>;
}

export interface UpdateUserDto {
  id: string;
  displayName?: string;
  status?: UserStatus;
  maxSecurityLevel?: SecurityLevel;
  roleIds?: string[];
  password?: string;
}

export interface RoleDto {
  id: string;
  code: RoleCode;
  name: string;
  permissions: PermissionGrant[];
  builtin: boolean;
}

export interface UpdateRolePermissionsDto {
  id: string;
  permissions: PermissionGrant[];
}

export interface UpdateUserScopesDto {
  userId: string;
  scopes: Array<{ scopeType: 'ALL' | 'FONDS' | 'ORG' | 'SELF'; scopeRefId?: string | null }>;
}

// ============================================================================
// 字典 / 参数 F-14
// ============================================================================
export interface DictItemDto {
  id: string;
  dictType: string;
  code: string;
  label: string;
  sort: number;
  inUse: boolean;
  /** 是否系统内置（不可删除） */
  builtin: boolean;
}

export interface UpsertDictItemDto {
  id?: string;
  dictType: string;
  code: string;
  label: string;
  sort?: number;
  inUse?: boolean;
}

export interface SystemParamDto {
  id: string;
  key: string;
  value: string;
  label: string | null;
  /** 是否敏感（前端脱敏展示） */
  secret: boolean;
  updatedAt: string;
}

export interface UpsertParamDto {
  key: string;
  value: string;
  label?: string | null;
  secret?: boolean;
}

// ============================================================================
// 审计日志 F-10
// ============================================================================
export interface AuditLogDto {
  id: string;
  userId: string | null;
  username: string | null;
  action: AuditAction;
  objectType: string | null;
  objectId: string | null;
  result: AuditResult;
  ip: string | null;
  durationMs: number | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogQuery extends PaginationQuery {
  userId?: string;
  username?: string;
  action?: AuditAction[];
  objectType?: string;
  objectId?: string;
  result?: AuditResult;
  from?: string;
  to?: string;
  keyword?: string;
}

// ============================================================================
// 备份 F-11
// ============================================================================
export interface BackupRecordDto {
  id: string;
  filename: string;
  storagePath: string;
  sizeBytes: number;
  sha256: string | null;
  status: 'RUNNING' | 'OK' | 'FAILED';
  dbStatus: string | null;
  minioStatus: string | null;
  startedAt: string;
  finishedAt: string | null;
  detail: Record<string, unknown> | null;
}

// ============================================================================
// 回收站 F-18（最小实现）
// ============================================================================
export interface RecycleBinDto {
  id: string;
  objectType: 'VOLUME' | 'ITEM' | 'FILE';
  objectId: string;
  objectLabel: string | null;
  deletedBy: string | null;
  deletedByName: string | null;
  deletedAt: string;
  purgeAfter: string;
  canRestore: boolean;
}

// ============================================================================
// 工作台 F-13
// ============================================================================
export interface DashboardSummary {
  /** 待著录（草稿件数） */
  pendingCatalog: number;
  /** 待审批借阅 */
  pendingApproval: number;
  /** 待归还（借出中） */
  pendingReturn: number;
  /** 鉴定到期（P1 预留，P0 返回 0） */
  appraisalDue: number;
  stock: { totalItems: number; totalFiles: number; totalBytes: number; totalFonds: number };
  intakeByMonth: Array<{ month: string; itemCount: number }>;
  borrowTopItems: Array<{ danghao: string; title: string; count: number }>;
  recentSearches: string[];
}

// ============================================================================
// KB 预留（P0 仅契约）
// ============================================================================
export interface KbQueryRequest {
  question: string;
  topK?: number;
  fondsId?: string;
}

export interface KbCitation {
  danghao: string;
  itemId: string;
  snippet: string;
  securityLevel: SecurityLevel;
}

export interface KbQueryResponse {
  /**
   * 自然语言答案。
   * 片段检索模式下恒为空串 —— 本系统在接入生成式能力前**不产出任何答案文本**，
   * 前端应据 `mode` 展示"仅返回依据片段"，不得把空 answer 当作故障。
   */
  answer: string;
  citations: KbCitation[];
  /** 是否命中依据（未命中时前端提示"无依据"） */
  grounded: boolean;
  /**
   * 本次回答的形态：
   *   - `retrieval`：仅片段检索，返回原文依据，不生成答案（A 档，当前实现）；
   *   - `generative`：生成式问答（B 档，需本地模型，未启用）。
   */
  mode?: 'retrieval' | 'generative';
}

// ============================================================================
// 健康检查
// ============================================================================
export interface HealthStatus {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  deps: Array<{ name: string; ok: boolean; latencyMs: number | null; message?: string }>;
}

// ============================================================================
// 鉴定 F-19（对齐泰坦：鉴定任务 / 任务处理 / 鉴定处置表）
// ============================================================================
export interface AppraisalTaskDto {
  id: string;
  taskNo: string;
  name: string;
  status: AppraisalTaskStatus;
  fondsId: string | null;
  fondsName: string | null;
  yearFrom: number;
  yearTo: number;
  /** 纳入鉴定的保管期限（空数组 = 不限） */
  retentions: Retention[];
  categoryCode: string | null;
  /** 仅纳入已到期件（按 RETENTION_YEARS 与年度差计算） */
  dueOnly: boolean;
  /** 期限依据文档/说明 */
  basis: string | null;
  remark: string | null;
  total: number;
  pending: number;
  keep: number;
  extend: number;
  transfer: number;
  destroy: number;
  /** 销毁审批实例（DESTROY 结论提交审批后生成） */
  workflowInstanceId: string | null;
  workflowStatus: WorkflowInstanceStatus | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AppraisalEntryDto {
  id: string;
  taskId: string;
  itemId: string;
  danghao: string;
  title: string;
  year: number;
  retentionBefore: Retention;
  retentionAfter: Retention | null;
  decision: AppraisalDecision;
  reason: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  executed: boolean;
  executedAt: string | null;
}

export interface CreateAppraisalTaskDto {
  name: string;
  fondsId?: string | null;
  yearFrom: number;
  yearTo: number;
  retentions?: Retention[];
  categoryCode?: string | null;
  dueOnly?: boolean;
  basis?: string | null;
  remark?: string | null;
}

/** 逐件/批量处置 */
export interface DecideAppraisalDto {
  ids: string[];
  decision: Exclude<AppraisalDecision, 'PENDING'>;
  /** EXTEND 必填：新的保管期限 */
  retentionAfter?: Retention | null;
  reason?: string | null;
}

export interface AppraisalExecuteResult {
  requested: number;
  kept: number;
  extended: number;
  transferred: number;
  /** 已执行软删除（进回收站）的件数 */
  destroyed: number;
  /** 结论为销毁但审批未通过，暂缓执行的件数 */
  pendingApproval: number;
  failed: Array<{ id: string; reason: string }>;
}

// ============================================================================
// 开放管理 F-19（未处理 → 条目开放 / 原文开放 / 不开放 / 再审查）
// ============================================================================
export interface OpenBatchDto {
  id: string;
  batchNo: string;
  name: string;
  status: OpenBatchStatus;
  fondsId: string | null;
  fondsName: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  securityLevels: SecurityLevel[];
  total: number;
  pending: number;
  openedEntry: number;
  openedFulltext: number;
  denied: number;
  rereview: number;
  workflowInstanceId: string | null;
  workflowStatus: WorkflowInstanceStatus | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface OpenReviewDto {
  id: string;
  batchId: string;
  itemId: string;
  danghao: string;
  title: string;
  year: number;
  securityLevel: SecurityLevel;
  decision: OpenDecision;
  reason: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  appliedAt: string | null;
}

export interface CreateOpenBatchDto {
  name: string;
  fondsId?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  securityLevels?: SecurityLevel[];
  /** 仅纳入未开放件（open_scope = NONE），默认 true */
  unopenedOnly?: boolean;
}

/** 审核结论提交（批量） */
export interface ReviewOpenBatchDto {
  ids: string[];
  decision: Exclude<OpenDecision, 'PENDING'>;
  /** DENY / REREVIEW 建议填理由 */
  reason?: string | null;
}

export interface OpenApplyResult {
  applied: number;
  openedEntry: number;
  openedFulltext: number;
  denied: number;
  failed: Array<{ id: string; reason: string }>;
}

// ============================================================================
// 审批流引擎 F-07（流程类型 / 环节 / 实例 / 任务）
// ============================================================================
export interface WorkflowNodeDto {
  id?: string;
  seq: number;
  name: string;
  /** 处理角色（R0-R4）；'*' 表示不限角色（仅需权限域匹配） */
  roleCode: RoleCode | '*';
  /** 该环节要求的权限域（为空则只校验角色） */
  permDomain?: string | null;
  /** 最后一个环节通过后触发的业务回调键 */
  onApprove?: string | null;
  /** 是否允许驳回（默认 true） */
  allowReject?: boolean;
  /** 超时提醒小时数（0/空 = 不提醒） */
  timeoutHours?: number | null;
}

export interface WorkflowDefDto {
  id: string;
  code: string;
  name: string;
  bizType: WorkflowBizType;
  version: number;
  enabled: boolean;
  description: string | null;
  nodes: WorkflowNodeDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowDefDto {
  code: string;
  name: string;
  bizType: WorkflowBizType;
  description?: string | null;
  enabled?: boolean;
  nodes: WorkflowNodeDto[];
}

export interface WorkflowTaskDto {
  id: string;
  instanceId: string;
  nodeId: string;
  seq: number;
  nodeName: string;
  roleCode: RoleCode | '*';
  status: WorkflowTaskStatus;
  actedBy: string | null;
  actedByName: string | null;
  opinion: string | null;
  actedAt: string | null;
  createdAt: string;
}

export interface WorkflowInstanceDto {
  id: string;
  defId: string;
  defCode: string;
  defName: string;
  bizType: WorkflowBizType;
  bizId: string;
  title: string;
  summary: string | null;
  status: WorkflowInstanceStatus;
  currentSeq: number;
  currentNodeName: string | null;
  initiatorId: string | null;
  initiatorName: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** 当前用户是否可处理（角色匹配且实例流转中） */
  canAct: boolean;
  tasks: WorkflowTaskDto[];
}

export interface StartWorkflowDto {
  bizType: WorkflowBizType;
  bizId: string;
  title: string;
  summary?: string | null;
  payload?: Record<string, unknown>;
}

export interface WorkflowActionDto {
  action: WorkflowAction;
  /** 意见（驳回必填） */
  opinion: string;
}

// ============================================================================
// P4 向量检索 / RAG / LLM Wiki
// ============================================================================
export interface RagChunkHit {
  chunkId: string;
  itemId: string;
  danghao: string;
  title: string;
  chunkNo: number;
  content: string;
  /** 相似度 0-1（向量余弦；词法模式为相关度归一化值） */
  score: number;
  securityLevel: SecurityLevel;
}

export interface RagRetrieveResult {
  query: string;
  hits: RagChunkHit[];
  /** VECTOR=向量召回；LEXICAL=嵌入不可用时降级为全文词法召回 */
  mode: 'VECTOR' | 'LEXICAL';
  tookMs: number;
  note: string | null;
}

export interface RagAskRequest {
  question: string;
  topK?: number;
}

export interface RagCitation {
  index: number;
  itemId: string;
  danghao: string;
  title: string;
  chunkNo: number;
  snippet: string;
}

export interface RagAskResult {
  answer: string;
  citations: RagCitation[];
  mode: 'VECTOR' | 'LEXICAL';
  model: string | null;
  tookMs: number;
  /** true = 生成模型不可用或未启用，answer 为抽取式摘要 */
  degraded: boolean;
  note: string | null;
}

export interface RagStatusDto {
  embeddingProvider: string;
  embeddingModel: string | null;
  embeddingDim: number;
  embeddingAvailable: boolean;
  llmModel: string | null;
  llmAvailable: boolean;
  vectorStore: 'PGVECTOR' | 'ARRAY_FALLBACK';
  chunkCount: number;
  itemCount: number;
  lastIndexedAt: string | null;
}

export interface RagReindexResult {
  items: number;
  chunks: number;
  skipped: number;
  failed: number;
  tookMs: number;
}

export interface WikiTopicDto {
  keyword: string;
  count: number;
  sampleTitles: string[];
}

export interface WikiRelationDto {
  id: string;
  sourceItemId: string;
  targetItemId: string;
  targetDanghao: string | null;
  targetTitle: string | null;
  relationType: string;
  weight: number;
  source: 'AUTO' | 'MANUAL';
  createdAt: string;
}

export interface WikiSummaryDto {
  itemId: string;
  summary: string;
  keywords: string[];
  degraded: boolean;
  model: string | null;
}
