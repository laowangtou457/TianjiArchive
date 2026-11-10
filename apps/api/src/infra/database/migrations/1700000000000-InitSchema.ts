import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 初始建表迁移 —— 对齐 系统架构设计.md §4.2 DDL。
 *
 * 关键设计：
 *  - audit_log 为按月 RANGE 分区表（PG 分区表不支持由 TypeORM 生成，故手写 DDL）；
 *  - archive_item 建复合部分索引（deleted=false）支撑条件检索 P95<1s；
 *  - danghao 全库唯一索引作为并发取号兜底；
 *  - 全文检索用 GIN(to_tsvector) 索引作为 ES 降级方案。
 */
export class InitSchema1700000000000 implements MigrationInterface {
  name = 'InitSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- 扩展
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // ---------------------------------------------------------------- 全宗 / 机构
    await queryRunner.query(`
      CREATE TABLE "fonds" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "fonds_no" varchar(32) NOT NULL,
        "name" varchar(200) NOT NULL,
        "org_name" varchar(200),
        "year_start" int,
        "year_end" int,
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        "history_note" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uk_fonds_no" UNIQUE ("fonds_no")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "org_node" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "fonds_id" uuid NOT NULL REFERENCES "fonds"("id") ON DELETE CASCADE,
        "parent_id" uuid,
        "code" varchar(64) NOT NULL,
        "name" varchar(200) NOT NULL,
        "sort" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_org_fonds" ON "org_node" ("fonds_id")`);
    await queryRunner.query(`CREATE INDEX "idx_org_parent" ON "org_node" ("parent_id")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_org_fonds_code" ON "org_node" ("fonds_id", "code")`,
    );

    // ---------------------------------------------------------------- 门类 / 档号规则 / 序列
    await queryRunner.query(`
      CREATE TABLE "category" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" varchar(32) NOT NULL,
        "name" varchar(100) NOT NULL,
        "field_schema" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "danghao_rule_id" uuid,
        "sort" int NOT NULL DEFAULT 0,
        "active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uk_category_code" UNIQUE ("code")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "danghao_rule" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "fonds_id" uuid NOT NULL REFERENCES "fonds"("id") ON DELETE CASCADE,
        "category_id" uuid REFERENCES "category"("id") ON DELETE SET NULL,
        "segments" jsonb NOT NULL,
        "separator" varchar(4) NOT NULL DEFAULT '-',
        "reset_cycle" varchar(16) NOT NULL DEFAULT 'YEAR',
        "zero_pad" int NOT NULL DEFAULT 4,
        "active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_rule_fonds" ON "danghao_rule" ("fonds_id")`);
    await queryRunner.query(`CREATE INDEX "idx_rule_category" ON "danghao_rule" ("category_id")`);

    await queryRunner.query(`
      CREATE TABLE "danghao_sequence" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "scope_key" varchar(200) NOT NULL,
        "next_value" bigint NOT NULL DEFAULT 1,
        "version" int NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uk_seq_scope" UNIQUE ("scope_key")
      )
    `);

    // ---------------------------------------------------------------- 案卷 / 件
    await queryRunner.query(`
      CREATE TABLE "volume" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "fonds_id" uuid NOT NULL REFERENCES "fonds"("id") ON DELETE RESTRICT,
        "category_id" uuid REFERENCES "category"("id") ON DELETE SET NULL,
        "org_id" uuid REFERENCES "org_node"("id") ON DELETE SET NULL,
        "danghao" varchar(120) NOT NULL,
        "title" varchar(500) NOT NULL,
        "responsible" varchar(200),
        "year" int NOT NULL,
        "retention" varchar(16) NOT NULL,
        "security_level" varchar(16) NOT NULL DEFAULT 'PUBLIC',
        "item_count" int NOT NULL DEFAULT 0,
        "start_date" date,
        "end_date" date,
        "class_no" varchar(64),
        "keywords" text[] NOT NULL DEFAULT '{}',
        "note" text,
        "status" varchar(16) NOT NULL DEFAULT 'DRAFT',
        "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "deleted" boolean NOT NULL DEFAULT FALSE,
        "created_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uk_volume_danghao" UNIQUE ("danghao")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_volume_fonds_year" ON "volume" ("fonds_id", "year", "deleted")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_volume_query" ON "volume" ("fonds_id", "year", "retention", "security_level")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_volume_level" ON "volume" ("security_level")`);

    await queryRunner.query(`
      CREATE TABLE "archive_item" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "volume_id" uuid REFERENCES "volume"("id") ON DELETE SET NULL,
        "fonds_id" uuid NOT NULL REFERENCES "fonds"("id") ON DELETE RESTRICT,
        "danghao" varchar(120) NOT NULL,
        "title" varchar(500) NOT NULL,
        "responsible" varchar(200),
        "doc_no" varchar(120),
        "doc_date" date,
        "year" int NOT NULL,
        "retention" varchar(16) NOT NULL,
        "security_level" varchar(16) NOT NULL DEFAULT 'PUBLIC',
        "category_code" varchar(32),
        "class_no" varchar(64),
        "keywords" text[] NOT NULL DEFAULT '{}',
        "pages" int,
        "note" text,
        "status" varchar(16) NOT NULL DEFAULT 'DRAFT',
        "open_flag" varchar(16) NOT NULL DEFAULT 'CONTROLLED',
        "full_text" text,
        "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "deleted" boolean NOT NULL DEFAULT FALSE,
        "created_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uk_item_danghao" UNIQUE ("danghao")
      )
    `);
    // 高频条件检索复合部分索引（NFR-3 条件检索 P95<1s）
    await queryRunner.query(
      `CREATE INDEX "idx_item_query" ON "archive_item" ("fonds_id", "year", "retention", "security_level", "category_code") WHERE "deleted" = FALSE`,
    );
    await queryRunner.query(`CREATE INDEX "idx_item_date" ON "archive_item" ("doc_date")`);
    await queryRunner.query(`CREATE INDEX "idx_item_volume" ON "archive_item" ("volume_id")`);
    await queryRunner.query(
      `CREATE INDEX "idx_item_status" ON "archive_item" ("status", "deleted")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_item_level" ON "archive_item" ("security_level")`);
    // 中文模糊查询降级支持（ES 不可用时的 LIKE 检索）
    await queryRunner.query(
      `CREATE INDEX "idx_item_title_trgm" ON "archive_item" USING gin ("title" gin_trgm_ops)`,
    );
    // 全文降级方案：GIN(to_tsvector('simple', ...))，ES 故障时兜底
    await queryRunner.query(
      `CREATE INDEX "idx_item_fts" ON "archive_item" USING gin (to_tsvector('simple', coalesce("title",'') || ' ' || coalesce("responsible",'') || ' ' || coalesce("full_text",'')))`,
    );

    // ---------------------------------------------------------------- 电子文件 / 全文
    await queryRunner.query(`
      CREATE TABLE "electronic_file" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "item_id" uuid NOT NULL REFERENCES "archive_item"("id") ON DELETE CASCADE,
        "bucket" varchar(64) NOT NULL,
        "object_key" varchar(500) NOT NULL,
        "filename" varchar(300) NOT NULL,
        "mime" varchar(120),
        "size" bigint NOT NULL,
        "sha256" char(64) NOT NULL,
        "preview_key" varchar(500),
        "thumb_key" varchar(500),
        "extract_status" varchar(16) NOT NULL DEFAULT 'PENDING',
        "extract_error" text,
        "authenticity_check" jsonb,
        "uploaded_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_file_bucket_key" ON "electronic_file" ("bucket", "object_key")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_file_item" ON "electronic_file" ("item_id")`);
    await queryRunner.query(`CREATE INDEX "idx_file_sha" ON "electronic_file" ("sha256")`);

    await queryRunner.query(`
      CREATE TABLE "document_text" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "item_id" uuid NOT NULL REFERENCES "archive_item"("id") ON DELETE CASCADE,
        "file_id" uuid REFERENCES "electronic_file"("id") ON DELETE CASCADE,
        "content" text NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_doctext_item" ON "document_text" ("item_id")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_doctext_file_version" ON "document_text" ("file_id", "version")`,
    );

    // ---------------------------------------------------------------- 用户 / 角色 / 数据范围
    await queryRunner.query(`
      CREATE TABLE "app_user" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "username" varchar(64) NOT NULL,
        "password_hash" varchar(120) NOT NULL,
        "display_name" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        "max_security_level" varchar(16) NOT NULL DEFAULT 'PUBLIC',
        "pwd_changed_at" timestamptz,
        "failed_count" int NOT NULL DEFAULT 0,
        "locked_until" timestamptz,
        "last_login_at" timestamptz,
        "last_login_ip" varchar(64),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uk_user_username" UNIQUE ("username")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "role" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" varchar(32) NOT NULL,
        "name" varchar(64) NOT NULL,
        "permissions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "builtin" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uk_role_code" UNIQUE ("code")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "user_role" (
        "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE CASCADE,
        "role_id" uuid NOT NULL REFERENCES "role"("id") ON DELETE CASCADE,
        PRIMARY KEY ("user_id", "role_id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "user_data_scope" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE CASCADE,
        "scope_type" varchar(16) NOT NULL,
        "scope_ref_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_scope_user" ON "user_data_scope" ("user_id")`);

    // ---------------------------------------------------------------- 借阅
    await queryRunner.query(`
      CREATE TABLE "borrow_order" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "order_no" varchar(40) NOT NULL,
        "applicant_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE RESTRICT,
        "item_id" uuid NOT NULL REFERENCES "archive_item"("id") ON DELETE RESTRICT,
        "purpose" varchar(500) NOT NULL,
        "mode" varchar(16) NOT NULL,
        "expect_return" date NOT NULL,
        "borrow_date" date,
        "actual_return" timestamptz,
        "status" varchar(20) NOT NULL DEFAULT 'PENDING',
        "renew_count" int NOT NULL DEFAULT 0,
        "current_level" int NOT NULL DEFAULT 1,
        "required_level" int NOT NULL DEFAULT 1,
        "return_remark" varchar(500),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uk_borrow_order_no" UNIQUE ("order_no")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_borrow_applicant" ON "borrow_order" ("applicant_id", "status")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_borrow_item" ON "borrow_order" ("item_id")`);
    await queryRunner.query(
      `CREATE INDEX "idx_borrow_status_due" ON "borrow_order" ("status", "expect_return")`,
    );

    await queryRunner.query(`
      CREATE TABLE "borrow_approval" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "order_id" uuid NOT NULL REFERENCES "borrow_order"("id") ON DELETE CASCADE,
        "approver_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE RESTRICT,
        "level" int NOT NULL DEFAULT 1,
        "action" varchar(16) NOT NULL,
        "opinion" varchar(500) NOT NULL,
        "acted_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_approval_order" ON "borrow_approval" ("order_id")`);

    // ---------------------------------------------------------------- 审计日志（按月分区）
    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id" bigint GENERATED ALWAYS AS IDENTITY,
        "user_id" uuid,
        "username" varchar(64),
        "action" varchar(32) NOT NULL,
        "object_type" varchar(32),
        "object_id" varchar(64),
        "result" varchar(16) NOT NULL,
        "ip" inet,
        "duration_ms" int,
        "detail" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("id", "created_at")
      ) PARTITION BY RANGE ("created_at")
    `);
    // 预建 2024-2027 分区 + 默认分区，保证写入永不失败
    await queryRunner.query(`
      DO $$
      DECLARE
        y int;
        m int;
        start_date date;
        end_date date;
        part_name text;
      BEGIN
        FOR y IN 2024..2027 LOOP
          FOR m IN 1..12 LOOP
            start_date := make_date(y, m, 1);
            end_date := (start_date + interval '1 month')::date;
            part_name := format('audit_log_%s_%s', y, lpad(m::text, 2, '0'));
            EXECUTE format(
              'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
              part_name, start_date, end_date
            );
          END LOOP;
        END LOOP;
        EXECUTE 'CREATE TABLE IF NOT EXISTS audit_log_default PARTITION OF audit_log DEFAULT';
      END $$;
    `);
    // BRIN 时间索引（分区表父表上建，自动级联到分区）
    await queryRunner.query(
      `CREATE INDEX "idx_audit_created_brin" ON "audit_log" USING brin ("created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_user_time" ON "audit_log" ("user_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_action_time" ON "audit_log" ("action", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_object" ON "audit_log" ("object_type", "object_id")`,
    );

    // ---------------------------------------------------------------- 字典 / 参数
    await queryRunner.query(`
      CREATE TABLE "dict_item" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "dict_type" varchar(64) NOT NULL,
        "code" varchar(64) NOT NULL,
        "label" varchar(200) NOT NULL,
        "sort" int NOT NULL DEFAULT 0,
        "in_use" boolean NOT NULL DEFAULT true,
        "builtin" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_dict_type_code" ON "dict_item" ("dict_type", "code")`,
    );

    await queryRunner.query(`
      CREATE TABLE "system_param" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "param_key" varchar(100) NOT NULL,
        "param_value" text NOT NULL DEFAULT '',
        "label" varchar(200),
        "secret" boolean NOT NULL DEFAULT false,
        "grp" varchar(32) NOT NULL DEFAULT 'misc',
        "value_type" varchar(16) NOT NULL DEFAULT 'string',
        "editable" boolean NOT NULL DEFAULT true,
        "updated_by" varchar(64),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uk_param_key" ON "system_param" ("param_key")`);
    await queryRunner.query(`CREATE INDEX "idx_param_grp" ON "system_param" ("grp")`);

    // ---------------------------------------------------------------- 知识库预留
    await queryRunner.query(`
      CREATE TABLE "kb_entry" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "item_id" uuid NOT NULL REFERENCES "archive_item"("id") ON DELETE CASCADE,
        "source_danghao" varchar(120) NOT NULL,
        "security_level" varchar(16) NOT NULL,
        "chunk" text NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        "embedding_status" varchar(16) NOT NULL DEFAULT 'NONE',
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_kb_item" ON "kb_entry" ("item_id")`);
    await queryRunner.query(`CREATE INDEX "idx_kb_level" ON "kb_entry" ("security_level")`);

    // ---------------------------------------------------------------- 回收站
    await queryRunner.query(`
      CREATE TABLE "recycle_bin" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "object_type" varchar(16) NOT NULL,
        "object_id" uuid NOT NULL,
        "object_label" varchar(600),
        "snapshot" jsonb,
        "deleted_by" uuid,
        "deleted_at" timestamptz NOT NULL DEFAULT now(),
        "purge_after" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_recycle_object" ON "recycle_bin" ("object_type", "object_id")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_recycle_purge" ON "recycle_bin" ("purge_after")`);

    // ---------------------------------------------------------------- 检索辅助
    await queryRunner.query(`
      CREATE TABLE "saved_search" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(200) NOT NULL,
        "query" jsonb NOT NULL,
        "shared" boolean NOT NULL DEFAULT false,
        "owner_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE CASCADE,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_saved_owner" ON "saved_search" ("owner_id")`);

    await queryRunner.query(`
      CREATE TABLE "search_history" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE CASCADE,
        "keyword" varchar(500),
        "query" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "result_count" int NOT NULL DEFAULT 0,
        "took_ms" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_history_user_time" ON "search_history" ("user_id", "created_at")`,
    );

    // ---------------------------------------------------------------- 备份记录
    await queryRunner.query(`
      CREATE TABLE "backup_record" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "filename" varchar(200) NOT NULL,
        "storage_path" varchar(500) NOT NULL,
        "size_bytes" bigint NOT NULL DEFAULT 0,
        "sha256" char(64),
        "status" varchar(16) NOT NULL DEFAULT 'RUNNING',
        "db_status" varchar(16),
        "minio_status" varchar(16),
        "started_at" timestamptz NOT NULL DEFAULT now(),
        "finished_at" timestamptz,
        "detail" jsonb,
        "triggered_by" uuid
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_backup_started" ON "backup_record" ("started_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tables = [
      'backup_record',
      'search_history',
      'saved_search',
      'recycle_bin',
      'kb_entry',
      'system_param',
      'dict_item',
      'audit_log',
      'borrow_approval',
      'borrow_order',
      'user_data_scope',
      'user_role',
      'role',
      'app_user',
      'document_text',
      'electronic_file',
      'archive_item',
      'volume',
      'danghao_sequence',
      'danghao_rule',
      'category',
      'org_node',
      'fonds',
    ];
    for (const t of tables) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }
  }
}
