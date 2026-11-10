import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KbIndexer } from './kb.indexer';
import { KbEsService } from './kb.es';

/**
 * 片段索引自愈扫描（增量入口）。
 *
 * ## 为什么用"扫描陈旧"而不是在抽取完成时回调
 *
 * 抽取器是独立进程，没有 API 的 DI 容器；让它反向调用 API 会引入内网回调、鉴权、
 * 重试三套新问题。而"哪些条目缺片段 / 密级不一致"完全可由一条 SQL 判定
 * （见 `KbIndexer.findStaleItemIds`），扫描式增量**无需耦合**，且天然幂等：
 * 索引好了就不再入选，跑多少次都一样。
 *
 * 代价是延迟（最长一个扫描周期），对本场景可接受——片段检索不是事务性业务。
 *
 * ## 覆盖的三类情况
 *
 *   ① 新条目/新抽取完成 → 无片段；
 *   ② 密级被改（`updateItem` / `batchUpdate` 支持改密级）→ 片段密级与条目不一致；
 *   ③ 升级前的老数据从未建过索引 → 无片段。
 *
 * 每轮限量（默认 100），避免一次扫描把 API 拖住；积压会在后续轮次自然消化。
 */
@Injectable()
export class KbScheduler {
  private readonly logger = new Logger(KbScheduler.name);
  /** 单轮上限：过大会让一次 cron 占用过多连接与 CPU */
  private static readonly BATCH = 100;

  public constructor(
    private readonly indexer: KbIndexer,
    private readonly es: KbEsService,
  ) {}

  /** 每 5 分钟扫描一次陈旧条目 */
  @Cron('0 */5 * * * *', { name: 'kb-stale-sweep' })
  public async sweepStale(): Promise<void> {
    // ES 未就绪时不写（否则片段写入 PG 但检索镜像缺失，状态会自相矛盾）
    const ready = await this.es.ready();
    if (!ready) {
      this.logger.debug('kb_chunks 未就绪，跳过本轮片段自愈扫描');
      return;
    }

    let ids: string[] = [];
    try {
      ids = await this.indexer.findStaleItemIds(KbScheduler.BATCH);
    } catch (err) {
      this.logger.warn(`片段陈旧扫描失败（下轮重试）: ${(err as Error).message}`);
      return;
    }
    if (ids.length === 0) return;

    const r = await this.indexer.indexItems(ids);
    await this.es.refresh();
    this.logger.log(
      `片段自愈：条目 ${r.items}/${ids.length}（失败 ${r.failed}），写入片段 ${r.chunks}`,
    );
  }
}
