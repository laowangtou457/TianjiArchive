/**
 * 压测自死锁缺陷 #11 防回归（联调现场实证：CONCURRENCY=200 × ROUNDS=10
 * 挂起 18 分钟，pg_stat_activity 20 会话 idle in transaction /
 * last query START TRANSACTION / ClientRead）。
 *
 * 死锁机理：bench 每个任务经 AppDataSource.transaction 持有**一条**池连接，
 * 而档号生成内部的规则解析（resolveRule / firstOrgCode）走**全局** repository，
 * 需申请**第二条**池连接——并发 > 池上限时，前 N 个任务持连接等连接、其余
 * 任务等第一条连接，全体互等 = 客户端自死锁（非数据库行锁等待）。
 *
 * 修复（rule.service.ts）：generate 路径的规则/机构读取全部改经事务 manager
 * （resolveRule / firstOrgCode 新增可选 manager 参数），单连接完成。
 *
 * 本 spec 的两个守卫面：
 *   ① 生成路径**绝不触碰全局 repository**（全局 repo 桩一碰即炸，测试仍
 *      能通过 = 不再二次取连接，并发 > 池上限场景不可能再自死锁）；
 *   ② 看门狗（danghao-bench-watchdog）：到点必触发、撤防必不触发、
 *      恰好一次——「工具不喊疼」家族的第二道防线。
 */
import { describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import { DanghaoRuleService } from '@api/modules/danghao/rule.service';
import { DanghaoSequenceService } from '@api/modules/danghao/sequence.service';
import { DanghaoRule } from '@api/infra/database/entities/danghao-rule.entity';
import { OrgNode } from '@api/infra/database/entities/org-node.entity';
import { Fonds } from '@api/infra/database/entities/fonds.entity';
import { Category } from '@api/infra/database/entities/category.entity';
import { Retention } from '@tianji/shared';
import { armWatchdog, type WatchdogTimer } from '@api/scripts/danghao-bench-watchdog';

/** 全局 repository 桩：任何读取都视为「二次取连接」直接炸（缺陷 #11 的探测针） */
function makeGlobalRepoProbe<T>(name: string): T {
  return {
    findOne: () => {
      throw new Error(`GLOBAL_REPO_TOUCHED:${name}（生成路径禁止申请第二条池连接）`);
    },
  } as unknown as T;
}

/** 规则行：YEAR + VOLUME + ITEM 三段（含卷级段，preview 的卷级模板才合法） */
const ITEM_RULE_ROW = {
  id: 'rule-1',
  fondsId: 'fonds-1',
  categoryId: null,
  segments: [
    { type: 'YEAR', pad: 4 },
    { type: 'VOLUME', pad: 4 },
    { type: 'ITEM', pad: 4 },
  ],
  separator: '-',
  resetCycle: 'YEAR',
  zeroPad: 4,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

/** 规则行：YEAR + VOLUME 两段（无 ITEM，卷级模板） */
const VOLUME_RULE_ROW = {
  ...ITEM_RULE_ROW,
  id: 'rule-2',
  segments: [
    { type: 'YEAR', pad: 4 },
    { type: 'VOLUME', pad: 4 },
  ],
};

/** 事务 manager 桩：规则/机构读走 getRepository，序列走 query（打的是 manager，不是全局连接） */
function makeManagerStub(ruleRow: typeof ITEM_RULE_ROW) {
  const getRepositoryCalls: string[] = [];
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === DanghaoRule) {
        getRepositoryCalls.push('DanghaoRule');
        return { findOne: async () => ruleRow };
      }
      if (entity === OrgNode) {
        getRepositoryCalls.push('OrgNode');
        return { findOne: async () => ({ code: 'BGS' }) };
      }
      throw new Error(`manager.getRepository 未模拟的实体: ${String(entity)}`);
    },
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO danghao_sequence')) return [];
      if (normalized.startsWith('UPDATE danghao_sequence')) return [{ next_value: '1' }];
      throw new Error(`manager.query 未模拟的 SQL: ${normalized}`);
    },
  } as unknown as EntityManager;
  return { manager, getRepositoryCalls };
}

function makeRuleService() {
  const globalRuleRepo = makeGlobalRepoProbe<typeof DanghaoRule>('ruleRepo');
  const globalOrgRepo = makeGlobalRepoProbe<typeof OrgNode>('orgRepo');
  const seqService = new DanghaoSequenceService({} as DataSource);
  const service = new DanghaoRuleService(
    globalRuleRepo as never,
    makeGlobalRepoProbe<typeof Fonds>('fondsRepo') as never,
    globalOrgRepo as never,
    makeGlobalRepoProbe<typeof Category>('categoryRepo') as never,
    seqService,
  );
  return { service, globalRuleRepo, globalOrgRepo, seqService };
}

// ============================================================================
describe('缺陷 #11 防回归：档号生成路径单连接化（并发 > 池上限不再自死锁）', () => {
  it('generateItemDanghao：规则/机构读全部经事务 manager，全局 repo 零触碰', async () => {
    const { service, globalRuleRepo, globalOrgRepo } = makeRuleService();
    const { manager, getRepositoryCalls } = makeManagerStub(ITEM_RULE_ROW);

    const result = await service.generateItemDanghao(manager, {
      fondsId: 'fonds-1',
      fondsNo: 'A036',
      categoryId: null,
      year: 2026,
      retention: Retention.PERM,
    });

    // 全局 repo 的探测针从未触发（触发了上面早就抛错使本用例红）
    expect(globalRuleRepo.findOne).toBeDefined();
    expect(globalOrgRepo.findOne).toBeDefined();
    // 且 manager 侧确实发生了规则 + 机构两次读取（正向证据，防空转：
    // 若实现改成「什么都不读」，本断言会红）
    expect(getRepositoryCalls).toContain('DanghaoRule');
    expect(getRepositoryCalls).toContain('OrgNode');
    // 末段 ITEM 序号取到 1（卷号同样经序列取 1），档号可解析（2026-0001-0001）
    expect(result.itemNo).toBe(1);
    expect(result.volumeNo).toBe(1);
    expect(result.danghao).toBe('2026-0001-0001');
  });

  it('generateVolumeDanghao：同样单连接化，卷号取到 1', async () => {
    const { service, globalRuleRepo } = makeRuleService();
    const { manager, getRepositoryCalls } = makeManagerStub(VOLUME_RULE_ROW);

    const result = await service.generateVolumeDanghao(manager, {
      fondsId: 'fonds-1',
      fondsNo: 'A036',
      categoryId: null,
      year: 2026,
      retention: Retention.PERM,
    });

    expect(globalRuleRepo.findOne).toBeDefined();
    expect(getRepositoryCalls).toContain('DanghaoRule');
    expect(getRepositoryCalls).toContain('OrgNode');
    expect(result.volumeNo).toBe(1);
    expect(result.danghao).toBe('2026-0001');
  });

  it('非事务路径（preview）保持全局 repo 语义不回归（向后兼容）', async () => {
    // preview 不在事务内，resolveRule 不传 manager → 仍走构造器注入的全局 repo
    const globalRuleRepo = { findOne: async () => ITEM_RULE_ROW };
    const fondsRepo = { findOne: async () => ({ fondsNo: 'A036' }) };
    const orgRepo = { findOne: async () => ({ code: 'BGS' }) };
    const seqService = new DanghaoSequenceService({
      query: async () => [], // peek：表内无行 → 1
    } as never);
    const service = new DanghaoRuleService(
      globalRuleRepo as never,
      fondsRepo as never,
      orgRepo as never,
      makeGlobalRepoProbe<typeof Category>('categoryRepo') as never,
      seqService,
    );

    const preview = await service.preview({
      fondsId: 'fonds-1',
      year: 2026,
      count: 2,
    });

    expect(preview.itemDanghaos).toHaveLength(2);
    expect(preview.itemDanghaos[0]).toBe('2026-0001-0001');
  });
});

// ============================================================================
describe('轮级看门狗（工具不喊疼家族第二道防线）', () => {
  /** 假定时器：记录回调，由测试手动 fire（确定性，不依赖真实计时） */
  function makeFakeTimer() {
    let pending: (() => void) | null = null;
    const timer: WatchdogTimer = {
      set: (cb) => {
        pending = cb;
        return { handle: 1 };
      },
      clear: () => {
        pending = null;
      },
    };
    return {
      timer,
      fire: () => {
        const cb = pending;
        pending = null;
        cb?.();
      },
      isPending: () => pending !== null,
    };
  }

  it('未撤防：到点恰好触发一次（重复 fire 不重复喊疼）', () => {
    const fake = makeFakeTimer();
    const onTimeout = vi.fn();
    armWatchdog(60_000, onTimeout, fake.timer);

    expect(fake.isPending()).toBe(true);
    fake.fire();
    fake.fire(); // 到点后的事件源若重复触发，也只喊一次
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('撤防后：到点绝不触发', () => {
    const fake = makeFakeTimer();
    const onTimeout = vi.fn();
    const disarm = armWatchdog(60_000, onTimeout, fake.timer);

    disarm();
    fake.fire();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('撤防幂等：重复撤防不抛错、不影响结果', () => {
    const fake = makeFakeTimer();
    const onTimeout = vi.fn();
    const disarm = armWatchdog(60_000, onTimeout, fake.timer);

    disarm();
    disarm();
    expect(() => disarm()).not.toThrow();
    fake.fire();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
