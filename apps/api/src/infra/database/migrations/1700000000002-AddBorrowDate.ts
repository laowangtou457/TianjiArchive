import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 借阅单新增「借出日」字段。
 *
 * 背景（PRD 5.4 BR-06-3）：续借时必须以「借出日」为基准计算总借期
 * （`新应还日 − 借出日 ≤ 90 天`），不能用「距今天数」——逾期单的距今天数为负，
 * 会被反向漏判为通过。
 *
 * 该迁移对已部署环境补充列；新建环境由 InitSchema 直接建出该列，
 * 因此这里用 `IF NOT EXISTS` 保证两条路径都安全。
 *
 * 数据回填：已存在的 LENT / OVERDUE / RETURNED 单据按
 * `created_at::date` 回填（申请日≈借出日，误差仅为审批时延，属可接受的近似）。
 */
export class AddBorrowDate1700000002000 implements MigrationInterface {
  name = 'AddBorrowDate1700000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) 补列（幂等）
    await queryRunner.query(`ALTER TABLE "borrow_order" ADD COLUMN IF NOT EXISTS "borrow_date" date`);

    // 2) 历史数据回填：已进入借出及之后状态的单据，用申请日近似借出日
    await queryRunner.query(`
      UPDATE "borrow_order"
         SET "borrow_date" = "created_at"::date
       WHERE "borrow_date" IS NULL
         AND "status" IN ('LENT', 'OVERDUE', 'RETURNED')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "borrow_order" DROP COLUMN IF EXISTS "borrow_date"`);
  }
}
