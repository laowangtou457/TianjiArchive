import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wiki 批量导入支持：页面级密级 + 来源档案条目引用。
 *
 *   - security_level：按「书籍类型」建空间时，同一空间内密级混合
 *     （如裁判文书含公开/内部/涉密卷），页面继承来源条目密级，
 *     空间密级只作上限；可见性按页面密级逐页判定（fail-closed）。
 *   - source_item_id：幂等续跑的去重键。Partial unique index：
 *     同一来源条目在未删除页面中唯一 —— 页面被删后允许再次导入，
 *     导入中断重跑时按此键跳过已导入页面。
 */
export class AddWikiPageSource17000000000112 implements MigrationInterface {
  name = 'AddWikiPageSource17000000000112';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "wiki_page" ADD COLUMN IF NOT EXISTS "source_item_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "wiki_page" ADD COLUMN IF NOT EXISTS "security_level" varchar(16)`,
    );
    await queryRunner.query(
      `UPDATE "wiki_page" SET "security_level" = 'INTERNAL' WHERE "security_level" IS NULL`,
    );
    // 既有页面的密级对齐到所属空间（存量数据一次性校准）
    await queryRunner.query(
      `UPDATE "wiki_page" p SET "security_level" = s."security_level"
         FROM "wiki_space" s WHERE p."space_id" = s."id" AND p."security_level" = 'INTERNAL'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_wiki_page_source"
         ON "wiki_page" ("source_item_id")
        WHERE "source_item_id" IS NOT NULL AND "deleted" = FALSE`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_wiki_page_source" ON "wiki_page" ("source_item_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_wiki_page_level" ON "wiki_page" ("security_level")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uk_wiki_page_source"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_wiki_page_source"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_wiki_page_level"`);
    await queryRunner.query(`ALTER TABLE "wiki_page" DROP COLUMN IF EXISTS "source_item_id"`);
    await queryRunner.query(`ALTER TABLE "wiki_page" DROP COLUMN IF EXISTS "security_level"`);
  }
}
