import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 扩展上传白名单：txt / epub / mobi（书籍当档案入库的实测需求）。
 *
 * ## 为什么是条件更新而不是直接覆盖
 *
 * `file.allowed_extensions` 是 retention 模式参数，存量库里已有种子行
 * （`1700000000004` 补齐 22 项基础行时写入）。直接 UPDATE 会把**管理员
 * 自改过的白名单**（例如特意收紧成 `pdf,ofd` 的密级环境）静默放宽 ——
 * 那是一次未授权的安全口径变更。
 *
 * 所以只做「默认值漂移跟进」：仅当现值仍等于出厂旧默认时才写入新默认；
 * 管理员改过的值一律不动（新格式他们可自行在系统参数里追加）。
 */
export class ExtendEbookFormats1700000006000 implements MigrationInterface {
  name = 'ExtendEbookFormats1700000006000';

  /** 出厂旧默认（2026-11-10 扩展前） */
  private static readonly OLD_DEFAULT =
    'pdf,jpg,jpeg,png,tif,tiff,mp4,mp3,wav,doc,docx,xls,xlsx,ofd';

  /** 出厂新默认（与 packages/shared/src/params.ts 的 default 保持一致） */
  private static readonly NEW_DEFAULT =
    'pdf,jpg,jpeg,png,tif,tiff,mp4,mp3,wav,doc,docx,xls,xlsx,ofd,txt,epub,mobi';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "system_param"
          SET "param_value" = $2,
              "updated_at" = now()
        WHERE "param_key" = 'file.allowed_extensions'
          AND "param_value" = $1`,
      [ExtendEbookFormats1700000006000.OLD_DEFAULT, ExtendEbookFormats1700000006000.NEW_DEFAULT],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 反向同理：仅当现值仍等于新默认才回退，避免覆盖管理员改动
    await queryRunner.query(
      `UPDATE "system_param"
          SET "param_value" = $2,
              "updated_at" = now()
        WHERE "param_key" = 'file.allowed_extensions'
          AND "param_value" = $1`,
      [ExtendEbookFormats1700000006000.NEW_DEFAULT, ExtendEbookFormats1700000006000.OLD_DEFAULT],
    );
  }
}
