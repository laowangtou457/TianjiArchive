import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  ALLOWED_MIME_TYPES,
  CHUNK_SIZE,
  ExtractStatus,
  MAX_FILE_SIZE,
  PreviewKind,
  QUEUE_NAME,
  resolvePreviewKind,
  type CompleteUploadRequest,
  type ElectronicFileDto,
  type ExtractJobPayload,
  type IntegrityCheckResult,
  type PermissionSnapshot,
  type PresignRequest,
  type PresignResponse,
  type PreviewResponse,
  BizException,
  ErrorCode,
} from '@tianji/shared';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { asPartialUpdate } from '../../common/types/typeorm-helpers';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { DocumentText } from '../../infra/database/entities/document-text.entity';
import { MinioService } from '../../infra/storage/storage.module';
import { DictService } from '../dict/dict.service';
import { ParamService } from '../param/param.service';
import { PARAM_KEY } from '../../common/constants/enums';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';

/** 魔法数字嗅探（上传内容双校验，架构 §8） */
const MAGIC_NUMBERS: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', bytes: [0x42, 0x4d] },
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { mime: 'video/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ftyp
  { mime: 'audio/wav', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  { mime: 'audio/x-wav', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'application/ofd', bytes: [0x50, 0x4b, 0x03, 0x04] }, // zip 容器
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  { mime: 'application/vnd.ms-excel', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { mime: 'application/msword', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { mime: 'application/vnd.ms-powerpoint', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  // 电子书：EPUB = ZIP 容器（与 OOXML 同 magic，按声明的 mime 分开比对）；
  // MOBI/AZW3 = PalmDB，'BOOKMOBI' 在文件偏移 60 —— 嗅探读取长度须 ≥ 64 字节
  { mime: 'application/epub+zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  {
    mime: 'application/x-mobipocket-ebook',
    bytes: [0x42, 0x4f, 0x4f, 0x4b, 0x4d, 0x4f, 0x42, 0x49], // BOOKMOBI
    offset: 60,
  },
  {
    mime: 'application/vnd.amazon.ebook', // AZW3（KF8）与 MOBI 同为 PalmDB 容器签名
    bytes: [0x42, 0x4f, 0x4f, 0x4b, 0x4d, 0x4f, 0x42, 0x49], // BOOKMOBI
    offset: 60,
  },
];

/**
 * 电子文件服务（F-08，DA/T 58-2014 / GB/T 18894-2016 四性检测）。
 *
 * 核心流程（架构 §6.2）：
 *   1) 预签名分片直传：API 只签发凭证，文件不经过 API 服务器（NFR-6）；
 *   2) 完成登记：服务端重算 SHA-256 与客户端比对（完整性基线，入库必记）；
 *   3) 入队抽取：BullMQ → apps/extractor 抽文本/缩略图/预览 PDF；
 *   4) 预览：预签名短时效 URL + 动态水印参数（Q4 默认策略）。
 *
 * 权限：预览与下载强制通过 AccessFilterBuilder 校验（与检索同一口径）。
 */
@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    @InjectRepository(ElectronicFile) private readonly fileRepo: Repository<ElectronicFile>,
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(DocumentText) private readonly textRepo: Repository<DocumentText>,
    private readonly minio: MinioService,
    private readonly dict: DictService,
    private readonly accessBuilder: AccessFilterBuilder,
    private readonly paramService: ParamService,
    @InjectQueue(QUEUE_NAME.EXTRACT) private readonly extractQueue: Queue,
  ) {}

  // ==========================================================================
  // 上传（预签名分片直传）
  // ==========================================================================

  /**
   * 签发上传凭证。
   * - 单文件大小上限取自参数 `file.max_upload_size_mb`（默认 2048MB，出厂与 NFR-6 一致）；
   * - 扩展名白名单取自参数 `file.allowed_extensions`（逗号分隔，空则不限）；
   * - mime 白名单校验（类型与内容双校验，内容在 complete 阶段嗅探）。
   */
  public async presign(dto: PresignRequest, user: PermissionSnapshot): Promise<PresignResponse> {
    if (!dto.filename || dto.filename.trim().length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '文件名不能为空');
    }

    // 大小上限参数化：读失败回落出厂常量，不因参数故障拒绝上传
    const maxBytes = await this.readMaxUploadBytes();
    if (dto.size <= 0 || dto.size > maxBytes) {
      const human = maxBytes >= 1024 * 1024 * 1024
        ? `${(maxBytes / 1024 / 1024 / 1024).toFixed(0)}GB`
        : `${Math.floor(maxBytes / 1024 / 1024)}MB`;
      throw new BizException(ErrorCode.FILE_TOO_LARGE, `单文件不得超过 ${human}`);
    }

    // 扩展名白名单（参数为空表示不限制，此时仅靠 mime 白名单兜底）
    const allowedExts = await this.readAllowedExtensions();
    if (allowedExts.length > 0) {
      const ext = path.extname(dto.filename).toLowerCase().replace('.', '');
      if (ext === '' || !allowedExts.includes(ext)) {
        throw new BizException(
          ErrorCode.FILE_UNSUPPORTED_TYPE,
          `不支持的文件扩展名：${ext === '' ? '(无扩展名)' : ext}。允许：${allowedExts.join('/')}`,
        );
      }
    }

    if (!ALLOWED_MIME_TYPES.includes(dto.mime)) {
      throw new BizException(
        ErrorCode.FILE_UNSUPPORTED_TYPE,
        `不支持的文件类型：${dto.mime}。允许：PDF/图片/Office/音视频/OFD/纯文本`,
      );
    }

    // 条目存在性 + 访问校验
    const item = await this.itemRepo.findOne({ where: { id: dto.itemId, deleted: false } });
    if (!item) throw new BizException(ErrorCode.NOT_FOUND, '档案条目不存在');
    if (
      !this.accessBuilder.canAccessRecord(user, {
        securityLevel: item.securityLevel,
        fondsId: item.fondsId,
      })
    ) {
      throw new BizException(ErrorCode.FORBIDDEN, '密级或数据范围不足，无法挂接电子文件');
    }

    const ext = path.extname(dto.filename).toLowerCase().replace('.', '') || 'bin';
    const datePath = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    const objectKey = `origin/${datePath}/${item.danghao}/${randomUUID()}.${ext}`;
    const bucket = this.minio.buckets.original;

    const multipart = dto.multipart !== false && dto.size > CHUNK_SIZE;
    if (!multipart) {
      const putUrl = await this.minio.presignPut(bucket, objectKey, dto.mime);
      return {
        uploadId: null,
        bucket,
        objectKey,
        partCount: 1,
        chunkSize: dto.size,
        partUrls: [],
        putUrl,
        expiresIn: this.minio.presignExpires,
      };
    }

    const uploadId = await this.minio.initMultipart(bucket, objectKey, dto.mime);
    const partCount = Math.ceil(dto.size / CHUNK_SIZE);
    const partUrls: Array<{ partNumber: number; url: string }> = [];
    for (let i = 1; i <= partCount; i += 1) {
      const url = await this.minio.presignUploadPart(bucket, objectKey, uploadId, i);
      partUrls.push({ partNumber: i, url });
    }

    return {
      uploadId,
      bucket,
      objectKey,
      partCount,
      chunkSize: CHUNK_SIZE,
      partUrls,
      putUrl: null,
      expiresIn: this.minio.presignExpires,
    };
  }

  /**
   * 完成上传登记：合并分片 → 服务端重算 SHA-256 → 落库 → 入抽取队列。
   */
  public async complete(
    dto: CompleteUploadRequest,
    user: PermissionSnapshot,
  ): Promise<ElectronicFileDto> {
    const item = await this.itemRepo.findOne({ where: { id: dto.itemId, deleted: false } });
    if (!item) throw new BizException(ErrorCode.NOT_FOUND, '档案条目不存在');

    // 1) 合并分片
    if (dto.uploadId && dto.parts && dto.parts.length > 0) {
      try {
        await this.minio.completeMultipart(dto.bucket, dto.objectKey, dto.uploadId, dto.parts);
      } catch (err) {
        this.logger.error(`合并分片失败: ${(err as Error).message}`);
        throw new BizException(ErrorCode.FILE_UPLOAD_INCOMPLETE, '分片上传未完成或分片缺失');
      }
    }

    // 2) 对象存在性与大小
    const exists = await this.minio.objectExists(dto.bucket, dto.objectKey);
    if (!exists) {
      throw new BizException(ErrorCode.FILE_UPLOAD_INCOMPLETE, '对象未上传成功，请重试');
    }

    // 3) 服务端重算 SHA-256（完整性基线，DA/T 58-2014）
    const computed = await this.minio.computeSha256(dto.bucket, dto.objectKey);
    const clientSha = (dto.sha256 ?? '').toLowerCase();
    if (clientSha && computed.sha256 !== clientSha) {
      this.logger.warn(
        `文件哈希不一致 item=${dto.itemId} client=${clientSha} server=${computed.sha256}`,
      );
      // 哈希不符时删除脏对象，避免垃圾数据
      await this.minio.removeObject(dto.bucket, dto.objectKey);
      throw new BizException(
        ErrorCode.FILE_HASH_MISMATCH,
        `文件完整性校验失败（SHA-256 不一致），已丢弃上传内容`,
      );
    }

    // 4) 内容魔数嗅探（防伪造扩展名）
    if (!ROUTES_MAGIC_CHECK_DISABLED()) {
      const ok = await this.sniffMagic(dto.bucket, dto.objectKey, dto.mime);
      if (!ok) {
        await this.minio.removeObject(dto.bucket, dto.objectKey);
        throw new BizException(
          ErrorCode.FILE_UNSUPPORTED_TYPE,
          '文件内容与声明的类型不匹配，已拒绝入库',
        );
      }
    }

    // 5) 落库（入库必记 SHA-256）
    const entity = this.fileRepo.create({
      itemId: dto.itemId,
      bucket: dto.bucket,
      objectKey: dto.objectKey,
      filename: dto.filename,
      mime: dto.mime,
      size: String(computed.size || dto.size),
      sha256: computed.sha256,
      extractStatus: ExtractStatus.PENDING,
      uploadedBy: user.userId,
    });
    const saved = await this.fileRepo.save(entity);

    // 6) 入抽取队列（并发 ≤4 由 worker 侧控制）
    const payload: ExtractJobPayload = {
      fileId: saved.id,
      itemId: saved.itemId,
      bucket: saved.bucket,
      objectKey: saved.objectKey,
      mime: saved.mime ?? dto.mime,
      filename: saved.filename,
    };
    try {
      await this.extractQueue.add('extract', payload, {
        jobId: `extract_${saved.id}`,
        removeOnComplete: true,
      });
      this.logger.log(`文件入库并已入抽取队列: ${saved.filename}（${saved.sha256.slice(0, 12)}…）`);
    } catch (err) {
      this.logger.warn(`入抽取队列失败（可手动重试）: ${(err as Error).message}`);
    }

    return this.toDto(saved);
  }

  /** 失败重投抽取任务 */
  public async requeueExtract(fileId: string): Promise<{ queued: boolean }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId } });
    if (!file) throw new BizException(ErrorCode.FILE_NOT_FOUND);
    await this.fileRepo.update({ id: fileId }, { extractStatus: ExtractStatus.PENDING, extractError: null });
    await this.extractQueue.add('extract', {
      fileId: file.id,
      itemId: file.itemId,
      bucket: file.bucket,
      objectKey: file.objectKey,
      mime: file.mime ?? 'application/octet-stream',
      filename: file.filename,
    } satisfies ExtractJobPayload);
    return { queued: true };
  }

  // ==========================================================================
  // 查询 / 预览 / 下载
  // ==========================================================================

  /** 某条目下的文件列表 */
  public async listByItem(itemId: string, user: PermissionSnapshot): Promise<ElectronicFileDto[]> {
    const item = await this.requireAccessibleItem(itemId, user);
    const rows = await this.fileRepo.find({
      where: { itemId: item.id },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => this.toDto(r));
  }

  /** 文件详情 */
  public async detail(fileId: string, user: PermissionSnapshot): Promise<ElectronicFileDto> {
    const { file } = await this.requireAccessibleFile(fileId, user);
    return this.toDto(file);
  }

  /**
   * 预览：返回短时效预签名 URL + 预览类型。
   * Office 走服务端转换的 PDF（preview_key），无则提示降级下载。
   */
  public async preview(fileId: string, user: PermissionSnapshot): Promise<PreviewResponse> {
    const { file } = await this.requireAccessibleFile(fileId, user);
    const mime = file.mime ?? 'application/octet-stream';
    const kind = resolvePreviewKind(mime);
    const watermarked = await this.dict.isWatermarkEnabled();
    // 水印文案同样来自参数（preview.watermark_text）。前端必须用这个值渲染，
    // 不得另写字面量，否则 D-6「改水印→新预览生效」在前端断链。
    const watermarkTemplate = watermarked ? await this.dict.getWatermarkTemplate() : '';

    // Office：优先返回转换后的 PDF
    if (kind === 'OFFICE') {
      if (file.previewKey) {
        const url = await this.minio.presignGet(this.minio.buckets.preview, file.previewKey, 900);
        return {
          url,
          kind: PreviewKind.PDF,
          mime: 'application/pdf',
          filename: `${path.parse(file.filename).name}.pdf`,
          expiresIn: 900,
          watermarked,
          watermarkTemplate,
        };
      }
      if (file.extractStatus === ExtractStatus.PENDING || file.extractStatus === ExtractStatus.RUNNING) {
        throw new BizException(
          ErrorCode.PREVIEW_UNSUPPORTED,
          'Office 文档正在转换为 PDF，请稍后重试（通常 10~60 秒）',
        );
      }
      throw new BizException(
        ErrorCode.PREVIEW_UNSUPPORTED,
        '该文档暂无法在线预览（转换失败），可申请下载原件',
      );
    }

    if (kind === 'NONE') {
      throw new BizException(ErrorCode.PREVIEW_UNSUPPORTED, '该格式不支持在线预览');
    }

    // 电子书容器：EPUB 返回原件 presign URL（前端 epub.js 解码渲染）；
    // MOBI/AZW3 预览降级为抽取文本（前端无 PalmDB 解码器，转换器已产出 document_text）
    if (kind === 'EBOOK') {
      if (mime === 'application/epub+zip') {
        const url = await this.minio.presignGet(file.bucket, file.objectKey, 900);
        return {
          url,
          kind: PreviewKind.EBOOK,
          mime,
          filename: file.filename,
          expiresIn: 900,
          watermarked,
          watermarkTemplate,
        };
      }
      const text = await this.textRepo.findOne({ where: { fileId: file.id }, order: { version: 'DESC' } });
      if (!text || !text.content) {
        if (file.extractStatus === ExtractStatus.PENDING || file.extractStatus === ExtractStatus.RUNNING) {
          throw new BizException(
            ErrorCode.PREVIEW_UNSUPPORTED,
            '电子书正在解析正文，请稍后重试（通常 10~60 秒）',
          );
        }
        throw new BizException(
          ErrorCode.PREVIEW_UNSUPPORTED,
          '该电子书暂无可预览的正文（解析失败），可申请下载原件',
        );
      }
      const buffer = Buffer.from(text.content, 'utf8');
      const key = `preview-text/${file.id}.txt`;
      await this.minio.putObject(this.minio.buckets.preview, key, buffer, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      const url = await this.minio.presignGet(this.minio.buckets.preview, key, 900);
      return {
        url,
        kind: PreviewKind.TEXT,
        mime: 'text/plain; charset=utf-8',
        filename: `${path.parse(file.filename).name}.txt`,
        expiresIn: 900,
        watermarked: false,
        watermarkTemplate: '',
      };
    }

    // 文本类：读 document_text 直接返回（避免暴露原件）
    if (kind === 'TEXT') {
      const text = await this.textRepo.findOne({ where: { fileId: file.id }, order: { version: 'DESC' } });
      const buffer = Buffer.from(text?.content ?? '', 'utf8');
      const key = `preview-text/${file.id}.txt`;
      await this.minio.putObject(this.minio.buckets.preview, key, buffer, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      const url = await this.minio.presignGet(this.minio.buckets.preview, key, 900);
      return {
        url,
        kind: PreviewKind.TEXT,
        mime: 'text/plain; charset=utf-8',
        filename: `${path.parse(file.filename).name}.txt`,
        expiresIn: 900,
        watermarked: false,
        watermarkTemplate: '',
      };
    }

    const url = await this.minio.presignGet(file.bucket, file.objectKey, 900);
    return {
      url,
      kind,
      mime,
      filename: file.filename,
      expiresIn: 900,
      watermarked,
      watermarkTemplate,
    };
  }

  /**
   * 下载：受参数 `preview.download_mode` 三态控制。
   *
   * - `disabled`：一律拒绝（默认，仅在线预览）；
   * - `approval`：需沿借阅/下载审批流放行后才可下载 —— 本方法只放行「已批准」的单据，
   *   判定依据是调用方传入 `user` 已有的下载授权（审批通过后由审批链路授予临时权限）；
   * - `free`：直接签发下载 URL。
   *
   * 无论哪种模式，都必须具备 FILE 域 READ 权限，并强制留痕（拦截器）。
   */
  public async download(
    fileId: string,
    user: PermissionSnapshot,
  ): Promise<{ url: string; filename: string; expiresIn: number }> {
    const mode = await this.dict.getDownloadMode();

    if (mode === 'disabled') {
      throw new BizException(
        ErrorCode.DOWNLOAD_DISABLED,
        '系统当前仅允许在线预览，下载需经审批后由管理员临时开启',
      );
    }
    if (mode === 'approval' && !this.hasApprovedDownloadGrant(user)) {
      throw new BizException(
        ErrorCode.DOWNLOAD_DISABLED,
        '当前下载模式为「审批后下载」，请先提交下载申请并等待审批通过',
      );
    }

    const { file } = await this.requireAccessibleFile(fileId, user);
    const url = await this.minio.presignGet(file.bucket, file.objectKey, 300, {
      'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    });
    return { url, filename: file.filename, expiresIn: 300 };
  }

  /**
   * 判定用户是否已获得「下载放行」授权（approval 模式使用）。
   *
   * 授来源：FILE 域显式 `DOWNLOAD` 操作授权。审批通过后由审批链路写入，
   * 因此这里不需要再查审批单 —— 授权本身就是审批结果的载体。
   */
  private hasApprovedDownloadGrant(user: PermissionSnapshot): boolean {
    const grant = user.grants?.['FILE'];
    if (!grant) return false;
    const ops = (grant.ops ?? []) as readonly string[];
    return ops.includes('DOWNLOAD');
  }

  /** 单文件大小上限（字节），读参数失败时回落出厂常量 */
  private async readMaxUploadBytes(): Promise<number> {
    try {
      const mb = await this.paramService.getInt(PARAM_KEY.FILE_MAX_UPLOAD_SIZE_MB);
      if (Number.isFinite(mb) && mb > 0) return mb * 1024 * 1024;
    } catch (err) {
      this.logger.warn(`读取 file.max_upload_size_mb 失败，回落出厂上限: ${(err as Error).message}`);
    }
    return MAX_FILE_SIZE;
  }

  /** 允许的扩展名（小写、去点）。空数组表示不限制 */
  private async readAllowedExtensions(): Promise<string[]> {
    try {
      const raw = await this.paramService.get(PARAM_KEY.FILE_ALLOWED_EXTENSIONS);
      return String(raw ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
        .filter((s) => s.length > 0);
    } catch (err) {
      this.logger.warn(`读取 file.allowed_extensions 失败，按不限处理: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * 四性检测（P0 实现「完整性」：重算 SHA-256 比对；其余三项返回 UNKNOWN 预留）。
   * 接口：POST /api/files/:id/integrity-check
   */
  public async integrityCheck(fileId: string, user: PermissionSnapshot): Promise<IntegrityCheckResult> {
    const { file } = await this.requireAccessibleFile(fileId, user);
    const checkedAt = new Date().toISOString();
    let actualSha256 = '';
    let integrity: 'PASS' | 'FAIL' = 'FAIL';
    try {
      const computed = await this.minio.computeSha256(file.bucket, file.objectKey);
      actualSha256 = computed.sha256;
      integrity = computed.sha256.toLowerCase() === file.sha256.toLowerCase() ? 'PASS' : 'FAIL';
    } catch (err) {
      this.logger.warn(`四性检测读取对象失败 file=${fileId}: ${(err as Error).message}`);
      actualSha256 = '';
      integrity = 'FAIL';
    }

    const result: IntegrityCheckResult = {
      integrity,
      authenticity: 'UNKNOWN',
      usability:
        file.extractStatus === ExtractStatus.OK
          ? 'PASS'
          : file.extractStatus === ExtractStatus.FAILED
            ? 'FAIL'
            : 'UNKNOWN',
      security: 'UNKNOWN',
      expectedSha256: file.sha256,
      actualSha256,
      checkedAt,
      message:
        integrity === 'PASS'
          ? '完整性校验通过（SHA-256 一致）；真实性/可用性/安全性为 P1 扩展项'
          : '完整性校验失败：对象内容与入库基线不一致，疑似被篡改或损坏',
    };

    // 结果落库，供后续审计与台账展示
    await this.fileRepo.update(
      { id: fileId },
      asPartialUpdate<ElectronicFile>({
        authenticityCheck: result as unknown as Record<string, unknown>,
      }),
    );
    return result;
  }

  /** 删除文件（软清理：移除对象 + 删除记录） */
  public async remove(fileId: string, user: PermissionSnapshot): Promise<{ deleted: boolean }> {
    const { file } = await this.requireAccessibleFile(fileId, user);
    await this.minio.removeObject(file.bucket, file.objectKey);
    if (file.previewKey) await this.minio.removeObject(this.minio.buckets.preview, file.previewKey);
    if (file.thumbKey) await this.minio.removeObject(this.minio.buckets.thumb, file.thumbKey);
    await this.fileRepo.delete({ id: fileId });
    return { deleted: true };
  }

  /** 条目全文（抽取结果，供检索与详情展示） */
  public async itemFulltext(itemId: string, user: PermissionSnapshot): Promise<{ content: string }> {
    const item = await this.requireAccessibleItem(itemId, user);
    const rows = await this.textRepo.find({ where: { itemId: item.id }, order: { version: 'DESC' } });
    const content = rows.map((r) => r.content).join('\n');
    return { content: content || item.fullText || '' };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 校验条目可访问（密级 + 数据范围，与检索同源） */
  private async requireAccessibleItem(
    itemId: string,
    user: PermissionSnapshot,
  ): Promise<ArchiveItem> {
    const item = await this.itemRepo.findOne({ where: { id: itemId, deleted: false } });
    if (!item) throw new BizException(ErrorCode.NOT_FOUND, '档案条目不存在');
    if (
      !this.accessBuilder.canAccessRecord(user, {
        securityLevel: item.securityLevel,
        fondsId: item.fondsId,
        createdBy: item.createdBy,
      })
    ) {
      throw new BizException(ErrorCode.FORBIDDEN, '密级或数据范围不足，无法访问该档案');
    }
    return item;
  }

  /** 校验文件可访问 */
  private async requireAccessibleFile(
    fileId: string,
    user: PermissionSnapshot,
  ): Promise<{ file: ElectronicFile; item: ArchiveItem }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId } });
    if (!file) throw new BizException(ErrorCode.FILE_NOT_FOUND, '电子文件不存在');
    const item = await this.requireAccessibleItem(file.itemId, user);
    return { file, item };
  }

  /** 读取对象头部并做魔数比对 */
  private async sniffMagic(bucket: string, objectKey: string, declaredMime: string): Promise<boolean> {
    const candidates = MAGIC_NUMBERS.filter((m) => m.mime === declaredMime);
    if (candidates.length === 0) {
      // 无对应签名规则的类型（如 audio/mpeg、text/plain）不做强校验
      return true;
    }
    try {
      // 读取头部 128 字节：MOBI 的 'BOOKMOBI' 签名在偏移 60，16 字节不够
      const HEAD_BYTES = 128;
      const stream = await this.minio.getObjectStream(bucket, objectKey);
      const head = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const onData = (chunk: Buffer): void => {
          chunks.push(chunk);
          total += chunk.length;
          if (total >= HEAD_BYTES) {
            stream.removeListener('data', onData);
            (stream as unknown as { destroy?: () => void }).destroy?.();
            resolve(Buffer.concat(chunks).subarray(0, HEAD_BYTES));
          }
        };
        stream.on('data', onData);
        stream.on('end', () => resolve(Buffer.concat(chunks).subarray(0, HEAD_BYTES)));
        stream.on('error', reject);
      });
      return candidates.some((c) => {
        const offset = c.offset ?? 0;
        if (head.length < offset + c.bytes.length) return false;
        return c.bytes.every((b, i) => head[offset + i] === b);
      });
    } catch (err) {
      this.logger.warn(`魔数嗅探失败（放行）: ${(err as Error).message}`);
      return true;
    }
  }

  private toDto(r: ElectronicFile): ElectronicFileDto {
    const mime = r.mime ?? 'application/octet-stream';
    return {
      id: r.id,
      itemId: r.itemId,
      bucket: r.bucket,
      objectKey: r.objectKey,
      filename: r.filename,
      mime: r.mime,
      size: Number(r.size),
      sha256: r.sha256,
      previewKey: r.previewKey,
      thumbKey: r.thumbKey,
      extractStatus: r.extractStatus,
      previewKind: resolvePreviewKind(mime),
      createdAt: new Date(r.createdAt).toISOString(),
      integrityCheck: (r.authenticityCheck as unknown as IntegrityCheckResult) ?? null,
    };
  }
}

/** 环境开关：压测时可跳过魔数嗅探（默认开启校验） */
function ROUTES_MAGIC_CHECK_DISABLED(): boolean {
  return (process.env.FILE_MAGIC_CHECK ?? 'true').toLowerCase() === 'false';
}
