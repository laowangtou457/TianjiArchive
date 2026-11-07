import { Module } from '@nestjs/common';
import { AccessModule } from './access/access.module';
import { RedisModule } from '../infra/redis/redis.module';

/**
 * 公共模块聚合：把 AccessModule / RedisModule 的全局能力显式引入，
 * 便于各业务模块只 import 本模块即可获得权限过滤器与缓存。
 * （AppModule 已 import 两者，此处作为可读性封装，保持向后兼容）
 */
@Module({
  imports: [AccessModule, RedisModule],
  exports: [AccessModule, RedisModule],
})
export class CommonModule {}
