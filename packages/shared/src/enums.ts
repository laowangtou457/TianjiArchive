/**
 * 共享枚举与常量 —— 密级 / 保管期限 / 角色 / 操作类型 / 借阅状态机 / 任务状态等。
 *
 * 设计原则：
 * 1) 密级用「数值可比大小」表达，权限过滤条件恒为 `security_level <= user.maxSecurityLevel`；
 * 2) 保管期限、门类、利用目的等可扩展项走字典表（dict_item），此处只固化 DA/T 标准默认值；
 * 3) 所有枚举同时导出「值数组」与「中文标签表」，前端下拉与后端校验共用同一份定义。
 */

// ============================================================================
// 密级（PRD Q8：默认三档，可通过 dict_item 扩展，数值越大越密）
// ============================================================================
export const SecurityLevel = {
  PUBLIC: 'PUBLIC',
  INTERNAL: 'INTERNAL',
  SECRET: 'SECRET',
} as const;
export type SecurityLevel = (typeof SecurityLevel)[keyof typeof SecurityLevel];

/** 密级排序权重：过滤时 `item.level <= user.maxLevel` */
export const SECURITY_LEVEL_RANK: Readonly<Record<SecurityLevel, number>> = {
  PUBLIC: 0,
  INTERNAL: 1,
  SECRET: 2,
};

export const SECURITY_LEVEL_LABELS: Readonly<Record<SecurityLevel, string>> = {
  PUBLIC: '公开',
  INTERNAL: '内部',
  SECRET: '秘密',
};

export const SECURITY_LEVEL_VALUES: readonly SecurityLevel[] = [
  SecurityLevel.PUBLIC,
  SecurityLevel.INTERNAL,
  SecurityLevel.SECRET,
];

/** 由数值权重反查密级（用于 seed / 审批路由） */
export function securityLevelFromRank(rank: number): SecurityLevel {
  const found = SECURITY_LEVEL_VALUES.find((l) => SECURITY_LEVEL_RANK[l] === rank);
  return found ?? SecurityLevel.PUBLIC;
}

/**
 * 返回 <= 给定密级的所有密级（用于 SQL IN 过滤，兼容性优于自定义比较函数）。
 * 未知密级 fail-closed：返回空数组（调用方应视为「无任何可访问密级」），
 * 绝不回落 rank 0 把 PUBLIC 当作上限。
 */
export function securityLevelsAtMost(max: SecurityLevel): SecurityLevel[] {
  const maxRank = SECURITY_LEVEL_RANK[max];
  if (maxRank === undefined) return [];
  return SECURITY_LEVEL_VALUES.filter((l) => SECURITY_LEVEL_RANK[l] <= maxRank);
}

// ============================================================================
// 保管期限（DA/T 22-2015：永久 / 定期 30 年 / 定期 10 年）
// ============================================================================
export const Retention = {
  PERM: 'PERM',
  Y30: 'Y30',
  Y10: 'Y10',
} as const;
export type Retention = (typeof Retention)[keyof typeof Retention];

export const RETENTION_LABELS: Readonly<Record<Retention, string>> = {
  PERM: '永久',
  Y30: '定期 30 年',
  Y10: '定期 10 年',
};

export const RETENTION_VALUES: readonly Retention[] = [Retention.PERM, Retention.Y30, Retention.Y10];

/** 保管期限 → 年限（PERM 用 -1 表示永久） */
export const RETENTION_YEARS: Readonly<Record<Retention, number>> = {
  PERM: -1,
  Y30: 30,
  Y10: 10,
};

// ============================================================================
// 角色（PRD §3.1）
// ============================================================================
export const RoleCode = {
  R0: 'R0',
  R1: 'R1',
  R2: 'R2',
  R3: 'R3',
  R4: 'R4',
} as const;
export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];

export const ROLE_LABELS: Readonly<Record<RoleCode, string>> = {
  R0: '系统管理员',
  R1: '档案管理员',
  R2: '部门兼职档案员',
  R3: '借阅用户',
  R4: '领导/查档审批人',
};

export const ROLE_VALUES: readonly RoleCode[] = ['R0', 'R1', 'R2', 'R3', 'R4'];

// ============================================================================
// 功能域（权限矩阵的行，PRD §3.2）
// ============================================================================
export const PermissionDomain = {
  FONDS: 'FONDS',
  VOLUME: 'VOLUME',
  ITEM: 'ITEM',
  DANGHAO_RULE: 'DANGHAO_RULE',
  ARCHIVE_CONFIRM: 'ARCHIVE_CONFIRM',
  SEARCH: 'SEARCH',
  SEARCH_INTERNAL: 'SEARCH_INTERNAL',
  FILE: 'FILE',
  PREVIEW: 'PREVIEW',
  BORROW_APPLY: 'BORROW_APPLY',
  BORROW_APPROVE: 'BORROW_APPROVE',
  BORROW_RETURN: 'BORROW_RETURN',
  REPORT: 'REPORT',
  COMPILATION: 'COMPILATION',
  APPRAISAL: 'APPRAISAL',
  RECYCLE: 'RECYCLE',
  USER: 'USER',
  AUDIT_LOG: 'AUDIT_LOG',
  BACKUP: 'BACKUP',
  IMPORT_EXPORT: 'IMPORT_EXPORT',
  PARAM: 'PARAM',
  DICT: 'DICT',
  KB: 'KB',
} as const;
export type PermissionDomain = (typeof PermissionDomain)[keyof typeof PermissionDomain];

export const PERMISSION_DOMAIN_LABELS: Readonly<Record<PermissionDomain, string>> = {
  FONDS: '全宗管理',
  VOLUME: '案卷级著录',
  ITEM: '文件级著录',
  DANGHAO_RULE: '档号规则配置',
  ARCHIVE_CONFIRM: '归档/入库确认',
  SEARCH: '综合检索（公开级）',
  SEARCH_INTERNAL: '检索（内部/秘密级）',
  FILE: '电子文件挂接',
  PREVIEW: '在线预览',
  BORROW_APPLY: '借阅申请',
  BORROW_APPROVE: '借阅审批',
  BORROW_RETURN: '归还登记/催还',
  REPORT: '统计报表',
  COMPILATION: '档案编研',
  APPRAISAL: '鉴定与开放管理',
  RECYCLE: '回收站',
  USER: '用户与权限',
  AUDIT_LOG: '操作日志',
  BACKUP: '数据备份/恢复',
  IMPORT_EXPORT: '数据导入导出/移交接收',
  PARAM: '系统参数配置',
  DICT: '数据字典',
  KB: '片段检索',
};

export const PERMISSION_DOMAIN_VALUES: readonly PermissionDomain[] = Object.values(PermissionDomain);

// ============================================================================
// 操作类型（四要素之「操作」）
// ============================================================================
export const OperationType = {
  READ: 'READ',
  WRITE: 'WRITE',
  APPROVE: 'APPROVE',
  DELETE: 'DELETE',
  EXPORT: 'EXPORT',
} as const;
export type OperationType = (typeof OperationType)[keyof typeof OperationType];

export const OPERATION_TYPE_LABELS: Readonly<Record<OperationType, string>> = {
  READ: '查',
  WRITE: '著',
  APPROVE: '审',
  DELETE: '删',
  EXPORT: '出',
};

export const OPERATION_TYPE_VALUES: readonly OperationType[] = [
  'READ',
  'WRITE',
  'APPROVE',
  'DELETE',
  'EXPORT',
];

// ============================================================================
// 权限态（权限矩阵图例：✔ 完全 / ○ 受限 / △ 只读 / ✖ 无）
// ============================================================================
export const PermissionMode = {
  FULL: 'FULL',
  LIMITED: 'LIMITED',
  READONLY: 'READONLY',
  NONE: 'NONE',
} as const;
export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode];

export const PERMISSION_MODE_SYMBOL: Readonly<Record<PermissionMode, string>> = {
  FULL: '✔',
  LIMITED: '○',
  READONLY: '△',
  NONE: '✖',
};

export const PERMISSION_MODE_LABELS: Readonly<Record<PermissionMode, string>> = {
  FULL: '完全权限',
  LIMITED: '受限权限',
  READONLY: '只读',
  NONE: '无权限',
};

/** 角色权限声明单元：某功能域下允许的操作集合 + 权限态 */
export interface PermissionGrant {
  /** 功能域 */
  domain: PermissionDomain;
  /** 允许的操作类型 */
  ops: OperationType[];
  /** 权限态（仅影响前端展示与语义，服务端以 ops 为准） */
  mode: PermissionMode;
  /** 是否受数据范围限制（全宗/机构/本人） */
  scoped?: boolean;
  /** 是否受密级限制 */
  levelCapped?: boolean;
}

// ============================================================================
// 数据范围（四要素之「数据范围」）
// ============================================================================
export const DataScopeType = {
  ALL: 'ALL',
  FONDS: 'FONDS',
  ORG: 'ORG',
  SELF: 'SELF',
} as const;
export type DataScopeType = (typeof DataScopeType)[keyof typeof DataScopeType];

export const DATA_SCOPE_LABELS: Readonly<Record<DataScopeType, string>> = {
  ALL: '全部数据',
  FONDS: '指定全宗',
  ORG: '指定机构',
  SELF: '本人创建',
};

export const DATA_SCOPE_VALUES: readonly DataScopeType[] = ['ALL', 'FONDS', 'ORG', 'SELF'];

// ============================================================================
// 档案状态
// ============================================================================
export const VolumeStatus = {
  DRAFT: 'DRAFT',
  ARCHIVED: 'ARCHIVED',
  VOID: 'VOID',
} as const;
export type VolumeStatus = (typeof VolumeStatus)[keyof typeof VolumeStatus];

export const VOLUME_STATUS_LABELS: Readonly<Record<VolumeStatus, string>> = {
  DRAFT: '草稿',
  ARCHIVED: '已归档',
  VOID: '已作废',
};

export const ItemStatus = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  ARCHIVED: 'ARCHIVED',
  VOID: 'VOID',
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

export const ITEM_STATUS_LABELS: Readonly<Record<ItemStatus, string>> = {
  DRAFT: '草稿',
  SUBMITTED: '待归档确认',
  ARCHIVED: '已归档',
  VOID: '已作废',
};

export const ITEM_STATUS_VALUES: readonly ItemStatus[] = ['DRAFT', 'SUBMITTED', 'ARCHIVED', 'VOID'];

// ============================================================================
// 开放/划控标识（F-19 / DA/T 22-2015 开放审核）
// ============================================================================
export const OpenFlag = {
  OPEN: 'OPEN',
  CONTROLLED: 'CONTROLLED',
} as const;
export type OpenFlag = (typeof OpenFlag)[keyof typeof OpenFlag];

export const OPEN_FLAG_LABELS: Readonly<Record<OpenFlag, string>> = {
  OPEN: '开放',
  CONTROLLED: '控制使用',
};

// ============================================================================
// 全宗状态
// ============================================================================
export const FondsStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type FondsStatus = (typeof FondsStatus)[keyof typeof FondsStatus];

export const FONDS_STATUS_LABELS: Readonly<Record<FondsStatus, string>> = {
  ACTIVE: '启用',
  DISABLED: '停用（可检索不可新增）',
};

// ============================================================================
// 借阅状态机（PRD F-06）
// PENDING → APPROVED → LENT → RETURNED
//   支线：REJECTED / CANCELLED / OVERDUE
// ============================================================================
export const BorrowStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  LENT: 'LENT',
  RETURNED: 'RETURNED',
  OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED',
} as const;
export type BorrowStatus = (typeof BorrowStatus)[keyof typeof BorrowStatus];

export const BORROW_STATUS_LABELS: Readonly<Record<BorrowStatus, string>> = {
  PENDING: '待审批',
  APPROVED: '已批准',
  REJECTED: '已驳回',
  LENT: '已借出',
  RETURNED: '已归还',
  OVERDUE: '逾期',
  CANCELLED: '已撤销',
};

export const BORROW_STATUS_VALUES: readonly BorrowStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'LENT',
  'RETURNED',
  'OVERDUE',
  'CANCELLED',
];

/** 借阅状态流转表：key 为当前状态，value 为允许的下一状态 */
export const BORROW_TRANSITIONS: Readonly<Record<BorrowStatus, readonly BorrowStatus[]>> = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['LENT', 'CANCELLED'],
  REJECTED: [],
  LENT: ['RETURNED', 'OVERDUE'],
  OVERDUE: ['RETURNED'],
  RETURNED: [],
  CANCELLED: [],
};

/** 是否为终态 */
export function isBorrowTerminal(status: BorrowStatus): boolean {
  return ['REJECTED', 'RETURNED', 'CANCELLED'].includes(status);
}

/** 借阅方式 */
export const BorrowMode = {
  ONLINE: 'ONLINE',
  ORIGINAL: 'ORIGINAL',
} as const;
export type BorrowMode = (typeof BorrowMode)[keyof typeof BorrowMode];

export const BORROW_MODE_LABELS: Readonly<Record<BorrowMode, string>> = {
  ONLINE: '在线阅览',
  ORIGINAL: '原件借出',
};

/** 审批动作 */
export const ApprovalAction = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
} as const;
export type ApprovalAction = (typeof ApprovalAction)[keyof typeof ApprovalAction];

/**
 * 借阅业务参数（PRD 5.4 / F-06，BR-06-1 ~ BR-06-7）—— **运行期取值载体**。
 *
 * ⚠️ 这里只定义**结构**，不再持有数值。数值一律来自 `sys_param`
 * （`PARAM_DEFS` 为唯一定义源，见 `./params.ts`），由后端 `ParamService`
 * 读取后实例化，通过 `GET /borrow/config` 下发给前端。
 *
 * 为什么保留这个类型：前后端共用同一结构，避免后端加参数前端不知道、
 * 或前端文案与后端校验口径漂移（PR-P1「业务代码禁止策略字面量」）。
 *
 * 阈值与边界语义（取值来自参数，语义写死在这里）：
 *  - `maxTotalDays`：BR-06-1/3 总借期上限，自**借出日**起算，含续借累计；
 *  - `maxRenewalCount`：BR-06-2 续借次数上限（0 = 禁止续借）；
 *  - `maxRenewalDays`：单次续借天数上限（与总借期是**两个独立维度**）；
 *  - `defaultDays`：申请页预填借期（受 C-1 约束 ≤ maxTotalDays）；
 *  - `minDays`：借期下限，固定 1（不参数化：0 天借期无业务意义）。
 *  - 边界均为**闭区间**（maxTotalDays = 90 表示 90 天本身合法）。
 */
export interface BorrowRules {
  readonly maxTotalDays: number;
  readonly minDays: number;
  readonly maxRenewalCount: number;
  readonly maxRenewalDays: number;
  readonly defaultDays: number;
}

/** 借期下限（不参数化，全系统固定 1 天） */
export const BORROW_MIN_DAYS = 1;

/** 参数字段缺失/非法时的兜底值（与 PARAM_DEFS 默认值一致，仅用于容错，不参与业务口径） */
export const BORROW_RULES_FALLBACK: BorrowRules = {
  maxTotalDays: 90,
  minDays: BORROW_MIN_DAYS,
  maxRenewalCount: 1,
  maxRenewalDays: 30,
  defaultDays: 30,
};

/**
 * 生成借阅规则的用户可见说明（前端统一展示）。
 * 入参为**运行期**规则，故文案永远与实际执行口径一致。
 */
export function borrowRulesHint(rules: BorrowRules): string {
  const renew =
    rules.maxRenewalCount > 0
      ? `可续借 ${rules.maxRenewalCount} 次（每次不超过 ${rules.maxRenewalDays} 天），续借后总借期仍不得超过 ${rules.maxTotalDays} 天。`
      : '当前设置为不允许续借。';
  return `借期自借出日起最长 ${rules.maxTotalDays} 天，${renew}`;
}

// ============================================================================
// 审计操作动作（F-10）
// ============================================================================
export const AuditAction = {
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  SEARCH: 'SEARCH',
  PREVIEW: 'PREVIEW',
  DOWNLOAD: 'DOWNLOAD',
  APPROVE: 'APPROVE',
  EXPORT: 'EXPORT',
  PERM_CHANGE: 'PERM_CHANGE',
  RESTORE: 'RESTORE',
  VOID: 'VOID',
  BACKUP: 'BACKUP',
  IMPORT: 'IMPORT',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AUDIT_ACTION_LABELS: Readonly<Record<AuditAction, string>> = {
  LOGIN: '登录',
  LOGOUT: '登出',
  CREATE: '新增',
  UPDATE: '修改',
  DELETE: '删除',
  SEARCH: '检索',
  PREVIEW: '预览',
  DOWNLOAD: '下载',
  APPROVE: '审批',
  EXPORT: '导出',
  PERM_CHANGE: '权限变更',
  RESTORE: '还原',
  VOID: '作废',
  BACKUP: '备份',
  IMPORT: '导入',
};

export const AUDIT_ACTION_VALUES: readonly AuditAction[] = Object.values(AuditAction);

/** 审计结果 */
export const AuditResult = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  DENIED: 'DENIED',
} as const;
export type AuditResult = (typeof AuditResult)[keyof typeof AuditResult];

/** 需要强制留痕、不可关闭的动作（架构 §11） */
export const MANDATORY_AUDIT_ACTIONS: readonly AuditAction[] = [
  'SEARCH',
  'PREVIEW',
  'DOWNLOAD',
  'LOGIN',
  'LOGOUT',
  'PERM_CHANGE',
  'APPROVE',
  'DELETE',
  'VOID',
  'EXPORT',
  'BACKUP',
];

// ============================================================================
// 电子文件抽取状态
// ============================================================================
export const ExtractStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  OK: 'OK',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;
export type ExtractStatus = (typeof ExtractStatus)[keyof typeof ExtractStatus];

export const EXTRACT_STATUS_LABELS: Readonly<Record<ExtractStatus, string>> = {
  PENDING: '待抽取',
  RUNNING: '抽取中',
  OK: '已完成',
  FAILED: '抽取失败',
  SKIPPED: '不支持（跳过）',
};

// ============================================================================
// 备份状态
// ============================================================================
export const BackupStatus = {
  RUNNING: 'RUNNING',
  OK: 'OK',
  FAILED: 'FAILED',
} as const;
export type BackupStatus = (typeof BackupStatus)[keyof typeof BackupStatus];

// ============================================================================
// 用户状态
// ============================================================================
export const UserStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  LOCKED: 'LOCKED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const USER_STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  ACTIVE: '正常',
  DISABLED: '停用',
  LOCKED: '锁定',
};

// ============================================================================
// 回收站对象类型
// ============================================================================
export const RecycleObjectType = {
  VOLUME: 'VOLUME',
  ITEM: 'ITEM',
  FILE: 'FILE',
} as const;
export type RecycleObjectType = (typeof RecycleObjectType)[keyof typeof RecycleObjectType];

// ============================================================================
// 分页常量（架构 §11）
// ============================================================================
export const PAGE_SIZE_OPTIONS: readonly number[] = [20, 50, 100];
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// ============================================================================
// MinIO 桶（架构 §11）
// ============================================================================
export const BUCKET = {
  ORIGINAL: 'archive-original',
  PREVIEW: 'archive-preview',
  THUMB: 'archive-thumb',
  BACKUP: 'archive-backup',
} as const;

// ============================================================================
// 文件上传约束（NFR-6）
// ============================================================================
/** 单文件上限 2GB */
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
/** 分片大小 5MB */
export const CHUNK_SIZE = 5 * 1024 * 1024;

/** 允许的 MIME 白名单（上传时 + 服务端魔数嗅探双校验） */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'image/bmp',
  'image/gif',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/ofd',
];

/** 预览分类 */
export const PreviewKind = {
  PDF: 'PDF',
  IMAGE: 'IMAGE',
  AUDIO: 'AUDIO',
  VIDEO: 'VIDEO',
  OFFICE: 'OFFICE',
  TEXT: 'TEXT',
  NONE: 'NONE',
} as const;
export type PreviewKind = (typeof PreviewKind)[keyof typeof PreviewKind];

/** 依据 MIME 判定预览类型 */
export function resolvePreviewKind(mime: string): PreviewKind {
  const m = (mime || '').toLowerCase();
  if (m === 'application/pdf' || m === 'application/ofd') return 'PDF';
  if (m.startsWith('image/')) return 'IMAGE';
  if (m.startsWith('audio/')) return 'AUDIO';
  if (m.startsWith('video/')) return 'VIDEO';
  if (m.startsWith('text/')) return 'TEXT';
  if (m.includes('word') || m.includes('excel') || m.includes('spreadsheet') || m.includes('presentation') || m.includes('powerpoint')) {
    return 'OFFICE';
  }
  return 'NONE';
}

// ============================================================================
// 队列名
// ============================================================================
export const QUEUE_NAME = {
  EXTRACT: 'archive-extract',
  BACKUP: 'archive-backup',
  BULK_IMPORT: 'archive-bulk-import',
} as const;

/** 抽取任务载荷 */
export interface ExtractJobPayload {
  fileId: string;
  itemId: string;
  bucket: string;
  objectKey: string;
  mime: string;
  filename: string;
}

// ============================================================================
// 通用小工具（前后端共用）
// ============================================================================
/** ISO 时间格式化（UTC ISO 8601） */
export function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 安全数字转换，带默认值 */
export function toInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}
