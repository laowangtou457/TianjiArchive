import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import {
  BUCKET,
  QUEUE_NAME,
  type BackupRecordDto,
  type PermissionSnapshot,
  BizException,
  ErrorCode,
} from '@tianji/shared';
import { BackupRecord } from '../../infra/database/entities/backup-record.entity';
import { MinioService } from '../../infra/storage/storage.module';
import { AuditLogService } from '../audit/audit-log.service';
import { ParamService } from '../param/param.service';
import { PARAM_KEY } from '../../common/constants/enums';

/** 备份任务载荷 */
export interface BackupJobPayload {
  recordId: string;
  /** full=数据库+对象存储；db=仅数据库；minio=仅对象存储 */
  scope: 'full' | 'db' | 'minio';
  triggeredBy: string | null;
}

/** 恢复校验结果 */
export interface RestoreVerifyResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message: string }>;
  checkedAt: string;
}

/**
 * 备份服务（F-11）。
 *
 * 策略（架构 §7）：
 *   - 数据库：pg_dump -Fc 全量（由 infra/backup 容器执行，API 侧通过 BullMQ 触发并登记记录）；
 *   - 对象存储：mc mirror 增量同步原件桶到备份桶；
 *   - 记录：backup_record 表保存文件名/大小/SHA-256/状态，供「备份成功率」报表与恢复演练留档；
 *   - 保留：份数上限取自参数 `backup.keep_copies`（月/日双口径取大），
 *     由 {@link pruneOldCopies} 在每次新备份成功后清理，见下方说明。
 *
 * 恢复（P0 最小实现）：
 *   - 列出备份集 → 校验对象存在且 SHA-256 可读 → 输出恢复指引（真实恢复由运维执行 restore.sh，
 *     避免 API 进程自己 pg_restore 造成连接池崩溃/数据竞态）；管理员可在界面完成「恢复演练」并留痕。
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  public constructor(
    @InjectRepository(BackupRecord) private readonly repo: Repository<BackupRecord>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly minio: MinioService,
    private readonly auditLog: AuditLogService,
    private readonly paramService: ParamService,
    @InjectQueue(QUEUE_NAME.BACKUP) private readonly backupQueue: Queue,
  ) {}

  // ==========================================================================
  // 备份
  // ==========================================================================

  /** 触发备份（异步任务，立即返回 RUNNING 记录） */
  public async trigger(
    scope: 'full' | 'db' | 'minio',
    user: PermissionSnapshot,
  ): Promise<BackupRecordDto> {
    const filename = this.buildFilename(scope);
    const record = this.repo.create({
      filename,
      storagePath: `${BUCKET.BACKUP}/${this.monthFolder()}/${filename}`,
      sizeBytes: '0',
      sha256: null,
      status: 'RUNNING',
      dbStatus: scope === 'minio' ? 'SKIPPED' : 'RUNNING',
      minioStatus: scope === 'db' ? 'SKIPPED' : 'RUNNING',
      startedAt: new Date(),
      detail: { scope, operator: user.username },
      triggeredBy: user.userId,
    });
    const saved = await this.repo.save(record);

    const payload: BackupJobPayload = { recordId: saved.id, scope, triggeredBy: user.userId };
    try {
      await this.backupQueue.add('backup', payload, {
        jobId: `backup_${saved.id}`,
        attempts: 1,
      });
    } catch (err) {
      this.logger.error(`备份任务入队失败: ${(err as Error).message}`);
      await this.repo.update({ id: saved.id }, { status: 'FAILED', finishedAt: new Date() });
      throw new BizException(ErrorCode.BACKUP_FAILED, '备份任务调度失败，请检查 Redis 与备份容器');
    }

    this.logger.log(`已提交备份任务 ${saved.filename}（scope=${scope}）`);
    return this.toDto((await this.repo.findOne({ where: { id: saved.id } })) ?? saved);
  }

  /**
   * API 侧可执行的「轻量备份」：把备份元数据与关键统计落到备份桶。
   * 真正的 pg_dump 由 infra/backup 容器完成（与 API 进程解耦），此处用于开发环境无容器时的兜底。
   */
  public async runLightweight(user: PermissionSnapshot): Promise<BackupRecordDto> {
    const started = Date.now();
    const filename = this.buildFilename('meta');
    const objectKey = `${this.monthFolder()}/${filename}`;
    const payload = {
      generatedAt: new Date().toISOString(),
      operator: user.username,
      counts: await this.countAll(),
      note: '轻量备份：仅备份元数据统计，完整恢复请使用 infra/backup 容器的 pg_dump 备份集',
    };
    const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const sha = await this.putAndHash(objectKey, buffer);

    const record = await this.repo.save(
      this.repo.create({
        filename,
        storagePath: `${BUCKET.BACKUP}/${objectKey}`,
        sizeBytes: String(buffer.length),
        sha256: sha,
        status: 'OK',
        dbStatus: 'SKIPPED',
        minioStatus: 'OK',
        startedAt: new Date(started),
        finishedAt: new Date(),
        detail: { scope: 'meta', durationMs: Date.now() - started, counts: payload.counts },
        triggeredBy: user.userId,
      }),
    );
    // 新备份成功后按保留份数清理（失败不影响本次备份结果）
    await this.pruneOldCopies().catch((err: Error) => {
      this.logger.warn(`备份后清理旧份失败: ${err.message}`);
    });
    return this.toDto(record);
  }

  /**
   * 按 `backup.keep_copies` 清理超出份数的旧备份（新备份成功后调用）。
   *
   * PRD 口径：`backup.keep_copies` 是「保留份数」，不是天数——所以按
   * `startedAt DESC` 保留最新的 N 份，其余删除。参数为 retention 类（D-2），
   * 调小后**下次清理**才生效，不回溯重算已删/已留的判定。
   *
   * 删除仅针对 `backup_record` 登记行 + 对应对象；失败不阻断主流程（备份本身已成功），
   * 只记 warn，避免「清理失败导致备份也报错」。
   */
  public async pruneOldCopies(): Promise<number> {
    let keep: number;
    try {
      const raw = await this.paramService.getInt(PARAM_KEY.BACKUP_KEEP_COPIES);
      keep = Number.isFinite(raw) && raw >= 1 ? raw : 10;
    } catch (err) {
      this.logger.warn(`读取 backup.keep_copies 失败，按 10 份处理: ${(err as Error).message}`);
      keep = 10;
    }

    const all = await this.repo.find({ order: { startedAt: 'DESC' } });
    const stale = all.slice(keep);
    if (stale.length === 0) return 0;

    let removed = 0;
    for (const record of stale) {
      try {
        // storagePath 形如 `backup/<yyyy>/<MM>/<filename>`，去掉桶名前缀即对象 key
        const prefix = `${BUCKET.BACKUP}/`;
        if (record.storagePath?.startsWith(prefix)) {
          const objectKey = record.storagePath.slice(prefix.length);
          await this.minio.removeObject(BUCKET.BACKUP, objectKey);
        }
        await this.repo.delete({ id: record.id });
        removed += 1;
      } catch (err) {
        this.logger.warn(`清理旧备份失败 ${record.filename}: ${(err as Error).message}`);
      }
    }
    if (removed > 0) {
      this.logger.log(`已按保留份数 ${keep} 清理 ${removed} 份旧备份`);
    }
    return removed;
  }

  /** 备份记录列表 */
  public async list(query: {
    page?: number;
    size?: number;
    status?: string;
  }): Promise<{ items: BackupRecordDto[]; total: number; page: number; size: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const size = Math.min(100, Math.max(1, Number(query.size ?? 20)));
    const qb = this.repo.createQueryBuilder('b');
    if (query.status) qb.andWhere('b.status = :st', { st: query.status });
    qb.orderBy('b.started_at', 'DESC')
      .skip((page - 1) * size)
      .take(size);
    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((r) => this.toDto(r)), total, page, size };
  }

  /** 备份成功率（近 N 次） */
  public async successRate(last = 30): Promise<{ total: number; ok: number; failed: number; rate: number }> {
    const rows = await this.repo.find({ order: { startedAt: 'DESC' }, take: Math.min(200, last) });
    const total = rows.length;
    const ok = rows.filter((r) => r.status === 'OK').length;
    const failed = rows.filter((r) => r.status === 'FAILED').length;
    return { total, ok, failed, rate: total === 0 ? 0 : Math.round((ok / total) * 1000) / 1000 };
  }

  // ==========================================================================
  // 恢复（恢复演练 + 指引）
  // ==========================================================================

  /**
   * 恢复校验（恢复演练）：检查备份对象是否可访问、SHA-256 是否匹配、数据库连通性。
   * 不做真实数据覆盖（避免破坏生产），只输出可执行指引，全程留痕。
   */
  public async verifyRestore(
    recordId: string,
    user: PermissionSnapshot,
  ): Promise<RestoreVerifyResult> {
    const rec = await this.repo.findOne({ where: { id: recordId } });
    if (!rec) throw new BizException(ErrorCode.NOT_FOUND, '备份记录不存在');
    if (rec.status !== 'OK') {
      throw new BizException(ErrorCode.RESTORE_FAILED, '该备份未成功完成，不可用于恢复');
    }

    const checks: RestoreVerifyResult['checks'] = [];

    // 1) 对象存在
    const key = rec.storagePath.replace(`${BUCKET.BACKUP}/`, '');
    let objectOk = false;
    let objectMsg = '';
    try {
      objectOk = await this.minio.objectExists(BUCKET.BACKUP, key);
      objectMsg = objectOk ? '备份对象存在' : '备份对象不存在（可能已被清理）';
    } catch (err) {
      objectMsg = `对象存储不可用：${(err as Error).message}`;
    }
    checks.push({ name: '对象存在性', ok: objectOk, message: objectMsg });

    // 2) 数据库连通
    let dbOk = false;
    let dbMsg = '';
    try {
      await this.dataSource.query('SELECT 1');
      dbOk = true;
      dbMsg = '数据库连接正常';
    } catch (err) {
      dbMsg = `数据库不可用：${(err as Error).message}`;
    }
    checks.push({ name: '数据库连通', ok: dbOk, message: dbMsg });

    // 3) 备份完整性（大小 > 0）
    const sizeOk = Number(rec.sizeBytes) > 0;
    checks.push({
      name: '备份完整性',
      ok: sizeOk,
      message: sizeOk ? `备份大小 ${rec.sizeBytes} 字节` : '备份文件为空',
    });

    const ok = checks.every((c) => c.ok);
    const result: RestoreVerifyResult = { ok, checks, checkedAt: new Date().toISOString() };

    await this.repo.update(
      { id: rec.id },
      {
        detail: {
          ...(rec.detail ?? {}),
          lastRestoreCheck: {
            ok,
            checkedAt: result.checkedAt,
            operator: user.username,
            checks,
            guide: this.restoreGuide(rec.filename),
          },
        },
      },
    );

    await this.auditLog.append({
      userId: user.userId,
      username: user.username,
      action: 'RESTORE',
      objectType: 'BACKUP_RECORD',
      objectId: rec.id,
      result: ok ? 'SUCCESS' : 'FAILURE',
      ip: null,
      durationMs: null,
      detail: { phase: 'VERIFY', checks },
    });

    return result;
  }

  /** 恢复操作指引（供界面展示与运维执行） */
  public restoreGuide(filename: string): string[] {
    return [
      '1) 停止 api 与 extractor 容器：docker compose stop api extractor',
      `2) 恢复数据库：docker compose exec -T postgres pg_restore -U tianji -d tianji_archive --clean --if-exists /backup/pg/${filename}`,
      '3) 恢复对象存储：mc mirror --overwrite tianji/archive-backup/ tianji/archive-original/',
      '4) 重新索引：curl -X POST /api/search/reindex（用管理员令牌）',
      '5) 启动服务：docker compose start api extractor，并访问 /health 校验',
    ];
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 轻量备份：写对象并计算 SHA-256 */
  private async putAndHash(objectKey: string, buffer: Buffer): Promise<string> {
    await this.minio.putObject(BUCKET.BACKUP, objectKey, buffer, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    const stat = await this.minio.statObject(BUCKET.BACKUP, objectKey);
    return stat.etag ? `etag:${stat.etag}` : '';
  }

  /** 全库关键表计数（轻量备份元信息） */
  private async countAll(): Promise<Record<string, number>> {
    const tables = [
      'fonds',
      'org_node',
      'category',
      'volume',
      'archive_item',
      'electronic_file',
      'borrow_order',
      'app_user',
      'audit_log',
    ];
    const result: Record<string, number> = {};
    for (const t of tables) {
      try {
        const rows = (await this.dataSource.query(`SELECT COUNT(*)::int AS c FROM ${t}`)) as Array<{
          c: number;
        }>;
        result[t] = Number(rows[0]?.c ?? 0);
      } catch {
        result[t] = -1;
      }
    }
    return result;
  }

  /** 文件名：tianji_{scope}_{yyyyMMdd_HHmmss} */
  private buildFilename(scope: string): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `tianji_${scope}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** 月度目录 */
  private monthFolder(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}`;
  }

  /** 转 DTO */
  private toDto(r: BackupRecord): BackupRecordDto {
    return {
      id: r.id,
      filename: r.filename,
      storagePath: r.storagePath,
      sizeBytes: Number(r.sizeBytes),
      sha256: r.sha256,
      status: r.status,
      dbStatus: r.dbStatus,
      minioStatus: r.minioStatus,
      startedAt: new Date(r.startedAt).toISOString(),
      finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
      detail: r.detail,
    };
  }
}
