import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  SECURITY_LEVEL_RANK,
  type PermissionSnapshot,
  type SecurityLevel,
  type WikiAskCitation,
  type WikiAskResult,
  type WikiPageDto,
  type WikiPageTreeNode,
  type WikiPageVersionDto,
  type WikiSearchHitDto,
  type WikiSpaceDto,
} from '@tianji/shared';
import { WikiChunk } from '../../infra/database/entities/wiki-chunk.entity';
import { WikiPage } from '../../infra/database/entities/wiki-page.entity';
import { WikiPageVersion } from '../../infra/database/entities/wiki-page-version.entity';
import { WikiSpace } from '../../infra/database/entities/wiki-space.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import {
  LlmGateway,
  OllamaEmbeddingProvider,
} from '../rag/embedding.provider';

/** 切片目标长度（字符）：与档案全文库同一量级，nomic-embed 的舒适区 */
const CHUNK_TARGET = 800;
/** 每页保留的版本数上限 */
const MAX_VERSIONS = 50;
/** 问答召回条数 */
const ASK_TOPK = 6;
/** 允许的空间密级 */
const SPACE_LEVELS = ['PUBLIC', 'INTERNAL', 'SECRET'] as const;
type SpaceLevel = (typeof SPACE_LEVELS)[number];

/**
 * 可编辑 Wiki 页面库（知识 Wiki）。
 *
 * ## 与「档案 LLM Wiki」（wiki.service.ts）的分工
 *
 *   - wiki.service：围绕**档案条目**的知识网（关联/主题/摘要），事实来源是档案；
 *   - 本服务：**人写的**知识页面（空间/页面树/版本/回滚），事实来源是编研笔记。
 *
 * ## 权限
 *
 *   - 功能域 WIKI：READ 浏览/提问，WRITE 维护页面与空间；
 *   - 密级：空间级 security_level，无权用户看不到空间的存在（404 语义，同档案）。
 *     页面树的行级过滤按空间密级整树过滤（页面继承空间密级）。
 *
 * ## 生成能力可缺省
 *
 *   - 保存页面时同步切片入 wiki_chunk；嵌入服务不可用时页面照常保存，
 *     chunk 记 embedding 空（is_embedded=false 语义），reindex 时补齐；
 *   - /wiki/pages/ask 先召回后生成，模型不可用退化为「检索摘录」（degraded）。
 */
@Injectable()
export class WikiPagesService {
  private readonly logger = new Logger(WikiPagesService.name);
  /** 运行库是否为 pgvector（首次使用时探测，缓存） */
  private vectorKind: 'PGVECTOR' | 'ARRAY' | null = null;

  constructor(
    @InjectRepository(WikiSpace) private readonly spaceRepo: Repository<WikiSpace>,
    @InjectRepository(WikiPage) private readonly pageRepo: Repository<WikiPage>,
    @InjectRepository(WikiPageVersion) private readonly versionRepo: Repository<WikiPageVersion>,
    @InjectRepository(WikiChunk) private readonly chunkRepo: Repository<WikiChunk>,
    private readonly accessFilter: AccessFilterBuilder,
    private readonly llm: LlmGateway,
    private readonly embedding: OllamaEmbeddingProvider,
  ) {}

  // ==========================================================================
  // 空间
  // ==========================================================================

  public async listSpaces(user: PermissionSnapshot): Promise<WikiSpaceDto[]> {
    const spaces = await this.spaceRepo.find({ where: { deleted: false }, order: { createdAt: 'ASC' } });
    const visible = spaces.filter((s) => this.canAccessSpace(user, s));
    if (visible.length === 0) return [];
    const counts: Array<{ space_id: string; c: string }> = await this.spaceRepo.query(
      `SELECT space_id, COUNT(*)::text AS c FROM wiki_page
        WHERE deleted = FALSE AND space_id = ANY($1::uuid[]) GROUP BY space_id`,
      [visible.map((s) => s.id)],
    );
    const countMap = new Map<string, number>(
      counts.map((r) => [r.space_id, Number.parseInt(r.c, 10)] as [string, number]),
    );
    return visible.map((s) => this.toSpaceDto(s, countMap.get(s.id) ?? 0));
  }

  public async createSpace(
    body: { name: string; description?: string; securityLevel?: string },
    user: PermissionSnapshot,
  ): Promise<WikiSpaceDto> {
    const name = (body.name ?? '').trim();
    if (name.length === 0 || name.length > 100) {
      throw new BizException(ErrorCode.BAD_REQUEST, '空间名称须为 1-100 字符');
    }
    const level = (body.securityLevel ?? 'INTERNAL') as SpaceLevel;
    if (!SPACE_LEVELS.includes(level)) {
      throw new BizException(ErrorCode.BAD_REQUEST, `密级必须是 ${SPACE_LEVELS.join('/')}`);
    }
    const dup = await this.spaceRepo.findOne({ where: { name, deleted: false } });
    if (dup) throw new BizException(ErrorCode.BAD_REQUEST, '同名空间已存在');
    const row = await this.spaceRepo.save(
      this.spaceRepo.create({
        name,
        description: body.description?.trim() || null,
        securityLevel: level,
        createdBy: user.userId,
      }),
    );
    return this.toSpaceDto(row, 0);
  }

  public async updateSpace(
    id: string,
    body: { name?: string; description?: string; securityLevel?: string },
    user: PermissionSnapshot,
  ): Promise<WikiSpaceDto> {
    const space = await this.requireSpace(id, user);
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (name.length === 0 || name.length > 100) {
        throw new BizException(ErrorCode.BAD_REQUEST, '空间名称须为 1-100 字符');
      }
      const dup = await this.spaceRepo.findOne({ where: { name, deleted: false, id: Not(id) } });
      if (dup) throw new BizException(ErrorCode.BAD_REQUEST, '同名空间已存在');
      space.name = name;
    }
    if (body.description !== undefined) space.description = body.description?.trim() || null;
    if (body.securityLevel !== undefined) {
      const level = body.securityLevel as SpaceLevel;
      if (!SPACE_LEVELS.includes(level)) {
        throw new BizException(ErrorCode.BAD_REQUEST, `密级必须是 ${SPACE_LEVELS.join('/')}`);
      }
      // 密级只能升不能降：降级等于把已按高密级管理的页面整体放低门槛
      if (SPACE_LEVELS.indexOf(level) > SPACE_LEVELS.indexOf(space.securityLevel as SpaceLevel)) {
        throw new BizException(ErrorCode.BAD_REQUEST, '空间密级只允许调高（降级需先评估页面内容）');
      }
      space.securityLevel = level;
    }
    await this.spaceRepo.save(space);
    const count = await this.pageRepo.count({ where: { spaceId: space.id, deleted: false } });
    return this.toSpaceDto(space, count);
  }

  public async deleteSpace(id: string, user: PermissionSnapshot): Promise<{ deleted: boolean }> {
    const space = await this.requireSpace(id, user);
    const count = await this.pageRepo.count({ where: { spaceId: space.id, deleted: false } });
    if (count > 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, `空间下仍有 ${count} 个页面，先删除页面`);
    }
    await this.spaceRepo.save({ ...space, deleted: true });
    return { deleted: true };
  }

  // ==========================================================================
  // 页面（树 / 详情 / 增删改）
  // ==========================================================================

  /** 页面树（空间内整树，按 orderNo 排序；无权页面整棵隐去） */
  public async pageTree(spaceId: string, user: PermissionSnapshot): Promise<WikiPageTreeNode[]> {
    const space = await this.requireSpace(spaceId, user);
    const pages = await this.pageRepo.find({
      where: { spaceId: space.id, deleted: false },
      order: { orderNo: 'ASC', createdAt: 'ASC' },
    });
    const userRank = SECURITY_LEVEL_RANK[user.maxSecurityLevel];
    const visible = pages.filter((p) => {
      const r = SECURITY_LEVEL_RANK[p.securityLevel as SecurityLevel];
      return r !== undefined && userRank !== undefined && r <= userRank;
    });
    const nodes = new Map<string, WikiPageTreeNode>(
      visible.map((p) => [p.id, this.toTreeNode(p)]),
    );
    const roots: WikiPageTreeNode[] = [];
    for (const p of visible) {
      const node = nodes.get(p.id)!;
      if (p.parentId && nodes.has(p.parentId)) {
        nodes.get(p.parentId)!.children.push(node);
      } else {
        roots.push(node); // 父页缺失/已删/无权时提升为根，避免孤儿不可见
      }
    }
    return roots;
  }

  public async createPage(
    body: { spaceId: string; parentId?: string | null; title: string; contentMd?: string; orderNo?: number },
    user: PermissionSnapshot,
  ): Promise<WikiPageDto> {
    const space = await this.requireSpace(body.spaceId, user);
    const title = (body.title ?? '').trim();
    if (title.length === 0 || title.length > 200) {
      throw new BizException(ErrorCode.BAD_REQUEST, '页面标题须为 1-200 字符');
    }
    let parentId: string | null = null;
    if (body.parentId) {
      const parent = await this.requirePage(body.parentId, user);
      if (parent.spaceId !== space.id) {
        throw new BizException(ErrorCode.BAD_REQUEST, '父页面必须属于同一空间');
      }
      parentId = parent.id;
    }
    const content = body.contentMd ?? '';
    const page = await this.pageRepo.save(
      this.pageRepo.create({
        spaceId: space.id,
        parentId,
        title,
        contentMd: content,
        orderNo: body.orderNo ?? 0,
        versionNo: 1,
        securityLevel: space.securityLevel,
        createdBy: user.userId,
        updatedBy: user.userId,
      }),
    );
    await this.versionRepo.save(
      this.versionRepo.create({ pageId: page.id, versionNo: 1, title, contentMd: content, editedBy: user.userId }),
    );
    await this.indexPage(page.id);
    return this.pageDto(page, space);
  }

  public async getPage(id: string, user: PermissionSnapshot): Promise<WikiPageDto> {
    const page = await this.requirePage(id, user);
    const space = await this.spaceRepo.findOne({ where: { id: page.spaceId } });
    return this.pageDto(page, space);
  }

  /**
   * 更新页面：版本 +1、快照留档、重新切片。
   * 移动（parentId/orderNo）不产生新版本 —— 版本追踪的是内容，不是摆放位置。
   */
  public async updatePage(
    id: string,
    body: { title?: string; contentMd?: string; parentId?: string | null; orderNo?: number },
    user: PermissionSnapshot,
  ): Promise<WikiPageDto> {
    const page = await this.requirePage(id, user);
    const space = await this.spaceRepo.findOne({ where: { id: page.spaceId } });
    if (!space) throw new BizException(ErrorCode.NOT_FOUND, '所属空间不存在');
    let contentChanged = false;

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (title.length === 0 || title.length > 200) {
        throw new BizException(ErrorCode.BAD_REQUEST, '页面标题须为 1-200 字符');
      }
      if (title !== page.title) {
        page.title = title;
        contentChanged = true;
      }
    }
    if (body.contentMd !== undefined && body.contentMd !== page.contentMd) {
      page.contentMd = body.contentMd;
      contentChanged = true;
    }
    if (body.parentId !== undefined) {
      if (body.parentId === page.id) {
        throw new BizException(ErrorCode.BAD_REQUEST, '页面不能以自身为父');
      }
      if (body.parentId) {
        const parent = await this.requirePage(body.parentId, user);
        if (parent.spaceId !== page.spaceId) {
          throw new BizException(ErrorCode.BAD_REQUEST, '父页面必须属于同一空间');
        }
        // 防环：新父不能是自己的后代
        const ancestors = await this.collectAncestors(parent.id);
        if (ancestors.has(page.id)) {
          throw new BizException(ErrorCode.BAD_REQUEST, '不能把页面移动到自己的子树下');
        }
      }
      page.parentId = body.parentId || null;
    }
    if (body.orderNo !== undefined) page.orderNo = body.orderNo;

    if (contentChanged) {
      page.versionNo += 1;
      page.updatedBy = user.userId;
      await this.pageRepo.save(page);
      await this.versionRepo.save(
        this.versionRepo.create({
          pageId: page.id,
          versionNo: page.versionNo,
          title: page.title,
          contentMd: page.contentMd,
          editedBy: user.userId,
        }),
      );
      await this.pruneVersions(page.id);
      await this.indexPage(page.id);
    } else {
      page.updatedBy = user.userId;
      await this.pageRepo.save(page);
    }
    return this.pageDto(page, space);
  }

  /** 删除页面：连同子树一起软删（悬空子树不可见，等于隐性丢失） */
  public async deletePage(id: string, user: PermissionSnapshot): Promise<{ deleted: number }> {
    const page = await this.requirePage(id, user);
    const descendants = await this.collectDescendants(page.id);
    const ids = [page.id, ...descendants];
    await this.pageRepo.query(
      `UPDATE wiki_page SET deleted = TRUE, updated_at = now() WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    await this.chunkRepo.query(
      `UPDATE wiki_chunk SET deleted = TRUE WHERE page_id = ANY($1::uuid[])`,
      [ids],
    );
    return { deleted: ids.length };
  }

  // ==========================================================================
  // 版本
  // ==========================================================================

  public async listVersions(pageId: string, user: PermissionSnapshot): Promise<WikiPageVersionDto[]> {
    await this.requirePage(pageId, user);
    const rows = await this.versionRepo.find({
      where: { pageId },
      order: { versionNo: 'DESC' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      pageId: r.pageId,
      versionNo: r.versionNo,
      title: r.title,
      contentMd: r.contentMd,
      editedBy: r.editedBy,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  public async restoreVersion(
    pageId: string,
    versionNo: number,
    user: PermissionSnapshot,
  ): Promise<WikiPageDto> {
    const page = await this.requirePage(pageId, user);
    const ver = await this.versionRepo.findOne({ where: { pageId, versionNo } });
    if (!ver) throw new BizException(ErrorCode.NOT_FOUND, `版本 ${versionNo} 不存在`);
    const space = await this.spaceRepo.findOne({ where: { id: page.spaceId } });
    if (!space) throw new BizException(ErrorCode.NOT_FOUND, '所属空间不存在');

    page.title = ver.title;
    page.contentMd = ver.contentMd;
    page.versionNo += 1;
    page.updatedBy = user.userId;
    await this.pageRepo.save(page);
    // 回滚本身也留档：以当前新版本号保存回滚后的内容
    await this.versionRepo.save(
      this.versionRepo.create({
        pageId: page.id,
        versionNo: page.versionNo,
        title: page.title,
        contentMd: page.contentMd,
        editedBy: user.userId,
      }),
    );
    await this.indexPage(page.id);
    return this.pageDto(page, space);
  }

  // ==========================================================================
  // Wiki 问答 + 向量库
  // ==========================================================================

  public async ask(question: string, user: PermissionSnapshot, spaceId?: string): Promise<WikiAskResult> {
    const started = Date.now();
    const q = (question ?? '').trim();
    if (q.length === 0) throw new BizException(ErrorCode.BAD_REQUEST, '问题不能为空');

    // 只在用户可见的空间里召回
    const spaces = (await this.spaceRepo.find({ where: { deleted: false } })).filter((s) =>
      this.canAccessSpace(user, s),
    );
    const scopeIds = spaceId ? spaces.filter((s) => s.id === spaceId).map((s) => s.id) : spaces.map((s) => s.id);
    if (scopeIds.length === 0) {
      return {
        answer: '当前账号没有可见的 Wiki 空间，无法作答。',
        citations: [],
        mode: 'LEXICAL',
        model: null,
        tookMs: Date.now() - started,
        degraded: true,
        note: '无可见空间',
      };
    }

    let mode: 'VECTOR' | 'LEXICAL' = 'LEXICAL';
    let hits: Array<{ pageId: string; content: string; score: number }> = [];
    const levels = this.levelsFor(user);
    try {
      const [vec] = await this.embedding.embed([q]);
      if (vec && (await this.detectStore()) === 'PGVECTOR') {
        mode = 'VECTOR';
        hits = await this.vectorSearch(vec, scopeIds, levels);
      }
    } catch (err) {
      this.logger.warn(`Wiki 向量召回失败，退词法：${(err as Error).message}`);
    }
    if (hits.length === 0) {
      hits = await this.lexicalSearch(q, scopeIds, levels);
      mode = 'LEXICAL';
    }
    hits = hits.slice(0, ASK_TOPK);

    const pages = hits.length
      ? await this.pageRepo.find({ where: { id: In(hits.map((h) => h.pageId)) } })
      : [];
    const pageMap = new Map(pages.map((p) => [p.id, p]));
    const spaceMap = new Map(spaces.map((s) => [s.id, s.name]));

    const citations: WikiAskCitation[] = [];
    for (const h of hits) {
      const p = pageMap.get(h.pageId);
      if (!p) continue;
      // 防御纵深：召回行已按密级过滤，此处再按实体密级逐条复核
      const r = SECURITY_LEVEL_RANK[p.securityLevel as SecurityLevel];
      const u = SECURITY_LEVEL_RANK[user.maxSecurityLevel];
      if (r === undefined || u === undefined || r > u) continue;
      citations.push({
        index: citations.length + 1,
        pageId: p.id,
        pageTitle: p.title,
        spaceName: spaceMap.get(p.spaceId) ?? '',
        snippet: h.content.slice(0, 220),
        score: Math.round(h.score * 100) / 100,
      });
    }

    const context = hits
      .map((h, i) => {
        const p = pageMap.get(h.pageId);
        return `[${i + 1}] 《${p?.title ?? '未知页面'}》：${h.content}`;
      })
      .join('\n\n');

    const note =
      citations.length === 0 ? 'Wiki 中没有命中相关内容，回答基于零引用，请谨慎采信' : null;

    try {
      if (await this.llm.available()) {
        const system =
          '你是档案部门的知识库助手。只依据给出的 Wiki 页面片段回答问题；' +
          '片段没有覆盖的内容明确说「Wiki 中未收录」。答案中用 [n] 标注所引片段，不编造。';
        const answer = await this.llm.chat(system, `Wiki 片段：\n${context || '（无命中片段）'}\n\n问题：${q}`);
        if (answer) {
          return {
            answer,
            citations,
            mode,
            model: this.llm.model,
            tookMs: Date.now() - started,
            degraded: false,
            note,
          };
        }
      }
    } catch (err) {
      this.logger.warn(`Wiki 问答生成失败，退摘录：${(err as Error).message}`);
    }

    // 降级：直接给出摘录，不包装成模型结论
    const excerpt = hits
      .map((h, i) => {
        const p = pageMap.get(h.pageId);
        return `[${i + 1}] 《${p?.title ?? '未知页面'}》 ${h.content.slice(0, 160)}…`;
      })
      .join('\n');
    return {
      answer: excerpt || 'Wiki 中没有找到与问题相关的内容。',
      citations,
      mode,
      model: null,
      tookMs: Date.now() - started,
      degraded: true,
      note: note ?? '生成模型不可用，以下为检索摘录（未经归纳）',
    };
  }

  /**
   * 页面搜索：标题 + 正文（wiki_chunk）ILIKE，逐页/逐空间密级过滤。
   * 标题命中排前；正文命中截取命中词前后片段。
   */
  public async search(
    q: string,
    spaceId: string | null,
    user: PermissionSnapshot,
  ): Promise<WikiSearchHitDto[]> {
    const term = q.replace(/[%_\\]/g, ' ').trim();
    if (term.length === 0) return [];
    const levels = this.levelsFor(user);
    if (levels.length === 0) return [];
    const pattern = `%${term}%`;
    const rows: Array<{
      id: string;
      title: string;
      space_id: string;
      space_name: string;
      level: string;
      title_hit: boolean;
      snippet: string | null;
      source_no: string | null;
    }> = await this.pageRepo.query(
      `SELECT p.id, p.title, p.space_id, s.name AS space_name,
              p.security_level AS level,
              (p.title ILIKE $1) AS title_hit,
              a.danghao AS source_no,
              (SELECT substring(c.content FROM GREATEST(1, POSITION(LOWER($2) IN LOWER(c.content)) - 40) FOR 200)
                 FROM wiki_chunk c
                WHERE c.page_id = p.id AND c.deleted = FALSE AND c.content ILIKE $1
                LIMIT 1) AS snippet
         FROM wiki_page p
         JOIN wiki_space s ON s.id = p.space_id AND s.deleted = FALSE
         LEFT JOIN archive_item a ON a.id = p.source_item_id
        WHERE p.deleted = FALSE
          AND p.security_level = ANY($3::varchar[])
          AND s.security_level = ANY($3::varchar[])
          AND ($4::uuid IS NULL OR p.space_id = $4)
          AND (p.title ILIKE $1
               OR EXISTS (SELECT 1 FROM wiki_chunk c
                           WHERE c.page_id = p.id AND c.deleted = FALSE AND c.content ILIKE $1))
        ORDER BY (p.title ILIKE $1) DESC, p.updated_at DESC
        LIMIT 50`,
      [pattern, term, levels, spaceId],
    );
    return rows.map((r) => ({
      pageId: r.id,
      title: r.title,
      spaceId: r.space_id,
      spaceName: r.space_name,
      securityLevel: r.level as SecurityLevel,
      titleHit: r.title_hit,
      snippet: r.snippet,
      sourceNo: r.source_no,
    }));
  }

  /** 重建全部页面向量（嵌入模型可用时补齐历史空块） */
  public async reindex(user: PermissionSnapshot): Promise<{ pages: number; chunks: number }> {    const spaces = (await this.spaceRepo.find({ where: { deleted: false } })).filter((s) =>
      this.canAccessSpace(user, s),
    );
    const scopeIds = spaces.map((s) => s.id);
    if (scopeIds.length === 0) return { pages: 0, chunks: 0 };
    const pages = await this.pageRepo
      .createQueryBuilder()
      .where('space_id = ANY(:ids::uuid[]) AND deleted = FALSE', { ids: scopeIds })
      .getMany();
    let chunks = 0;
    for (const p of pages) {
      chunks += await this.indexPage(p.id);
    }
    this.logger.log(`Wiki 向量重建：${pages.length} 页 / ${chunks} 块`);
    return { pages: pages.length, chunks };
  }

  public async indexStatus(user: PermissionSnapshot): Promise<{
    pageCount: number;
    chunkCount: number;
    embeddedCount: number;
    vectorStore: string;
  }> {
    const spaces = (await this.spaceRepo.find({ where: { deleted: false } })).filter((s) =>
      this.canAccessSpace(user, s),
    );
    const ids = spaces.map((s) => s.id);
    if (ids.length === 0) return { pageCount: 0, chunkCount: 0, embeddedCount: 0, vectorStore: 'UNKNOWN' };
    const kind = await this.detectStore();
    const levels = this.levelsFor(user);
    const rows: Array<{ pages: string; chunks: string; embedded: string }> = await this.pageRepo.query(
      `SELECT COUNT(DISTINCT p.id)::text AS pages,
              COUNT(c.id)::text AS chunks,
              COUNT(c.id) FILTER (WHERE c.embedding IS NOT NULL)::text AS embedded
         FROM wiki_page p
         LEFT JOIN wiki_chunk c ON c.page_id = p.id AND c.deleted = FALSE
        WHERE p.deleted = FALSE AND p.space_id = ANY($1::uuid[])
          AND p.security_level = ANY($2::varchar[])`,
      [ids, levels],
    );
    const r = rows[0];
    return {
      pageCount: Number.parseInt(r?.pages ?? '0', 10),
      chunkCount: Number.parseInt(r?.chunks ?? '0', 10),
      embeddedCount: Number.parseInt(r?.embedded ?? '0', 10),
      vectorStore: kind,
    };
  }

  // ==========================================================================
  // 内部：切片 / 向量库
  // ==========================================================================

  /** 批量导入用公开入口（逐页切片入向量库） */
  public async indexPageForImport(pageId: string): Promise<number> {
    return this.indexPage(pageId);
  }

  /**
   * 页面切片并入向量库（全量替换式：先删旧块再写入）。
   * 返回本次写入的块数；嵌入不可用时写入空向量块（等 reindex 补齐）。
   */
  private async indexPage(pageId: string): Promise<number> {
    const page = await this.pageRepo.findOne({ where: { id: pageId } });
    if (!page || page.deleted) return 0;
    const text = this.normalizeForChunk(page.title, page.contentMd);
    if (text.trim().length === 0) {
      await this.chunkRepo.query(`UPDATE wiki_chunk SET deleted = TRUE WHERE page_id = $1`, [pageId]);
      return 0;
    }
    const pieces = this.splitChunks(text);

    await this.chunkRepo.query(`DELETE FROM wiki_chunk WHERE page_id = $1`, [pageId]);

    const kind = await this.detectStore();
    let n = 0;
    // 分批嵌入：每批 16 条 —— 整本书数百块时单次调用会撞 20s 超时
    const BATCH = 16;
    const vectors: Array<number[] | null> = new Array(pieces.length).fill(null);
    if (vectors.length > 0) {
      for (let s = 0; s < pieces.length; s += BATCH) {
        try {
          const part = await this.embedding.embed(pieces.slice(s, s + BATCH));
          for (let i = 0; i < part.length; i++) vectors[s + i] = part[i];
        } catch (err) {
          this.logger.warn(`页面 ${page.title} 批次 ${s}-${s + BATCH} 嵌入失败（留空待 reindex）：${(err as Error).message}`);
        }
      }
    }
    for (let i = 0; i < pieces.length; i++) {
      const vec = vectors[i];
      if (kind === 'PGVECTOR' && vec) {
        await this.chunkRepo.query(
          `INSERT INTO wiki_chunk (page_id, chunk_no, content, char_len, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [pageId, i, pieces[i], pieces[i].length, OllamaEmbeddingProvider.literal(vec)],
        );
      } else if (kind === 'ARRAY' && vec) {
        await this.chunkRepo.query(
          `INSERT INTO wiki_chunk (page_id, chunk_no, content, char_len, embedding)
           VALUES ($1, $2, $3, $4, $5::double precision[])`,
          [pageId, i, pieces[i], pieces[i].length, vec],
        );
      } else {
        await this.chunkRepo.query(
          `INSERT INTO wiki_chunk (page_id, chunk_no, content, char_len, embedding)
           VALUES ($1, $2, $3, $4, NULL)`,
          [pageId, i, pieces[i], pieces[i].length],
        );
      }
      n++;
    }
    return n;
  }

  /** 标题并入首块 + 压掉 Markdown 记号，保证「标题即语义」进入向量 */
  private normalizeForChunk(title: string, md: string): string {
    const cleaned = (md || '')
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' ')) // 代码块不参与语义
      .replace(/[#>*`~[\]()!|-]/g, ' ')
      .replace(/[ \t]+/g, ' ');
    return `${title}\n${cleaned}`;
  }

  /** 按段落聚合到 ~CHUNK_TARGET 的切片（保留段落边界，不硬切句） */
  private splitChunks(text: string): string[] {
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    if (paras.length === 0) return [];
    const chunks: string[] = [];
    let cur = '';
    for (const p of paras) {
      if (cur.length === 0) {
        cur = p;
      } else if (cur.length + p.length + 1 <= CHUNK_TARGET) {
        cur += '\n' + p;
      } else {
        chunks.push(cur);
        cur = p;
      }
      // 单段超长的兜底硬切（表格/长列表），避免单块过大
      while (cur.length > CHUNK_TARGET * 1.5) {
        chunks.push(cur.slice(0, CHUNK_TARGET));
        cur = cur.slice(CHUNK_TARGET);
      }
    }
    if (cur.length > 0) chunks.push(cur);
    return chunks.slice(0, 1024); // 单页块数上限（批量导入整本书可达数百块）
  }

  private async detectStore(): Promise<'PGVECTOR' | 'ARRAY'> {
    if (this.vectorKind) return this.vectorKind;
    const rows: Array<{ ok: boolean }> = await this.chunkRepo
      .query(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`)
      .catch(() => [{ ok: false }]);
    this.vectorKind = rows[0]?.ok ? 'PGVECTOR' : 'ARRAY';
    return this.vectorKind;
  }

  private async vectorSearch(
    vec: number[],
    spaceIds: string[],
    levels: string[],
  ): Promise<Array<{ pageId: string; content: string; score: number }>> {
    const literal = OllamaEmbeddingProvider.literal(vec);
    if ((await this.detectStore()) === 'PGVECTOR') {
      const rows: Array<{ page_id: string; content: string; distance: string }> =
        await this.chunkRepo.query(
          `SELECT c.page_id, c.content,
                  (1 - (c.embedding <=> $1::vector))::text AS distance
             FROM wiki_chunk c
             JOIN wiki_page p ON p.id = c.page_id AND p.deleted = FALSE
            WHERE c.deleted = FALSE AND c.embedding IS NOT NULL
              AND p.space_id = ANY($2::uuid[])
              AND p.security_level = ANY($3::varchar[])
            ORDER BY c.embedding <=> $1::vector
            LIMIT 12`,
          [literal, spaceIds, levels],
        );
      return rows.map((r) => ({
        pageId: r.page_id,
        content: r.content,
        score: Math.max(0, Number.parseFloat(r.distance) || 0),
      }));
    }
    // 数组降级：取回候选在应用内算余弦（页数少，可接受）
    const rows: Array<{ page_id: string; content: string; embedding: number[] | null }> =
      await this.chunkRepo.query(
        `SELECT c.page_id, c.content, c.embedding
           FROM wiki_chunk c
           JOIN wiki_page p ON p.id = c.page_id AND p.deleted = FALSE
          WHERE c.deleted = FALSE AND c.embedding IS NOT NULL
            AND p.space_id = ANY($1::uuid[])
            AND p.security_level = ANY($2::varchar[])`,
        [spaceIds, levels],
      );
    return rows
      .map((r) => ({
        pageId: r.page_id,
        content: r.content,
        score: this.cosine(vec, r.embedding),
      }))
      .filter((h) => h.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }

  private async lexicalSearch(
    q: string,
    spaceIds: string[],
    levels: string[],
  ): Promise<Array<{ pageId: string; content: string; score: number }>> {
    const term = q.replace(/[%_]/g, '').trim();
    if (term.length === 0) return [];
    const rows: Array<{ page_id: string; content: string; title_hit: boolean }> = await this.chunkRepo.query(
      `SELECT DISTINCT ON (c.page_id) c.page_id, c.content, (p.title ILIKE $1) AS title_hit
         FROM wiki_chunk c
         JOIN wiki_page p ON p.id = c.page_id AND p.deleted = FALSE
        WHERE c.deleted = FALSE AND p.space_id = ANY($2::uuid[])
          AND p.security_level = ANY($3::varchar[])
          AND (c.content ILIKE $1 OR p.title ILIKE $1)
        LIMIT 12`,
      [`%${term}%`, spaceIds, levels],
    );
    return rows.map((r) => ({
      pageId: r.page_id,
      content: r.content,
      score: r.title_hit ? 0.9 : 0.6,
    }));
  }

  private cosine(a: number[], b: number[] | null): number {
    if (!Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // ==========================================================================
  // 内部：树 / 权限 / 转换
  // ==========================================================================

  private async collectAncestors(pageId: string): Promise<Set<string>> {
    const seen = new Set<string>();
    let cur: string | null = pageId;
    while (cur) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const row: Array<{ parent_id: string | null }> = await this.pageRepo.query(
        `SELECT parent_id FROM wiki_page WHERE id = $1`,
        [cur],
      );
      cur = row[0]?.parent_id ?? null;
    }
    return seen;
  }

  private async collectDescendants(rootId: string): Promise<string[]> {
    const rows: Array<{ id: string; parent_id: string | null }> = await this.pageRepo.query(
      `SELECT id, parent_id FROM wiki_page WHERE deleted = FALSE`,
    );
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const key = r.parent_id ?? '';
      const arr = map.get(key) ?? [];
      arr.push(r.id);
      map.set(key, arr);
    }
    const out: string[] = [];
    const queue = [rootId];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const child of map.get(cur) ?? []) {
        out.push(child);
        queue.push(child);
      }
    }
    return out;
  }

  /**
   * Wiki 空间可见性：只按密级判定（fail-closed），不套全宗/机构数据范围 ——
   * Wiki 是部门级编研知识，不挂全宗；scope 受限用户（如 R2）也按密级可见。
   */
  private canAccessSpace(user: PermissionSnapshot, space: WikiSpace): boolean {
    const recordRank = SECURITY_LEVEL_RANK[space.securityLevel as SecurityLevel];
    const userRank = SECURITY_LEVEL_RANK[user.maxSecurityLevel];
    if (recordRank === undefined || userRank === undefined) return false;
    return recordRank <= userRank;
  }

  private async requireSpace(id: string, user: PermissionSnapshot): Promise<WikiSpace> {
    const space = await this.spaceRepo.findOne({ where: { id, deleted: false } });
    if (!space || !this.canAccessSpace(user, space)) {
      throw new BizException(ErrorCode.NOT_FOUND, '空间不存在或无权访问');
    }
    return space;
  }

  private async requirePage(id: string, user: PermissionSnapshot): Promise<WikiPage> {
    const page = await this.pageRepo.findOne({ where: { id, deleted: false } });
    if (!page) throw new BizException(ErrorCode.NOT_FOUND, '页面不存在或无权访问');
    const space = await this.spaceRepo.findOne({ where: { id: page.spaceId } });
    if (!space || space.deleted || !this.canAccessSpace(user, space)) {
      throw new BizException(ErrorCode.NOT_FOUND, '页面不存在或无权访问');
    }
    // 页面级密级（批量导入的同类型空间内密级混合，逐页判定）
    const pageRank = SECURITY_LEVEL_RANK[page.securityLevel as SecurityLevel];
    const userRank = SECURITY_LEVEL_RANK[user.maxSecurityLevel];
    if (pageRank === undefined || userRank === undefined || pageRank > userRank) {
      throw new BizException(ErrorCode.NOT_FOUND, '页面不存在或无权访问');
    }
    return page;
  }

  private async pruneVersions(pageId: string): Promise<void> {
    await this.versionRepo.query(
      `DELETE FROM wiki_page_version
        WHERE page_id = $1
          AND version_no <= (SELECT MAX(version_no) - $2 FROM wiki_page_version WHERE page_id = $1)`,
      [pageId, MAX_VERSIONS],
    );
  }

  /** 当前用户可见密级（SQL IN 过滤用；空数组表示无任何可见密级） */
  private levelsFor(user: PermissionSnapshot): string[] {
    const order = ['PUBLIC', 'INTERNAL', 'SECRET'];
    const max = order.indexOf(user.maxSecurityLevel);
    if (max < 0) return [];
    return order.slice(0, max + 1);
  }

  private toSpaceDto(s: WikiSpace, pageCount: number): WikiSpaceDto {
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      securityLevel: s.securityLevel as WikiSpaceDto['securityLevel'],
      pageCount,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private toTreeNode(p: WikiPage): WikiPageTreeNode {
    return {
      id: p.id,
      spaceId: p.spaceId,
      parentId: p.parentId,
      title: p.title,
      orderNo: p.orderNo,
      versionNo: p.versionNo,
      securityLevel: p.securityLevel as WikiPageTreeNode['securityLevel'],
      updatedAt: p.updatedAt.toISOString(),
      children: [],
    };
  }

  private pageDto(p: WikiPage, space: WikiSpace | null): WikiPageDto {
    return {
      id: p.id,
      spaceId: p.spaceId,
      spaceName: space?.name ?? '',
      parentId: p.parentId,
      title: p.title,
      contentMd: p.contentMd,
      orderNo: p.orderNo,
      versionNo: p.versionNo,
      securityLevel: p.securityLevel as WikiPageDto['securityLevel'],
      sourceItemId: p.sourceItemId,
      createdBy: p.createdBy,
      updatedBy: p.updatedBy,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }
}
