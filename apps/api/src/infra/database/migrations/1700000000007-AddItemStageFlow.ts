import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 归档阶段状态机落地（对齐泰坦 DARMS 收集链路）：
 *
 * 1) archive_item 补「归档人/归档时间」列（确认归档留痕，IF NOT EXISTS 幂等）；
 * 2) 新建 item_stage_log 阶段流转日志表（只插不改删）；
 * 3) 历史已归档数据回填 archived_at（用 updated_at 近似，误差为最后一次修改时间）。
 *
 * 注意：状态枚举新增 PRE_ARCHIVED / NO_ARCHIVE 是 varchar 列上的取值扩展，
 * 无需 DDL；新状态由应用层 ITEM_STAGE_TRANSITIONS 校验。
 */
export class AddItemStageFlow1700000007000 implements MigrationInterface {
  name = 'AddItemStageFlow1700000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) 归档留痕列（幂等）
    await queryRunner.query(
      `ALTER TABLE "archive_item" ADD COLUMN IF NOT EXISTS "archived_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "archive_item" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_item_archived_at" ON "archive_item" ("archived_at")`,
    );

    // 2) 阶段流转日志表
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "item_stage_log" (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
        "item_id"       uuid NOT NULL,
        "action"        varchar(32) NOT NULL,
        "action_label"  varchar(64) NOT NULL,
        "from_status"   varchar(16),
        "to_status"     varchar(16) NOT NULL,
        "reason"        varchar(500),
        "operator_id"   uuid,
        "operator_name" varchar(64),
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_item_stage_log" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_stage_log_item" ON "item_stage_log" ("item_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_stage_log_action" ON "item_stage_log" ("action")`,
    );

    // 3) 历史数据回填：已归档条目补 archived_at（≈最后修改时间，可接受近似）
    await queryRunner.query(`
      UPDATE "archive_item"
         SET "archived_at" = "updated_at"
       WHERE "status" = 'ARCHIVED'
         AND "archived_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "item_stage_log"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_item_archived_at"`);
    await queryRunner.query(`ALTER TABLE "archive_item" DROP COLUMN IF EXISTS "archived_at"`);
    await queryRunner.query(`ALTER TABLE "archive_item" DROP COLUMN IF EXISTS "archived_by"`);
  }
}
