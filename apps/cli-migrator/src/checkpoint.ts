import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** 断点状态 */
export type CheckpointStatus = 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';

/** 单条迁移记录 */
export interface CheckpointRow {
  danghao: string;
  status: CheckpointStatus;
  attempts: number;
  itemId: string | null;
  fileCount: number;
  error: string | null;
  updatedAt: string;
}

/**
 * 断点续传（SQLite 本地状态库，PRD F-12）。
 *
 * 设计：
 *   - 以档号为主键，记录 DONE/FAILED/PENDING，重跑时跳过 DONE；
 *   - 每次状态变更即时提交（WAL 模式），进程被杀也不丢进度；
 *   - 同时保存「目录行快照」与「文件清单」，使续传无需重新解析 Excel/扫描目录。
 */
export class Checkpoint {
  private readonly db: Database.Database;
  private readonly dbPath: string;

  public constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  /** 建表 */
  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint (
        danghao    TEXT PRIMARY KEY,
        status     TEXT NOT NULL DEFAULT 'PENDING',
        attempts   INTEGER NOT NULL DEFAULT 0,
        item_id    TEXT,
        file_count INTEGER NOT NULL DEFAULT 0,
        error      TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoint_status ON checkpoint(status);

      CREATE TABLE IF NOT EXISTS checkpoint_file (
        danghao  TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        abs_path TEXT NOT NULL,
        size     INTEGER NOT NULL DEFAULT 0,
        status   TEXT NOT NULL DEFAULT 'PENDING',
        object_key TEXT,
        error    TEXT,
        PRIMARY KEY (danghao, rel_path)
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  /** 写入元信息（源文件名、启动时间等） */
  public setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** 读取元信息 */
  public getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** 批量登记待迁移档号（已存在的保持原状，保证续传） */
  public seed(danghaos: Array<{ danghao: string; files: Array<{ relPath: string; absPath: string; size: number }> }>): void {
    const insertRow = this.db.prepare(
      'INSERT INTO checkpoint (danghao, status) VALUES (?, ?) ON CONFLICT(danghao) DO NOTHING',
    );
    const insertFile = this.db.prepare(
      `INSERT INTO checkpoint_file (danghao, rel_path, abs_path, size)
       VALUES (?, ?, ?, ?) ON CONFLICT(danghao, rel_path) DO NOTHING`,
    );
    const tx = this.db.transaction(
      (items: Array<{ danghao: string; files: Array<{ relPath: string; absPath: string; size: number }> }>) => {
        for (const it of items) {
          insertRow.run(it.danghao, 'PENDING');
          for (const f of it.files) insertFile.run(it.danghao, f.relPath, f.absPath, f.size);
        }
      },
    );
    tx(danghaos);
  }

  /** 取待处理档号（跳过 DONE；FAILED 可重试） */
  public pending(limit = 1000): string[] {
    const rows = this.db
      .prepare(
        `SELECT danghao FROM checkpoint WHERE status IN ('PENDING','FAILED') ORDER BY danghao LIMIT ?`,
      )
      .all(limit) as Array<{ danghao: string }>;
    return rows.map((r) => r.danghao);
  }

  /** 取某档号的文件清单 */
  public filesOf(danghao: string): Array<{ relPath: string; absPath: string; size: number }> {
    return this.db
      .prepare('SELECT rel_path AS relPath, abs_path AS absPath, size FROM checkpoint_file WHERE danghao = ?')
      .all(danghao) as Array<{ relPath: string; absPath: string; size: number }>;
  }

  /** 标记成功 */
  public markDone(danghao: string, itemId: string, fileCount: number): void {
    this.db
      .prepare(
        `UPDATE checkpoint
            SET status='DONE', item_id=?, file_count=?, error=NULL, attempts=attempts+1, updated_at=datetime('now')
          WHERE danghao = ?`,
      )
      .run(itemId, fileCount, danghao);
    this.db
      .prepare(`UPDATE checkpoint_file SET status='DONE' WHERE danghao = ?`)
      .run(danghao);
  }

  /** 标记失败（记录原因，重跑会重试） */
  public markFailed(danghao: string, error: string): void {
    this.db
      .prepare(
        `UPDATE checkpoint
            SET status='FAILED', error=?, attempts=attempts+1, updated_at=datetime('now')
          WHERE danghao = ?`,
      )
      .run(error.slice(0, 500), danghao);
  }

  /** 标记跳过（如 Excel 行校验失败） */
  public markSkipped(danghao: string, error: string): void {
    this.db
      .prepare(
        `UPDATE checkpoint
            SET status='SKIPPED', error=?, updated_at=datetime('now')
          WHERE danghao = ?`,
      )
      .run(error.slice(0, 500), danghao);
  }

  /** 单个文件迁移状态（用于对象存储断点） */
  public markFileDone(danghao: string, relPath: string, objectKey: string): void {
    this.db
      .prepare(
        `UPDATE checkpoint_file SET status='DONE', object_key=?, error=NULL
          WHERE danghao = ? AND rel_path = ?`,
      )
      .run(objectKey, danghao, relPath);
  }

  /** 单个文件失败 */
  public markFileFailed(danghao: string, relPath: string, error: string): void {
    this.db
      .prepare(`UPDATE checkpoint_file SET status='FAILED', error=? WHERE danghao = ? AND rel_path = ?`)
      .run(error.slice(0, 500), danghao, relPath);
  }

  /** 统计（报告用） */
  public summary(): {
    total: number;
    done: number;
    failed: number;
    skipped: number;
    pending: number;
    filesDone: number;
    filesFailed: number;
  } {
    const s = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status='DONE' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status='SKIPPED' THEN 1 ELSE 0 END) AS skipped,
           SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending
         FROM checkpoint`,
      )
      .get() as Record<string, number | null>;
    const f = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status='DONE' THEN 1 ELSE 0 END) AS files_done,
           SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS files_failed
         FROM checkpoint_file`,
      )
      .get() as Record<string, number | null>;
    return {
      total: Number(s.total ?? 0),
      done: Number(s.done ?? 0),
      failed: Number(s.failed ?? 0),
      skipped: Number(s.skipped ?? 0),
      pending: Number(s.pending ?? 0),
      filesDone: Number(f.files_done ?? 0),
      filesFailed: Number(f.files_failed ?? 0),
    };
  }

  /** 失败明细（报告用） */
  public failures(limit = 200): Array<{ danghao: string; error: string; attempts: number }> {
    return this.db
      .prepare(
        `SELECT danghao, COALESCE(error,'') AS error, attempts FROM checkpoint
          WHERE status IN ('FAILED','SKIPPED') ORDER BY danghao LIMIT ?`,
      )
      .all(limit) as Array<{ danghao: string; error: string; attempts: number }>;
  }

  /** 关闭 */
  public close(): void {
    this.db.close();
  }

  /** 路径（日志展示） */
  public get path(): string {
    return this.dbPath;
  }

  /** 清空（重跑全量） */
  public reset(): void {
    this.db.exec('DELETE FROM checkpoint; DELETE FROM checkpoint_file;');
  }
}
