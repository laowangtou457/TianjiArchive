import { Global, Module } from '@nestjs/common';
import { AccessFilterBuilder } from './access-filter.builder';
import { AccessDeniedEchoFilter } from './access.module.filter';

/**
 * 访问控制模块（全局）。
 * Search / File / Kb 三个模块显式依赖同一个 AccessFilterBuilder 实例，
 * 保证「检索、预览、kb」三处权限过滤口径完全一致（硬性验收要点 3）。
 */
@Global()
@Module({
  providers: [AccessFilterBuilder, AccessDeniedEchoFilter],
  exports: [AccessFilterBuilder, AccessDeniedEchoFilter],
})
export class AccessModule {}

export { AccessFilterBuilder };
