import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 扩展功能通用表 extension_record（P6 / P7 / P8）。
 *
 * 设计要点：
 *   - 一张表 + category 区分业务，避免为十几个配置/清单型功能建十几张表；
 *   - DDL 幂等（CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS）；
 *   - body_json 为 jsonb，与实体 @Column({ type: 'jsonb' }) 对齐；
 *   - 时间列 timestamptz，主键 uuid 默认 gen_random_uuid()；
 *   - down 仅删表，仅用于紧急回退表结构。
 *
 * 注意：本迁移只负责建表；ExtensionRecord 实体还需在 entities/index.ts 导出、
 * 并在 typeorm.module.ts 的 ALL_ENTITIES 中注册（由主代理完成）。
 */
export class AddExtensionRecord1700000000014 implements MigrationInterface {
  name = 'AddExtensionRecord1700000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "extension_record" (
        "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
        "category"   varchar(64) NOT NULL,
        "title"      varchar(200) NOT NULL,
        "body_json"  jsonb NOT NULL DEFAULT '{}'::jsonb,
        "status"     varchar(32) NOT NULL DEFAULT 'DRAFT',
        "enabled"    boolean NOT NULL DEFAULT TRUE,
        "created_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_extension_record" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_extension_record_category" ON "extension_record" ("category")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_extension_record_status" ON "extension_record" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_extension_record_cat_status" ON "extension_record" ("category", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "extension_record"`);
  }
}
