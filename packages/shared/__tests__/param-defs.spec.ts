/**
 * PARAM_DEFS 单一源自检 + PR-P8 生效模式边界（架构 §4.3 / D-1 守卫）
 *
 * 本文件守两件事：
 *
 *  ① **配置错误在模块加载期就炸**：`assertParamDefs()` 在 `params.ts` 末尾自动执行，
 *     误配（如把 `borrow.*` 标成直读）会让 import 直接抛错。这里再显式测一遍规则本身，
 *     防止有人「优化」掉那条加载期调用却没有替代守卫。
 *
 *  ② **borrow 类参数结构上不可能直读**：读取路径由 `effectiveMode` 决定，
 *     而 `judgment` 类永不走直读。借期参数若直读，改一次就立刻作用于在途
 *     借阅单的逾期判定，违反 D-1「仅对新申请/新续借生效」。这类症状发生在业务侧
 *     极难察觉，所以必须在结构层面焊死。
 */
import { describe, expect, it } from 'vitest';
import {
  DIRECT_READ_MODES,
  EFFECTIVE_MODE_ALLOWED_GROUPS,
  PARAM_DEFS,
  ParamDefConfigError,
  ParamEffectiveMode,
  allParamKeys,
  assertParamDefs,
  isDirectReadParam,
  validateParamValue,
  type ParamDef,
} from '@tianji/shared';

/** 取一份合法定义作为改造基底 */
function baseDef(over: Partial<ParamDef> = {}): ParamDef {
  return {
    key: 'test.sample_param',
    default: '10',
    type: 'int',
    grp: 'borrow',
    effectiveMode: ParamEffectiveMode.JUDGMENT,
    label: '样例',
    confirm: 'LOW',
    editable: true,
    min: 0,
    max: 100,
    rangeText: '0–100',
    consumer: '测试',
    ...over,
  };
}

describe('PARAM_DEFS 单一源：出厂配置必须自洽', () => {
  it('22 项参数，key 无重复', () => {
    expect(PARAM_DEFS.length).toBe(22);
    expect(new Set(allParamKeys()).size).toBe(22);
  });

  it('全员通过 assertParamDefs（加载期自检已执行，此处显式复核）', () => {
    expect(() => assertParamDefs()).not.toThrow();
  });

  it('每项都声明了 effectiveMode（不存在「忘了填就默认」的情况）', () => {
    for (const def of PARAM_DEFS) {
      expect(def.effectiveMode, `${def.key} 缺 effectiveMode`).toBeDefined();
    }
  });
});

describe('PR-P8 生效模式边界：borrow 类恒为 judgment，结构上不可直读', () => {
  it('全部 borrow 参数 effectiveMode === judgment', () => {
    const borrowDefs = PARAM_DEFS.filter((d) => d.grp === 'borrow');
    expect(borrowDefs.length, '应至少有 6 项 borrow 参数').toBeGreaterThanOrEqual(6);
    for (const def of borrowDefs) {
      expect(def.effectiveMode, `${def.key} 必须是 judgment（D-1）`).toBe(
        ParamEffectiveMode.JUDGMENT,
      );
    }
  });

  it('isDirectReadParam 对全部 borrow 参数返回 false', () => {
    for (const def of PARAM_DEFS.filter((d) => d.grp === 'borrow')) {
      expect(isDirectReadParam(def.key), `${def.key} 不得直读`).toBe(false);
    }
  });

  it('只有 read-immediate 类参数直读（security / preview）', () => {
    for (const def of PARAM_DEFS) {
      const expected = DIRECT_READ_MODES.includes(def.effectiveMode);
      expect(isDirectReadParam(def.key), `${def.key} 直读判定不符`).toBe(expected);
    }
    const directKeys = PARAM_DEFS.filter((d) => isDirectReadParam(d.key)).map((d) => d.key);
    for (const key of directKeys) {
      const def = PARAM_DEFS.find((d) => d.key === key) as ParamDef;
      expect(['security', 'preview'], `${key} 不属于允许直读的分组`).toContain(def.grp);
    }
  });

  it('未登记 key 按最保守处理：直读（宁可慢，不可读到陈旧安全参数）', () => {
    expect(isDirectReadParam('not.registered.key')).toBe(true);
  });
});

describe('assertParamDefs 拦截误配：把 borrow 改成直读必须抛错', () => {
  it('borrow + read-immediate → 抛 ParamDefConfigError 且提示 D-1', () => {
    const bad = baseDef({ effectiveMode: ParamEffectiveMode.READ_IMMEDIATE });
    expect(() => assertParamDefs([bad])).toThrow(ParamDefConfigError);
    expect(() => assertParamDefs([bad])).toThrow(/D-1/);
  });

  it('borrow + retention → 同样拒绝（判定生效与存量失效不可混用）', () => {
    const bad = baseDef({ effectiveMode: ParamEffectiveMode.RETENTION });
    expect(() => assertParamDefs([bad])).toThrow(ParamDefConfigError);
  });

  it('security + judgment → 拒绝（安全参数不允许有缓存延迟）', () => {
    const bad = baseDef({ grp: 'security', effectiveMode: ParamEffectiveMode.JUDGMENT });
    expect(() => assertParamDefs([bad])).toThrow(ParamDefConfigError);
  });

  it('key 重复 → 抛错', () => {
    expect(() => assertParamDefs([baseDef(), baseDef()])).toThrow(/重复/);
  });

  it('int 型缺 min/max → 抛错', () => {
    const bad = baseDef({ min: undefined, max: undefined });
    expect(() => assertParamDefs([bad])).toThrow(/min\/max/);
  });

  it('int 型默认值越界 → 抛错', () => {
    expect(() => assertParamDefs([baseDef({ default: '999' })])).toThrow(/不在区间/);
  });

  it('enum 型默认值不在枚举内 → 抛错', () => {
    const bad = baseDef({
      type: 'enum',
      default: 'nope',
      enumValues: ['a', 'b'],
      min: undefined,
      max: undefined,
    });
    expect(() => assertParamDefs([bad])).toThrow(/不在枚举/);
  });
});

describe('PR-P7 固化项：editable=false 必须拒绝修改（含合法值）', () => {
  it('log.retention_years 不可编辑', () => {
    const def = PARAM_DEFS.find((d) => d.key === 'log.retention_years');
    expect(def?.editable).toBe(false);
  });

  it('固化项传入**合法整数**也必须被拒（这是最容易漏的路径）', () => {
    // 曾经的缺陷：validateParamValue 只校验区间，不校验 editable，
    // 于是 `log.retention_years = 5`（本就在 1–10 区间内）会静默通过。
    const r = validateParamValue('log.retention_years', '5');
    expect(r.ok).toBe(false);
    expect(r.reason, '拒绝时必须给出原因，否则管理端无法展示').toContain('固化');
  });

  it('固化项传出厂默认值也被拒（不是「值没变就放行」）', () => {
    expect(validateParamValue('log.retention_years', '3').ok).toBe(false);
  });

  it('内部场景可显式放行（迁移/恢复用 allowFixed）', () => {
    expect(validateParamValue('log.retention_years', '5', { allowFixed: true }).ok).toBe(true);
  });

  it('可编辑参数不受影响', () => {
    expect(validateParamValue('borrow.max_total_days', '90').ok).toBe(true);
  });
});

describe('三层生效分类的映射表完整', () => {
  it('每个 effectiveMode 都有允许分组，且判定集合覆盖全部业务组', () => {
    const covered = new Set(Object.values(EFFECTIVE_MODE_ALLOWED_GROUPS).flat());
    for (const def of PARAM_DEFS) {
      expect(covered.has(def.grp), `${def.grp} 未出现在任何 effectiveMode 的允许分组中`).toBe(
        true,
      );
    }
  });

  it('判定生效组只含会导致「在途单据判定变化」的参数域', () => {
    expect(EFFECTIVE_MODE_ALLOWED_GROUPS[ParamEffectiveMode.JUDGMENT]).toEqual([
      'borrow',
      'search',
      'extract',
    ]);
  });
});
