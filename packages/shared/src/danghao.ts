/**
 * 档号模板引擎 —— 前后端同源（架构 §11、DA/T 22-2015 §5.3）
 *
 * 职责：
 *   1) 定义档号段类型常量与段元数据；
 *   2) 解析 / 校验模板（段序列 + 分隔符 + 补零位数 + 流水重置周期）；
 *   3) 用「上下文值」渲染档号（前端试算、后端真实分配共用同一套逻辑，保证试算与生成一致）；
 *   4) 计算序列作用域 key（scope_key），保证「同全宗 + 同年度 + 同周期」共享同一序列。
 *
 * 重要约束：
 *   - 序列段（VOLUME / ITEM）由服务端序列服务赋值，前端试算时可用占位值；
 *   - 档号入库后不可改，只允许「作废 + 重编」并写审计（DANGHAO_IMMUTABLE）。
 */

import { BizException, ErrorCode } from './errors';

// ============================================================================
// 段类型
// ============================================================================
export const DanghaoSegmentType = {
  /** 全宗号，如 A036 */
  FONDS: 'FONDS',
  /** 目录号 / 分类号，如 2024-BGS 或 Y */
  CATALOG: 'CATALOG',
  /** 年度，如 2024 */
  YEAR: 'YEAR',
  /** 机构代码，如 BGS */
  ORG: 'ORG',
  /** 保管期限代码，如 Y / 30 / 10 */
  RETENTION: 'RETENTION',
  /** 卷号（序列） */
  VOLUME: 'VOLUME',
  /** 件号（序列） */
  ITEM: 'ITEM',
} as const;
export type DanghaoSegmentType = (typeof DanghaoSegmentType)[keyof typeof DanghaoSegmentType];

export const DANGHAO_SEGMENT_LABELS: Readonly<Record<DanghaoSegmentType, string>> = {
  FONDS: '全宗号',
  CATALOG: '目录号',
  YEAR: '年度',
  ORG: '机构代码',
  RETENTION: '保管期限',
  VOLUME: '卷号',
  ITEM: '件号',
};

export const DANGHAO_SEGMENT_VALUES: readonly DanghaoSegmentType[] = [
  'FONDS',
  'CATALOG',
  'YEAR',
  'ORG',
  'RETENTION',
  'VOLUME',
  'ITEM',
];

/** 段是否由序列服务分配（需要行锁取号） */
export function isSerialSegment(type: DanghaoSegmentType): boolean {
  return type === 'VOLUME' || type === 'ITEM';
}

// ============================================================================
// 模板结构
// ============================================================================
export interface DanghaoSegment {
  /** 段类型 */
  type: DanghaoSegmentType;
  /** 补零位数，例如 pad=4 → 0007；0/undefined 表示不补零 */
  pad?: number;
  /** 段前缀字面量（可选），如 YEAR 段前面加 'D' */
  literal?: string;
  /** 该段固定值（可选），优先于上下文取值；用于固定目录号等 */
  fixed?: string;
}

export interface DanghaoTemplate {
  segments: DanghaoSegment[];
  /** 段分隔符，默认 '-' */
  separator: string;
}

/** 序列重置周期（DA/T 22-2015） */
export const ResetCycle = {
  /** 按年度重置（件号/卷号每年从 1 开始） */
  YEAR: 'YEAR',
  /** 按卷重置（件号在每卷内从 1 开始） */
  VOLUME: 'VOLUME',
  /** 永不重置 */
  NEVER: 'NEVER',
} as const;
export type ResetCycle = (typeof ResetCycle)[keyof typeof ResetCycle];

export const RESET_CYCLE_LABELS: Readonly<Record<ResetCycle, string>> = {
  YEAR: '按年度重置',
  VOLUME: '按卷重置',
  NEVER: '永不重置',
};

export const MAX_SEGMENTS = 8;
export const MAX_SEPARATOR_LENGTH = 4;
export const MAX_PAD = 10;
export const MAX_DANGHAO_LENGTH = 120;

/** 渲染上下文：段类型 → 原始值 */
export interface DanghaoContext {
  fondsNo?: string;
  catalogNo?: string;
  year?: number | string;
  orgCode?: string;
  retentionCode?: string;
  volumeNo?: number;
  itemNo?: number;
  /** 显式覆盖某些段的渲染值（优先级最高） */
  overrides?: Partial<Record<DanghaoSegmentType, string>>;
}

/** 补零 */
export function padNumber(value: number | string, pad = 0): string {
  const raw = String(value ?? '');
  if (!pad || pad <= 0) return raw;
  // 仅对纯数字补零
  if (!/^\d+$/.test(raw)) return raw;
  return raw.padStart(pad, '0');
}

/**
 * 校验模板合法性，返回错误信息数组（空数组表示合法）。
 * 前端配置页直接用此函数给出即时提示。
 */
export function validateTemplate(template: DanghaoTemplate): string[] {
  const errors: string[] = [];
  const segments = template?.segments ?? [];

  if (!Array.isArray(segments) || segments.length === 0) {
    errors.push('档号模板至少需要一个段');
    return errors;
  }
  if (segments.length > MAX_SEGMENTS) {
    errors.push(`档号模板最多 ${MAX_SEGMENTS} 个段`);
  }

  const sep = template.separator ?? '';
  if (typeof sep !== 'string') {
    errors.push('分隔符必须是字符串');
  } else if (sep.length > MAX_SEPARATOR_LENGTH) {
    errors.push(`分隔符长度不能超过 ${MAX_SEPARATOR_LENGTH}`);
  } else if (/[0-9A-Za-z]/.test(sep)) {
    errors.push('分隔符不能包含字母或数字，避免歧义');
  }

  let serialCount = 0;
  const seen = new Set<string>();
  segments.forEach((seg, idx) => {
    if (!seg || typeof seg !== 'object') {
      errors.push(`第 ${idx + 1} 段定义非法`);
      return;
    }
    if (!DANGHAO_SEGMENT_VALUES.includes(seg.type)) {
      errors.push(`第 ${idx + 1} 段类型「${String(seg.type)}」不受支持`);
      return;
    }
    if (seen.has(seg.type) && !isSerialSegment(seg.type)) {
      errors.push(`段类型「${DANGHAO_SEGMENT_LABELS[seg.type]}」重复出现`);
    }
    seen.add(seg.type);

    if (isSerialSegment(seg.type)) serialCount += 1;

    if (seg.pad !== undefined) {
      if (!Number.isInteger(seg.pad) || seg.pad < 0 || seg.pad > MAX_PAD) {
        errors.push(`第 ${idx + 1} 段补零位数必须是 0~${MAX_PAD} 的整数`);
      }
    }
    if (seg.literal !== undefined && String(seg.literal).length > 8) {
      errors.push(`第 ${idx + 1} 段前缀字面量过长（≤8）`);
    }
  });

  if (serialCount === 0) {
    errors.push('档号模板必须包含至少一个流水段（卷号或件号），否则无法保证唯一');
  }
  if (serialCount > 2) {
    errors.push('流水段最多两个（卷号 + 件号）');
  }

  // 流水段必须位于模板末尾连续区域（卷号后不应再有非件号段）
  const firstSerialIdx = segments.findIndex((s) => s && isSerialSegment(s.type));
  if (firstSerialIdx >= 0) {
    const tail = segments.slice(firstSerialIdx);
    const illegalTail = tail.filter(
      (s) => s && !isSerialSegment(s.type) && !(s as DanghaoSegment).literal,
    );
    if (illegalTail.length > 0) {
      errors.push('流水段之后只允许出现流水段或纯字面量段');
    }
  }

  return errors;
}

/** 校验不通过直接抛业务异常（后端用） */
export function assertValidTemplate(template: DanghaoTemplate): void {
  const errors = validateTemplate(template);
  if (errors.length > 0) {
    throw new BizException(ErrorCode.RULE_TEMPLATE_INVALID, errors.join('；'), errors);
  }
}

/** 从上下文取某段的原始字符串值 */
function resolveSegmentRaw(seg: DanghaoSegment, ctx: DanghaoContext): string {
  const override = ctx.overrides?.[seg.type];
  if (override !== undefined && override !== null && String(override).length > 0) {
    return String(override);
  }
  if (seg.fixed !== undefined && seg.fixed !== null && String(seg.fixed).length > 0) {
    return String(seg.fixed);
  }
  switch (seg.type) {
    case 'FONDS':
      return String(ctx.fondsNo ?? '');
    case 'CATALOG':
      return String(ctx.catalogNo ?? '');
    case 'YEAR':
      return ctx.year === undefined || ctx.year === null ? '' : String(ctx.year);
    case 'ORG':
      return String(ctx.orgCode ?? '');
    case 'RETENTION':
      return String(ctx.retentionCode ?? '');
    case 'VOLUME':
      return ctx.volumeNo === undefined || ctx.volumeNo === null ? '' : String(ctx.volumeNo);
    case 'ITEM':
      return ctx.itemNo === undefined || ctx.itemNo === null ? '' : String(ctx.itemNo);
    default:
      return '';
  }
}

/**
 * 渲染档号。
 * @param template 模板
 * @param ctx      上下文
 * @param options.strict 严格模式（默认 true）：段值为空时抛异常；false 时跳过空段
 * @throws BizException(2005) 模板非法或段值缺失（strict）
 */
export function renderDanghao(
  template: DanghaoTemplate,
  ctx: DanghaoContext,
  options: { strict?: boolean } = {},
): string {
  const strict = options.strict !== false;
  const errors = validateTemplate(template);
  if (errors.length > 0) {
    throw new BizException(ErrorCode.RULE_TEMPLATE_INVALID, errors.join('；'), errors);
  }

  const parts: string[] = [];
  for (const seg of template.segments) {
    const raw = resolveSegmentRaw(seg, ctx);
    if (!raw) {
      if (strict) {
        throw new BizException(
          ErrorCode.RULE_TEMPLATE_INVALID,
          `档号段「${DANGHAO_SEGMENT_LABELS[seg.type]}」取值为空，无法生成档号`,
        );
      }
      continue;
    }
    const padded = isSerialSegment(seg.type) || seg.pad ? padNumber(raw, seg.pad ?? 0) : raw;
    const withLiteral = `${seg.literal ?? ''}${padded}`;
    parts.push(withLiteral);
  }

  const result = parts.join(template.separator ?? '-');
  if (result.length > MAX_DANGHAO_LENGTH) {
    throw new BizException(
      ErrorCode.RULE_TEMPLATE_INVALID,
      `生成的档号长度 ${result.length} 超过上限 ${MAX_DANGHAO_LENGTH}`,
    );
  }
  return result;
}

/**
 * 计算序列作用域 key —— 由「序列段之前的所有段」组成，配合重置周期构成唯一键。
 *
 * 例：模板 FONDS-YEAR-ORG-RETENTION-VOLUME-ITEM，resetCycle=YEAR
 *   VOLUME 的 scope  = `A036|2024|BGS|Y|V:YEAR`
 *   ITEM   的 scope  = `A036|2024|BGS|Y|0007|I:VOLUME`（按卷重置）
 *
 * 该 key 用作 danghao_sequence.scope_key 唯一索引，保证并发安全。
 */
export function buildScopeKey(
  template: DanghaoTemplate,
  ctx: DanghaoContext,
  serialType: 'VOLUME' | 'ITEM',
  resetCycle: ResetCycle = 'YEAR',
): string {
  const segs = template?.segments ?? [];
  const serialIdx = segs.findIndex((s) => s && s.type === serialType);
  const prefixSegs = serialIdx >= 0 ? segs.slice(0, serialIdx) : segs;

  const prefix: string[] = [];
  for (const seg of prefixSegs) {
    const raw = resolveSegmentRaw(seg, ctx);
    if (!raw) continue;
    // 序列段也需参与前缀（ITEM 依赖 VOLUME 号）
    prefix.push(isSerialSegment(seg.type) ? padNumber(raw, seg.pad ?? 0) : `${seg.literal ?? ''}${seg.pad ? padNumber(raw, seg.pad) : raw}`);
  }

  let cycleToken = 'N';
  if (resetCycle === 'YEAR') {
    const year = ctx.year ?? '';
    cycleToken = `Y:${year}`;
    // 年度已在 prefix 中出现过则不重复
    if (year && prefix.includes(String(year))) cycleToken = 'Y';
  } else if (resetCycle === 'VOLUME') {
    const vol = ctx.volumeNo;
    cycleToken = vol === undefined || vol === null ? 'V' : `V:${padNumber(vol, 4)}`;
  }

  const flag = serialType === 'VOLUME' ? 'V' : 'I';
  return `${prefix.join('|')}|${flag}:${cycleToken}`;
}

/**
 * 解析档号字符串为段值（用于迁移工具的「按档号挂接」与反查）。
 * 采用「按分隔符切分 + 末端逆向匹配流水段」策略，容错缺段。
 */
export function parseDanghao(
  template: DanghaoTemplate,
  danghao: string,
): Partial<Record<DanghaoSegmentType, string>> | null {
  if (!danghao || typeof danghao !== 'string') return null;
  const sep = template.separator ?? '-';
  // 分隔符可能出现在字面量中，采用简单切分（标准档号不含分隔符字符）
  const tokens = sep ? danghao.split(sep) : [danghao];
  const segs = template.segments ?? [];
  if (tokens.length < segs.length) return null;

  const result: Partial<Record<DanghaoSegmentType, string>> = {};
  let cursor = 0;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (!seg) return null;
    const token = tokens[cursor];
    cursor += 1;
    if (token === undefined) return null;
    const literal = seg.literal ?? '';
    const value = literal && token.startsWith(literal) ? token.slice(literal.length) : token;
    result[seg.type] = value;
  }
  return result;
}

/** 默认模板（DA/T 22-2015 常见样例：全宗号-年度-机构-保管期限-卷号-件号） */
export const DEFAULT_DANGHAO_TEMPLATE: DanghaoTemplate = {
  separator: '-',
  segments: [
    { type: 'FONDS', pad: 0 },
    { type: 'YEAR', pad: 4 },
    { type: 'ORG', pad: 0 },
    { type: 'RETENTION', pad: 0 },
    { type: 'VOLUME', pad: 4 },
    { type: 'ITEM', pad: 4 },
  ],
};

/** 默认卷级模板（不含件号） */
export const DEFAULT_VOLUME_TEMPLATE: DanghaoTemplate = {
  separator: '-',
  segments: [
    { type: 'FONDS', pad: 0 },
    { type: 'YEAR', pad: 4 },
    { type: 'ORG', pad: 0 },
    { type: 'RETENTION', pad: 0 },
    { type: 'VOLUME', pad: 4 },
  ],
};

/** 生成模板的可读描述，如「[全宗号]-[年度(4)]-[机构代码]-[保管期限]-[卷号(4)]-[件号(4)]」 */
export function describeTemplate(template: DanghaoTemplate): string {
  const sep = template.separator ?? '-';
  return (template.segments ?? [])
    .map((s) => {
      const label = DANGHAO_SEGMENT_LABELS[s.type] ?? String(s.type);
      const pad = s.pad ? `(${s.pad})` : '';
      return `${s.literal ?? ''}[${label}${pad}]`;
    })
    .join(sep);
}
