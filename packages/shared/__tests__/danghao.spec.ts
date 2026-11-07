/**
 * 档号模板引擎单元测试（packages/shared/src/danghao.ts）
 *
 * 覆盖：模板解析与校验、补零、分隔符、重置周期作用域、非法模板报错、
 *       渲染严格/非严格模式、档号反解析、试算与生成同源一致性。
 */
import { describe, expect, it } from 'vitest';
import {
  assertValidTemplate,
  buildScopeKey,
  DEFAULT_DANGHAO_TEMPLATE,
  DEFAULT_VOLUME_TEMPLATE,
  DANGHAO_SEGMENT_LABELS,
  describeTemplate,
  isSerialSegment,
  MAX_DANGHAO_LENGTH,
  MAX_PAD,
  MAX_SEGMENTS,
  MAX_SEPARATOR_LENGTH,
  padNumber,
  parseDanghao,
  renderDanghao,
  validateTemplate,
  type DanghaoTemplate,
} from '@tianji/shared';

// ------------------------------------------------------------------ 测试夹具
const tpl = (segments: DanghaoTemplate['segments'], separator = '-'): DanghaoTemplate => ({
  segments,
  separator,
});

/** 断言抛出 BizException 且错误码为 2005（RULE_TEMPLATE_INVALID） */
function expectTemplateInvalid(fn: () => unknown, messagePart?: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, '期望抛出异常但未抛出').toBeTruthy();
  const e = caught as { name: string; code: number };
  expect(e.name).toBe('BizException');
  expect(e.code).toBe(2005);
  if (messagePart) expect((caught as Error).message).toContain(messagePart);
}

// ============================================================================
describe('段元数据', () => {
  it('只有 VOLUME / ITEM 属于序列段', () => {
    expect(isSerialSegment('VOLUME')).toBe(true);
    expect(isSerialSegment('ITEM')).toBe(true);
    for (const t of ['FONDS', 'CATALOG', 'YEAR', 'ORG', 'RETENTION'] as const) {
      expect(isSerialSegment(t)).toBe(false);
    }
  });

  it('每个段类型都有中文标签（前端下拉/提示依赖）', () => {
    const all = ['FONDS', 'CATALOG', 'YEAR', 'ORG', 'RETENTION', 'VOLUME', 'ITEM'] as const;
    for (const t of all) {
      expect(DANGHAO_SEGMENT_LABELS[t]).toBeTruthy();
    }
  });
});

// ============================================================================
describe('padNumber 补零', () => {
  it('按位数左补零', () => {
    expect(padNumber(7, 4)).toBe('0007');
    expect(padNumber(1234, 4)).toBe('1234');
  });

  it('超出位数不截断', () => {
    expect(padNumber(123456, 4)).toBe('123456');
  });

  it('pad 为 0 / 负数 / undefined 时原样返回', () => {
    expect(padNumber(7, 0)).toBe('7');
    expect(padNumber(7, -1)).toBe('7');
    expect(padNumber(7)).toBe('7');
  });

  it('非纯数字不补零（如带字母的机构代码）', () => {
    expect(padNumber('BGS', 4)).toBe('BGS');
    expect(padNumber('A1', 4)).toBe('A1');
  });

  it('空值安全', () => {
    expect(padNumber('' as unknown as number, 4)).toBe('');
    expect(padNumber(null as unknown as number, 4)).toBe('');
  });
});

// ============================================================================
describe('validateTemplate 模板合法性', () => {
  it('空模板 / 无段 → 报错', () => {
    expect(validateTemplate({ segments: [], separator: '-' })).toContain('档号模板至少需要一个段');
    expect(validateTemplate({} as DanghaoTemplate)).toContain('档号模板至少需要一个段');
    expect(validateTemplate(null as unknown as DanghaoTemplate)).toContain('档号模板至少需要一个段');
  });

  it(`段数超过 ${MAX_SEGMENTS} → 报错`, () => {
    const segments = Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) =>
      i === MAX_SEGMENTS ? ({ type: 'ITEM', pad: 4 } as const) : ({ type: 'ORG', pad: 0 } as const),
    );
    const errors = validateTemplate(tpl(segments as never));
    expect(errors.some((e) => e.includes(`最多 ${MAX_SEGMENTS} 个段`))).toBe(true);
  });

  it('分隔符含字母数字 → 报错（歧义）', () => {
    const errors = validateTemplate(tpl([{ type: 'YEAR', pad: 4 }, { type: 'ITEM', pad: 4 }], 'A'));
    expect(errors.some((e) => e.includes('分隔符不能包含字母或数字'))).toBe(true);
  });

  it(`分隔符超长（>${MAX_SEPARATOR_LENGTH}）→ 报错`, () => {
    const errors = validateTemplate(
      tpl([{ type: 'YEAR', pad: 4 }, { type: 'ITEM', pad: 4 }], '-----'),
    );
    expect(errors.some((e) => e.includes('分隔符长度'))).toBe(true);
  });

  it('分隔符允许常见符号 / 空字符串', () => {
    expect(validateTemplate(tpl([{ type: 'YEAR', pad: 4 }, { type: 'ITEM', pad: 4 }], '-'))).toEqual([]);
    expect(validateTemplate(tpl([{ type: 'YEAR', pad: 4 }, { type: 'ITEM', pad: 4 }], '.'))).toEqual([]);
    expect(validateTemplate(tpl([{ type: 'YEAR', pad: 4 }, { type: 'ITEM', pad: 4 }], ''))).toEqual([]);
  });

  it('不支持的段类型 → 报错', () => {
    const errors = validateTemplate(
      tpl([{ type: 'UNKNOWN' as never, pad: 0 }, { type: 'ITEM', pad: 4 }]),
    );
    expect(errors.some((e) => e.includes('不受支持'))).toBe(true);
  });

  it('非序列段重复出现 → 报错（如两个 YEAR）', () => {
    const errors = validateTemplate(
      tpl([{ type: 'YEAR', pad: 4 }, { type: 'YEAR', pad: 4 }, { type: 'ITEM', pad: 4 }]),
    );
    expect(errors.some((e) => e.includes('重复出现'))).toBe(true);
  });

  it('缺少流水段 → 报错（无法保证唯一性）', () => {
    const errors = validateTemplate(tpl([{ type: 'FONDS' }, { type: 'YEAR', pad: 4 }]));
    expect(errors.some((e) => e.includes('必须包含至少一个流水段'))).toBe(true);
  });

  it('补零位数越界 → 报错', () => {
    expect(
      validateTemplate(tpl([{ type: 'ITEM', pad: -1 }])).some((e) => e.includes('补零位数')),
    ).toBe(true);
    expect(
      validateTemplate(tpl([{ type: 'ITEM', pad: MAX_PAD + 1 }])).some((e) => e.includes('补零位数')),
    ).toBe(true);
    expect(
      validateTemplate(tpl([{ type: 'ITEM', pad: 3.5 }])).some((e) => e.includes('补零位数')),
    ).toBe(true);
  });

  it('前缀字面量过长 → 报错', () => {
    const errors = validateTemplate(tpl([{ type: 'ITEM', pad: 4, literal: 'ABCDEFGHIJ' }]));
    expect(errors.some((e) => e.includes('前缀字面量过长'))).toBe(true);
  });

  it('合法模板（默认件级模板）→ 无错误', () => {
    expect(validateTemplate(DEFAULT_DANGHAO_TEMPLATE)).toEqual([]);
    expect(validateTemplate(DEFAULT_VOLUME_TEMPLATE)).toEqual([]);
  });

  it('assertValidTemplate 非法时抛 2005 并携带明细', () => {
    let caught: unknown = null;
    try {
      assertValidTemplate(tpl([]));
    } catch (err) {
      caught = err as { code: number; details: unknown };
    }
    expect((caught as { code: number }).code).toBe(2005);
    expect(Array.isArray((caught as { details: unknown }).details)).toBe(true);
  });
});

// ============================================================================
describe('renderDanghao 渲染', () => {
  it('默认件级模板完整渲染（补零 4 位）', () => {
    const result = renderDanghao(DEFAULT_DANGHAO_TEMPLATE, {
      fondsNo: 'A036',
      year: 2024,
      orgCode: 'BGS',
      retentionCode: 'Y',
      volumeNo: 7,
      itemNo: 3,
    });
    expect(result).toBe('A036-2024-BGS-Y-0007-0003');
  });

  it('分隔符自定义生效', () => {
    const template = tpl(DEFAULT_VOLUME_TEMPLATE.segments, '.');
    expect(
      renderDanghao(template, {
        fondsNo: 'A036',
        year: 2024,
        orgCode: 'BGS',
        retentionCode: 'Y',
        volumeNo: 12,
      }),
    ).toBe('A036.2024.BGS.Y.0012');
  });

  it('段前缀字面量拼接在段值之前', () => {
    const template = tpl([
      { type: 'FONDS', pad: 0 },
      { type: 'YEAR', pad: 4, literal: 'D' },
      { type: 'ITEM', pad: 3 },
    ]);
    expect(renderDanghao(template, { fondsNo: 'A036', year: 2024, itemNo: 5 })).toBe('A036-D2024-005');
  });

  it('段固定值优先于上下文取值', () => {
    const template = tpl([
      { type: 'FONDS', pad: 0 },
      { type: 'CATALOG', fixed: 'FIX', pad: 0 },
      { type: 'ITEM', pad: 3 },
    ]);
    expect(
      renderDanghao(template, { fondsNo: 'A036', catalogNo: 'IGNORED', itemNo: 1 }),
    ).toBe('A036-FIX-001');
  });

  it('overrides 优先级最高', () => {
    const template = tpl([{ type: 'FONDS', pad: 0 }, { type: 'ITEM', pad: 3 }]);
    expect(
      renderDanghao(template, { fondsNo: 'A036', itemNo: 1, overrides: { FONDS: 'Z999' } }),
    ).toBe('Z999-001');
  });

  it('严格模式（默认）段值缺失 → 抛 2005', () => {
    expectTemplateInvalid(
      () => renderDanghao(DEFAULT_VOLUME_TEMPLATE, { fondsNo: 'A036', year: 2024 }),
      '取值为空',
    );
  });

  it('非严格模式跳过空段（试算场景）', () => {
    const result = renderDanghao(
      DEFAULT_VOLUME_TEMPLATE,
      { fondsNo: 'A036', year: 2024 },
      { strict: false },
    );
    expect(result).toBe('A036-2024');
  });

  it('渲染前先校验模板（非法模板抛 2005，而非产出脏号）', () => {
    expectTemplateInvalid(() => renderDanghao(tpl([]), {}));
  });

  it(`超长档号（>${MAX_DANGHAO_LENGTH}）→ 抛错`, () => {
    // 模板本身必须合法（validateTemplate 在长度校验之前），
    // 因此用 6 个互异非序列段 + 1 个流水段，靠「段值超长」构造总长 > 120。
    const t = tpl([
      { type: 'FONDS', pad: 0 },
      { type: 'CATALOG', pad: 0 },
      { type: 'YEAR', pad: 4 },
      { type: 'ORG', pad: 0 },
      { type: 'RETENTION', pad: 0 },
      { type: 'ITEM', pad: MAX_PAD },
    ]);
    expectTemplateInvalid(
      () =>
        renderDanghao(t, {
          fondsNo: 'F'.repeat(40),
          catalogNo: 'C'.repeat(40),
          year: 2024,
          orgCode: 'O'.repeat(40),
          retentionCode: 'R'.repeat(20),
          itemNo: 1234567890,
        }),
      '超过上限',
    );
  });

  it('数字型 year / volumeNo / itemNo 均按字符串渲染', () => {
    const out = renderDanghao(DEFAULT_DANGHAO_TEMPLATE, {
      fondsNo: 'A1',
      year: '2024',
      orgCode: 'X',
      retentionCode: '30',
      volumeNo: 1,
      itemNo: 2,
    });
    expect(out).toBe('A1-2024-X-30-0001-0002');
  });
});

// ============================================================================
describe('buildScopeKey 序列作用域（重置周期）', () => {
  it('YEAR 周期：年度参与作用域，年度已在前缀中不重复拼接', () => {
    const key = buildScopeKey(DEFAULT_VOLUME_TEMPLATE, {
      fondsNo: 'A036',
      year: 2024,
      orgCode: 'BGS',
      retentionCode: 'Y',
    }, 'VOLUME', 'YEAR');
    expect(key).toBe('A036|2024|BGS|Y|V:Y');
  });

  it('不同年度 → 不同作用域（按年重置的语义）', () => {
    const base = { fondsNo: 'A036', orgCode: 'BGS', retentionCode: 'Y' };
    const k2024 = buildScopeKey(DEFAULT_VOLUME_TEMPLATE, { ...base, year: 2024 }, 'VOLUME', 'YEAR');
    const k2025 = buildScopeKey(DEFAULT_VOLUME_TEMPLATE, { ...base, year: 2025 }, 'VOLUME', 'YEAR');
    expect(k2024).not.toBe(k2025);
  });

  it('不同全宗 / 机构 / 保管期限 → 不同作用域', () => {
    const base = { year: 2024, orgCode: 'BGS', retentionCode: 'Y' };
    const a = buildScopeKey(DEFAULT_VOLUME_TEMPLATE, { ...base, fondsNo: 'A036' }, 'VOLUME', 'YEAR');
    const b = buildScopeKey(DEFAULT_VOLUME_TEMPLATE, { ...base, fondsNo: 'A037' }, 'VOLUME', 'YEAR');
    expect(a).not.toBe(b);
  });

  it('NEVER 周期：作用域不含年度标记（全局连续）', () => {
    const key = buildScopeKey(DEFAULT_VOLUME_TEMPLATE, {
      fondsNo: 'A036',
      year: 2024,
      orgCode: 'BGS',
      retentionCode: 'Y',
    }, 'VOLUME', 'NEVER');
    expect(key.endsWith('V:N')).toBe(true);
  });

  it('VOLUME 周期：件号作用域包含卷号', () => {
    const key = buildScopeKey(DEFAULT_DANGHAO_TEMPLATE, {
      fondsNo: 'A036',
      year: 2024,
      orgCode: 'BGS',
      retentionCode: 'Y',
      volumeNo: 7,
    }, 'ITEM', 'VOLUME');
    expect(key).toContain('V:0007');
    expect(key.startsWith('I:') || key.includes('|I:')).toBe(true);
  });

  it('ITEM 与 VOLUME 的 flag 不同（避免共用一个序列）', () => {
    const ctx = { fondsNo: 'A036', year: 2024, orgCode: 'BGS', retentionCode: 'Y', volumeNo: 1 };
    const v = buildScopeKey(DEFAULT_DANGHAO_TEMPLATE, ctx, 'VOLUME', 'YEAR');
    const i = buildScopeKey(DEFAULT_DANGHAO_TEMPLATE, ctx, 'ITEM', 'YEAR');
    expect(v).not.toBe(i);
    expect(v).toContain('V:');
    expect(i).toContain('I:');
  });

  it('作用域 key 长度不超过数据库列上限 200', () => {
    const key = buildScopeKey(DEFAULT_DANGHAO_TEMPLATE, {
      fondsNo: 'A036',
      year: 2024,
      orgCode: 'BGS',
      retentionCode: 'Y',
      volumeNo: 1,
    }, 'ITEM', 'VOLUME');
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

// ============================================================================
describe('parseDanghao 反解析（迁移 CLI 挂接依赖）', () => {
  it('标准档号可逐段反解', () => {
    const parsed = parseDanghao(DEFAULT_DANGHAO_TEMPLATE, 'A036-2024-BGS-Y-0007-0003');
    expect(parsed).toMatchObject({
      FONDS: 'A036',
      YEAR: '2024',
      ORG: 'BGS',
      RETENTION: 'Y',
      VOLUME: '0007',
      ITEM: '0003',
    });
  });

  it('段数不足 → 返回 null', () => {
    expect(parseDanghao(DEFAULT_DANGHAO_TEMPLATE, 'A036-2024')).toBeNull();
  });

  it('非法入参（空 / 非字符串）→ 返回 null', () => {
    expect(parseDanghao(DEFAULT_DANGHAO_TEMPLATE, '')).toBeNull();
    expect(parseDanghao(DEFAULT_DANGHAO_TEMPLATE, null as unknown as string)).toBeNull();
  });

  it('带字面量的段，解析时剥离前缀', () => {
    const template = tpl([
      { type: 'FONDS', pad: 0 },
      { type: 'YEAR', pad: 4, literal: 'D' },
      { type: 'ITEM', pad: 3 },
    ]);
    expect(parseDanghao(template, 'A036-D2024-005')).toMatchObject({ YEAR: '2024', ITEM: '005' });
  });

  it('往返一致性：render → parse 应还原关键段值', () => {
    const ctx = { fondsNo: 'A036', year: 2024, orgCode: 'BGS', retentionCode: 'Y', volumeNo: 7, itemNo: 3 };
    const rendered = renderDanghao(DEFAULT_DANGHAO_TEMPLATE, ctx);
    const parsed = parseDanghao(DEFAULT_DANGHAO_TEMPLATE, rendered);
    expect(parsed?.FONDS).toBe('A036');
    expect(parsed?.ITEM).toBe('0003');
    expect(parsed?.VOLUME).toBe('0007');
  });
});

// ============================================================================
describe('describeTemplate 可读描述', () => {
  it('默认件级模板描述包含全部段与补零标注', () => {
    const desc = describeTemplate(DEFAULT_DANGHAO_TEMPLATE);
    expect(desc).toContain('[全宗号]');
    expect(desc).toContain('[件号(4)]');
    expect(desc.split('-').length).toBe(DEFAULT_DANGHAO_TEMPLATE.segments.length);
  });
});

// ============================================================================
describe('前后端同源一致性（试算 = 生成）', () => {
  /**
   * 架构 §11 要求「模板解析器前后端同源」。
   * 验证方法：同一模板 + 同一上下文，前端试算路径（renderDanghao strict:false）
   * 与后端生成路径（renderDanghao strict:true，序列值已知）必须逐字符相等。
   */
  it('试算（strict:false）与生成（strict:true）在同一上下文下产出完全一致', () => {
    const ctx = { fondsNo: 'A036', year: 2024, orgCode: 'BGS', retentionCode: 'Y', volumeNo: 7, itemNo: 3 };
    const preview = renderDanghao(DEFAULT_DANGHAO_TEMPLATE, ctx, { strict: false });
    const generated = renderDanghao(DEFAULT_DANGHAO_TEMPLATE, ctx, { strict: true });
    expect(preview).toBe(generated);
  });

  it('序列号递增时档号单调递增且不重复', () => {
    const seen = new Set<string>();
    for (let itemNo = 1; itemNo <= 50; itemNo += 1) {
      seen.add(
        renderDanghao(DEFAULT_DANGHAO_TEMPLATE, {
          fondsNo: 'A036',
          year: 2024,
          orgCode: 'BGS',
          retentionCode: 'Y',
          volumeNo: 1,
          itemNo,
        }),
      );
    }
    expect(seen.size).toBe(50);
  });
});
