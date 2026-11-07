/**
 * 跨端 DTO 契约 —— 后端 Controller 出参与前端 api 层共用。
 * 约定：时间字段统一为 ISO 8601 UTC 字符串；分页响应 `{list,total,page,size}`。
 */

import type {
  ApprovalAction,
  AuditAction,
  AuditResult,
  BorrowMode,
  BorrowStatus,
  ExtractStatus,
  FondsStatus,
  ItemStatus,
  OpenFlag,
  PermissionGrant,
  PreviewKind,
  Retention,
  RoleCode,
  SecurityLevel,
  UserStatus,
  VolumeStatus,
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
  fullText: string | null;
  extra: Record<string, unknown>;
  fileCount?: number;
  createdBy: string | null;
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
  answer: string;
  citations: KbCitation[];
  /** 是否命中依据（未命中时前端提示"无依据"） */
  grounded: boolean;
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
