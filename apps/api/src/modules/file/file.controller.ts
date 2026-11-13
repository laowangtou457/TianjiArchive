import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  BUCKET,
  type CompleteUploadRequest,
  type ElectronicFileDto,
  type IntegrityCheckResult,
  type PermissionSnapshot,
  type PresignRequest,
  type PresignResponse,
  type PreviewResponse,
} from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { FileService } from './file.service';

/**
 * 电子文件控制器（F-08）。
 *
 * 审计要求（硬性验收要点 4）：
 *   - 预览 PREVIEW、下载 DOWNLOAD 必须强制留痕（mandatory=true，不可用 @SkipAudit 关闭）。
 */
@Controller('files')
export class FileController {
  public constructor(private readonly fileService: FileService) {}

  /**
   * 申请上传凭证：>5MB 自动切分片，返回逐片预签名 URL。
   * 文件不经过 API 服务器（NFR-6），API 仅签发凭证。
   */
  @Post('presign')
  @RequirePerm({ domain: 'FILE', op: 'WRITE', checkScope: false, objectType: 'FILE' })
  @Audit({ action: 'UPDATE', objectType: 'FILE', objectIdPath: 'body.itemId' })
  public async presign(
    @Body() dto: PresignRequest,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PresignResponse> {
    return this.fileService.presign(dto, user as PermissionSnapshot);
  }

  /**
   * 完成上传登记：服务端重算 SHA-256（入库必记）、魔数嗅探、入抽取队列。
   */
  @Post('complete')
  @RequirePerm({ domain: 'FILE', op: 'WRITE', checkScope: false, objectType: 'FILE' })
  @Audit({ action: 'CREATE', objectType: 'ELECTRONIC_FILE', objectIdPath: 'body.itemId' })
  public async complete(
    @Body() dto: CompleteUploadRequest,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ElectronicFileDto> {
    return this.fileService.complete({ ...dto, bucket: dto.bucket || BUCKET.ORIGINAL }, user as PermissionSnapshot);
  }

  /** 某条目下的文件列表 */
  @Get()
  @RequirePerm({
    domain: 'FILE',
    op: 'READ',
    checkScope: false,
    objectType: 'FILE',
    // 检索利用链路：持检索权（R3/R4）可查看件下电子文件清单（行级密级校验在 service）
    altPerm: { domain: 'SEARCH', op: 'READ' },
  })
  public async list(
    @Query('itemId') itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ElectronicFileDto[]> {
    return this.fileService.listByItem(itemId, user as PermissionSnapshot);
  }

  /** 文件详情 */
  @Get(':id')
  @RequirePerm({ domain: 'FILE', op: 'READ', checkScope: false, objectType: 'FILE' })
  public async detail(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ElectronicFileDto> {
    return this.fileService.detail(id, user as PermissionSnapshot);
  }

  /** 在线预览（强制留痕） */
  @Get(':id/preview')
  @RequirePerm({ domain: 'PREVIEW', op: 'READ', checkScope: false, objectType: 'FILE' })
  @Audit({ action: 'PREVIEW', objectType: 'ELECTRONIC_FILE', mandatory: true, objectIdPath: 'params.id' })
  public async preview(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PreviewResponse> {
    return this.fileService.preview(id, user as PermissionSnapshot);
  }

  /** 下载原件（受系统参数控制，强制留痕） */
  @Get(':id/download')
  @RequirePerm({ domain: 'FILE', op: 'READ', checkScope: false, objectType: 'FILE' })
  @Audit({ action: 'DOWNLOAD', objectType: 'ELECTRONIC_FILE', mandatory: true, objectIdPath: 'params.id' })
  public async download(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ url: string; filename: string; expiresIn: number }> {
    return this.fileService.download(id, user as PermissionSnapshot);
  }

  /** 四性检测（P0 实现完整性：重算 SHA-256） */
  @Post(':id/integrity-check')
  @RequirePerm({ domain: 'FILE', op: 'READ', checkScope: false, objectType: 'FILE' })
  @Audit({ action: 'UPDATE', objectType: 'ELECTRONIC_FILE', objectIdPath: 'params.id' })
  public async integrityCheck(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<IntegrityCheckResult> {
    return this.fileService.integrityCheck(id, user as PermissionSnapshot);
  }

  /** 抽取失败重投 */
  @Post(':id/requeue-extract')
  @RequirePerm({ domain: 'FILE', op: 'WRITE', checkScope: false, objectType: 'FILE' })
  @Audit({ action: 'UPDATE', objectType: 'ELECTRONIC_FILE', objectIdPath: 'params.id' })
  public async requeue(@Param('id') id: string): Promise<{ queued: boolean }> {
    return this.fileService.requeueExtract(id);
  }

  /** 删除文件（含对象存储清理） */
  @Delete(':id')
  @RequirePerm({ domain: 'FILE', op: 'DELETE', checkScope: false, objectType: 'FILE' })
  @Audit({ action: 'DELETE', objectType: 'ELECTRONIC_FILE', mandatory: true, objectIdPath: 'params.id' })
  public async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ deleted: boolean }> {
    return this.fileService.remove(id, user as PermissionSnapshot);
  }
}
