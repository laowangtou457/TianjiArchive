import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BizException, ErrorCode, type SearchSynonymDto } from '@tianji/shared';
import { SearchSynonym } from '../../infra/database/entities/search-synonym.entity';

/**
 * 同义词组管理 + 检索期扩展。
 *
 * ## 为什么扩展放在查询期而不是索引期
 *
 * ES 的索引期同义词（synonym filter）要改分析器设置，必须关索引或重建，
 * 归档系统不能为改一条同义词停机；查询期扩展则**保存即生效**，改完马上能验。
 * 代价是每次查询多一次内存查表（已缓存），相对 ES 往返可忽略。
 *
 * ## 缓存口径
 *
 * 组表极小（几十条），进程内缓存 30s；写操作清本实例缓存。多实例部署下
 * 其他实例最多 30s 后生效——同义词是低频配置，这个延迟可接受，
 * 用 Redis pub/sub 换 30s 的实时性不值得（且会让配置变更依赖缓存中间件可用）。
 */
@Injectable()
export class SynonymService {
  private readonly logger = new Logger(SynonymService.name);

  private cache: { groups: string[][]; at: number } | null = null;
  private static readonly CACHE_TTL_MS = 30_000;
  /** 单次查询最多扩展词数：过多会让 bool 查询膨胀、把精确命中稀释掉 */
  private static readonly MAX_EXPAND = 8;

  constructor(
    @InjectRepository(SearchSynonym) private readonly repo: Repository<SearchSynonym>,
  ) {}

  // ==========================================================================
  // 管理
  // ==========================================================================

  public async list(): Promise<SearchSynonymDto[]> {
    const rows = await this.repo.find({ order: { createdAt: 'DESC' } });
    return rows.map((r) => this.toDto(r));
  }

  public async create(words: string[], note: string | null, userId: string | null): Promise<SearchSynonymDto> {
    const normalized = this.normalize(words);
    await this.assertNotOverlap(normalized, null);
    const row = await this.repo.save(
      this.repo.create({ words: normalized, note: note?.trim() || null, createdBy: userId }),
    );
    this.invalidate();
    return this.toDto(row);
  }

  public async update(
    id: string,
    patch: { words?: string[]; note?: string | null; enabled?: boolean },
  ): Promise<SearchSynonymDto> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '同义词组不存在');
    if (patch.words !== undefined) {
      const normalized = this.normalize(patch.words);
      await this.assertNotOverlap(normalized, id);
      row.words = normalized;
    }
    if (patch.note !== undefined) row.note = patch.note?.trim() || null;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    const saved = await this.repo.save(row);
    this.invalidate();
    return this.toDto(saved);
  }

  public async remove(id: string): Promise<{ deleted: boolean }> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '同义词组不存在');
    await this.repo.delete({ id });
    this.invalidate();
    return { deleted: true };
  }

  // ==========================================================================
  // 检索期扩展
  // ==========================================================================

  /**
   * 取与 query 相关的**扩展词**（不含 query 里已出现的词）。
   *
   * 匹配规则：query 里包含组内任一词即整组触发。中文没有词边界，
   * 用「包含」比「等于」更贴合实际输入（用户常输入「卷宗整理办法」）。
   * 组内词按长度降序匹配，避免短词「档」误触发。
   */
  public async expand(query: string): Promise<string[]> {
    const q = (query ?? '').trim();
    if (q.length === 0) return [];
    const groups = await this.loadGroups();
    const out: string[] = [];
    for (const words of groups) {
      const hit = words.some((w) => w.length >= 2 && q.includes(w));
      if (!hit) continue;
      for (const w of words) {
        if (w.length < 2) continue;
        if (q.includes(w)) continue; // 已出现在原查询里就不重复扩展
        if (!out.includes(w)) out.push(w);
      }
    }
    return out.slice(0, SynonymService.MAX_EXPAND);
  }

  private async loadGroups(): Promise<string[][]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < SynonymService.CACHE_TTL_MS) {
      return this.cache.groups;
    }
    try {
      const rows = await this.repo.find({ where: { enabled: true }, select: ['words'] });
      const groups = rows.map((r) => (Array.isArray(r.words) ? r.words : []));
      this.cache = { groups, at: now };
      return groups;
    } catch (err) {
      this.logger.warn(`同义词加载失败（本次不做扩展）: ${(err as Error).message}`);
      // 加载失败不阻断检索：退化为「无同义词」，仍能按原词召回
      return this.cache?.groups ?? [];
    }
  }

  /** 写操作后清缓存（本实例即时生效） */
  private invalidate(): void {
    this.cache = null;
  }

  // ==========================================================================
  // 校验与转换
  // ==========================================================================

  /** 词表规范化：去空白、去重、长度约束、至少 2 个词 */
  private normalize(words: string[]): string[] {
    const cleaned = (Array.isArray(words) ? words : [])
      .map((w) => String(w ?? '').trim())
      .filter(Boolean);
    const unique = [...new Set(cleaned)];
    if (unique.length < 2) {
      throw new BizException(ErrorCode.BAD_REQUEST, '同义词组至少需要 2 个不同的词');
    }
    if (unique.length > 20) {
      throw new BizException(ErrorCode.BAD_REQUEST, '同一组最多 20 个词');
    }
    const tooLong = unique.filter((w) => w.length > 64);
    if (tooLong.length > 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, `词长不得超过 64 字：${tooLong[0]}`);
    }
    return unique;
  }

  /**
   * 禁止两组共享同一个词。
   *
   * 共享会让扩展产生歧义（A 组说 AB 等价、B 组说 AC 等价，那 B 和 C 到底等价吗？），
   * 与其让检索结果变得不可解释，不如在保存时挡住并提示合并成一组。
   */
  private async assertNotOverlap(words: string[], excludeId: string | null): Promise<void> {
    const all = await this.repo.find({ select: ['id', 'words'] });
    for (const row of all) {
      if (excludeId && row.id === excludeId) continue;
      const shared = (row.words ?? []).filter((w) => words.includes(w));
      if (shared.length > 0) {
        throw new BizException(
          ErrorCode.BAD_REQUEST,
          `词「${shared[0]}」已存在于另一同义词组，请合并为一组后再保存`,
        );
      }
    }
  }

  private toDto(r: SearchSynonym): SearchSynonymDto {
    return {
      id: r.id,
      words: r.words ?? [],
      note: r.note,
      enabled: r.enabled,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }
}
