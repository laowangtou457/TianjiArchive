import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RecycleService } from './recycle.service';

/** 回收站定时清理（每日 04:00 清理过期条目） */
@Injectable()
export class RecycleScheduler {
  private readonly logger = new Logger(RecycleScheduler.name);

  public constructor(private readonly recycleService: RecycleService) {}

  @Cron('0 0 4 * * *', { name: 'recycle-purge-expired' })
  public async purgeExpired(): Promise<void> {
    try {
      const count = await this.recycleService.purgeExpired();
      if (count > 0) this.logger.log(`回收站过期清理完成：${count} 条`);
    } catch (err) {
      this.logger.error(`回收站清理失败: ${(err as Error).message}`);
    }
  }
}
