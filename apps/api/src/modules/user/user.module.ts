import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { UserAdminService } from './user-admin.service';
import { RoleController, UserController } from './user.controller';
import { AppUser } from '../../infra/database/entities/user.entity';
import { Role } from '../../infra/database/entities/role.entity';
import { UserDataScope } from '../../infra/database/entities/user-data-scope.entity';
import { ParamModule } from '../param/param.module';

/**
 * 用户模块：提供 UserService（被 Auth/Search/File 等复用）与用户管理接口。
 *
 * 依赖 ParamModule：密码策略与登录锁定阈值来自 sys_param（security 组直读库）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([AppUser, Role, UserDataScope]), ParamModule],
  controllers: [UserController, RoleController],
  providers: [UserService, UserAdminService],
  exports: [UserService, UserAdminService],
})
export class UserModule {}
