import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UserModule } from '../user/user.module';
import { ParamModule } from '../param/param.module';
import { AppUser } from '../../infra/database/entities/user.entity';
import { Role } from '../../infra/database/entities/role.entity';
import type { AppConfig } from '../../config/configuration';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppUser, Role]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const jwt = config.get<AppConfig['jwt']>('jwt');
        return {
          secret: jwt?.accessSecret,
          signOptions: { expiresIn: jwt?.accessTtlSeconds ?? 7200 },
        };
      },
    }),
    UserModule,
    ParamModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
