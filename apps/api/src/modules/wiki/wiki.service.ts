import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  type PermissionSnapshot,
  type WikiRelationDto,
  type WikiSummaryDto,
  type WikiTopicDto,
} from '@tianji/shared';
import { ItemRelation } from '../../infra/database/entities/item-relation.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { LlmGateway } from '../rag/embedding.provider';

/** 允许的关联类型（与实体注释一致，避免前端传任意值） */
const RELATION_TYPES = ['RELATED', 'SERIES', 'CITES', 'SAME_DOC'] as const;
type RelationType = (typeof RELATION_TYPES)[number];

/**
 * 档案知识组织（LLM Wiki，P4 预留接口之三）。
 *
 * ## 它不是「又一个检索」
 *
 * 检索是「找得到」，Wiki 是「连得起来、说得清」：
 *   - 关联（relations）：同主题/同卷/引用关系，形成档案之间的知识网；
 *   - 主题聚合（topics）：按主题词看馆藏分布，支撑编研选题；
 *   - 摘要（summary）：把条目元数据 + 首段正文压成 2-3 句，供目录浏览。
 *
 * ## 权限铁律
 *
 * 关联与摘要**必须**先过 AccessFilterBuilder.canAccessRecord：
 * 「这件档案存在」本身也是敏感信息（涉密档案的存在性不能泄露给无权用户）。
 * 因此无权时返回 404 而不是 403（403 等于确认存在）。
 *
 * ## 生成能力可缺省
 *
 * 摘要优先用 LLM；模型不可用时退化为「元数据拼装式摘要」（档号+题名+年度+责任者+
 * 主题词），并在 degraded=true 中标明 —— 宁可给出朴素但真实的描述，也不编造。
 */
@Injectable()
export class WikiService {
  private readonly logger = new Logger(WikiService.name);

  constructor(
    @InjectRepository(ItemRelation) private readonly relationRepo: Repository<ItemRelation>,
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    private readonly accessFilter: AccessFilterBuilder,
    private readonly llm: LlmGateway,
  ) {}

  // ==========================================================================
  // 关联
  // ==========================================================================

  public async listRelations(itemId: string, user: PermissionSnapshot): Promise<WikiRelationDto[]> {
    const item = await this.requireAccessible(itemId, user);
    const rows = await this.relationRepo.find({
      where: [{ sourceItemId: item.id }, { targetItemId: item.id }],
      order: { weight: 'DESC', createdAt: 'DESC' },
      take: 100,
    });
    const otherIds = rows.map((r) => (r.sourceItemId === item.id ? r.targetItemId : r.sourceItemId));
    const others = otherIds.length
      ? await this.itemRepo.find({ where: { id: In(otherIds), deleted: false } })
      : [];
    const map = new Map(others.map((o) => [o.id, o]));

    // 过滤掉「关得到但看不到」的对端：无权档案不出现在关联里
    return rows
      .map((r): WikiRelationDto | null => {
        const otherId = r.sourceItemId === item.id ? r.targetItemId : r.sourceItemId;
        const other = map.get(otherId);
        if (!other) return null;
        if (!this.accessFilter.canAccessRecord(user, other)) return null;
        return {
          id: r.id,
          sourceItemId: r.sourceItemId,
          targetItemId: r.targetItemId,
          targetDanghao: other.danghao,
          targetTitle: other.title,
          relationType: r.relationType,
          weight: r.weight,
          source: r.source as 'AUTO' | 'MANUAL',
          createdAt: r.createdAt.toISOString(),
        } satisfies WikiRelationDto;
      })
      .filter((x): x is WikiRelationDto => x !== null);
  }

  public async addRelation(
    sourceItemId: string,
    targetItemId: string,
    relationType: string,
    user: PermissionSnapshot,
  ): Promise<WikiRelationDto> {
    if (sourceItemId === targetItemId) {
      throw new BizException(ErrorCode.BAD_REQUEST, '不能与自身建立关联');
    }
    if (!RELATION_TYPES.includes(relationType as RelationType)) {
      throw new BizException(ErrorCode.BAD_REQUEST, `关联类型必须是 ${RELATION_TYPES.join('/')}`);
    }
    await this.requireAccessible(sourceItemId, user);
    const target = await this.requireAccessible(targetItemId, user);

    const existing = await this.relationRepo.findOne({
      where: { sourceItemId, targetItemId, relationType },
    });
    if (existing) {
      return {
        id: existing.id,
        sourceItemId,
        targetItemId,
        targetDanghao: target.danghao,
        targetTitle: target.title,
        relationType: existing.relationType,
        weight: existing.weight,
        source: existing.source as 'AUTO' | 'MANUAL',
        createdAt: existing.createdAt.toISOString(),
      };
    }
    const row = await this.relationRepo.save(
      this.relationRepo.create({
        sourceItemId,
        targetItemId,
        relationType,
        weight: 1,
        source: 'MANUAL',
        createdBy: user.userId,
      }),
    );
    return {
      id: row.id,
      sourceItemId,
      targetItemId,
      targetDanghao: target.danghao,
      targetTitle: target.title,
      relationType: row.relationType,
      weight: row.weight,
      source: 'MANUAL',
      createdAt: row.createdAt.toISOString(),
    };
  }

  public async removeRelation(id: string, user: PermissionSnapshot): Promise<{ deleted: boolean }> {
    const row = await this.relationRepo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '关联不存在');
    await this.requireAccessible(row.sourceItemId, user);
    await this.relationRepo.delete({ id });
    return { deleted: true };
  }

  /**
   * 自动关联：按「同主题词重合度 + 同案卷」生成 RELATED / SERIES。
   *
   * 只增不删（不清理旧自动关联）：档案主题会演化，上月合理的关联本月仍然合理；
   * 若要清理，由人工删除（source=MANUAL 的不会被自动流程覆盖）。
   */
  public async autoLink(itemId: string, user: PermissionSnapshot): Promise<{ created: number }> {
    const item = await this.requireAccessible(itemId, user);
    const keywords = Array.isArray(item.keywords) ? item.keywords.filter(Boolean) : [];
    const candidates = new Map<string, number>();

    if (keywords.length > 0) {
      const rows: Array<{ id: string; overlap: string }> = await this.itemRepo.query(
        `SELECT i.id, COUNT(*)::text AS overlap
           FROM archive_item i, unnest(i.keywords) kw
          WHERE i.deleted = FALSE AND i.id <> $1
            AND kw = ANY($2::text[])
            AND i.security_level = ANY($3::varchar[])
          GROUP BY i.id
          HAVING COUNT(*) >= 1
          ORDER BY COUNT(*) DESC
          LIMIT 10`,
        [item.id, keywords, this.levelsFor(user)],
      );
      for (const r of rows) candidates.set(r.id, Number.parseInt(r.overlap, 10));
    }

    if (item.volumeId) {
      const siblings: Array<{ id: string }> = await this.itemRepo.query(
        `SELECT id FROM archive_item
          WHERE volume_id = $1 AND id <> $2 AND deleted = FALSE
            AND security_level = ANY($3::varchar[])
          ORDER BY danghao LIMIT 5`,
        [item.volumeId, item.id, this.levelsFor(user)],
      );
      for (const s of siblings) {
        if (!candidates.has(s.id)) candidates.set(s.id, 0);
      }
    }

    let created = 0;
    for (const [otherId, overlap] of candidates) {
      const weight = Math.min(1, 0.4 + overlap * 0.15);
      const type: RelationType = overlap > 0 ? 'RELATED' : 'SERIES';
      const res = await this.relationRepo
        .createQueryBuilder()
        .insert()
        .values({
          sourceItemId: item.id,
          targetItemId: otherId,
          relationType: type,
          weight,
          source: 'AUTO',
          createdBy: user.userId,
        })
        .orIgnore()
        .execute();
      created += res.identifiers.length;
    }
    this.logger.log(`条目 ${item.danghao} 自动关联 ${created} 条`);
    return { created };
  }

  // ==========================================================================
  // 主题聚合
  // ==========================================================================

  /**
   * 主题词聚合（供编研选题/馆藏分布）。
   *
   * 只统计「当前用户有权访问」的条目：主题词数量本身会泄露馆藏结构，
   * 因此过滤条件与检索一致（密级 + 全宗范围），不是全库裸统计。
   */
  public async topics(
    limit: number,
    user: PermissionSnapshot,
    keyword?: string,
  ): Promise<WikiTopicDto[]> {
    // keyword 存在时占 $1，过滤条件从 $2 起；否则从 $1 起
    // （PG 不接受「跳过占位符」，起点算错会直接报 bind 参数数量不符）
    const filter = this.accessFilter.buildSql(user, 'i', { startIndex: keyword ? 2 : 1 });
    const rows: Array<{ kw: string; c: string; titles: string[] }> = await this.itemRepo.query(
      `SELECT kw, COUNT(*)::text AS c, (ARRAY_AGG(i.title ORDER BY i.year DESC))[1:3] AS titles
         FROM archive_item i, unnest(i.keywords) kw
        WHERE ${filter.clause}
          ${keyword ? `AND kw ILIKE $1` : ``}
        GROUP BY kw
        ORDER BY COUNT(*) DESC
        LIMIT ${Math.min(200, Math.max(1, limit))}`,
      keyword ? [`%${keyword}%`, ...filter.params] : filter.params,
    );
    return rows.map((r) => ({
      keyword: r.kw,
      count: Number.parseInt(r.c, 10),
      sampleTitles: r.titles ?? [],
    }));
  }

  // ==========================================================================
  // 摘要
  // ==========================================================================

  public async summary(itemId: string, user: PermissionSnapshot): Promise<WikiSummaryDto> {
    const item = await this.requireAccessible(itemId, user);
    const keywords = Array.isArray(item.keywords) ? item.keywords : [];

    // 取该条目的首段正文（若有），作为摘要的事实依据
    const chunkRows: Array<{ content: string }> = await this.itemRepo.query(
      `SELECT content FROM item_chunk WHERE item_id = $1 AND deleted = FALSE ORDER BY chunk_no LIMIT 2`,
      [item.id],
    );
    const excerpt = chunkRows.map((c) => c.content).join('\n').slice(0, 1500);

    const fallback = [
      `《${item.title}》`,
      `档号 ${item.danghao}`,
      `${item.year} 年形成`,
      item.responsible ? `责任者：${item.responsible}` : null,
      keywords.length ? `主题词：${keywords.join('、')}` : null,
      item.note ? `备注：${item.note.slice(0, 120)}` : null,
    ]
      .filter(Boolean)
      .join('；');

    try {
      const ok = await this.llm.available();
      if (!ok) {
        return {
          itemId: item.id,
          summary: `${fallback}。（生成模型不可用，以上为元数据摘要）`,
          keywords,
          degraded: true,
          model: null,
        };
      }
      const text = await this.llm.chat(
        '你是档案编研助手。根据给出的档案元数据与正文节选，写 2-3 句客观摘要，' +
          '说明这份档案「是什么、涉及谁、讲了什么」。禁止推测未出现的信息，不要使用第一人称。',
        `档号：${item.danghao}\n题名：${item.title}\n年度：${item.year}\n` +
          `责任者：${item.responsible ?? '未著录'}\n主题词：${keywords.join('、') || '无'}\n` +
          `正文节选：${excerpt || '（无全文，仅有元数据）'}`,
      );
      if (text) {
        return { itemId: item.id, summary: text, keywords, degraded: false, model: this.llm.model };
      }
    } catch (err) {
      this.logger.warn(`摘要生成失败，使用元数据摘要：${(err as Error).message}`);
    }
    return {
      itemId: item.id,
      summary: `${fallback}。（生成失败，以上为元数据摘要）`,
      keywords,
      degraded: true,
      model: null,
    };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 取条目并做行级校验；无权按「不存在」处理（不泄露存在性） */
  private async requireAccessible(itemId: string, user: PermissionSnapshot): Promise<ArchiveItem> {
    const item = await this.itemRepo.findOne({ where: { id: itemId } });
    if (!item || !this.accessFilter.canAccessRecord(user, item)) {
      throw new BizException(ErrorCode.NOT_FOUND, '档案不存在或无权访问');
    }
    return item;
  }

  /** 当前用户可见密级（SQL IN 过滤用；空数组表示无任何可见密级） */
  private levelsFor(user: PermissionSnapshot): string[] {
    const order = ['PUBLIC', 'INTERNAL', 'SECRET'];
    const max = order.indexOf(user.maxSecurityLevel);
    if (max < 0) return [];
    return order.slice(0, max + 1);
  }
}
