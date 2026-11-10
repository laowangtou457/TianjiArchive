import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `kb_entry` 新增「片段序号」列。
 *
 * 背景（A 档检索增强）：片段是条目正文切块后的产物，同一 `item_id` 会有多行。
 * 没有序号会导致：
 *   ① 引用无法定位到"第几段"，前端只能展示散落片段；
 *   ② 重建索引时无法判断片段是否完整（少几行也看不出来）；
 *   ③ 重复写入无法幂等（同一 item 的两批片段会叠加）。
 *
 * 该迁移对已部署环境补列；新建环境由 InitSchema 建出基础表后同样经此补列，
 * 因此用 `IF NOT EXISTS` 保证两条路径都安全。
 *
 * 唯一索引 `(item_id, chunk_no)` 是幂等的**结构性保证**：
 * 重建时先删后插，若逻辑写错（漏删）会直接报唯一冲突，而不是静默产生重复片段。
 * 现存行数为 0（此前无 chunk 生产者），故 DEFAULT 0 不会造成索引冲突。
 */
export class AddKbChunkNo1700000005000 implements MigrationInterface {
  name = 'AddKbChunkNo1700000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "kb_entry" ADD COLUMN IF NOT EXISTS "chunk_no" int NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_kb_item_chunk" ON "kb_entry" ("item_id", "chunk_no")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uk_kb_item_chunk"`);
    await queryRunner.query(`ALTER TABLE "kb_entry" DROP COLUMN IF EXISTS "chunk_no"`);
  }
}
