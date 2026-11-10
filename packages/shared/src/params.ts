/**
 * 业务参数定义（F-14 / PRD 5.5.2 / 架构 §4.3）—— **唯一定义源**。
 *
 * 前后端同源：后端 `PARAM_KEY`、种子数据、管理端页面、取值校验一律由本文件派生，
 * 禁止任何位置手写 key 字符串字面量（`docs/系统架构设计.md` §4.3 key 命名规范）。
 *
 * 六元组设计（key / 默认值 / 区间 / 类型 / grp / editable）：
 *  - `default`：单位未配置时的口径，必须与架构 §4.3 主表逐项一致（有种子比对测试守护）；
 *  - `min`/`max`/`enumValues`：PR-P4 范围校验的唯一来源，越界 400 拒绝，禁止静默落库；
 *  - `grp`：PR-P8 分级读取依据（security/preview 直读数据库，其余走 60s 缓存）；
 *  - `editable=false`：PR-P7 合规固化项（`log.retention_years` 等），管理端禁改。
 */

/** 参数值类型 */
export const ParamValueType = {
  INT: 'int',
  STRING: 'string',
  BOOL: 'bool',
  CRON: 'cron',
  ENUM: 'enum',
  CSV: 'csv',
} as const;
export type ParamValueType = (typeof ParamValueType)[keyof typeof ParamValueType];

/** 参数分组（决定权限归属与缓存策略） */
export const ParamGroup = {
  BORROW: 'borrow',
  PREVIEW: 'preview',
  RECYCLE: 'recycle',
  SECURITY: 'security',
  BACKUP: 'backup',
  LOG: 'log',
  FILE: 'file',
  IMPORT: 'import',
  SEARCH: 'search',
  EXTRACT: 'extract',
} as const;
export type ParamGroup = (typeof ParamGroup)[keyof typeof ParamGroup];

/** 确认级别（PRD 5.5.2）：🔴 高 / 🟡 中 / ⚪ 低 */
export const ParamConfirmLevel = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
} as const;
export type ParamConfirmLevel = (typeof ParamConfirmLevel)[keyof typeof ParamConfirmLevel];

/**
 * 参数生效模式（架构 §4.3 三层分类，**一等公民字段**）。
 *
 * 这是「读取路径」的唯一决定因素，{@link ParamGroup} 只负责管理端展示分组，
 * **不得**参与读取路径判定 —— 这样 `borrow.*` 在结构上就不可能被误配成直读
 * （借期参数若直读，改一次就立刻作用到在途借阅单的逾期判定，直接违反 D-1）。
 *
 * - `read-immediate`：读取生效。改后下一次读取立即生效（新签发会话用新超时、
 *   新预览用新水印），不追溯存量。→ 直读数据库，绕过 Redis 缓存。
 * - `judgment`：判定生效。改后仅对**新申请/新续借**生效，在途单据保持原判定基准
 *   （D-1）。→ 60s 缓存 + `param:invalidate` 主动失效。
 * - `retention`：存量失效。改后不回溯重算已有记录的到期时间（D-2），
 *   只影响新产生的记录。→ 60s 缓存 + 主动失效。
 */
export const ParamEffectiveMode = {
  /** 读取生效：直读 DB，无缓存延迟 */
  READ_IMMEDIATE: 'read-immediate',
  /** 判定生效：缓存 + 主动失效，在途单据不回溯（D-1） */
  JUDGMENT: 'judgment',
  /** 存量失效：缓存 + 主动失效，已有记录不重算（D-2） */
  RETENTION: 'retention',
} as const;
export type ParamEffectiveMode = (typeof ParamEffectiveMode)[keyof typeof ParamEffectiveMode];

/**
 * 各生效模式允许出现的参数分组。
 *
 * 用途：构造期静态校验（{@link assertParamDefs}）。把「谁能直读」写成
 * 数据而非散落的 if 判断，误配时在模块加载阶段直接抛错，
 * 而不是等到运行时出现「改借期参数把在途单据判成逾期」这种极难察觉的症状。
 */
export const EFFECTIVE_MODE_ALLOWED_GROUPS: Readonly<
  Record<ParamEffectiveMode, readonly ParamGroup[]>
> = {
  'read-immediate': ['security', 'preview'],
  judgment: ['borrow', 'search', 'extract'],
  retention: ['recycle', 'backup', 'log', 'file', 'import'],
};

/**
 * 直读（绕过缓存）的生效模式集合。
 *
 * 注意：判定对象是 `effectiveMode`，**不是** `grp`。
 */
export const DIRECT_READ_MODES: readonly ParamEffectiveMode[] = [ParamEffectiveMode.READ_IMMEDIATE];

/** 单个参数定义 */
export interface ParamDef {
  /** 参数 key（`模块.属性_下划线`） */
  readonly key: string;
  /** 默认值（字符串形态，与 sys_param.value 同构） */
  readonly default: string;
  /** 值类型 */
  readonly type: ParamValueType;
  /** 分组（仅用于管理端展示与授权归属，**不决定读取路径**） */
  readonly grp: ParamGroup;
  /** 生效模式（决定读取路径与生效语义，见 {@link ParamEffectiveMode}） */
  readonly effectiveMode: ParamEffectiveMode;
  /** 中文名（管理端展示，亦作为种子的 label） */
  readonly label: string;
  /** 确认级别（PRD 5.5.2） */
  readonly confirm: ParamConfirmLevel;
  /** 是否可编辑（PR-P7 合规固化项为 false） */
  readonly editable: boolean;
  /** 整数下界（type=int 时生效） */
  readonly min?: number;
  /** 整数上界（type=int 时生效） */
  readonly max?: number;
  /** 枚举合法值（type=enum 时生效） */
  readonly enumValues?: readonly string[];
  /** 展示用区间/格式说明 */
  readonly rangeText: string;
  /** 消费方（架构 §4.3「消费方」列，便于代码审查对账） */
  readonly consumer: string;
  /** 特别说明（PRD 封版例外、近似假设等，禁止删除——是给后人的留痕） */
  readonly note?: string;
}

/**
 * 22 项业务参数主表。
 *
 * 顺序与 `docs/系统架构设计.md` §4.3 主表编号一一对应，便于逐行对账。
 */
export const PARAM_DEFS: readonly ParamDef[] = [
  // ---------------------------------------------------------------- borrow
  {
    key: 'borrow.max_total_days',
    default: '90',
    type: 'int',
    grp: 'borrow',
    effectiveMode: 'judgment',
    label: '借期上限（天）',
    confirm: 'HIGH',
    editable: true,
    min: 1,
    max: 365,
    rangeText: '1–365',
    consumer: 'BorrowService 借期校验/逾期判定（D-1 仅新单生效）',
    note: '借阅总借期上限（自借出日起算，含续借累计）。在途单据不回溯重判逾期（D-1）。',
  },
  {
    key: 'borrow.max_renewal_count',
    default: '1',
    type: 'int',
    grp: 'borrow',
    effectiveMode: 'judgment',
    label: '续借次数上限',
    confirm: 'HIGH',
    editable: true,
    min: 0,
    max: 5,
    rangeText: '0–5（0=禁止续借）',
    consumer: 'BorrowService.renew 续借次数校验',
  },
  {
    key: 'borrow.max_renewal_days',
    default: '30',
    type: 'int',
    grp: 'borrow',
    effectiveMode: 'judgment',
    label: '单次续借天数上限',
    confirm: 'HIGH',
    editable: true,
    min: 1,
    max: 90,
    rangeText: '1–90',
    consumer: 'BorrowService.renew 单次续借入参校验',
    note: '与「总借期上限」是两个独立维度：单次续借天数与本值取小后才计入总借期。',
  },
  {
    key: 'borrow.default_days',
    default: '30',
    type: 'int',
    grp: 'borrow',
    effectiveMode: 'judgment',
    label: '默认借期（天）',
    confirm: 'MEDIUM',
    editable: true,
    min: 1,
    // 上界动态跟随 borrow.max_total_days（约束 C-1），此处仅作绝对兜底
    max: 365,
    rangeText: '1–borrow.max_total_days',
    consumer: '前端借阅申请页预填',
    note: '跨参数约束 C-1：保存时校验本值 ≤ borrow.max_total_days。',
  },
  {
    key: 'borrow.overdue_scan_cron',
    default: '0 5 * * * *',
    type: 'cron',
    grp: 'borrow',
    effectiveMode: 'judgment',
    label: '逾期扫描 cron',
    confirm: 'MEDIUM',
    editable: true,
    rangeText: '合法 cron 表达式',
    consumer: 'BorrowService.scanOverdue（调度周期来源）',
    note: '6 段式（秒 分 时 日 月 周），与 @nestjs/schedule 一致；默认每小时第 5 分钟。',
  },
  {
    key: 'borrow.overdue_remind_days',
    default: '3',
    type: 'int',
    grp: 'borrow',
    effectiveMode: 'judgment',
    label: '到期提醒提前天数',
    confirm: 'MEDIUM',
    editable: true,
    min: 0,
    max: 30,
    rangeText: '0–30（0=不提醒）',
    consumer: 'BorrowService.dueSoon 取数范围与提醒文案',
    note: '0 是合法值（表示关闭提醒），读取方禁止用 `n || 3` 之类短路写法，必须显式判 null/NaN。提醒 cron 本身不参数化（固定每日 09:00）。',
  },

  // ---------------------------------------------------------------- preview
  {
    key: 'preview.watermark_enabled',
    default: 'true',
    type: 'bool',
    grp: 'preview',
    effectiveMode: 'read-immediate',
    label: '预览水印开关',
    confirm: 'HIGH',
    editable: true,
    rangeText: 'true / false',
    consumer: 'FileService 预览渲染（PR-P8 直读，立即生效）',
  },
  {
    key: 'preview.watermark_template',
    default: '{username} {datetime}',
    type: 'string',
    grp: 'preview',
    effectiveMode: 'read-immediate',
    label: '水印模板',
    confirm: 'HIGH',
    editable: true,
    rangeText: '支持 {username} {datetime} {ip} 占位',
    consumer: 'FileService 预览渲染（PR-P8 直读，立即生效）',
  },
  {
    key: 'preview.download_mode',
    default: 'approval',
    type: 'enum',
    grp: 'preview',
    effectiveMode: 'read-immediate',
    label: '下载模式',
    confirm: 'HIGH',
    editable: true,
    enumValues: ['disabled', 'approval', 'free'],
    rangeText: 'disabled（禁止）/ approval（需审批）/ free（自由）',
    consumer: 'FileService 下载接口 + 前端下载按钮（PR-P8 直读，立即生效）',
    note: '由旧 key `download.enabled`（bool）迁移而来：false → disabled，true → approval。',
  },

  // ---------------------------------------------------------------- recycle
  {
    key: 'recycle.retention_days',
    default: '30',
    type: 'int',
    grp: 'recycle',
    effectiveMode: 'retention',
    label: '回收站保留天数',
    confirm: 'MEDIUM',
    editable: true,
    min: 7,
    max: 365,
    rangeText: '7–365',
    consumer: 'RecycleService 清理任务（D-2 增量生效）',
  },

  // ---------------------------------------------------------------- security
  {
    key: 'security.session_timeout_min',
    default: '30',
    type: 'int',
    grp: 'security',
    effectiveMode: 'read-immediate',
    label: '会话超时（分钟）',
    confirm: 'HIGH',
    editable: true,
    min: 5,
    max: 240,
    rangeText: '5–240',
    consumer: 'AuthService 会话守卫（PR-P8 直读，立即生效）',
    note: 'min=分钟 是 PRD 封版的命名例外，**禁止**重构为 `_minutes`（会触发又一轮 key 迁移）。',
  },
  {
    key: 'security.password_min_length',
    default: '10',
    type: 'int',
    grp: 'security',
    effectiveMode: 'read-immediate',
    label: '密码最小长度',
    confirm: 'MEDIUM',
    editable: true,
    min: 8,
    max: 32,
    rangeText: '8–32',
    consumer: 'UserService.assertPasswordPolicy（PR-P8 直读）',
  },
  {
    key: 'security.password_expire_days',
    default: '90',
    type: 'int',
    grp: 'security',
    effectiveMode: 'read-immediate',
    label: '密码有效期（天）',
    confirm: 'MEDIUM',
    editable: true,
    min: 0,
    max: 365,
    rangeText: '0–365（0=永不过期）',
    consumer: 'AuthService 登录强制改密判定（PR-P8 直读）',
  },
  {
    key: 'security.login_fail_lock_count',
    default: '5',
    type: 'int',
    grp: 'security',
    effectiveMode: 'read-immediate',
    label: '登录失败锁定阈值',
    confirm: 'MEDIUM',
    editable: true,
    min: 3,
    max: 10,
    rangeText: '3–10',
    consumer: 'UserService.recordLoginFailure（PR-P8 直读）',
  },
  {
    key: 'security.login_lock_min',
    default: '30',
    type: 'int',
    grp: 'security',
    effectiveMode: 'read-immediate',
    label: '锁定时长（分钟）',
    confirm: 'MEDIUM',
    editable: true,
    min: 5,
    max: 1440,
    rangeText: '5–1440',
    consumer: 'UserService.recordLoginFailure / assertUserUsable（PR-P8 直读）',
    note: 'min=分钟 是 PRD 封版的命名例外，**禁止**重构为 `_minutes`（会触发又一轮 key 迁移）。',
  },
  {
    key: 'security.permission_cache_ttl_seconds',
    default: '300',
    type: 'int',
    grp: 'security',
    effectiveMode: 'read-immediate',
    label: '权限快照 TTL（秒）',
    confirm: 'MEDIUM',
    editable: true,
    min: 0,
    max: 3600,
    rangeText: '0–3600',
    consumer: 'UserService.getSnapshot 缓存 TTL **仅兜底**',
    note: '生效依据是主动失效（版本号 + pub/sub 广播），TTL 只是兜底；跨参数约束 C-5 要求 TTL>0 时必须有主动失效通道。',
  },

  // ---------------------------------------------------------------- backup / log
  {
    key: 'backup.keep_copies',
    default: '30',
    type: 'int',
    grp: 'backup',
    effectiveMode: 'retention',
    label: '备份保留份数',
    confirm: 'MEDIUM',
    editable: true,
    min: 7,
    max: 180,
    rangeText: '7–180',
    consumer: '备份清理 sidecar（D-5 增量生效）',
  },
  {
    key: 'log.retention_years',
    default: '3',
    type: 'int',
    grp: 'log',
    effectiveMode: 'retention',
    label: '日志保留年数',
    confirm: 'HIGH',
    editable: false,
    min: 1,
    max: 10,
    rangeText: '1–10',
    consumer: '日志分区归档（D-7 增量生效）',
    note: 'PR-P7 合规固化：editable=false，管理端禁改。由旧 key `audit.retention.months`（36 月）单位换算迁移而来。',
  },

  // ---------------------------------------------------------------- file / import
  {
    key: 'file.max_upload_size_mb',
    default: '2048',
    type: 'int',
    grp: 'file',
    effectiveMode: 'retention',
    label: '单文件大小上限（MB）',
    confirm: 'LOW',
    editable: true,
    min: 1,
    max: 10240,
    rangeText: '1–10240',
    consumer: 'FileService 预签名/分片校验',
  },
  {
    key: 'file.allowed_extensions',
    default: 'pdf,jpg,jpeg,png,tif,tiff,mp4,mp3,wav,doc,docx,xls,xlsx,ofd',
    type: 'csv',
    grp: 'file',
    effectiveMode: 'retention',
    label: '允许的扩展名白名单',
    confirm: 'MEDIUM',
    editable: true,
    rangeText: '逗号分隔，不含点',
    consumer: 'FileService 上传白名单 + 魔数嗅探（立即生效）',
  },
  {
    key: 'import.batch_max_rows',
    default: '100000',
    type: 'int',
    grp: 'import',
    effectiveMode: 'retention',
    label: '单批导入行数上限',
    confirm: 'LOW',
    editable: true,
    min: 1000,
    max: 500000,
    rangeText: '1000–500000',
    consumer:
      'cli-migrator 的 --batch-max-rows（独立 CLI 进程，无 ParamService，由运维显式传参；' +
      '改参数后需同步调整运行命令，属有意边界）',
  },

  // ---------------------------------------------------------------- log / search / extract
  {
    key: 'log.slow_query_threshold_ms',
    default: '2000',
    type: 'int',
    grp: 'log',
    effectiveMode: 'retention',
    label: '慢查询阈值（毫秒）',
    confirm: 'LOW',
    editable: true,
    min: 100,
    max: 30000,
    rangeText: '100–30000',
    consumer: '慢查询告警（守护 NFR-2/3）',
  },
];

// ============================================================================
// 派生工具（后端 PARAM_KEY、种子数据、管理端渲染共用）
// ============================================================================

/** 管理端参数列表项（值 + 元数据，一次拉齐避免前端二次映射） */
export interface ParamMetaDto {
  key: string;
  /** 当前生效值 */
  value: string;
  label: string;
  grp: ParamGroup;
  type: ParamValueType;
  /** 是否可编辑（PR-P7 合规固化项为 false，管理端置灰） */
  editable: boolean;
  confirm: ParamConfirmLevel;
  /** 合法区间说明 */
  rangeText: string;
  /** 默认值（出厂口径，重置按钮用） */
  default: string;
  /** 消费方说明（让管理员明白改了会影响哪里） */
  consumer: string;
  /** 特别说明 */
  note: string | null;
}

/** key → ParamDef 索引 */
const PARAM_DEF_MAP: ReadonlyMap<string, ParamDef> = new Map(
  PARAM_DEFS.map((d) => [d.key, d]),
);

/** 按 key 取定义（未登记返回 undefined，调用方须 fail-closed 处理） */
export function getParamDef(key: string): ParamDef | undefined {
  return PARAM_DEF_MAP.get(key);
}

/** 全部参数 key 列表 */
export function allParamKeys(): string[] {
  return PARAM_DEFS.map((d) => d.key);
}

/**
 * key → 常量名映射（`borrow.max_total_days` → `BORROW_MAX_TOTAL_DAYS`）。
 * 后端 `PARAM_KEY` 由它派生，杜绝手写字符串。
 */
export function paramKeyConstName(key: string): string {
  return key.replace(/\./g, '_').toUpperCase();
}

/**
 * 由 PARAM_DEFS 派生 `PARAM_KEY` 常量对象。
 *
 * 形态：`{ BORROW_MAX_TOTAL_DAYS: 'borrow.max_total_days', ... }`，
 * 与历史手写常量相比只增不删（旧名保留在 `LEGACY_PARAM_KEY` 供迁移使用）。
 */
export function deriveParamKey(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const def of PARAM_DEFS) {
    out[paramKeyConstName(def.key)] = def.key;
  }
  return Object.freeze(out);
}

/**
 * 该参数是否走「直读数据库」通道（PR-P8）。
 *
 * 判定依据是 `effectiveMode` 而非 `grp`：只有 `read-immediate` 类参数
 * （当前即 security / preview 两组的安全与预览项）直读。
 * `borrow.*` 恒为 `judgment`，因此结构上不可能被误配成直读。
 */
export function isDirectReadParam(key: string): boolean {
  const def = getParamDef(key);
  if (!def) return true; // 未登记参数按最保守处理：绕过缓存
  return DIRECT_READ_MODES.includes(def.effectiveMode);
}

/** 模块加载期的参数定义自检错误（配置错误必须在启动阶段暴露，不能带到运行时） */
export class ParamDefConfigError extends Error {
  public constructor(message: string) {
    super(`PARAM_DEFS 配置错误：${message}`);
    this.name = 'ParamDefConfigError';
  }
}

/**
 * PARAM_DEFS 静态自检（模块加载期执行，抛错即启动失败）。
 *
 * 检查项：
 *  1. `effectiveMode` 与 `grp` 的组合必须落在 {@link EFFECTIVE_MODE_ALLOWED_GROUPS}。
 *     这一条直接消灭「把 borrow.* 配成直读」的可能 —— 不用靠人记得去检查。
 *  2. key 不得重复。
 *  3. `int` 型参数必须给出 min/max 且 min <= max；默认值须通过区间校验。
 *  4. `enum` 型参数必须给出 enumValues 且默认值在其中。
 *
 * 之所以写成抛异常而非 console.warn：告警会被淹没，而误配的后果
 * （借期参数直读导致在途单据被重判逾期）在业务侧极难察觉。
 */
export function assertParamDefs(defs: readonly ParamDef[] = PARAM_DEFS): void {
  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.key)) {
      throw new ParamDefConfigError(`参数 key 重复：${def.key}`);
    }
    seen.add(def.key);

    const allowed = EFFECTIVE_MODE_ALLOWED_GROUPS[def.effectiveMode];
    if (!allowed) {
      throw new ParamDefConfigError(
        `${def.key} 的 effectiveMode「${def.effectiveMode}」未登记在 EFFECTIVE_MODE_ALLOWED_GROUPS`,
      );
    }
    if (!allowed.includes(def.grp)) {
      throw new ParamDefConfigError(
        `${def.key} 的 grp「${def.grp}」不允许 effectiveMode「${def.effectiveMode}」` +
          `（允许的分组：${allowed.join(' / ')}）。` +
          (def.grp === 'borrow' && def.effectiveMode !== 'judgment'
            ? '借阅类参数必须为 judgment，否则借期变更会立即作用于在途单据逾期判定，违反 D-1。'
            : ''),
      );
    }

    if (def.type === 'int') {
      if (def.min === undefined || def.max === undefined) {
        throw new ParamDefConfigError(`${def.key} 为 int 型但缺少 min/max 区间定义`);
      }
      if (def.min > def.max) {
        throw new ParamDefConfigError(`${def.key} 的 min(${def.min}) 大于 max(${def.max})`);
      }
      const n = parseStrictInt(def.default);
      if (n === null || n < def.min || n > def.max) {
        throw new ParamDefConfigError(
          `${def.key} 的默认值「${def.default}」不在区间 [${def.min}, ${def.max}] 内`,
        );
      }
    }

    if (def.type === 'enum') {
      const values = def.enumValues ?? [];
      if (values.length === 0) {
        throw new ParamDefConfigError(`${def.key} 为 enum 型但未给出 enumValues`);
      }
      if (!values.includes(def.default)) {
        throw new ParamDefConfigError(
          `${def.key} 的默认值「${def.default}」不在枚举 [${values.join(', ')}] 内`,
        );
      }
    }
  }
}

/**
 * 数值型参数的区间校验结果。
 * `ok=false` 时 `reason` 为可直接展示给管理员的中文提示。
 */
export interface ParamRangeCheck {
  ok: boolean;
  reason?: string;
}

/** 把字符串解析成整数（严格：拒绝 `12abc`、空串、小数） */
export function parseStrictInt(raw: string): number | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 校验单个参数取值是否合法（PR-P4 范围校验的唯一实现）。
 *
 * 同时承担 PR-P7 的**固化项守卫**：`editable=false` 的参数一律拒绝，
 * 哪怕取值本身落在合法区间内。这条必须放在区间校验之前——
 * 否则「固化项 + 合法值」会静默通过，管理端 API 被绕过时无人察觉。
 *
 * @param key 参数 key
 * @param raw 待校验的原始值
 * @param options.allowFixed 内部迁移/备份恢复场景可放行固化项（默认 false）
 */
export function validateParamValue(
  key: string,
  raw: string,
  options: { allowFixed?: boolean } = {},
): ParamRangeCheck {
  const def = getParamDef(key);
  if (!def) {
    return { ok: false, reason: `未知参数 key：${key}（未在 PARAM_DEFS 登记）` };
  }
  if (!def.editable && !options.allowFixed) {
    return {
      ok: false,
      reason: `${def.label} 为合规固化项，不允许修改（PR-P7）${def.note ? `：${def.note}` : ''}`,
    };
  }
  const value = (raw ?? '').trim();
  if (value === '') return { ok: false, reason: `${def.label} 不能为空` };

  switch (def.type) {
    case 'int': {
      const n = parseStrictInt(value);
      if (n === null) return { ok: false, reason: `${def.label} 必须为整数` };
      if (def.min !== undefined && n < def.min) {
        return { ok: false, reason: `${def.label} 不得小于 ${def.min}（当前 ${n}）` };
      }
      if (def.max !== undefined && n > def.max) {
        return { ok: false, reason: `${def.label} 不得大于 ${def.max}（当前 ${n}）` };
      }
      return { ok: true };
    }
    case 'bool': {
      if (!['true', 'false'].includes(value.toLowerCase())) {
        return { ok: false, reason: `${def.label} 只能为 true / false` };
      }
      return { ok: true };
    }
    case 'enum': {
      const allowed = def.enumValues ?? [];
      if (!allowed.includes(value)) {
        return { ok: false, reason: `${def.label} 只能取 ${allowed.join(' / ')}` };
      }
      return { ok: true };
    }
    case 'cron': {
      // 仅做结构校验（5/6 段），语义合法性由调度器注册时兜底
      const parts = value.split(/\s+/).filter(Boolean);
      if (parts.length !== 5 && parts.length !== 6) {
        return { ok: false, reason: `${def.label} 必须为 5 段或 6 段 cron 表达式` };
      }
      return { ok: true };
    }
    case 'csv': {
      const items = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length === 0) return { ok: false, reason: `${def.label} 至少需要一个取值` };
      if (items.some((s) => /[^A-Za-z0-9]/.test(s))) {
        return { ok: false, reason: `${def.label} 只允许字母数字（不含点号）` };
      }
      return { ok: true };
    }
    case 'string':
    default:
      return { ok: true };
  }
}

// ============================================================================
// 跨参数依赖约束（PRD 5.5.5 / 架构 §4.3 C-1 ~ C-5）
// ============================================================================

/** 单条约束冲突 */
export interface ParamConflict {
  /** 约束编号 C-1 ~ C-5 */
  code: string;
  /** 涉及的参数 key */
  keys: string[];
  /** 可直接展示给管理员的中文说明 */
  message: string;
  /** 是否为阻断级（true=拒绝保存；false=仅提示告警） */
  blocking: boolean;
}

/** 读取合并视图（已保存值 + 本次待保存改动） */
export type ParamView = Readonly<Record<string, string>>;

/** 从视图读整数（缺失/非法回落 PARAM_DEFS 默认值） */
function intOf(view: ParamView, key: string): number {
  const raw = view[key];
  const parsed = raw === undefined ? null : parseStrictInt(raw);
  if (parsed !== null) return parsed;
  const def = getParamDef(key);
  return def ? (parseStrictInt(def.default) ?? 0) : 0;
}

/**
 * 校验全部跨参数约束，**一次性返回所有冲突**（不是抛第一个）。
 *
 * 设计取舍：管理员改一组参数时希望能一次看到全部问题，
 * 逐个抛错会让他来回试错 3 次才能保存，体验与效率都差。
 *
 * @param view 合并后的参数视图（key → value）
 * @returns 冲突列表；空数组表示全部通过
 */
export function validateCrossParams(view: ParamView): ParamConflict[] {
  const conflicts: ParamConflict[] = [];

  // ---------------------------------------------------------------- C-1
  const defaultDays = intOf(view, 'borrow.default_days');
  const maxTotalDays = intOf(view, 'borrow.max_total_days');
  if (maxTotalDays > 0 && defaultDays > maxTotalDays) {
    conflicts.push({
      code: 'C-1',
      keys: ['borrow.default_days', 'borrow.max_total_days'],
      message: `默认借期（${defaultDays} 天）不得大于借期上限（${maxTotalDays} 天）`,
      blocking: true,
    });
  }

  // ---------------------------------------------------------------- C-2
  const maxRenewalDays = intOf(view, 'borrow.max_renewal_days');
  if (maxTotalDays > 0 && maxRenewalDays > maxTotalDays) {
    conflicts.push({
      code: 'C-2',
      keys: ['borrow.max_renewal_days', 'borrow.max_total_days'],
      message: `单次续借天数上限（${maxRenewalDays} 天）不得大于借期上限（${maxTotalDays} 天）`,
      blocking: true,
    });
  }

  // ---------------------------------------------------------------- C-3
  // 备份区容量无独立参数，按「份数 × 单份体积 ≤ 容量」给出提示级告警
  // （容量来源：环境变量 BACKUP_VOLUME_GB，缺省 500GB，单份按全量估算）。
  const keepCopies = intOf(view, 'backup.keep_copies');
  const volumeGb = Number.parseInt(view['backup.volume_gb'] ?? '500', 10);
  const estimatedPerCopyGb = Number.parseInt(view['backup.single_copy_gb'] ?? '20', 10);
  if (
    Number.isFinite(volumeGb) &&
    Number.isFinite(estimatedPerCopyGb) &&
    volumeGb > 0 &&
    keepCopies * estimatedPerCopyGb > volumeGb
  ) {
    conflicts.push({
      code: 'C-3',
      keys: ['backup.keep_copies'],
      message:
        `备份保留 ${keepCopies} 份 × 单份约 ${estimatedPerCopyGb}GB = ` +
        `${keepCopies * estimatedPerCopyGb}GB，已超过备份区容量 ${volumeGb}GB，请复核`,
      // 容量为估算值，不做硬阻断
      blocking: false,
    });
  }

  // ---------------------------------------------------------------- C-4
  // 日志保留年限变更需容量复核（提示级）
  const retentionYears = intOf(view, 'log.retention_years');
  if (retentionYears > 5) {
    conflicts.push({
      code: 'C-4',
      keys: ['log.retention_years'],
      message: `日志保留 ${retentionYears} 年，请复核归档存储容量与检索性能影响`,
      blocking: false,
    });
  }

  // ---------------------------------------------------------------- C-5
  // 权限缓存 TTL > 0 时必须有主动失效通道。本系统已全量实现主动失效
  // （perm_ver 版本号 + perm:invalidate 广播），故该约束恒成立；
  // 保留校验的意义是：若将来有人把 TTL 调到 >0 却又拆掉失效通道，此处会拦住。
  const permTtl = intOf(view, 'security.permission_cache_ttl_seconds');
  const activeInvalidation = (view['security.permission_cache_invalidation'] ?? 'versioned-pubsub') !== 'none';
  if (permTtl > 0 && !activeInvalidation) {
    conflicts.push({
      code: 'C-5',
      keys: ['security.permission_cache_ttl_seconds'],
      message: '权限快照 TTL 大于 0 时必须启用主动失效通道（版本号 + pub/sub），否则撤权最长延迟等于 TTL',
      blocking: true,
    });
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// 模块加载期自检：配置错误必须在 import 阶段就炸，不能带到运行时
// ---------------------------------------------------------------------------
assertParamDefs();
