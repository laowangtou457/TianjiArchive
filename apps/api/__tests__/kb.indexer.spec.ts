/**
 * 片段索引器（KbIndexer）单测。
 *
 * 守的是三条容易出事的性质：
 *   ① **正文来源口径**：优先 `document_text`（抽取器权威产物），无则回退 `full_text`；
 *   ② **密级只从条目取**：片段密级必须等于 `archive_item.security_level`，
 *      切块器绝不参与密级判断（否则越权来源就是切块器）；
 *   ③ **幂等**：重建 = 先删后插，PG 与 ES 两侧都要清干净，不能叠加。
 */
import { describe, expect, it, vi } from 'vitest';
import { SecurityLevel } from '@tianji/shared';
import { KbIndexer } from '@api/modules/kb/kb.indexer';

interface ItemRow {
  id: string;
  danghao: string;
  security_level: string;
  fonds_id: string | null;
  created_by: string | null;
  deleted: boolean;
  item_full_text: string | null;
  doc_text: string | null;
}

function makeHarness(item?: Partial<ItemRow>) {
  const row: ItemRow | null = item
    ? {
        id: 'i-1',
        danghao: 'A036-2024-BGS-Y-0001-0001',
        security_level: SecurityLevel.INTERNAL,
        fonds_id: 'f-1',
        created_by: 'u-1',
        deleted: false,
        item_full_text: null,
        doc_text: null,
        ...item,
      }
    : null;

  /** 记录执行的 SQL 与参数 */
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  /** 事务内的片段写入 */
  const inserted: Array<{ level: string; chunk: string; chunkNo: number }> = [];
  let deleteCount = 0;

  const tx = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/^\s*DELETE FROM kb_entry/i.test(sql)) {
        deleteCount += 1;
        inserted.length = 0;
      } else if (/INSERT INTO kb_entry/i.test(sql)) {
        inserted.push({ level: String(params[2]), chunk: String(params[3]), chunkNo: Number(params[4]) });
      }
      return [];
    }),
  };

  const dataSource = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM archive_item i\s+WHERE i\.id = \$1/.test(sql)) return row ? [row] : [];
      if (/DELETE FROM kb_entry WHERE item_id = \$1 RETURNING/i.test(sql)) return [{ hit: 1 }];
      if (/count\(\*\)::int AS n FROM kb_entry WHERE item_id/i.test(sql)) return [{ n: inserted.length }];
      if (/count\(\*\)::int AS n FROM kb_entry/i.test(sql)) return [{ n: 12 }];
      if (/SELECT i\.id\s+FROM archive_item i\s+LEFT JOIN LATERAL/i.test(sql)) {
        return [{ id: 'i-1' }, { id: 'i-2' }];
      }
      if (/SELECT i\.id\s+FROM archive_item i\s+WHERE i\.deleted = FALSE/i.test(sql)) {
        return [{ id: 'i-1' }, { id: 'i-3' }];
      }
      return [];
    }),
    transaction: vi.fn(async (fn: (m: unknown) => Promise<void>) => fn(tx)),
  };

  const es = {
    deleteByItem: vi.fn(async () => 3),
    bulkIndex: vi.fn(async (docs: unknown[]) => ({ indexed: docs.length, errors: 0 })),
  };

  const indexer = new KbIndexer(dataSource as never, es as never);
  return { indexer, dataSource, es, tx, calls, inserted, get deleteCount() { return deleteCount; } };
}

describe('KbIndexer —— 正文来源口径', () => {
  it('优先用 document_text（抽取器权威产物）', async () => {
    const h = makeHarness({
      doc_text: '抽取器正文。'.repeat(100),
      item_full_text: '种子回填正文。'.repeat(5),
    });
    await h.indexer.indexItem('i-1');

    const joined = h.inserted.map((x) => x.chunk).join('');
    expect(joined).toContain('抽取器正文');
    expect(joined).not.toContain('种子回填正文');
  });

  it('document_text 为空时回退 archive_item.full_text', async () => {
    const h = makeHarness({ doc_text: null, item_full_text: '只有全文列的历史数据。'.repeat(30) });
    await h.indexer.indexItem('i-1');

    expect(h.inserted.length).toBeGreaterThan(0);
    expect(h.inserted.map((x) => x.chunk).join('')).toContain('只有全文列的历史数据');
  });

  it('两处正文都为空 → 不写片段，并清掉旧片段（ES 同样清）', async () => {
    const h = makeHarness({ doc_text: '   ', item_full_text: '' });
    const n = await h.indexer.indexItem('i-1');

    expect(n).toBe(0);
    expect(h.inserted).toHaveLength(0);
    expect(h.es.deleteByItem).toHaveBeenCalledWith('i-1');
  });

  it('条目不存在（已硬删）→ 走 purge，返回 0', async () => {
    const h = makeHarness();
    const n = await h.indexer.indexItem('i-404');

    expect(n).toBe(0);
    expect(h.es.deleteByItem).toHaveBeenCalledWith('i-404');
  });
});

describe('KbIndexer —— 密级与幂等', () => {
  it('片段密级恒等于条目密级（不由文本推断）', async () => {
    const h = makeHarness({ security_level: SecurityLevel.SECRET, doc_text: '机密正文。'.repeat(60) });
    await h.indexer.indexItem('i-1');

    expect(h.inserted.length).toBeGreaterThan(0);
    for (const c of h.inserted) expect(c.level).toBe(SecurityLevel.SECRET);
  });

  it('重建 = 先删后插（每次重建都执行一次 DELETE）', async () => {
    const h = makeHarness({ doc_text: '正文内容。'.repeat(60) });
    await h.indexer.indexItem('i-1');
    const first = h.inserted.length;
    await h.indexer.indexItem('i-1');

    expect(h.deleteCount).toBe(2);
    expect(h.inserted.length).toBe(first); // 不叠加
  });

  it('片段序号连续且从 0 起（供引用定位"第几段"）', async () => {
    const h = makeHarness({ doc_text: '关于档案工作的说明。'.repeat(200) });
    await h.indexer.indexItem('i-1');

    expect(h.inserted.length).toBeGreaterThan(1);
    expect(h.inserted.map((x) => x.chunkNo)).toEqual(h.inserted.map((_, i) => i));
  });

  it('ES 文档 id 形如 itemId:chunkNo（幂等 upsert，不产生重复文档）', async () => {
    const h = makeHarness({ doc_text: '正文。'.repeat(50) });
    await h.indexer.indexItem('i-1');

    const docs = h.es.bulkIndex.mock.calls[0]?.[0] as Array<{ id: string; itemId: string }>;
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      expect(d.id.startsWith('i-1:')).toBe(true);
      expect(d.itemId).toBe('i-1');
    }
    // ES 侧先清旧片段，再写新片段
    expect(h.es.deleteByItem).toHaveBeenCalledWith('i-1');
  });
});

describe('KbIndexer —— 批量与陈旧判定', () => {
  it('单条失败不中断整批（计入 failed）', async () => {
    const h = makeHarness({ doc_text: '正文。'.repeat(20) });
    const spy = vi
      .spyOn(h.indexer, 'indexItem')
      .mockResolvedValueOnce(2)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(1);

    const r = await h.indexer.indexItems(['a', 'b', 'c']);
    expect(r).toEqual({ items: 2, chunks: 3, failed: 1 });
    spy.mockRestore();
  });

  it('陈旧判定覆盖"无片段"与"密级不一致"，且排除软删除条目', async () => {
    const h = makeHarness();
    const ids = await h.indexer.findStaleItemIds(50);

    expect(ids).toEqual(['i-1', 'i-2']);
    const sql = h.calls.at(-1)?.sql ?? '';
    expect(sql).toContain('IS DISTINCT FROM'); // 密级不一致
    expect(sql).toContain('i.deleted = FALSE'); // 排除软删除
    expect(sql).toContain('document_text'); // 有正文才算
  });

  it('全量清单只取未删除且有正文的条目', async () => {
    const h = makeHarness();
    expect(await h.indexer.listAllItemIdsWithText()).toEqual(['i-1', 'i-3']);
  });

  it('countChunks 返回索引规模（供 /api/kb/status）', async () => {
    const h = makeHarness();
    expect(await h.indexer.countChunks()).toBe(12);
  });
});
