import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import {
  RecycleObjectType,
  type PermissionSnapshot,
  type RecycleBinDto,
  BizException,
  ErrorCode,
} from '@tianji/shared';
import { RecycleBin } from '../../infra/database/entities/recycle-bin.entity';
import { asPartialUpdate } from '../../common/types/typeorm-helpers';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { AppUser } from '../../infra/database/entities/user.entity';
import { MinioService } from '../../infra/storage/storage.module';
import { ParamService } from '../param/param.service';

/**
 * 回收站服务（F-18 最小实现）。
 *
 * 流程：
 *   1) 删除档案 → ArchiveService 软删除（deleted=true）+ 调用 RecycleService.record 入回收站；
 *   2) 还原 → 恢复 deleted=false（顺序：卷 → 件），并校验原档号是否被占用；
 *   3) 销毁 → 物理删除条目/案卷（电子文件同时清理对象存储）；
 *   4) 清理 → 超过 purge_after 的记录由定时任务清除（每天 04:00）。
 *
 * 权限：仅 ARCHIVE/RECYCLE 相关的管理员可见全部；普通用户不可见回收站。
 */
@Injectable()
export class RecycleService {
  private readonly logger = new Logger(RecycleService.name);

  public constructor(
    @InjectRepository(RecycleBin) private readonly recycleRepo: Repository<RecycleBin>,
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(Volume) private readonly volumeRepo: Repository<Volume>,
    @InjectRepository(ElectronicFile) private readonly fileRepo: Repository<ElectronicFile>,
    @InjectRepository(AppUser) private readonly userRepo: Repository<AppUser>,
    private readonly minio: MinioService,
    private readonly paramService: ParamService,
  ) {}

  /**
   * 回收站保留天数（F-18 / `recycle.retention_days`）。
   *
   * D-2 增量生效：每次登记删除时按**当前**参数计算新的到期日，
   * 已存在的 purge_after 不重算——否则把 30 改成 90 会让老数据凭空续命，
   * 把 90 改成 7 会立刻销毁本该还在保留期的数据。
   */
  private async retentionDays(): Promise<number> {
    try {
      const n = await this.paramService.getInt('recycle.retention_days');
      return Number.isFinite(n) && n > 0 ? n : 30;
    } catch (err) {
      this.logger.error(`读取回收站保留天数失败，回落 30 天: ${(err as Error).message}`);
      return 30;
    }
  }

  /** 登记删除（供 ArchiveService 调用）；同对象重复登记则覆盖 */
  public async record(input: {
    objectType: RecycleObjectType;
    objectId: string;
    objectLabel: string;
    snapshot: Record<string, unknown>;
    deletedBy: string | null;
  }): Promise<void> {
    const retentionDays = await this.retentionDays();
    const purgeAfter = new Date(Date.now() + retentionDays * 86400000);
    const existing = await this.recycleRepo.findOne({
      where: { objectType: input.objectType, objectId: input.objectId },
    });
    if (existing) {
      await this.recycleRepo.update(
        { id: existing.id },
        asPartialUpdate<RecycleBin>({
          objectLabel: input.objectLabel,
          snapshot: input.snapshot,
          deletedBy: input.deletedBy,
          deletedAt: new Date(),
          purgeAfter,
        }),
      );
      return;
    }
    const row = this.recycleRepo.create({
      objectType: input.objectType,
      objectId: input.objectId,
      objectLabel: input.objectLabel,
      snapshot: input.snapshot,
      deletedBy: input.deletedBy,
      deletedAt: new Date(),
      purgeAfter,
    });
    await this.recycleRepo.save(row);
  }

  /** 回收站列表（按类型/关键词过滤） */
  public async list(
    query: { objectType?: RecycleObjectType; keyword?: string; page?: number; size?: number },
    _user: PermissionSnapshot,
  ): Promise<{ items: RecycleBinDto[]; total: number; page: number; size: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const size = Math.min(100, Math.max(1, Number(query.size ?? 20)));

    const qb = this.recycleRepo.createQueryBuilder('r');
    if (query.objectType) qb.andWhere('r.object_type = :t', { t: query.objectType });
    if (query.keyword) qb.andWhere('r.object_label ILIKE :kw', { kw: `%${query.keyword}%` });
    qb.orderBy('r.deleted_at', 'DESC').skip((page - 1) * size).take(size);

    const [rows, total] = await qb.getManyAndCount();
    const userIds = [...new Set(rows.map((r) => r.deletedBy).filter((x): x is string => !!x))];
    const users = userIds.length
      ? await this.userRepo.find({ where: { id: In(userIds) }, select: ['id', 'displayName', 'username'] })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    const now = Date.now();

    return {
      items: rows.map((r) => ({
        id: r.id,
        objectType: r.objectType,
        objectId: r.objectId,
        objectLabel: r.objectLabel,
        deletedBy: r.deletedBy,
        deletedByName: r.deletedBy ? userMap.get(r.deletedBy)?.displayName ?? null : null,
        deletedAt: new Date(r.deletedAt).toISOString(),
        purgeAfter: new Date(r.purgeAfter).toISOString(),
        canRestore: r.purgeAfter.getTime() > now,
      })),
      total,
      page,
      size,
    };
  }

  /**
   * 还原：卷 → 先恢复案卷，再恢复其下条目；件 → 仅恢复该件并回补卷内件数。
   * 若已过保留期则拒绝。
   */
  public async restore(recycleId: string, _user: PermissionSnapshot): Promise<{ restored: boolean }> {
    const rec = await this.recycleRepo.findOne({ where: { id: recycleId } });
    if (!rec) throw new BizException(ErrorCode.NOT_FOUND, '回收站记录不存在');
    if (rec.purgeAfter.getTime() <= Date.now()) {
      throw new BizException(ErrorCode.RECYCLE_EXPIRED, '该数据已超过保留期，无法还原');
    }

    if (rec.objectType === RecycleObjectType.VOLUME) {
      const vol = await this.volumeRepo.findOne({ where: { id: rec.objectId } });
      if (!vol) throw new BizException(ErrorCode.NOT_FOUND, '原案卷已不存在');
      // 档号占用校验（可能已被新案卷使用）
      const conflict = await this.volumeRepo.count({
        where: { danghao: vol.danghao, deleted: false },
      });
      if (conflict > 0) {
        throw new BizException(
          ErrorCode.ARCHIVE_NO_CONFLICT,
          `档号 ${vol.danghao} 已被其他案卷占用，无法还原（请用迁移工具重新挂接）`,
        );
      }
      await this.volumeRepo.update({ id: vol.id }, { deleted: false });
      await this.itemRepo.update({ volumeId: vol.id, deleted: true }, { deleted: false });
    } else if (rec.objectType === RecycleObjectType.ITEM) {
      const item = await this.itemRepo.findOne({ where: { id: rec.objectId } });
      if (!item) throw new BizException(ErrorCode.NOT_FOUND, '原条目已不存在');
      const conflict = await this.itemRepo.count({ where: { danghao: item.danghao, deleted: false } });
      if (conflict > 0) {
        throw new BizException(
          ErrorCode.ARCHIVE_NO_CONFLICT,
          `档号 ${item.danghao} 已被其他条目占用，无法还原`,
        );
      }
      await this.itemRepo.update({ id: item.id }, { deleted: false });
      if (item.volumeId) {
        await this.volumeRepo.increment({ id: item.volumeId }, 'itemCount', 1);
      }
    } else {
      throw new BizException(ErrorCode.NOT_FOUND, '电子文件不通过回收站还原，请在条目下重新上传');
    }

    await this.recycleRepo.delete({ id: rec.id });
    this.logger.log(`回收站还原 ${rec.objectType} ${rec.objectLabel ?? rec.objectId}`);
    return { restored: true };
  }

  /** 彻底销毁（物理删除 + 对象存储清理） */
  public async purge(recycleId: string, _user: PermissionSnapshot): Promise<{ purged: boolean }> {
    const rec = await this.recycleRepo.findOne({ where: { id: recycleId } });
    if (!rec) throw new BizException(ErrorCode.NOT_FOUND, '回收站记录不存在');

    if (rec.objectType === RecycleObjectType.ITEM) {
      const files = await this.fileRepo.find({ where: { itemId: rec.objectId } });
      for (const f of files) {
        await this.safeRemoveObject(f.bucket, f.objectKey);
        if (f.previewKey) await this.safeRemoveObject(this.minio.buckets.preview, f.previewKey);
        if (f.thumbKey) await this.safeRemoveObject(this.minio.buckets.thumb, f.thumbKey);
      }
      await this.fileRepo.delete({ itemId: rec.objectId });
      await this.itemRepo.delete({ id: rec.objectId });
    } else if (rec.objectType === RecycleObjectType.VOLUME) {
      const items = await this.itemRepo.find({ where: { volumeId: rec.objectId }, select: ['id'] });
      for (const it of items) {
        const files = await this.fileRepo.find({ where: { itemId: it.id } });
        for (const f of files) {
          await this.safeRemoveObject(f.bucket, f.objectKey);
        }
        await this.fileRepo.delete({ itemId: it.id });
      }
      await this.itemRepo.delete({ volumeId: rec.objectId });
      await this.volumeRepo.delete({ id: rec.objectId });
    }

    await this.recycleRepo.delete({ id: rec.id });
    this.logger.warn(`回收站彻底销毁 ${rec.objectType} ${rec.objectLabel ?? rec.objectId}`);
    return { purged: true };
  }

  /** 过期清理（定时任务调用），返回清理条数 */
  public async purgeExpired(): Promise<number> {
    const expired = await this.recycleRepo.find({ where: { purgeAfter: LessThan(new Date()) } });
    let count = 0;
    for (const rec of expired) {
      try {
        await this.purge(rec.id, {
          userId: 'system',
          username: 'system',
          displayName: 'system',
          roles: [],
          grants: {},
          maxSecurityLevel: 'SECRET',
          scopes: [{ scopeType: 'ALL', scopeRefId: null }],
          fondsIds: null,
          orgIds: null,
          selfOnly: false,
        });
        count += 1;
      } catch (err) {
        this.logger.error(`过期清理失败 ${rec.id}: ${(err as Error).message}`);
      }
    }
    return count;
  }

  /** 对象删除容错（对象可能已被外部清理） */
  private async safeRemoveObject(bucket: string, key: string): Promise<void> {
    try {
      await this.minio.removeObject(bucket, key);
    } catch (err) {
      this.logger.warn(`对象删除失败 ${bucket}/${key}: ${(err as Error).message}`);
    }
  }
}
