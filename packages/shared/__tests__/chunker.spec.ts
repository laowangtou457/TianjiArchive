/**
 * 文本切块（chunker）单测。
 *
 * 这些断言守的是检索质量的**地基**：片段超长会让相似度坍缩成整篇均值，
 * 切口断在词中会让片段读起来像乱码，重叠缺失会让答案正好落在接缝上。
 * 因此这里按"性质"断言，而不是逐字符比对固定期望值。
 */
import { describe, expect, it } from 'vitest';
import { chunkText, normalizeText, DEFAULT_CHUNK_OPTIONS } from '../src/chunker';

const { max, overlap } = DEFAULT_CHUNK_OPTIONS;

/** 生成长度可控的中文正文（按句号分句） */
function cnText(sentences: number, perSentence = 40): string {
  return Array.from({ length: sentences }, (_, i) => {
    const body = `第${i + 1}句：` + '关于档案数字化工作的说明'.repeat(4).slice(0, perSentence - 6);
    return `${body}。`;
  }).join('');
}

describe('chunkText —— 边界与空值', () => {
  it('空串 / 纯空白 / undefined 一律返回空数组', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n\t ')).toEqual([]);
    expect(chunkText(undefined as unknown as string)).toEqual([]);
  });

  it('短文本整段成一片，序号从 0 起', () => {
    const r = chunkText('关于年度工作的报告。');
    expect(r).toHaveLength(1);
    expect(r[0].chunkNo).toBe(0);
    expect(r[0].text).toBe('关于年度工作的报告。');
    expect(r[0].charLen).toBe(r[0].text.length);
  });

  it('恰好等于上限的文本仍是一片', () => {
    const r = chunkText('档'.repeat(max));
    expect(r).toHaveLength(1);
    expect(r[0].charLen).toBe(max);
  });
});

describe('chunkText —— 长度约束（超长片段会让相似度坍缩）', () => {
  it('长中文正文：每片都不超过 max', () => {
    const r = chunkText(cnText(40));
    expect(r.length).toBeGreaterThan(1);
    for (const c of r) expect(c.charLen).toBeLessThanOrEqual(max);
  });

  it('完全无标点的超长文本也必须切开且不超上限', () => {
    const r = chunkText('无标点文本'.repeat(300));
    expect(r.length).toBeGreaterThan(1);
    for (const c of r) expect(c.charLen).toBeLessThanOrEqual(max);
  });

  it('极端小上限（max=10）不崩、不超限、能终止', () => {
    const r = chunkText('abcdefghijklmnopqrstuvwxyz'.repeat(5), { max: 10, target: 8, min: 4, overlap: 2 });
    expect(r.length).toBeGreaterThan(1);
    for (const c of r) expect(c.charLen).toBeLessThanOrEqual(10);
  });

  it('所有片段均非空（空片段进索引等于噪声）', () => {
    const r = chunkText(cnText(30));
    for (const c of r) expect(c.text.length).toBeGreaterThan(0);
  });
});

describe('chunkText —— 句读优先与英文不切词', () => {
  it('能在句末标点处断开时，片段以标点结尾', () => {
    const r = chunkText(cnText(30));
    // 除最后一片外，其余均应在句读处收尾（允许少数因超长硬切的例外）
    const endedWithPunct = r.slice(0, -1).filter((c) => /[。！？；…]$/.test(c.text)).length;
    expect(endedWithPunct).toBeGreaterThanOrEqual(r.length - 2);
  });

  it('硬切英文长串时不把单词劈成两半', () => {
    const words = Array.from({ length: 200 }, () => 'archive').join(' ');
    const r = chunkText(words, { max: 80, target: 60, min: 30, overlap: 10 });
    expect(r.length).toBeGreaterThan(2);
    // 只断言"切口"：片尾若落在字母串上，该串必须是完整单词（不能是 archiv/chiv 这类残片）
    for (const c of r.slice(0, -1)) {
      const tail = /([A-Za-z]+)$/.exec(c.text);
      if (tail) expect(tail[1]).toBe('archive');
    }
  });

  it('换行视为可断点（段落边界优先）', () => {
    const text = '第一段'.repeat(50) + '\n' + '第二段'.repeat(50);
    const r = chunkText(text, { max: 120, target: 100, min: 40, overlap: 10 });
    expect(r.some((c) => c.text.includes('\n'))).toBe(true);
  });
});

describe('chunkText —— 重叠与覆盖', () => {
  it('相邻片段按 overlap 精确回退（下一片以 上一片末尾 overlap 字符 开头）', () => {
    const r = chunkText(cnText(40));
    expect(r.length).toBeGreaterThan(2);
    for (let i = 0; i < r.length - 1; i += 1) {
      expect(r[i].charLen).toBeGreaterThan(overlap);
      expect(r[i + 1].text.slice(0, overlap)).toBe(r[i].text.slice(-overlap));
    }
  });

  it('首片从文首开始、末片到达文末（不丢内容）', () => {
    const src = cnText(25);
    const normalized = normalizeText(src);
    const r = chunkText(src);
    expect(normalized.startsWith(r[0].text)).toBe(true);
    expect(normalized.endsWith(r[r.length - 1].text)).toBe(true);
  });

  it('确定性：同一输入重复调用结果完全一致（保证重建幂等）', () => {
    const src = cnText(30);
    expect(chunkText(src)).toEqual(chunkText(src));
  });
});

describe('normalizeText', () => {
  it('统一换行、压缩连续空行、去首尾空白', () => {
    expect(normalizeText('a\r\nb\r\n\r\n\r\nc  ')).toBe('a\nb\n\nc');
  });

  it('不破坏中文正文与全角标点', () => {
    expect(normalizeText('  档案。\n管理；  ')).toBe('档案。\n管理；');
  });
});
