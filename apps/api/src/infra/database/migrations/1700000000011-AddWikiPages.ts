import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 知识 Wiki（可编辑页面库）：空间 / 页面树 / 页面版本 / 页面向量切片。
 *
 * 设计要点：
 *   - 密级在空间级（wiki_space.security_level），页面继承，检索过滤同档案口径；
 *   - 版本为全量快照，每页保留最近 50 版（淘汰由 Service 层执行）；
 *   - wiki_chunk.embedding 与 item_chunk 同策略：有 pgvector 用 vector(768)，
 *     否则 double precision[]（应用内余弦降级）；
 *   - 角色授权：R1 编研主力（READ+WRITE），R0/R2/R3/R4 只读（READ）。
 *     权限矩阵在 role.permissions（jsonb），迁移里用 jsonb 拼接追加，幂等：
 *     已含 WIKI 域的角色不重复追加。
 */
export class AddWikiPages17000000000111 implements MigrationInterface {
  name = 'AddWikiPages17000000000111';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query(`CREATE EXTENSION IF NOT EXISTS vector`)
      .catch(() => undefined);
    const hasVector = await this.hasVectorExtension(queryRunner);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wiki_space" (
        "id"             uuid NOT NULL DEFAULT gen_random_uuid(),
        "name"           varchar(100) NOT NULL,
        "description"    varchar(500),
        "security_level" varchar(16) NOT NULL DEFAULT 'INTERNAL',
        "created_by"     uuid,
        "deleted"        boolean NOT NULL DEFAULT FALSE,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "updated_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_wiki_space" PRIMARY KEY ("id"),
        CONSTRAINT "uk_wiki_space_name" UNIQUE ("name")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wiki_page" (
        "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
        "space_id"   uuid NOT NULL,
        "parent_id"  uuid,
        "title"      varchar(200) NOT NULL,
        "content_md" text NOT NULL DEFAULT '',
        "order_no"   int NOT NULL DEFAULT 0,
        "version_no" int NOT NULL DEFAULT 1,
        "created_by" uuid,
        "updated_by" uuid,
        "deleted"    boolean NOT NULL DEFAULT FALSE,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_wiki_page" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_wiki_page_space" ON "wiki_page" ("space_id", "deleted")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_wiki_page_parent" ON "wiki_page" ("parent_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wiki_page_version" (
        "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
        "page_id"    uuid NOT NULL,
        "version_no" int NOT NULL,
        "title"      varchar(200) NOT NULL,
        "content_md" text NOT NULL,
        "edited_by"  uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_wiki_page_version" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_wiki_page_version" ON "wiki_page_version" ("page_id", "version_no")`,
    );

    if (hasVector) {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "wiki_chunk" (
          "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
          "page_id"    uuid NOT NULL,
          "chunk_no"   int NOT NULL,
          "content"    text NOT NULL,
          "char_len"   int NOT NULL DEFAULT 0,
          "embedding"  vector(768),
          "deleted"    boolean NOT NULL DEFAULT FALSE,
          "created_at" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT "pk_wiki_chunk" PRIMARY KEY ("id")
        )
      `);
    } else {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "wiki_chunk" (
          "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
          "page_id"    uuid NOT NULL,
          "chunk_no"   int NOT NULL,
          "content"    text NOT NULL,
          "char_len"   int NOT NULL DEFAULT 0,
          "embedding"  double precision[],
          "deleted"    boolean NOT NULL DEFAULT FALSE,
          "created_at" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT "pk_wiki_chunk" PRIMARY KEY ("id")
        )
      `);
    }
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_wiki_chunk" ON "wiki_chunk" ("page_id", "chunk_no")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_wiki_chunk_page" ON "wiki_chunk" ("page_id", "chunk_no")`,
    );
    if (hasVector) {
      await queryRunner
        .query(
          `CREATE INDEX IF NOT EXISTS "idx_wiki_chunk_vec" ON "wiki_chunk"
             USING hnsw ("embedding" vector_cosine_ops)`,
        )
        .catch(() => undefined);
    }

    // ---- 角色授权：R1 WRITE+READ；R0/R2/R3/R4 READ（幂等：已有 WIKI 不重复） ----
    await queryRunner.query(`
      UPDATE "role" SET "permissions" = "permissions" || $1::jsonb
       WHERE "code" = 'R1'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements("permissions") el
            WHERE el->>'domain' = 'WIKI'
         )
    `, [
      JSON.stringify([{ domain: 'WIKI', ops: ['READ', 'WRITE'], mode: 'FULL', scoped: false, levelCapped: true }]),
    ]);

    await queryRunner.query(`
      UPDATE "role" SET "permissions" = "permissions" || $1::jsonb
       WHERE "code" IN ('R0', 'R2', 'R3', 'R4')
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements("permissions") el
            WHERE el->>'domain' = 'WIKI'
         )
    `, [
      JSON.stringify([{ domain: 'WIKI', ops: ['READ'], mode: 'READONLY', scoped: false, levelCapped: true }]),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "wiki_chunk"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "wiki_page_version"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "wiki_page"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "wiki_space"`);
    // 角色授权不回滚（幂等追加，重复执行无害；down 仅用于紧急回退表结构）
  }

  private async hasVectorExtension(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner
      .query(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`)
      .catch(() => [{ ok: false }]);
    return rows[0]?.ok === true;
  }
}
