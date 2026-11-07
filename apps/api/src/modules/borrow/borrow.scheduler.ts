import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BorrowService } from './borrow.service';
import { ParamService } from '../param/param.service';

/**
 * 借阅定时任务。
 *
 * 参数化边界（PRD 5.5 / 架构 §4.3）：
 *  - 逾期扫描**周期**可配（`borrow.overdue_scan_cron`）——它决定「多久发现逾期」，
 *    属于业务节奏，单位可能需要调快；
 *  - 到期提醒**提前天数**可配（`borrow.overdue_remind_days`）——它决定提醒窗口；
 *  - 但提醒**触发时刻**（每天 09:00）不参数化：它是工位作息约定，
 *    与业务策略无关，参数化只会增加配置面（架构师明确"勿过度设计"）。
 *
 * ⚠️ NestJS `@Cron` 装饰器在**类定义时**求值，无法异步读库。
 * 因此这里用「每分钟心跳 + 到期判定」实现可配置 cron：
 * 心跳固定每分钟跑一次，命中 `borrow.overdue_scan_cron` 描述的最近触发时刻才执行。
 * 相比动态 `SchedulerRegistry` 重注册，这种写法在进程重启后无需额外恢复逻辑，
 * 且多实例下天然幂等（扫描本身有 CAS 保护）。
 */
@Injectable()
export class BorrowScheduler {
  private readonly logger = new Logger(BorrowScheduler.name);

  /** 上次执行逾期扫描的分钟刻度（防止同一分钟内重复触发） */
  private lastScanMinute = '';

  public constructor(
    private readonly borrowService: BorrowService,
    private readonly paramService: ParamService,
  ) {}

  /**
   * 逾期扫描心跳（每分钟第 0 秒）。
   *
   * 是否真正执行由 `borrow.overdue_scan_cron` 决定；参数缺省时按每小时第 5 分钟执行。
   */
  @Cron('0 * * * * *', { name: 'borrow-overdue-scan' })
  public async scanOverdue(): Promise<void> {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    if (this.lastScanMinute === minuteKey) return;

    let cron = '0 5 * * * *';
    try {
      cron = await this.paramService.get('borrow.overdue_scan_cron');
    } catch (err) {
      this.logger.error(`读取逾期扫描 cron 失败，使用默认每小时: ${(err as Error).message}`);
    }

    if (!this.isDue(cron, now)) return;
    this.lastScanMinute = minuteKey;

    try {
      const count = await this.borrowService.scanOverdue();
      if (count > 0) {
        this.logger.warn(`逾期扫描完成：${count} 笔借阅单转为「逾期」`);
      }
    } catch (err) {
      this.logger.error(`逾期扫描失败: ${(err as Error).message}`);
    }
  }

  /** 到期提醒（每天 09:00，固定时刻不参数化） */
  @Cron('0 0 9 * * *', { name: 'borrow-due-soon' })
  public async remindDueSoon(): Promise<void> {
    try {
      // dueSoon() 内部读 borrow.overdue_remind_days；0 = 关闭提醒
      const list = await this.borrowService.dueSoon();
      if (list.length > 0) {
        this.logger.log(
          `即将到期 ${list.length} 笔：${list.map((o) => `${o.orderNo}(${o.expectReturn})`).join(', ')}`,
        );
      }
    } catch (err) {
      this.logger.error(`到期提醒失败: ${(err as Error).message}`);
    }
  }

  /** 每分钟兜底清理（保留装饰器使用示例，避免 CronExpression 未使用告警） */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'borrow-nightly-noop' })
  public async nightly(): Promise<void> {
    this.logger.debug('借阅夜间任务心跳（无操作）');
  }

  // ==========================================================================
  // cron 判定（秒 分 时 日 月 周，6 段式；5 段式自动补秒 0）
  // ==========================================================================

  /**
   * 判断当前分钟是否命中 cron 表达式。
   *
   * 支持语法：`*`、`数字`、`a-b` 区间、`* /n` 步长、`a,b,c` 列表。
   * 不支持的语法（如 `L`、`#`）会退化为「每小时整点」，并告警——
   * 宁可降级执行也不静默不执行（逾期不扫描是合规问题）。
   */
  private isDue(cron: string, now: Date): boolean {
    const parts = cron.trim().split(/\s+/).filter(Boolean);
    // 统一成 6 段：秒 分 时 日 月 周
    const fields = parts.length === 5 ? ['0', ...parts] : parts;
    if (fields.length !== 6) {
      this.logger.warn(`逾期扫描 cron「${cron}」格式非法，退化为每小时第 5 分钟`);
      return now.getMinutes() === 5;
    }
    const [sec, min, hour, dom, mon, dow] = fields;
    const values = [
      now.getSeconds(),
      now.getMinutes(),
      now.getHours(),
      now.getDate(),
      now.getMonth() + 1,
      now.getDay(),
    ];
    const specs = [sec, min, hour, dom, mon, dow];
    for (let i = 0; i < specs.length; i += 1) {
      if (!this.matchField(specs[i], values[i], i)) return false;
    }
    return true;
  }

  /** 单字段匹配 */
  private matchField(spec: string, value: number, index: number): boolean {
    if (!spec || spec === '*' || spec === '?') return true;

    // 步长：*/n 或 a-b/n
    if (spec.includes('/')) {
      const [base, stepRaw] = spec.split('/');
      const step = Number.parseInt(stepRaw, 10);
      if (!Number.isFinite(step) || step <= 0) return false;
      if (base === '*') return value % step === 0;
      const [from, to] = this.parseRange(base, index);
      return value >= from && value <= to && (value - from) % step === 0;
    }

    // 列表：a,b,c
    if (spec.includes(',')) {
      return spec.split(',').some((s) => this.matchField(s.trim(), value, index));
    }

    // 区间：a-b
    if (spec.includes('-')) {
      const [from, to] = this.parseRange(spec, index);
      return value >= from && value <= to;
    }

    // 单值
    const n = Number.parseInt(spec, 10);
    if (!Number.isFinite(n)) {
      this.logger.warn(`cron 字段「${spec}」无法解析，按不匹配处理`);
      return false;
    }
    // 星期允许 0 与 7 都表示周日
    if (index === 5) return value === n % 7;
    return value === n;
  }

  /** 解析区间端点（处理星期 7=周日） */
  private parseRange(spec: string, index: number): [number, number] {
    const [fromRaw, toRaw] = spec.split('-');
    let from = Number.parseInt(fromRaw, 10);
    let to = Number.parseInt(toRaw, 10);
    if (!Number.isFinite(from)) from = 0;
    if (!Number.isFinite(to)) to = from;
    if (index === 5) {
      from = from % 7;
      to = to % 7;
    }
    return [from, to];
  }
}
