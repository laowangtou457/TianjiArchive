/**
 * 离线样品 demo：模拟「书籍档案」全链路种子脚本（幂等，可重复执行）。
 *
 * 用法（api 容器内）：
 *   pnpm --filter @tianji/api demo:books
 *
 * 造数范围（独立 demo 标识，绝不污染正式数据）：
 *   - 全宗 `DEMO-BOOK`、门类 `BOOK`、2 个案卷、6 本书（件级档案）；
 *   - 每本书 2 个小型电子文件（TXT 正文 + 最小可用 PDF 模拟件），
 *     统一放在 `demo-books/<isbn>/` 前缀下；
 *   - 著录字段按 DA/T 22：题名/责任者/出版年/页数/摘要，另在 `extra`
 *     中带 ISBN、出版社、摘要等书籍专属字段。
 *
 * 走完整链路（不是只插数据库行）：
 *   1) 上传挂接：minio SDK putObject 写 S3 → electronic_file 落库（sha256 基线）；
 *   2) 全文抽取：向 BullMQ `archive-extract` 队列投任务，由**真实 extractor worker**
 *      从 S3 取件、写 document_text、更新 electronic_file.extract_status；
 *   3) 综合检索：ES 索引文档（含 IK mapping）→ 全文 + 元数据过滤查询命中；
 *   4) 预览/下载：presignedGetObject 生成 URL 并真实 fetch 回本地；
 *   5) 完整性：回读字节重算 sha256 与库内基线逐一比对。
 *
 * 幂等：所有 DB 写入按自然键 ON CONFLICT；对象内容确定性生成（无时间戳）；
 * 每次重跑重置 extract_status=PENDING 并重新投队列任务；ES 文档按 itemId upsert。
 * 任何一步失败都打印明细并以退出码 1 终止，绝不静默降级。
 */
import 'reflect-metadata';
import * as Minio from 'minio';
import { Queue } from 'bullmq';
import { Client as EsClient } from '@elastic/elasticsearch';
import { createHash } from 'node:crypto';
import { QUEUE_NAME, type ExtractJobPayload } from '@tianji/shared';
import { AppDataSource } from '../infra/database/data-source';
import { ARCHIVE_INDEX_SETTINGS } from '../infra/elasticsearch/es.module';

// ============================================================================
// 配置（沿用 MINIO_* 历史变量名：S3 兼容端点，当前后端为 SeaweedFS）
// ============================================================================
const ENDPOINT = process.env.MINIO_ENDPOINT ?? 'seaweedfs';
const PORT = Number(process.env.MINIO_PORT ?? 8333);
const USE_SSL = (process.env.MINIO_USE_SSL ?? 'false').toLowerCase() === 'true';
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? 'tianji_minio';
const SECRET_KEY = process.env.MINIO_SECRET_KEY ?? 'tianji_minio_change_me';
const BUCKET_ORIGINAL = process.env.MINIO_BUCKET_ORIGINAL ?? 'archive-original';
const BUCKET_PREVIEW = process.env.MINIO_BUCKET_PREVIEW ?? 'archive-preview';
const BUCKET_THUMB = process.env.MINIO_BUCKET_THUMB ?? 'archive-thumb';
const BUCKET_BACKUP = process.env.MINIO_BUCKET_BACKUP ?? 'archive-backup';
const ES_NODE = process.env.ES_NODE ?? 'http://elasticsearch:9200';
const ES_INDEX = process.env.ES_INDEX ?? 'archive_items';
const REDIS_HOST = process.env.REDIS_HOST ?? 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = Number(process.env.REDIS_DB ?? 0);

/** 全文检索标记：只出现在电子文件正文里，用于证明「全文抽取 → 检索命中」 */
const FULLTEXT_MARKER = '天玑离线样品书籍全文校验';
/** demo 全宗/门类标识（与其它数据隔离） */
const FONDS_NO = 'DEMO-BOOK';
const CATEGORY_CODE = 'BOOK';
const DEMO_PREFIX = 'demo-books/';
const EXTRACT_TIMEOUT_MS = 120_000;
const EXTRACT_POLL_MS = 2_000;
/** 固定时间戳，保证 ES 文档与 sha256 在重复执行时稳定 */
const FIXED_ISO = '2026-01-01T00:00:00.000Z';

interface BookDef {
  isbn: string;
  title: string;
  author: string;
  publisher: string;
  publishYear: number;
  pages: number;
  abstractText: string;
  keywords: string[];
  volumeIndex: number;
}

const VOLUMES: Array<{ danghao: string; title: string; note: string }> = [
  { danghao: 'DEMO-BOOK-2026-0001', title: '文学与档案（模拟卷）', note: '离线样品 demo：文学与档案管理主题' },
  { danghao: 'DEMO-BOOK-2026-0002', title: '数字档案馆（模拟卷）', note: '离线样品 demo：数字档案馆建设主题' },
];

const BOOKS: BookDef[] = [
  {
    isbn: '978-7-5013-0001-1',
    title: '档案管理学基础',
    author: '张明',
    publisher: '档案出版社',
    publishYear: 2021,
    pages: 286,
    abstractText: '系统介绍档案收集、整理、著录、保管与利用的基本原理，适合档案学入门教学。',
    keywords: ['档案管理', '著录', '整理'],
    volumeIndex: 0,
  },
  {
    isbn: '978-7-5013-0002-8',
    title: 'DA/T 22 归档文件整理规则释义',
    author: '李华',
    publisher: '标准出版社',
    publishYear: 2022,
    pages: 198,
    abstractText: '逐条解释归档文件整理规则的件级整理要求、档号结构与目录编制方法。',
    keywords: ['归档文件', '档号', '标准'],
    volumeIndex: 0,
  },
  {
    isbn: '978-7-5013-0003-5',
    title: '电子文件四性检测实践',
    author: '王芳',
    publisher: '信息科学出版社',
    publishYear: 2023,
    pages: 244,
    abstractText: '围绕真实性、完整性、可用性、安全性，给出哈希校验与元数据留痕的落地方案。',
    keywords: ['电子文件', '完整性', 'sha256'],
    volumeIndex: 0,
  },
  {
    isbn: '978-7-5013-0004-2',
    title: '数字档案馆建设导论',
    author: '陈刚',
    publisher: '信息技术出版社',
    publishYear: 2020,
    pages: 320,
    abstractText: '讨论数字档案馆的总体架构、对象存储、全文检索与长期保存策略。',
    keywords: ['数字档案馆', '对象存储', '检索'],
    volumeIndex: 1,
  },
  {
    isbn: '978-7-5013-0005-9',
    title: '海量小文件存储优化',
    author: '赵雷',
    publisher: '计算机出版社',
    publishYear: 2024,
    pages: 176,
    abstractText: '分析分布式对象存储在海量小文件场景下的元数据瓶颈与合并写入策略。',
    keywords: ['SeaweedFS', '小文件', '存储'],
    volumeIndex: 1,
  },
  {
    isbn: '978-7-5013-0006-6',
    title: '档案信息检索与知识服务',
    author: '孙悦',
    publisher: '图书情报出版社',
    publishYear: 2025,
    pages: 262,
    abstractText: '结合中文分词与倒排索引，介绍档案综合检索、分面统计与知识图谱预留接口。',
    keywords: ['全文检索', '分词', '知识服务'],
    volumeIndex: 1,
  },
];

interface FileRecord {
  fileId: string;
  itemId: string;
  objectKey: string;
  mime: string;
  filename: string;
  sha256: string;
  size: number;
  previewKey: string;
  isbn: string;
}

// ============================================================================
// 工具
// ============================================================================

function buildClient(): Minio.Client {
  return new Minio.Client({
    endPoint: ENDPOINT,
    port: PORT,
    useSSL: USE_SSL,
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    region: 'us-east-1',
    pathStyle: true,
  });
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成最小可用的单页 PDF（含 ASCII 文本层，供 pdf-parse / 预览链路读取） */
function buildMinimalPdf(lines: string[]): Buffer {
  const escape = (s: string): string => s.replace(/[\\()]/g, '\\$&');
  const textOps = lines
    .map((line, i) => `BT /F1 12 Tf 50 ${780 - i * 22} Td (${escape(line)}) Tj ET`)
    .join('\n');
  const stream = `BT /F1 12 Tf 50 800 Td (Tianji Demo Book) Tj ET\n${textOps}`;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

/** 确保业务桶存在（幂等；API 的 MinioService.onModuleInit 也做同样的事） */
async function ensureBuckets(client: Minio.Client): Promise<void> {
  for (const name of [BUCKET_ORIGINAL, BUCKET_PREVIEW, BUCKET_THUMB, BUCKET_BACKUP]) {
    const exists = await client.bucketExists(name);
    if (!exists) {
      await client.makeBucket(name, 'us-east-1');
      console.log(`  创建桶：${name}`);
    }
  }
}

/** 取单行 id（优先 INSERT RETURNING，冲突时 SELECT） */
async function upsertReturningId(
  sql: string,
  params: unknown[],
  selectSql: string,
  selectParams: unknown[],
): Promise<string> {
  const inserted = (await AppDataSource.query(sql, params)) as Array<{ id: string }>;
  if (inserted.length > 0) return inserted[0].id;
  const found = (await AppDataSource.query(selectSql, selectParams)) as Array<{ id: string }>;
  if (found.length === 0) throw new Error(`插入且查询均失败：${selectSql.slice(0, 80)}`);
  return found[0].id;
}

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
  console.log('════════════ 离线样品 demo：模拟书籍档案全链路 ════════════');
  console.log(
    `S3=${ENDPOINT}:${PORT}（SeaweedFS S3 Gateway） ES=${ES_NODE} index=${ES_INDEX} ` +
      `全宗=${FONDS_NO} 书目=${BOOKS.length} 本`,
  );

  const client = buildClient();
  const es = new EsClient({ node: ES_NODE, requestTimeout: 15_000, maxRetries: 2 });
  await AppDataSource.initialize();
  console.log('▶ 数据库已连接');

  try {
    await ensureBuckets(client);

    // ---------------------------------------------------------------- 1) 三级著录数据
    const fondsId = await upsertReturningId(
      `INSERT INTO fonds (fonds_no, name, org_name, year_start, status, history_note)
       VALUES ($1,$2,$3,$4,'ACTIVE',$5)
       ON CONFLICT (fonds_no) DO NOTHING RETURNING id`,
      [FONDS_NO, '模拟书籍档案全宗（demo）', '离线样品组', 2020, '可重复执行的样品数据，与正式 WS 全宗隔离'],
      `SELECT id FROM fonds WHERE fonds_no = $1`,
      [FONDS_NO],
    );
    await upsertReturningId(
      `INSERT INTO category (code, name, field_schema, sort, active)
       VALUES ($1,$2,'[]'::jsonb,$3,TRUE)
       ON CONFLICT (code) DO NOTHING RETURNING id`,
      [CATEGORY_CODE, '书籍档案（demo）', 99],
      `SELECT id FROM category WHERE code = $1`,
      [CATEGORY_CODE],
    );

    const volumeIds: string[] = [];
    for (const v of VOLUMES) {
      const id = await upsertReturningId(
        `INSERT INTO volume
           (fonds_id, danghao, title, responsible, year, retention, security_level,
            keywords, status, note, extra)
         VALUES ($1,$2,$3,$4,$5,'PERM','PUBLIC',$6::text[],'ARCHIVED',$7,$8::jsonb)
         ON CONFLICT (danghao) DO NOTHING RETURNING id`,
        [fondsId, v.danghao, v.title, '离线样品组', 2026, ['模拟', '书籍', 'demo'], v.note, JSON.stringify({ demo: true })],
        `SELECT id FROM volume WHERE danghao = $1`,
        [v.danghao],
      );
      volumeIds.push(id);
    }

    const fileRecords: FileRecord[] = [];
    const itemIds: string[] = [];
    const esDocs: Array<Record<string, unknown>> = [];

    for (const [index, book] of BOOKS.entries()) {
      const volumeId = volumeIds[book.volumeIndex] ?? volumeIds[0];
      const volume = VOLUMES[book.volumeIndex] ?? VOLUMES[0];
      const itemNo = BOOKS.slice(0, index + 1).filter((b) => b.volumeIndex === book.volumeIndex).length;
      const danghao = `${volume.danghao}-${String(itemNo).padStart(4, '0')}`;
      const itemId = await upsertReturningId(
        `INSERT INTO archive_item
           (volume_id, fonds_id, danghao, title, responsible, doc_no, doc_date, year,
            retention, security_level, category_code, class_no, keywords, pages, note,
            status, open_flag, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PERM','PUBLIC',$9,$10,$11::text[],$12,$13,
                 'ARCHIVED','OPEN',$14::jsonb)
         ON CONFLICT (danghao) DO NOTHING RETURNING id`,
        [
          volumeId,
          fondsId,
          danghao,
          book.title,
          book.author,
          book.isbn,
          `${book.publishYear}-01-01`,
          book.publishYear,
          CATEGORY_CODE,
          `BK-${String(index + 1).padStart(3, '0')}`,
          book.keywords,
          book.pages,
          book.abstractText,
          JSON.stringify({
            isbn: book.isbn,
            publisher: book.publisher,
            publishYear: book.publishYear,
            pages: book.pages,
            abstract: book.abstractText,
            demo: true,
          }),
        ],
        `SELECT id FROM archive_item WHERE danghao = $1`,
        [danghao],
      );
      itemIds.push(itemId);
      console.log(`  著录：${danghao} 《${book.title}》`);

      // ------------------------------------------------------------ 2) 电子文件（TXT + PDF）
      const txtContent = [
        `题名：${book.title}`,
        `责任者：${book.author}`,
        `出版社：${book.publisher}`,
        `出版年：${book.publishYear}`,
        `ISBN：${book.isbn}`,
        `页数：${book.pages}`,
        `摘要：${book.abstractText}`,
        `主题词：${book.keywords.join('、')}`,
        FULLTEXT_MARKER,
        `本文件为离线样品 demo 的模拟电子文件，可重复生成、内容确定。`,
      ].join('\n');
      const pdfContent = buildMinimalPdf([
        `Tianji demo book: ${book.isbn}`,
        'Offline sample electronic file (PDF simulation).',
        'Fulltext marker lives in the TXT companion file.',
      ]);
      const previewContent = Buffer.from(
        `【天玑样品预览】${book.title} / ${book.author} / ${book.publisher}\n` +
          `仅用于离线 demo 预览链路验证（${FULLTEXT_MARKER}）\n`,
        'utf8',
      );

      const attachments: Array<{ ext: string; mime: string; data: Buffer }> = [
        { ext: 'txt', mime: 'text/plain; charset=utf-8', data: Buffer.from(txtContent, 'utf8') },
        { ext: 'pdf', mime: 'application/pdf', data: pdfContent },
      ];
      const previewKey = `${DEMO_PREFIX}${book.isbn}/preview.txt`;
      await client.putObject(
        BUCKET_PREVIEW,
        previewKey,
        previewContent,
        previewContent.length,
        { 'Content-Type': 'text/plain; charset=utf-8' },
      );

      for (const attachment of attachments) {
        const objectKey = `${DEMO_PREFIX}${book.isbn}/${book.isbn}.${attachment.ext}`;
        const filename = `${book.title}.${attachment.ext}`;
        await client.putObject(BUCKET_ORIGINAL, objectKey, attachment.data, attachment.data.length, {
          'Content-Type': attachment.mime,
        });
        const digest = sha256(attachment.data);
        const fileId = await upsertReturningId(
          `INSERT INTO electronic_file
             (item_id, bucket, object_key, filename, mime, size, sha256, preview_key, extract_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')
           ON CONFLICT (bucket, object_key)
           DO UPDATE SET sha256 = EXCLUDED.sha256,
                         size = EXCLUDED.size,
                         mime = EXCLUDED.mime,
                         filename = EXCLUDED.filename,
                         preview_key = EXCLUDED.preview_key,
                         extract_status = 'PENDING',
                         extract_error = NULL
           RETURNING id`,
          [
            itemId,
            BUCKET_ORIGINAL,
            objectKey,
            filename,
            attachment.mime,
            attachment.data.length,
            digest,
            previewKey,
          ],
          `SELECT id FROM electronic_file WHERE bucket = $1 AND object_key = $2`,
          [BUCKET_ORIGINAL, objectKey],
        );
        fileRecords.push({
          fileId,
          itemId,
          objectKey,
          mime: attachment.mime,
          filename,
          sha256: digest,
          size: attachment.data.length,
          previewKey,
          isbn: book.isbn,
        });
      }

      // ------------------------------------------------------------ 3) ES 文档（先建文档，worker 再补全文）
      esDocs.push({
        id: itemId,
        danghao,
        title: book.title,
        responsible: book.author,
        docNo: book.isbn,
        keywords: book.keywords,
        note: book.abstractText,
        fulltext: '',
        fondsId,
        orgId: null,
        volumeId,
        year: book.publishYear,
        retention: 'PERM',
        securityLevel: 'PUBLIC',
        categoryCode: CATEGORY_CODE,
        classNo: `BK-${String(index + 1).padStart(3, '0')}`,
        status: 'ARCHIVED',
        openFlag: 'OPEN',
        docDate: `${book.publishYear}-01-01`,
        createdAt: FIXED_ISO,
        updatedAt: FIXED_ISO,
        createdBy: null,
        deleted: false,
        fileCount: 2,
        hasPreview: true,
      });
    }

    // ---------------------------------------------------------------- ES 索引（幂等）
    const indexExists = await es.indices.exists({ index: ES_INDEX });
    if (!indexExists) {
      // 复用 API 侧的权威 mapping（dynamic:'strict'，含 IK 分析器），避免判据/字段漂移。
      // 与 es.module.ts:buildIndexBody()/indices.create 同一写法：先 JSON 克隆再按
      // { settings; mappings } 定型后展开。此前 `as never` 会让 TS2698 报
      // "Spread types may only be created from object types"（ts-node 容器内同样报错）。
      const indexBody = JSON.parse(JSON.stringify(ARCHIVE_INDEX_SETTINGS)) as {
        settings: unknown;
        mappings: unknown;
      };
      await es.indices.create({ index: ES_INDEX, ...indexBody });
      console.log(`  创建 ES 索引：${ES_INDEX}`);
    }
    for (const doc of esDocs) {
      await es.index({ index: ES_INDEX, id: String(doc.id), document: doc, refresh: false });
    }
    await es.indices.refresh({ index: ES_INDEX });
    console.log(`  ES 文档写入：${esDocs.length} 条`);

    // ---------------------------------------------------------------- 4) 投真实抽取队列
    const queue = new Queue(QUEUE_NAME.EXTRACT, {
      connection: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD,
        db: REDIS_DB,
        maxRetriesPerRequest: null,
      } as never,
    });
    const payloads: ExtractJobPayload[] = fileRecords.map((f) => ({
      fileId: f.fileId,
      itemId: f.itemId,
      bucket: BUCKET_ORIGINAL,
      objectKey: f.objectKey,
      mime: f.mime,
      filename: f.filename,
    }));
    for (const payload of payloads) {
      await queue.add('extract', payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: true,
      });
    }
    await queue.close();
    console.log(`  已投抽取任务：${payloads.length} 个（等待 extractor worker 处理）`);

    // ---------------------------------------------------------------- 等待抽取完成（有上限）
    const fileIds = fileRecords.map((f) => f.fileId);
    const deadline = Date.now() + EXTRACT_TIMEOUT_MS;
    let statuses: Array<{ id: string; extract_status: string; extract_error: string | null }> = [];
    while (Date.now() < deadline) {
      statuses = (await AppDataSource.query(
        `SELECT id, extract_status, extract_error FROM electronic_file WHERE id = ANY($1::uuid[])`,
        [fileIds],
      )) as Array<{ id: string; extract_status: string; extract_error: string | null }>;
      const failed = statuses.filter((s) => s.extract_status === 'FAILED');
      if (failed.length > 0) {
        throw new Error(
          `抽取任务失败：${failed.map((f) => `${f.id}=${f.extract_error ?? '未知'}`).join('; ')}`,
        );
      }
      const done = statuses.filter(
        (s) => s.extract_status === 'OK' || s.extract_status === 'SKIPPED',
      );
      if (done.length === fileIds.length) break;
      await sleep(EXTRACT_POLL_MS);
    }
    const doneCount = statuses.filter(
      (s) => s.extract_status === 'OK' || s.extract_status === 'SKIPPED',
    ).length;
    if (doneCount !== fileIds.length) {
      throw new Error(
        `抽取超时（${EXTRACT_TIMEOUT_MS / 1000}s）：完成 ${doneCount}/${fileIds.length}；` +
          `当前状态 ${JSON.stringify(statuses)}；请确认 extractor 容器在运行且日志无异常`,
      );
    }

    // 把正文回填到 archive_item.full_text（PG 侧兜底检索也可见）
    await AppDataSource.query(
      `UPDATE archive_item ai
          SET full_text = COALESCE(
                (SELECT dt.content FROM document_text dt
                  WHERE dt.item_id = ai.id
                  ORDER BY length(dt.content) DESC LIMIT 1),
                ai.full_text)
        WHERE ai.id = ANY($1::uuid[])`,
      [itemIds],
    );
    const docTextCount = (await AppDataSource.query(
      `SELECT COUNT(*)::int AS cnt FROM document_text WHERE item_id = ANY($1::uuid[])`,
      [itemIds],
    )) as Array<{ cnt: number }>;
    console.log(`  全文抽取完成：${doneCount}/${fileIds.length} 个文件，document_text ${docTextCount[0]?.cnt ?? 0} 条`);

    // ---------------------------------------------------------------- 5) 综合检索（全文 + 元数据过滤）
    await es.indices.refresh({ index: ES_INDEX });
    const searchResp = (await es.search({
      index: ES_INDEX,
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query: FULLTEXT_MARKER,
                fields: ['fulltext^2', 'title', 'note', 'keywords'],
              },
            },
          ],
          filter: [{ term: { fondsId } }, { term: { status: 'ARCHIVED' } }],
        },
      },
      size: 20,
    })) as unknown as { hits: { total: { value: number } | number; hits: Array<{ _id: string }> } };
    const totalValue = searchResp.hits.total;
    const hitCount = typeof totalValue === 'number' ? totalValue : totalValue.value;
    const hitIds = new Set(searchResp.hits.hits.map((h) => h._id));
    const missingHits = itemIds.filter((id) => !hitIds.has(id));
    if (hitCount < BOOKS.length || missingHits.length > 0) {
      throw new Error(
        `综合检索命中不足：hits=${hitCount}，期望至少 ${BOOKS.length}；` +
          `未命中的条目=${missingHits.join(', ')}`,
      );
    }
    console.log(`  综合检索命中：${hitCount} 条（全文标记 + 全宗/状态过滤）`);

    // ---------------------------------------------------------------- 6) 预览/下载 + sha256 完整性
    let downloadOk = 0;
    let previewOk = 0;
    let shaOk = 0;
    for (const file of fileRecords) {
      const downloadUrl = await client.presignedGetObject(BUCKET_ORIGINAL, file.objectKey, 900);
      const resp = await fetch(downloadUrl);
      if (!resp.ok) throw new Error(`下载失败 ${file.objectKey}: HTTP ${resp.status}`);
      const data = Buffer.from(await resp.arrayBuffer());
      if (data.length !== file.size) {
        throw new Error(`下载长度不符 ${file.objectKey}: ${data.length} != ${file.size}`);
      }
      downloadOk += 1;
      if (sha256(data) !== file.sha256) {
        throw new Error(`sha256 校验失败 ${file.objectKey}`);
      }
      shaOk += 1;

      const previewUrl = await client.presignedGetObject(BUCKET_PREVIEW, file.previewKey, 900);
      const previewResp = await fetch(previewUrl);
      if (!previewResp.ok) throw new Error(`预览失败 ${file.previewKey}: HTTP ${previewResp.status}`);
      const previewText = await previewResp.text();
      if (!previewText.includes('天玑样品预览')) {
        throw new Error(`预览内容异常 ${file.previewKey}`);
      }
      previewOk += 1;
    }

    // ---------------------------------------------------------------- 汇总（正向证据）
    console.log('');
    console.log('──────────── demo 链路汇总 ────────────');
    console.log(`DEMO_BOOKS_TOTAL=${BOOKS.length}`);
    console.log(`DEMO_VOLUMES_TOTAL=${VOLUMES.length}`);
    console.log(`FILES_UPLOADED=${fileRecords.length}`);
    console.log(`EXTRACTED_OK=${doneCount}`);
    console.log(`DOCUMENT_TEXT_ROWS=${docTextCount[0]?.cnt ?? 0}`);
    console.log(`SEARCH_HITS=${hitCount}`);
    // D-4 分层纪律：下面两个 *_DOWNLOADS_OK 是【S3 wire 层自检】，仅统计脚本用
    // presignedGetObject 签发的 URL 能被 HTTP GET 取回且内容 sha256 一致；脚本不经过
    // 业务鉴权 / 审批授权 / hasApprovedDownloadGrant，不绕鉴权，也【不构成「下载功能
    // 已验证」】。审批后下载的业务放行链路（L2，授权写入未实现）本轮不验、不修、不绕过。
    console.log(
      'DOWNLOAD_SCOPE=S3_WIRE_LAYER_ONLY（PRESIGNED_DOWNLOADS_OK / PREVIEW_DOWNLOADS_OK 为 S3 wire 层自检，不绕鉴权，不构成下载功能已验证；业务放行链路 L2 未实现，本轮不验不修）',
    );
    console.log(`PRESIGNED_DOWNLOADS_OK=${downloadOk}`);
    console.log(`PREVIEW_DOWNLOADS_OK=${previewOk}`);
    console.log(`SHA256_VERIFIED=${shaOk}`);
    if (
      fileRecords.length === BOOKS.length * 2 &&
      doneCount === fileRecords.length &&
      shaOk === fileRecords.length &&
      previewOk === fileRecords.length &&
      (docTextCount[0]?.cnt ?? 0) > 0
    ) {
      console.log('IS_PASS: YES —— 上传挂接 / 全文抽取 / 综合检索 / 预览下载 / sha256 完整性全链路通过');
    } else {
      throw new Error('汇总统计未达预期（正向证据断言失败）');
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err: Error) => {
  console.error(`✖ demo 链路失败：${err.message}`);
  process.exit(1);
});
