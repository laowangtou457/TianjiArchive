import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * sys_param 增补列（PRD 5.5 / 架构 §4.3）。
 *
 * 原表只有 key/value/label/secret，无法承载「参数分区（grp）」「值类型（value_type）」
 * 「是否可编辑（editable，PR-P7 合规固化）」三类元数据，导致：
 *  - 管理端无法按 grp 做分级授权展示（PR-P5）；
 *  - 无法用 editable=false 固化 `log.retention_years`（PR-P7）；
 *  - 后端无法按类型做严格解析。
 *
 * 取值仍以 `PARAM_DEFS`（packages/shared）为唯一定义源；本列只是把它落到库里，
 * 便于 SQL 直接统计与运维排查（不用回溯代码）。
 */
export class AddParamMetaColumns1700000000003 implements MigrationInterface {
  name = 'AddParamMetaColumns1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "system_param" ADD COLUMN IF NOT EXISTS "grp" varchar(32) NOT NULL DEFAULT 'misc'`,
    );
    await queryRunner.query(
      `ALTER TABLE "system_param" ADD COLUMN IF NOT EXISTS "value_type" varchar(16) NOT NULL DEFAULT 'string'`,
    );
    await queryRunner.query(
      `ALTER TABLE "system_param" ADD COLUMN IF NOT EXISTS "editable" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "system_param" ADD COLUMN IF NOT EXISTS "updated_by" varchar(64)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_param_grp" ON "system_param" ("grp")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_param_grp"`);
    await queryRunner.query(`ALTER TABLE "system_param" DROP COLUMN IF EXISTS "updated_by"`);
    await queryRunner.query(`ALTER TABLE "system_param" DROP COLUMN IF EXISTS "editable"`);
    await queryRunner.query(`ALTER TABLE "system_param" DROP COLUMN IF EXISTS "value_type"`);
    await queryRunner.query(`ALTER TABLE "system_param" DROP COLUMN IF EXISTS "grp"`);
  }
}
