import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 检索同义词表（对齐泰坦 DARMS 同义词维护）。
 *
 * 建表 + 若干常用档案领域同义词组作为种子数据（可按业务删除）：
 *   - 档案 / 卷宗 / 案卷
 *   - 归档 / 存档 / 立卷
 *   - 借阅 / 借出 / 外借
 *   - 保管期限 / 保存期限
 *   - 密级 / 保密级别
 *
 * 种子数据用 `WHERE NOT EXISTS` 幂等，重跑不会重复插入。
 */
export class AddSearchSynonym1700000008000 implements MigrationInterface {
  name = 'AddSearchSynonym1700000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "search_synonym" (
        "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
        "words"      text[] NOT NULL,
        "note"       varchar(200),
        "enabled"    boolean NOT NULL DEFAULT TRUE,
        "created_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_search_synonym" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_synonym_enabled" ON "search_synonym" ("enabled")`,
    );

    const seeds: Array<[string[], string]> = [
      [['档案', '卷宗', '案卷'], '档案领域基础同义（种子）'],
      [['归档', '存档', '立卷'], '归档动作同义（种子）'],
      [['借阅', '借出', '外借'], '利用服务同义（种子）'],
      [['保管期限', '保存期限'], '保管期限同义（种子）'],
      [['密级', '保密级别'], '密级同义（种子）'],
      [['查阅', '查档', '利用'], '利用服务同义（种子）'],
    ];
    for (const [words, note] of seeds) {
      await queryRunner.query(
        `INSERT INTO "search_synonym" ("words", "note")
         SELECT $1::text[], $2
          WHERE NOT EXISTS (
            SELECT 1 FROM "search_synonym" WHERE "words" = $1::text[]
          )`,
        [words, note],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "search_synonym"`);
  }
}
