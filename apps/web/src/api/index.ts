/**
 * 各业务域的 API 封装（薄封装，类型全部来自 @tianji/shared）。
 * 页面只依赖本文件，不直接拼 URL。
 */
import type {
  BackupRecordDto,
  BorrowOrderDto,
  BorrowStatsReport,
  CategoryDto,
  CreateBorrowOrderDto,
  CreateCategoryDto,
  CreateDanghaoRuleDto,
  CreateFondsDto,
  DashboardSummary,
  DanghaoRuleDto,
  DictItemDto,
  ElectronicFileDto,
  FondsDto,
  FulltextSearchQuery,
  FulltextSearchResult,
  IntakeReport,
  IntegrityCheckResult,
  ItemDto,
  LoginRequest,
  LoginResponse,
  OrgNodeDto,
  PageResult,
  PermissionSnapshot,
  PresignRequest,
  PresignResponse,
  CompleteUploadRequest,
  PreviewResponse,
  PreviewDanghaoRequest,
  PreviewDanghaoResponse,
  RecycleBinDto,
  RoleDto,
  SearchHistoryDto,
  StockReport,
  SystemParamDto,
  ParamDef,
  ParamMetaDto,
  ParamConflict,
  UserDto,
  VoidReassignResult,
  VolumeDto,
} from '@tianji/shared';
import { api } from './client';

// ---------------------------------------------------------------- 认证
export const authApi = {
  login: (body: LoginRequest): Promise<LoginResponse> => api.post('/auth/login', body),
  logout: (refreshToken?: string): Promise<{ success: boolean }> =>
    api.post('/auth/logout', { refreshToken }),
  profile: (): Promise<PermissionSnapshot> => api.get('/auth/profile'),
  changePassword: (oldPassword: string, newPassword: string): Promise<{ success: boolean }> =>
    api.post('/auth/change-password', { oldPassword, newPassword }),
};

// ---------------------------------------------------------------- 工作台
export const dashboardApi = {
  summary: (): Promise<DashboardSummary> => api.get('/dashboard/summary'),
};

// ---------------------------------------------------------------- 全宗 / 机构
export const fondsApi = {
  list: (): Promise<FondsDto[]> => api.get('/fonds'),
  detail: (id: string): Promise<FondsDto> => api.get(`/fonds/${id}`),
  create: (body: CreateFondsDto): Promise<FondsDto> => api.post('/fonds', body),
  update: (id: string, body: Partial<CreateFondsDto>): Promise<FondsDto> =>
    api.patch(`/fonds/${id}`, body),
  orgs: (fondsId: string): Promise<OrgNodeDto[]> => api.get(`/fonds/${fondsId}/orgs`),
  createOrg: (fondsId: string, body: Omit<OrgNodeDto, 'id' | 'children'>): Promise<OrgNodeDto> =>
    api.post(`/fonds/${fondsId}/orgs`, body),
};

// ---------------------------------------------------------------- 门类
export const categoryApi = {
  list: (): Promise<CategoryDto[]> => api.get('/categories'),
  detail: (id: string): Promise<CategoryDto> => api.get(`/categories/${id}`),
  create: (body: CreateCategoryDto): Promise<CategoryDto> => api.post('/categories', body),
  update: (id: string, body: Partial<CreateCategoryDto>): Promise<CategoryDto> =>
    api.patch(`/categories/${id}`, body),
  itemFields: (id: string) => api.get(`/categories/${id}/fields/item`),
  volumeFields: (id: string) => api.get(`/categories/${id}/fields/volume`),
};

// ---------------------------------------------------------------- 档号规则
export const danghaoApi = {
  list: (fondsId?: string): Promise<DanghaoRuleDto[]> =>
    api.get('/danghao-rules', fondsId ? { fondsId } : undefined),
  create: (body: CreateDanghaoRuleDto): Promise<DanghaoRuleDto> => api.post('/danghao-rules', body),
  update: (id: string, body: Partial<CreateDanghaoRuleDto>): Promise<DanghaoRuleDto> =>
    api.patch(`/danghao-rules/${id}`, body),
  preview: (body: PreviewDanghaoRequest): Promise<PreviewDanghaoResponse> =>
    api.post('/danghao-rules/preview', body),
  previewById: (id: string, body: PreviewDanghaoRequest): Promise<PreviewDanghaoResponse> =>
    api.post(`/danghao-rules/${id}/preview`, body),
};

// ---------------------------------------------------------------- 著录（卷 / 件）
export const archiveApi = {
  listVolumes: (params: {
    page?: number;
    size?: number;
    fondsId?: string;
    categoryId?: string;
    year?: number;
    status?: string;
    keyword?: string;
  }): Promise<PageResult<VolumeDto>> => api.get('/archive/volumes', params),

  volumeDetail: (id: string): Promise<VolumeDto> => api.get(`/archive/volumes/${id}`),

  createVolume: (body: Record<string, unknown>): Promise<VolumeDto> =>
    api.post('/archive/volumes', body),

  updateVolume: (id: string, body: Record<string, unknown>): Promise<VolumeDto> =>
    api.patch(`/archive/volumes/${id}`, body),

  confirmVolume: (id: string): Promise<{ confirmed: number }> =>
    api.post(`/archive/volumes/${id}/confirm`),

  deleteVolume: (id: string): Promise<{ deleted: boolean }> => api.delete(`/archive/volumes/${id}`),

  listItems: (params: {
    page?: number;
    size?: number;
    volumeId?: string;
    fondsId?: string;
    status?: string;
    keyword?: string;
    level?: string;
  }): Promise<PageResult<ItemDto>> => api.get('/archive/items', params),

  itemDetail: (id: string): Promise<ItemDto> => api.get(`/archive/items/${id}`),

  createItemInVolume: (volumeId: string, body: Record<string, unknown>): Promise<ItemDto> =>
    api.post(`/archive/volumes/${volumeId}/items`, body),

  createItem: (body: Record<string, unknown>): Promise<ItemDto> => api.post('/archive/items', body),

  updateItem: (id: string, body: Record<string, unknown>): Promise<ItemDto> =>
    api.patch(`/archive/items/${id}`, body),

  submitItem: (id: string): Promise<ItemDto> => api.post(`/archive/items/${id}/submit`),

  confirmItems: (ids: string[]): Promise<{ confirmed: number }> =>
    api.post('/archive/items/confirm', { ids }),

  batchUpdate: (ids: string[], patch: Record<string, unknown>) =>
    api.post('/archive/items/batch-update', { ids, patch }),

  voidReassign: (id: string, reason: string, reassign = true): Promise<VoidReassignResult> =>
    api.post(`/archive/items/${id}/void`, { reason, reassign }),

  deleteItem: (id: string): Promise<{ deleted: boolean }> => api.delete(`/archive/items/${id}`),
};

// ---------------------------------------------------------------- 检索
export const searchApi = {
  fulltext: (q: FulltextSearchQuery): Promise<FulltextSearchResult> =>
    api.get('/search/fulltext', q as Record<string, unknown>),

  conditional: (body: Record<string, unknown>): Promise<FulltextSearchResult> =>
    api.post('/search/conditional', body),

  history: (): Promise<SearchHistoryDto[]> => api.get('/search/history'),

  saved: (): Promise<Array<{ id: string; name: string; query: Record<string, unknown>; shared: boolean }>> =>
    api.get('/search/saved'),

  save: (name: string, query: Record<string, unknown>, shared = false) =>
    api.post('/search/saved', { name, query, shared }),

  removeSaved: (id: string): Promise<{ deleted: boolean }> => api.delete(`/search/saved/${id}`),

  reindex: (): Promise<{ indexed: number; failed: number }> => api.post('/search/reindex'),
};

// ---------------------------------------------------------------- 电子文件
export const fileApi = {
  presign: (body: PresignRequest): Promise<PresignResponse> => api.post('/files/presign', body),
  complete: (body: CompleteUploadRequest): Promise<ElectronicFileDto> =>
    api.post('/files/complete', body),
  listByItem: (itemId: string): Promise<ElectronicFileDto[]> => api.get('/files', { itemId }),
  detail: (id: string): Promise<ElectronicFileDto> => api.get(`/files/${id}`),
  preview: (id: string): Promise<PreviewResponse> => api.get(`/files/${id}/preview`),
  download: (id: string): Promise<{ url: string; filename: string; expiresIn: number }> =>
    api.get(`/files/${id}/download`),
  integrityCheck: (id: string): Promise<IntegrityCheckResult> =>
    api.post(`/files/${id}/integrity-check`),
  requeue: (id: string): Promise<{ queued: boolean }> => api.post(`/files/${id}/requeue-extract`),
  remove: (id: string): Promise<{ deleted: boolean }> => api.delete(`/files/${id}`),
};

// ---------------------------------------------------------------- 借阅
/** 借阅规则（后端 sys_param 下发，前端预填与提示的唯一来源） */
export interface BorrowRulesDto {
  maxTotalDays: number;
  minDays: number;
  maxRenewalCount: number;
  maxRenewalDays: number;
  defaultDays: number;
  hint: string;
}

export const borrowApi = {
  /** 当前生效的借阅规则（公开接口，无需 PARAM 权限） */
  config: (): Promise<BorrowRulesDto> => api.get('/borrow/config'),
  create: (body: CreateBorrowOrderDto): Promise<BorrowOrderDto> => api.post('/borrow/orders', body),
  list: (params: {
    page?: number;
    size?: number;
    status?: string;
    mine?: boolean;
    keyword?: string;
  }): Promise<{ items: BorrowOrderDto[]; total: number; page: number; size: number }> =>
    api.get('/borrow/orders', params),
  detail: (id: string): Promise<BorrowOrderDto> => api.get(`/borrow/orders/${id}`),
  approve: (id: string, action: 'APPROVE' | 'REJECT', opinion: string): Promise<BorrowOrderDto> =>
    api.post(`/borrow/orders/${id}/approve`, { action, opinion }),
  lend: (id: string): Promise<BorrowOrderDto> => api.post(`/borrow/orders/${id}/lend`),
  giveBack: (id: string, remark?: string): Promise<BorrowOrderDto> =>
    api.post(`/borrow/orders/${id}/return`, { remark }),
  cancel: (id: string): Promise<BorrowOrderDto> => api.patch(`/borrow/orders/${id}/cancel`),
  renew: (id: string): Promise<BorrowOrderDto> => api.patch(`/borrow/orders/${id}/renew`),
  overdue: (): Promise<BorrowOrderDto[]> => api.get('/borrow/orders/overdue'),
  stats: (): Promise<BorrowStatsReport> => api.get('/borrow/stats'),
};

// ---------------------------------------------------------------- 报表
export const reportApi = {
  stock: (params?: Record<string, unknown>): Promise<StockReport> => api.get('/reports/stock', params),
  intake: (params?: Record<string, unknown>): Promise<IntakeReport> =>
    api.get('/reports/intake', params),
  borrow: (): Promise<BorrowStatsReport> => api.get('/reports/borrow'),
  exportStock: (params?: Record<string, unknown>): Promise<void> =>
    api.download('/reports/stock/export', params, `库存统计.xlsx`),
  exportIntake: (params?: Record<string, unknown>): Promise<void> =>
    api.download('/reports/intake/export', params, `接收统计.xlsx`),
  exportBorrow: (): Promise<void> => api.download('/reports/borrow/export', undefined, `借阅统计.xlsx`),
};

// ---------------------------------------------------------------- 用户 / 角色
export const userApi = {
  list: (params?: { page?: number; size?: number; keyword?: string }): Promise<PageResult<UserDto>> =>
    api.get('/users', params),
  create: (body: Record<string, unknown>): Promise<UserDto> => api.post('/users', body),
  update: (id: string, body: Record<string, unknown>): Promise<UserDto> =>
    api.patch(`/users/${id}`, body),
  disable: (id: string): Promise<{ deleted: boolean }> => api.delete(`/users/${id}`),
  resetPassword: (id: string, password: string): Promise<{ success: boolean }> =>
    api.post(`/users/${id}/reset-password`, { password }),
  updateScopes: (id: string, scopes: Array<{ scopeType: string; scopeRefId?: string | null }>) =>
    api.put(`/users/${id}/scopes`, { scopes }),
  roles: (): Promise<RoleDto[]> => api.get('/roles'),
  updateRolePermissions: (id: string, permissions: unknown[]): Promise<RoleDto> =>
    api.patch(`/roles/${id}/permissions`, { permissions }),
};

// ---------------------------------------------------------------- 字典 / 参数
export const dictApi = {
  list: (dictType: string): Promise<DictItemDto[]> => api.get(`/dicts/${dictType}`),
  all: (): Promise<Record<string, DictItemDto[]>> => api.get('/dicts'),
  upsert: (body: Record<string, unknown>): Promise<DictItemDto> => api.post('/dicts', body),
  remove: (id: string): Promise<{ deleted: boolean }> => api.delete(`/dicts/${id}`),
  params: (): Promise<SystemParamDto[]> => api.get('/params'),
  upsertParam: (body: Record<string, unknown>): Promise<SystemParamDto> => api.put('/params', body),
};

// ---------------------------------------------------------------- 业务参数管理（F-14）
/**
 * 参数管理（单一源驱动）。
 *
 * 与 `dictApi.params` 的区别：这里返回的是 **PARAM_DEFS 元数据 + 当前值**，
 * 页面据此渲染分组、区间提示、可编辑性，不再在前端手写任何 key 或分组前缀。
 */
export const paramApi = {
  /** 全量参数元数据（PARAM_DEFS 定义，用于渲染分组/区间/可编辑性） */
  meta: (): Promise<ParamDef[]> => api.get('/params/meta'),
  /** 当前生效值 + 元数据（列表数据源） */
  list: (): Promise<ParamMetaDto[]> => api.get('/params'),
  /** 跨参数冲突预检（C-1~C-5），返回全部冲突而非第一条 */
  check: (items: Array<{ key: string; value: string }>): Promise<ParamConflict[]> =>
    api.post('/params/check', { items }),
  /** 单值保存 */
  save: (key: string, value: string): Promise<{ updated: true }> =>
    api.put('/params', { key, value }),
  /** 批量保存（任一校验失败整体不落库） */
  saveBatch: (items: Array<{ key: string; value: string }>): Promise<{ updated: number }> =>
    api.put('/params/batch', { items }),
};

// ---------------------------------------------------------------- 审计日志
export const auditApi = {
  list: (params: Record<string, unknown>): Promise<PageResult<Record<string, unknown>>> =>
    api.get('/audit-logs', params),
  export: (params: Record<string, unknown>): Promise<void> =>
    api.download('/audit-logs/export', params, '操作日志.csv'),
};

// ---------------------------------------------------------------- 备份
export const backupApi = {
  run: (scope: 'full' | 'db' | 'minio' | 'meta' = 'full'): Promise<BackupRecordDto> =>
    api.post('/backups/run', { scope }),
  list: (params?: { page?: number; size?: number }): Promise<PageResult<BackupRecordDto>> =>
    api.get('/backups', params),
  successRate: (): Promise<{ total: number; ok: number; failed: number; rate: number }> =>
    api.get('/backups/success-rate'),
  verifyRestore: (id: string): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }>; checkedAt: string }> =>
    api.post(`/backups/${id}/verify-restore`),
};

// ---------------------------------------------------------------- 回收站
export const recycleApi = {
  list: (params?: Record<string, unknown>): Promise<PageResult<RecycleBinDto>> =>
    api.get('/recycle', params),
  restore: (id: string): Promise<{ restored: boolean }> => api.post(`/recycle/${id}/restore`),
  purge: (id: string): Promise<{ purged: boolean }> => api.delete(`/recycle/${id}`),
};

// ---------------------------------------------------------------- 知识库（P2 预留）
export const kbApi = {
  status: (): Promise<{
    enabled: boolean;
    embeddingProvider: string;
    dimension: number;
    productionReady: boolean;
    indexedChunks: number;
    filter: Record<string, unknown>;
  }> => api.get('/kb/status'),
  query: (question: string, topK?: number, fondsId?: string): Promise<{
    answer: string;
    citations: Array<{ danghao: string; itemId: string; snippet: string; securityLevel: string }>;
    grounded: boolean;
  }> =>
    api.post('/kb/query', {
      question,
      ...(topK !== undefined ? { topK } : {}),
      ...(fondsId !== undefined ? { fondsId } : {}),
    }),
  /** 重建指定条目的向量（P2；P0 传空数组即无操作） */
  reindex: (itemIds: string[]): Promise<{ indexed: number }> => api.post('/kb/reindex', { itemIds }),
};

// ---------------------------------------------------------------- 健康检查
export const healthApi = {
  check: (): Promise<{ status: string; version: string; deps: Array<{ name: string; ok: boolean }> }> =>
    api.get('/health'),
};
