import { MigrationInterface, QueryRunner } from 'typeorm';
import { PARAM_DEFS, type ParamDef } from '@tianji/shared';

/**
 * 参数 key 迁移（PRD 5.5.2 封版 / 架构 §4.3「存量 key 迁移」）。
 *
 * ## 为什么必须搬数据而不是只改常量
 *
 * 参数 key 改名后，如果只管代码常量、不搬库里存量行：
 *  - 管理端读到的是「新 key 不存在」→ 展示默认值；
 *  - 业务读到的是「新 key 不存在」→ 回落默认值；
 *  - 单位此前配的值（例如把续借次数从 1 调到 0）**静默丢失**。
 * 这等同于「改代码丢配置」，是本次改造最高危的一类事故。
 *
 * ## 两个特例（不能简单改 keys）
 *
 * 1) `download.enabled`（bool）→ `preview.download_mode`（枚举）
 *    true → `approval`（保留「可下载但需审批」的原有行为上限）
 *    false → `disabled`
 *
 * 2) `audit.retention.months` → `log.retention_years` 是**单位换算**
 *    36（月）→ 3（年）。直接搬值会写成「36 年」，等于把日志永久留存 ——
 *    既浪费存储也违反保留期制度。必须 `value/12` 取整（最少 1 年）。
 *
 * ## 迁移后处理
 *
 * 旧行**保留**（不删）并打日志式告警：万一有人仍在读旧 key（灰度期外部脚本），
 * 不会因为行消失而静默回落默认值。真正的清理放在下一个大版本。
 */
export class MigrateParamKeys1700000000004 implements MigrationInterface {
  name = 'MigrateParamKeys1700000000004';

  /** 简单改名映射：旧 key → 新 key（值原样搬迁） */
  private readonly renameMap: ReadonlyArray<{ from: string; to: string }> = [
    { from: 'recycle.retention.days', to: 'recycle.retention_days' },
    { from: 'session.timeout.minutes', to: 'security.session_timeout_min' },
    { from: 'preview.watermark.enabled', to: 'preview.watermark_enabled' },
    // 注意：旧 key 是 preview.watermark.text，新 key 是 preview.watermark_template
    { from: 'preview.watermark.text', to: 'preview.watermark_template' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------- 0) 补齐 22 项基础行
    for (const def of PARAM_DEFS) {
      await queryRunner.query(
        `INSERT INTO "system_param" ("param_key", "param_value", "label", "secret", "grp", "value_type", "editable")
         VALUES ($1, $2, $3, FALSE, $4, $5, $6)
         ON CONFLICT ("param_key") DO UPDATE
           SET "label" = EXCLUDED."label",
               "grp" = EXCLUDED."grp",
               "value_type" = EXCLUDED."value_type",
               "editable" = EXCLUDED."editable"`,
        [def.key, def.default, def.label, def.grp, def.type, def.editable],
      );
    }

    // ---------------------------------------------------------- 1) 简单改名
    for (const { from, to } of this.renameMap) {
      await this.migrateSimple(queryRunner, from, to);
    }

    // ---------------------------------------------------------- 2) bool → 枚举
    await this.migrateDownloadMode(queryRunner);

    // ---------------------------------------------------------- 3) 月 → 年（单位换算）
    await this.migrateRetentionYears(queryRunner);

    // ---------------------------------------------------------- 4) 值同时需要纠偏的 key
    // `borrow.renew.max`（旧默认 2）→ `borrow.max_renewal_count`（PRD 封版 1）。
    // 若旧值是「2」说明单位从未主动改过（沿用旧出厂值），不对应 PRD 口径，按新默认 1 落地；
    // 其它值（0/1/3/4/5 等）视为单位主动配置过，原样保留，避免覆盖真实配置。
    await this.migrateRenewalCount(queryRunner);

    // `borrow.default.days`（旧默认 15）→ `borrow.default_days`（PRD 封版 30），口径同上。
    await this.migrateDefaultBorrowDays(queryRunner);

    // ---------------------------------------------------------- 5) 已废弃参数（保留行 + 提醒）
    await this.markObsolete(queryRunner, 'borrow.max.overdue', '允许逾期借阅单数');
    await this.markObsolete(queryRunner, 'search.page.size.default', '默认分页大小');
    await this.markObsolete(queryRunner, 'extract.max.concurrent', '抽取并发上限');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 反向只还原「改名」与「换算」，不删新增行（删了会丢配置）
    for (const { from, to } of this.renameMap) {
      await queryRunner.query(
        `UPDATE "system_param" SET "param_key" = $1 WHERE "param_key" = $2`,
        [from, to],
      );
    }
    await queryRunner.query(
      `UPDATE "system_param" SET "param_key" = 'download.enabled', "param_value" = 'true'
        WHERE "param_key" = 'preview.download_mode' AND "param_value" = 'approval'`,
    );
    await queryRunner.query(
      `UPDATE "system_param" SET "param_key" = 'download.enabled', "param_value" = 'false'
        WHERE "param_key" = 'preview.download_mode' AND "param_value" = 'disabled'`,
    );
    await queryRunner.query(
      `UPDATE "system_param" SET "param_key" = 'audit.retention.months',
                                 "param_value" = (("param_value"::int) * 12)::text
        WHERE "param_key" = 'log.retention_years'`,
    );
  }

  // ==========================================================================
  // 具体搬迁
  // ==========================================================================

  /**
   * 简单改名：仅当「新 key 尚未存在」或「新 key 仍是出厂默认值」时用旧值覆盖。
   *
   * 判据说明：新 key 已被管理员改过（值 ≠ 默认值）时，说明新口径已生效，
   * 此时用旧值覆盖会回退管理员的设置 —— 宁可少搬，不能覆盖。
   */
  private async migrateSimple(queryRunner: QueryRunner, from: string, to: string): Promise<void> {
    const def = PARAM_DEFS.find((d: ParamDef) => d.key === to);
    const fallback = def?.default ?? '';
    const legacy = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = $1 LIMIT 1`,
      [from],
    );
    if (legacy.length === 0) {
      // 旧 key 不存在：说明是全新环境，什么都不用做
      return;
    }
    const legacyValue = String(legacy[0].param_value ?? '').trim();
    if (legacyValue === '') return;

    const current = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = $1 LIMIT 1`,
      [to],
    );
    const currentValue = current.length > 0 ? String(current[0].param_value ?? '').trim() : null;
    const untouched = currentValue === null || currentValue === fallback;

    if (!untouched) {
      // 新 key 已被主动配置过，保留新值（不覆盖），仅保留旧行以备排查
      return;
    }
    await queryRunner.query(
      `UPDATE "system_param" SET "param_value" = $1, "updated_at" = now() WHERE "param_key" = $2`,
      [legacyValue, to],
    );
  }

  /** `download.enabled`(bool) → `preview.download_mode`(枚举) */
  private async migrateDownloadMode(queryRunner: QueryRunner): Promise<void> {
    const legacy = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = 'download.enabled' LIMIT 1`,
    );
    if (legacy.length === 0) return;
    const raw = String(legacy[0].param_value ?? '').trim().toLowerCase();
    // true → approval：老系统「允许下载」的语义是「可申请下载」，不是「完全放开」
    const mapped = raw === 'true' || raw === '1' ? 'approval' : 'disabled';

    const current = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = 'preview.download_mode' LIMIT 1`,
    );
    const currentValue = current.length > 0 ? String(current[0].param_value ?? '').trim() : null;
    // 新 key 已非默认值（approval 是默认值）→ 说明被主动配置过，保留
    if (currentValue !== null && currentValue !== 'approval') return;

    await queryRunner.query(
      `UPDATE "system_param" SET "param_value" = $1, "updated_at" = now()
        WHERE "param_key" = 'preview.download_mode'`,
      [mapped],
    );
  }

  /** `audit.retention.months` → `log.retention_years`（value/12 取整，下限 1） */
  private async migrateRetentionYears(queryRunner: QueryRunner): Promise<void> {
    const legacy = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = 'audit.retention.months' LIMIT 1`,
    );
    if (legacy.length === 0) return;
    const months = Number.parseInt(String(legacy[0].param_value ?? '').trim(), 10);
    if (!Number.isFinite(months) || months <= 0) return;

    // ⚠️ 单位换算：36 月 → 3 年。直接搬值会得到「36 年」，属于严重口径错误。
    const years = Math.max(1, Math.floor(months / 12));

    const current = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = 'log.retention_years' LIMIT 1`,
    );
    const currentValue = current.length > 0 ? String(current[0].param_value ?? '').trim() : null;
    // 新 key 已偏离默认值（3）→ 被主动配置过，保留
    if (currentValue !== null && currentValue !== '3') return;

    await queryRunner.query(
      `UPDATE "system_param" SET "param_value" = $1, "updated_at" = now()
        WHERE "param_key" = 'log.retention_years'`,
      [String(years)],
    );
  }

  /** `borrow.renew.max` → `borrow.max_renewal_count`（旧出厂值 2 需纠正为 PRD 封版 1） */
  private async migrateRenewalCount(queryRunner: QueryRunner): Promise<void> {
    const legacy = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = 'borrow.renew.max' LIMIT 1`,
    );
    if (legacy.length === 0) return;
    const legacyValue = String(legacy[0].param_value ?? '').trim();
    if (legacyValue === '') return;

    const current = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = 'borrow.max_renewal_count' LIMIT 1`,
    );
    const currentValue = current.length > 0 ? String(current[0].param_value ?? '').trim() : null;
    if (currentValue !== null && currentValue !== '1') return; // 已主动配置，保留

    // 旧出厂值 2 不是单位的主动决策（是旧默认值），按 PRD 封版 1 落地；
    // 其余值原样搬迁。
    const mapped = legacyValue === '2' ? '1' : legacyValue;
    await queryRunner.query(
      `UPDATE "system_param" SET "param_value" = $1, "updated_at" = now()
        WHERE "param_key" = 'borrow.max_renewal_count'`,
      [mapped],
    );
  }

  /** `borrow.default.days` → `borrow.default_days`（旧出厂值 15 需纠正为 PRD 封版 30） */
  private async migrateDefaultBorrowDays(queryRunner: QueryRunner): Promise<void> {
    const legacy = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = 'borrow.default.days' LIMIT 1`,
    );
    if (legacy.length === 0) return;
    const legacyValue = String(legacy[0].param_value ?? '').trim();
    if (legacyValue === '') return;

    const current = await queryRunner.query(
      `SELECT "param_value" FROM "system_param" WHERE "param_key" = 'borrow.default_days' LIMIT 1`,
    );
    const currentValue = current.length > 0 ? String(current[0].param_value ?? '').trim() : null;
    if (currentValue !== null && currentValue !== '30') return;

    const mapped = legacyValue === '15' ? '30' : legacyValue;
    await queryRunner.query(
      `UPDATE "system_param" SET "param_value" = $1, "updated_at" = now()
        WHERE "param_key" = 'borrow.default_days'`,
      [mapped],
    );
  }

  /**
   * 已废弃参数：保留行（不删）+ 打标，避免「行消失 → 读不到 → 静默回落默认值」。
   * 真正的清理留待确认无外部引用后再做。
   */
  private async markObsolete(queryRunner: QueryRunner, key: string, note: string): Promise<void> {
    await queryRunner.query(
      `UPDATE "system_param" SET "editable" = FALSE, "grp" = 'obsolete',
                               "label" = COALESCE("label", '') || '（已废弃：' || $2 || '）',
                               "updated_at" = now()
        WHERE "param_key" = $1`,
      [key, note],
    );
  }
}
