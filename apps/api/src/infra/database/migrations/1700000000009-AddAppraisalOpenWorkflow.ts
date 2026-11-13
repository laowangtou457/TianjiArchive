import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3：鉴定 / 开放管理 / 可配置审批流 三套表 + archive_item 开放范围列。
 *
 * 设计要点：
 *  1) 全部 `IF NOT EXISTS` 幂等，可重复执行（现场补跑不会炸）；
 *  2) 开放范围 `open_scope` 由 open_flag 保守回填：原本「开放」的只给 ENTRY（条目开放），
 *     不自动给 FULLTEXT —— 原文开放是更强授权，必须走开放批次人工审核；
 *  3) 审批流种子只种两条最小可用流程（开放批次、鉴定销毁），
 *     其余业务可在「流程配置」页面自行新增，不预置空壳。
 */
export class AddAppraisalOpenWorkflow1700000009000 implements MigrationInterface {
  name = 'AddAppraisalOpenWorkflow1700000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- 鉴定任务
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "appraisal_task" (
        "id"                   uuid NOT NULL DEFAULT gen_random_uuid(),
        "task_no"              varchar(40)  NOT NULL,
        "name"                 varchar(200) NOT NULL,
        "status"               varchar(20)  NOT NULL DEFAULT 'DRAFT',
        "fonds_id"             uuid,
        "year_from"            int          NOT NULL,
        "year_to"              int          NOT NULL,
        "retentions"           text[]       NOT NULL DEFAULT '{}',
        "category_code"        varchar(32),
        "due_only"             boolean      NOT NULL DEFAULT TRUE,
        "basis"                text,
        "remark"               text,
        "total"                int          NOT NULL DEFAULT 0,
        "destroy_count"        int          NOT NULL DEFAULT 0,
        "workflow_instance_id" uuid,
        "created_by"           uuid,
        "created_at"           timestamptz  NOT NULL DEFAULT now(),
        "updated_at"           timestamptz  NOT NULL DEFAULT now(),
        "finished_at"          timestamptz,
        CONSTRAINT "pk_appraisal_task" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_appraisal_task_no" ON "appraisal_task" ("task_no")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_appraisal_task_status" ON "appraisal_task" ("status", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "appraisal_entry" (
        "id"               uuid NOT NULL DEFAULT gen_random_uuid(),
        "task_id"          uuid NOT NULL,
        "item_id"          uuid NOT NULL,
        "danghao"          varchar(120) NOT NULL,
        "title"            varchar(500) NOT NULL,
        "year"             int          NOT NULL,
        "retention_before" varchar(16)  NOT NULL,
        "retention_after"  varchar(16),
        "decision"         varchar(16)  NOT NULL DEFAULT 'PENDING',
        "reason"           varchar(500),
        "decided_by"       uuid,
        "decided_at"       timestamptz,
        "executed"         boolean      NOT NULL DEFAULT FALSE,
        "executed_at"      timestamptz,
        CONSTRAINT "pk_appraisal_entry" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_appraisal_entry" ON "appraisal_entry" ("task_id", "item_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_appraisal_entry_decision" ON "appraisal_entry" ("task_id", "decision")`,
    );

    // ---------------------------------------------------------------- 开放批次
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "open_batch" (
        "id"                   uuid NOT NULL DEFAULT gen_random_uuid(),
        "batch_no"             varchar(40)  NOT NULL,
        "name"                 varchar(200) NOT NULL,
        "status"               varchar(20)  NOT NULL DEFAULT 'DRAFT',
        "fonds_id"             uuid,
        "year_from"            int,
        "year_to"              int,
        "security_levels"      text[]       NOT NULL DEFAULT '{}',
        "total"                int          NOT NULL DEFAULT 0,
        "workflow_instance_id" uuid,
        "created_by"           uuid,
        "created_at"           timestamptz  NOT NULL DEFAULT now(),
        "updated_at"           timestamptz  NOT NULL DEFAULT now(),
        "finished_at"          timestamptz,
        CONSTRAINT "pk_open_batch" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_open_batch_no" ON "open_batch" ("batch_no")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_open_batch_status" ON "open_batch" ("status", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "open_review" (
        "id"             uuid NOT NULL DEFAULT gen_random_uuid(),
        "batch_id"       uuid NOT NULL,
        "item_id"        uuid NOT NULL,
        "danghao"        varchar(120) NOT NULL,
        "title"          varchar(500) NOT NULL,
        "year"           int          NOT NULL,
        "security_level" varchar(16)  NOT NULL,
        "decision"       varchar(20)  NOT NULL DEFAULT 'PENDING',
        "reason"         varchar(500),
        "reviewer_id"    uuid,
        "reviewed_at"    timestamptz,
        "applied_at"     timestamptz,
        CONSTRAINT "pk_open_review" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_open_review_batch_item" ON "open_review" ("batch_id", "item_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_open_review_decision" ON "open_review" ("batch_id", "decision")`,
    );

    // ---------------------------------------------------------------- 审批流
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workflow_def" (
        "id"          uuid NOT NULL DEFAULT gen_random_uuid(),
        "code"        varchar(60)  NOT NULL,
        "name"        varchar(120) NOT NULL,
        "biz_type"    varchar(32)  NOT NULL,
        "version"     int          NOT NULL DEFAULT 1,
        "enabled"     boolean      NOT NULL DEFAULT TRUE,
        "description" varchar(500),
        "created_by"  uuid,
        "created_at"  timestamptz  NOT NULL DEFAULT now(),
        "updated_at"  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_workflow_def" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_workflow_def_code" ON "workflow_def" ("code")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_workflow_def_biz" ON "workflow_def" ("biz_type", "enabled")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workflow_node" (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
        "def_id"        uuid NOT NULL,
        "seq"           int  NOT NULL,
        "name"          varchar(80) NOT NULL,
        "role_code"     varchar(8)  NOT NULL DEFAULT '*',
        "perm_domain"   varchar(32),
        "on_approve"    varchar(40),
        "allow_reject"  boolean     NOT NULL DEFAULT TRUE,
        "timeout_hours" int,
        CONSTRAINT "pk_workflow_node" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_workflow_node_seq" ON "workflow_node" ("def_id", "seq")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workflow_instance" (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
        "def_id"        uuid NOT NULL,
        "biz_type"      varchar(32)  NOT NULL,
        "biz_id"        uuid NOT NULL,
        "title"         varchar(200) NOT NULL,
        "summary"       varchar(500),
        "status"        varchar(20)  NOT NULL DEFAULT 'RUNNING',
        "current_seq"   int          NOT NULL DEFAULT 1,
        "payload"       jsonb        NOT NULL DEFAULT '{}'::jsonb,
        "initiator_id"  uuid,
        "created_at"    timestamptz  NOT NULL DEFAULT now(),
        "finished_at"   timestamptz,
        CONSTRAINT "pk_workflow_instance" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_workflow_instance_biz" ON "workflow_instance" ("biz_type", "biz_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_workflow_instance_status" ON "workflow_instance" ("status", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workflow_task" (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
        "instance_id"   uuid NOT NULL,
        "node_id"       uuid NOT NULL,
        "seq"           int  NOT NULL,
        "node_name"     varchar(80) NOT NULL,
        "role_code"     varchar(8)  NOT NULL DEFAULT '*',
        "status"        varchar(20) NOT NULL DEFAULT 'PENDING',
        "acted_by"      uuid,
        "acted_by_name" varchar(80),
        "opinion"       varchar(500),
        "acted_at"      timestamptz,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_workflow_task" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_workflow_task_instance" ON "workflow_task" ("instance_id", "seq")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_workflow_task_pending" ON "workflow_task" ("status", "role_code")`,
    );

    // ---------------------------------------------------------------- 开放范围列
    await queryRunner.query(
      `ALTER TABLE "archive_item" ADD COLUMN IF NOT EXISTS "open_scope" varchar(16) NOT NULL DEFAULT 'NONE'`,
    );
    // 保守回填：历史 OPEN 只认定为「条目开放」，原文开放需走开放批次重新审核
    await queryRunner.query(
      `UPDATE "archive_item" SET "open_scope" = 'ENTRY' WHERE "open_flag" = 'OPEN' AND "open_scope" = 'NONE'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_item_open_scope" ON "archive_item" ("open_scope")`,
    );

    // ---------------------------------------------------------------- 编号序列
    // 任务号/批次号用序列生成，避免「按 COUNT 自增」在并发建单时撞号。
    // 序列不随单据删除回收（号码可有空洞，这是档案编号的常规做法）。
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "seq_appraisal_task_no" START 1`);
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "seq_open_batch_no" START 1`);

    // ---------------------------------------------------------------- 流程种子    // 开放批次：R1 档案管理员审核 → 通过后自动应用开放标识
    await queryRunner.query(`
      INSERT INTO "workflow_def" ("code", "name", "biz_type", "version", "enabled", "description")
      SELECT 'WF-OPEN-BATCH', '开放批次审批', 'OPEN_BATCH', 1, TRUE,
             '档案管理员审核开放结论，通过后统一应用开放标识（条目/原文）'
      WHERE NOT EXISTS (SELECT 1 FROM "workflow_def" WHERE "code" = 'WF-OPEN-BATCH')
    `);
    await queryRunner.query(`
      INSERT INTO "workflow_node" ("def_id", "seq", "name", "role_code", "perm_domain", "on_approve", "allow_reject")
      SELECT d."id", 1, '档案管理员审核', 'R1', 'APPRAISAL', 'OPEN_BATCH_APPLY', TRUE
      FROM "workflow_def" d
      WHERE d."code" = 'WF-OPEN-BATCH'
        AND NOT EXISTS (SELECT 1 FROM "workflow_node" n WHERE n."def_id" = d."id")
    `);

    // 鉴定销毁：R1 初审 → R4 批准 → 通过后执行销毁（进回收站）
    await queryRunner.query(`
      INSERT INTO "workflow_def" ("code", "name", "biz_type", "version", "enabled", "description")
      SELECT 'WF-APPRAISAL-DESTROY', '鉴定销毁审批', 'APPRAISAL_DESTROY', 1, TRUE,
             '销毁不可逆：档案管理员初审 + 领导批准，通过后执行软删除并进回收站'
      WHERE NOT EXISTS (SELECT 1 FROM "workflow_def" WHERE "code" = 'WF-APPRAISAL-DESTROY')
    `);
    await queryRunner.query(`
      INSERT INTO "workflow_node" ("def_id", "seq", "name", "role_code", "perm_domain", "on_approve", "allow_reject")
      SELECT d."id", 1, '档案管理员初审', 'R1', 'APPRAISAL', NULL, TRUE
      FROM "workflow_def" d
      WHERE d."code" = 'WF-APPRAISAL-DESTROY'
        AND NOT EXISTS (SELECT 1 FROM "workflow_node" n WHERE n."def_id" = d."id" AND n."seq" = 1)
    `);
    await queryRunner.query(`
      INSERT INTO "workflow_node" ("def_id", "seq", "name", "role_code", "perm_domain", "on_approve", "allow_reject")
      SELECT d."id", 2, '领导批准', 'R4', 'APPRAISAL', 'APPRAISAL_DESTROY_EXEC', TRUE
      FROM "workflow_def" d
      WHERE d."code" = 'WF-APPRAISAL-DESTROY'
        AND NOT EXISTS (SELECT 1 FROM "workflow_node" n WHERE n."def_id" = d."id" AND n."seq" = 2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "seq_open_batch_no"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "seq_appraisal_task_no"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_item_open_scope"`);
    await queryRunner.query(`ALTER TABLE "archive_item" DROP COLUMN IF EXISTS "open_scope"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_task"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_instance"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_node"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_def"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "open_review"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "open_batch"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "appraisal_entry"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "appraisal_task"`);
  }
}
