import { MigrationInterface, QueryRunner } from 'typeorm';
import { buildSeedRoles, buildSeedCategories, buildSeedDicts, buildSeedParams } from './seed-data';

/**
 * 种子数据迁移：角色权限矩阵（PRD §3.2）、门类字段集（DA/T 18 核心字段）、
 * 字典（保管期限/密级/利用目的）、系统参数。
 *
 * 独立性：本迁移只写基础配置数据，不创建用户（管理员账号由 seed.ts 脚本创建，
 * 以便密码可用环境变量覆盖）。使用 ON CONFLICT 保证可重复执行。
 */
export class SeedBaseline1700000001000 implements MigrationInterface {
  name = 'SeedBaseline1700000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- 角色
    for (const role of buildSeedRoles()) {
      await queryRunner.query(
        `INSERT INTO "role" ("code", "name", "permissions", "builtin")
         VALUES ($1, $2, $3::jsonb, TRUE)
         ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "permissions" = EXCLUDED."permissions"`,
        [role.code, role.name, JSON.stringify(role.permissions)],
      );
    }

    // ---------------------------------------------------------------- 门类
    for (const cat of buildSeedCategories()) {
      await queryRunner.query(
        `INSERT INTO "category" ("code", "name", "field_schema", "sort", "active")
         VALUES ($1, $2, $3::jsonb, $4, TRUE)
         ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "field_schema" = EXCLUDED."field_schema"`,
        [cat.code, cat.name, JSON.stringify(cat.fieldSchema), cat.sort],
      );
    }

    // ---------------------------------------------------------------- 字典
    for (const d of buildSeedDicts()) {
      await queryRunner.query(
        `INSERT INTO "dict_item" ("dict_type", "code", "label", "sort", "in_use", "builtin")
         VALUES ($1, $2, $3, $4, TRUE, TRUE)
         ON CONFLICT ("dict_type", "code") DO UPDATE SET "label" = EXCLUDED."label", "sort" = EXCLUDED."sort"`,
        [d.dictType, d.code, d.label, d.sort],
      );
    }

    // ---------------------------------------------------------------- 系统参数
    // 默认值一律来自 PARAM_DEFS（buildSeedParams 派生），与架构 §4.3 主表强一致。
    // 注意 ON CONFLICT 只更新元数据、**不覆盖 value**：
    // 已有环境里管理员改过的值不能被重新跑迁移冲回默认值。
    for (const p of buildSeedParams()) {
      await queryRunner.query(
        `INSERT INTO "system_param" ("param_key", "param_value", "label", "secret", "grp", "value_type", "editable")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT ("param_key") DO UPDATE
           SET "label" = EXCLUDED."label",
               "grp" = EXCLUDED."grp",
               "value_type" = EXCLUDED."value_type",
               "editable" = EXCLUDED."editable"`,
        [p.key, p.value, p.label, p.secret, p.grp, p.valueType, p.editable],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "role" WHERE "builtin" = TRUE`);
    await queryRunner.query(`DELETE FROM "category"`);
    await queryRunner.query(`DELETE FROM "dict_item" WHERE "builtin" = TRUE`);
    await queryRunner.query(`DELETE FROM "system_param"`);
  }
}
