import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P5 新功能：数据导入批次 / 保管期限表 / 销毁批次与销毁明细。
 *
 * 设计要点：
 *   - 全部 DDL 幂等（CREATE TABLE IF NOT EXISTS + CREATE ... INDEX IF NOT EXISTS），
 *     重复执行或灰度环境已有部分表时均安全；
 *   - 时间列统一 timestamptz，主键 uuid 默认 gen_random_uuid()；
 *   - JSON 列用 jsonb，与实体 `@Column({ type: 'jsonb' })` 对齐；
 *   - down 仅删表（破坏性），不回滚其它数据，仅紧急回退表结构时使用。
 */
export class AddDataImportRetentionDestroy1700000000013 implements MigrationInterface {
  name = 'AddDataImportRetentionDestroy1700000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- 数据导入批次
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "import_batch" (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
        "batch_no"      varchar(64) NOT NULL,
        "name"          varchar(200) NOT NULL,
        "status"        varchar(16) NOT NULL DEFAULT 'CREATED',
        "template_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_by"    uuid,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "confirmed_at"  timestamptz,
        "file_count"    int NOT NULL DEFAULT 0,
        "success_count" int NOT NULL DEFAULT 0,
        "fail_count"    int NOT NULL DEFAULT 0,
        "detail_json"   jsonb NOT NULL DEFAULT '[]'::jsonb,
        CONSTRAINT "pk_import_batch" PRIMARY KEY ("id"),
        CONSTRAINT "uk_import_batch_no" UNIQUE ("batch_no")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_import_batch_status" ON "import_batch" ("status", "created_at")`,
    );

    // ---------------------------------------------------------------- 保管期限表
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "retention_plan" (
        "id"          uuid NOT NULL DEFAULT gen_random_uuid(),
        "code"        varchar(32) NOT NULL,
        "name"        varchar(100) NOT NULL,
        "years"       int NOT NULL,
        "level"       varchar(16) NOT NULL DEFAULT 'Y30',
        "description" varchar(500),
        "enabled"     boolean NOT NULL DEFAULT TRUE,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_retention_plan" PRIMARY KEY ("id"),
        CONSTRAINT "uk_retention_plan_code" UNIQUE ("code")
      )
    `);

    // ---------------------------------------------------------------- 销毁批次
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "destroy_batch" (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
        "batch_no"      varchar(64) NOT NULL,
        "reason"        varchar(500) NOT NULL,
        "status"        varchar(16) NOT NULL DEFAULT 'PENDING',
        "item_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_by"    uuid,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_destroy_batch" PRIMARY KEY ("id"),
        CONSTRAINT "uk_destroy_batch_no" UNIQUE ("batch_no")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_destroy_batch_status" ON "destroy_batch" ("status", "created_at")`,
    );

    // ---------------------------------------------------------------- 销毁明细/留痕
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "destroy_entry" (
        "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
        "batch_id"   uuid NOT NULL,
        "item_id"    uuid,
        "danghao"    varchar(120) NOT NULL,
        "title"      varchar(500),
        "result"     varchar(32) NOT NULL DEFAULT 'PENDING',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_destroy_entry" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_destroy_entry_batch" ON "destroy_entry" ("batch_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "destroy_entry"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "destroy_batch"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "retention_plan"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "import_batch"`);
  }
}
