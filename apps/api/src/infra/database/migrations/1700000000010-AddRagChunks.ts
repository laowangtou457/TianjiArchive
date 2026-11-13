import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P4：向量检索底座（item_chunk）+ 知识关联（item_relation）。
 *
 * 关键设计：**embedding 列类型按运行库能力自适应**
 *   - 有 pgvector：`vector(768)` + HNSW 余弦索引 → 召回在库内完成；
 *   - 无 pgvector：`double precision[]`（应用内余弦），功能可用但慢一个量级。
 * 两条路径由 `RagService` 运行时探测（读 pg_type / pg_extension），不靠环境变量猜，
 * 避免「配置说有、实际没有」导致的静默空结果。
 *
 * 维度 768 对应 nomic-embed-text / bge-base-zh 一类中文嵌入模型；
 * 换模型必须同时重建该列（docs/RAG与知识库设计.md §3.3 写明了换模型的四步操作）。
 */
export class AddRagChunks17000000010000 implements MigrationInterface {
  name = 'AddRagChunks17000000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 尝试启用扩展；无权限/无包时静默跳过（降级路径仍可跑）
    await queryRunner
      .query(`CREATE EXTENSION IF NOT EXISTS vector`)
      .catch(() => undefined);

    const hasVector = await this.hasVectorExtension(queryRunner);

    if (hasVector) {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "item_chunk" (
          "id"             uuid NOT NULL DEFAULT gen_random_uuid(),
          "item_id"        uuid NOT NULL,
          "chunk_no"       int  NOT NULL,
          "content"        text NOT NULL,
          "char_len"       int  NOT NULL DEFAULT 0,
          "embedding"      vector(768),
          "security_level" varchar(16) NOT NULL,
          "fonds_id"       uuid NOT NULL,
          "deleted"        boolean NOT NULL DEFAULT FALSE,
          "created_at"     timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT "pk_item_chunk" PRIMARY KEY ("id")
        )
      `);
    } else {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "item_chunk" (
          "id"             uuid NOT NULL DEFAULT gen_random_uuid(),
          "item_id"        uuid NOT NULL,
          "chunk_no"       int  NOT NULL,
          "content"        text NOT NULL,
          "char_len"       int  NOT NULL DEFAULT 0,
          "embedding"      double precision[],
          "security_level" varchar(16) NOT NULL,
          "fonds_id"       uuid NOT NULL,
          "deleted"        boolean NOT NULL DEFAULT FALSE,
          "created_at"     timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT "pk_item_chunk" PRIMARY KEY ("id")
        )
      `);
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_item_chunk" ON "item_chunk" ("item_id", "chunk_no")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_item_chunk_item" ON "item_chunk" ("item_id", "chunk_no")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_item_chunk_access" ON "item_chunk" ("security_level", "fonds_id")`,
    );

    if (hasVector) {
      // HNSW 对增量写入更友好（ivfflat 需要足够训练样本，小库上召回率差）
      await queryRunner
        .query(
          `CREATE INDEX IF NOT EXISTS "idx_item_chunk_vec" ON "item_chunk"
             USING hnsw ("embedding" vector_cosine_ops)`,
        )
        .catch(() => undefined);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "item_relation" (
        "id"             uuid NOT NULL DEFAULT gen_random_uuid(),
        "source_item_id" uuid NOT NULL,
        "target_item_id" uuid NOT NULL,
        "relation_type"  varchar(20) NOT NULL DEFAULT 'RELATED',
        "weight"         double precision NOT NULL DEFAULT 0.5,
        "source"         varchar(10) NOT NULL DEFAULT 'AUTO',
        "created_by"     uuid,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_item_relation" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_item_relation"
         ON "item_relation" ("source_item_id", "target_item_id", "relation_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_item_relation_source" ON "item_relation" ("source_item_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "item_relation"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "item_chunk"`);
  }

  private async hasVectorExtension(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner
      .query(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`)
      .catch(() => [{ ok: false }]);
    return rows[0]?.ok === true;
  }
}
