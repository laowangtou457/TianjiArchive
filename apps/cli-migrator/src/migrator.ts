import type { Pool as PgPool } from 'pg';
import { Client as MinioClient } from 'minio';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BUCKET, ExtractStatus, QUEUE_NAME } from '@tianji/shared';
import type { CatalogRow } from './excel.reader';
import type { FileEntry } from './file.matcher';
import type { MigrationResultItem } from './report';

/** 迁移选项 */
export interface MigratorOptions {
  /** 试运行：只校验与匹配，不写库、不上传 */
  dryRun: boolean;
  /** 每个档号最多挂接文件数（防止误把整目录挂到一个档号） */
  maxFilesPerItem: number;
  /** 上传并发 */
  concurrency: number;
  /** 迁移操作人（写入 created_by 与审计） */
  operator: string;
  /** 是否入抽取队列 */
  enqueueExtract: boolean;
}

/** 迁移器：Excel 目录 + 文件树 → PG + MinIO */
export class Migrator {
  public constructor(
    private readonly pg: PgPool,
    private readonly minio: MinioClient,
    private readonly options: MigratorOptions,
  ) {}

  /** 迁移单个档号（幂等：档号已存在则跳过并返回其 ID） */
  public async migrateOne(
    row: CatalogRow,
    files: FileEntry[],
  ): Promise<MigrationResultItem> {
    try {
      if (this.options.dryRun) {
        return {
          danghao: row.danghao,
          status: 'DONE',
          itemId: null,
          fileCount: files.length,
          error: files.length > this.options.maxFilesPerItem ? '试运行：文件数超阈值' : null,
        };
      }

      // 1) 解析全宗与门类
      const fondsId = await this.resolveFondsId(row.fondsNo);
      const categoryId = await this.resolveCategoryId(row.categoryCode);

      // 2) 幂等：档号已存在则直接返回
      const existing = await this.pg.query<{ id: string }>(
        `SELECT id FROM archive_item WHERE danghao = $1`,
        [row.danghao],
      );
      if (existing.rows.length > 0) {
        return {
          danghao: row.danghao,
          status: 'DONE',
          itemId: existing.rows[0].id,
          fileCount: 0,
          error: '档号已存在（跳过，未重复挂接文件）',
        };
      }

      // 3) 写入条目
      const inserted = await this.pg.query<{ id: string }>(
        `INSERT INTO archive_item
           (danghao, fonds_id, category_id, title, responsible, year, retention, security_level,
            start_date, end_date, keywords, note, status, open_flag, extra, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT','OPEN',$13::jsonb,$14)
         RETURNING id`,
        [
          row.danghao,
          fondsId,
          categoryId,
          row.title,
          row.responsible || null,
          row.year,
          row.retention,
          row.securityLevel,
          row.startDate,
          row.endDate,
          row.keywords,
          row.note || null,
          JSON.stringify({ migratedFrom: 'cli-migrator', sourceRow: row.rowNo, raw: row.raw }),
          this.options.operator,
        ],
      );
      const itemId = inserted.rows[0].id;

      // 4) 上传文件（超过阈值的报错交由人工处理）
      if (files.length > this.options.maxFilesPerItem) {
        return {
          danghao: row.danghao,
          status: 'FAILED',
          itemId,
          fileCount: 0,
          error: `匹配到 ${files.length} 个文件，超过单件上限 ${this.options.maxFilesPerItem}，请人工确认`,
        };
      }

      let uploaded = 0;
      for (const file of files) {
        await this.uploadOne(itemId, row, file);
        uploaded += 1;
      }

      // 5) 更新卷内件数（无卷时跳过）
      return {
        danghao: row.danghao,
        status: 'DONE',
        itemId,
        fileCount: uploaded,
        error: null,
      };
    } catch (err) {
      return {
        danghao: row.danghao,
        status: 'FAILED',
        itemId: null,
        fileCount: 0,
        error: (err as Error).message,
      };
    }
  }

  /** 上传单文件并登记 electronic_file */
  private async uploadOne(itemId: string, row: CatalogRow, file: FileEntry): Promise<void> {
    const ext = path.extname(file.filename);
    const objectKey = `migrated/${row.year}/${row.danghao}/${this.safeName(file.filename)}`;

    const stat = await fs.stat(file.absPath);
    const sha256 = await this.hashFile(file.absPath);
    const mime = this.guessMime(ext);

    // 1) 上传对象
    await this.minio.putObject(BUCKET.ORIGINAL, objectKey, createReadStream(file.absPath), stat.size, {
      'Content-Type': mime,
    });

    // 2) 登记（唯一约束 bucket+object_key 保证幂等）
    await this.pg.query(
      `INSERT INTO electronic_file
         (item_id, bucket, object_key, filename, mime, size, sha256, extract_status, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (bucket, object_key) DO NOTHING`,
      [
        itemId,
        BUCKET.ORIGINAL,
        objectKey,
        file.filename,
        mime,
        stat.size,
        sha256,
        ExtractStatus.PENDING,
        this.options.operator,
      ],
    );
  }

  /** 解析全宗：优先按编号，缺失则按名称，仍无则报错 */
  private async resolveFondsId(fondsNo: string): Promise<string> {
    if (!fondsNo) throw new Error('Excel 缺少全宗号，无法定位全宗');
    const r = await this.pg.query<{ id: string }>(`SELECT id FROM fonds WHERE fonds_no = $1`, [fondsNo]);
    if (r.rows.length === 0) {
      throw new Error(`全宗号 ${fondsNo} 不存在，请先在系统中创建全宗`);
    }
    return r.rows[0].id;
  }

  /** 解析门类：按编码，缺失时返回 null（允许门类为空） */
  private async resolveCategoryId(code: string): Promise<string | null> {
    if (!code) return null;
    const r = await this.pg.query<{ id: string }>(`SELECT id FROM category WHERE code = $1`, [code]);
    return r.rows.length > 0 ? r.rows[0].id : null;
  }

  /** 流式计算 SHA-256 */
  private hashFile(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (c) => hash.update(c));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /** 文件名安全化（去非法字符，保留中文） */
  private safeName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
  }

  /** 扩展名 → MIME（迁移场景够用即可） */
  private guessMime(ext: string): string {
    const map: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.tif': 'image/tiff',
      '.tiff': 'image/tiff',
      '.bmp': 'image/bmp',
      '.gif': 'image/gif',
      '.txt': 'text/plain',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.ofd': 'application/ofd',
    };
    return map[ext.toLowerCase()] ?? 'application/octet-stream';
  }

  /** 队列名（供 CLI 提示） */
  public static queueName(): string {
    return QUEUE_NAME.EXTRACT;
  }
}
