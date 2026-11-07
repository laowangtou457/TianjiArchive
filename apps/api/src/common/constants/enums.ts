/**
 * 应用内部常量枚举（服务层使用）。
 * 对外契约枚举一律从 @tianji/shared 引入，此处只放「服务端独有」常量。
 */
import { deriveParamKey } from '@tianji/shared';

export * from '@tianji/shared';

/** 请求上下文中挂载的键名 */
export const CTX_KEY = {
  USER: 'currentUser',
  AUDIT_DOMAIN: 'auditDomain',
  IDEMPOTENCY_KEY: 'idempotencyKey',
} as const;

/** 元数据键（Reflector 读取） */
export const META_KEY = {
  IS_PUBLIC: 'isPublic',
  REQUIRE_PERM: 'requirePerm',
  AUDIT: 'auditMeta',
  SKIP_AUDIT: 'skipAudit',
} as const;

/** 字典类型常量（与 seed-data 保持一致） */
export const DICT_TYPE = {
  SECURITY_LEVEL: 'SECURITY_LEVEL',
  RETENTION: 'RETENTION',
  BORROW_PURPOSE: 'BORROW_PURPOSE',
  BORROW_STATUS: 'BORROW_STATUS',
  DESTROY_REASON: 'DESTROY_REASON',
  SUBJECT_WORD: 'SUBJECT_WORD',
  CATEGORY: 'CATEGORY',
} as const;

/**
 * 系统参数键常量 —— **由 `@tianji/shared` 的 `PARAM_DEFS` 派生**，不手写字符串。
 *
 * 用法：`PARAM_KEY.BORROW_MAX_TOTAL_DAYS`（常量名 = key 大写、`.` 换 `_`）。
 * 新增/改名参数只需改 `PARAM_DEFS` 一处，此处自动跟随，杜绝
 * 「管理端改参数不生效、静默回落默认值」这类 key 漂移事故。
 */
export const PARAM_KEY: Readonly<Record<string, string>> = deriveParamKey();

/**
 * 历史参数 key（已废弃，仅供迁移与灰度期读旧值使用）。
 *
 * 这 11 个 key 在 PRD 5.5.2 封版时统一改为 `模块.属性_下划线` 命名。
 * `MigrateParamKeys1700000000003` 迁移负责把存量数据搬到新 key；
 * 本表保留是为了让迁移脚本与灰度期兼容读取有据可查，**业务代码禁止再引用**。
 */
export const LEGACY_PARAM_KEY = {
  PREVIEW_WATERMARK_ENABLED: 'preview.watermark.enabled',
  PREVIEW_WATERMARK_TEXT: 'preview.watermark.text',
  DOWNLOAD_ENABLED: 'download.enabled',
  SESSION_TIMEOUT_MINUTES: 'session.timeout.minutes',
  BORROW_MAX_OVERDUE: 'borrow.max.overdue',
  BORROW_RENEW_MAX: 'borrow.renew.max',
  BORROW_DEFAULT_DAYS: 'borrow.default.days',
  RECYCLE_RETENTION_DAYS: 'recycle.retention.days',
  AUDIT_RETENTION_MONTHS: 'audit.retention.months',
  SEARCH_PAGE_SIZE_DEFAULT: 'search.page.size.default',
  EXTRACT_MAX_CONCURRENT: 'extract.max.concurrent',
} as const;

/** 审计对象类型 */
export const AUDIT_OBJECT = {
  AUTH: 'AUTH',
  FONDS: 'FONDS',
  ORG: 'ORG',
  CATEGORY: 'CATEGORY',
  DANGHAO_RULE: 'DANGHAO_RULE',
  VOLUME: 'VOLUME',
  ITEM: 'ITEM',
  FILE: 'FILE',
  BORROW: 'BORROW',
  USER: 'USER',
  ROLE: 'ROLE',
  DICT: 'DICT',
  PARAM: 'PARAM',
  BACKUP: 'BACKUP',
  SEARCH: 'SEARCH',
  REPORT: 'REPORT',
  RECYCLE: 'RECYCLE',
  KB: 'KB',
} as const;

/** Redis 缓存键前缀 */
export const CACHE_KEY = {
  /**
   * 用户权限快照，**带版本号**：`perm:{userId}:v{n}`。
   *
   * 版本号由 `perm_ver:{userId}` 计数键提供，权限变更时 INCR 即让所有旧 key
   * 立即失效（读不到 = 缓存未命中 = 重建），无需 SCAN 删除，也不受多实例
   * 删除时序影响。这是「撤权即时生效」的核心机制（PRD 5.5 C-5）。
   * TTL 仅兜底（防止版本号被误删导致旧 key 永久残留）。
   */
  PERMISSION: 'perm:',

  /** 权限缓存版本号计数键：`perm_ver:{userId}` */
  PERMISSION_VERSION: 'perm_ver:',

  /** 权限失效广播通道（pub/sub，多实例通知清进程内缓存） */
  PERMISSION_CHANNEL: 'perm:invalidate',

  /** 参数失效广播通道（pub/sub） */
  PARAM_CHANNEL: 'param:invalidate',

  DICT: 'dict:',
  PARAM: 'param:',
  CATEGORY: 'category:',
  DASHBOARD: 'dashboard:',
  LOGIN_FAILED: 'login:failed:',
  REFRESH_REVOKED: 'auth:revoked:',

  /**
   * 会话记录：`auth:session:{sessionId}`。
   *
   * 值为 `{ userId, createdAt, timeoutMinutes }`。
   * `timeoutMinutes` 是**签发时刻**的超时快照（QD-1），
   * 存量会话据此走完有效期而不受参数变更影响（D-3）。
   */
  AUTH_SESSION: 'auth:session:',
} as const;

/**
 * 缓存 TTL（秒）—— **仅兜底**。
 *
 * 生效依据是主动失效（版本号 / pub/sub 广播）；TTL 只负责在失效通道异常时
 * 限制最坏情况下的陈旧窗口。权限快照的真实 TTL 来自
 * `security.permission_cache_ttl_seconds` 参数，此处常量仅供缺省回落与测试基线。
 */
export const CACHE_TTL = {
  /** 权限快照兜底 TTL（真实值见参数 security.permission_cache_ttl_seconds） */
  PERMISSION: 300,
  DICT: 600,
  PARAM: 60,
  CATEGORY: 600,
  DASHBOARD: 60,
  /** 权限版本号计数键的保留期（远大于任何 TTL，避免版本号丢失导致旧 key 复活） */
  PERMISSION_VERSION: 7 * 86400,
} as const;

/** 抽取队列并发上限默认值（NFR：独立队列并发 ≤4） */
export const EXTRACT_CONCURRENCY_MAX = 4;

/** 批量操作上限 */
export const BATCH_UPDATE_MAX = 2000;

/** 分页兜底 */
export const DEFAULT_SIZE = 20;
export const MAX_SIZE = 100;
