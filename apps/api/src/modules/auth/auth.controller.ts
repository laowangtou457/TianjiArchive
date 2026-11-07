import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import {
  type ChangePasswordRequest,
  type LoginResponse,
  type LoginRequest,
  type PermissionSnapshot,
  type RefreshResponse,
} from '@tianji/shared';
import { AuthService } from './auth.service';
import { Public, CurrentUser } from '../../common/decorators/require-perm.decorator';

/** 登录 DTO */
export class LoginDto implements LoginRequest {
  @IsString()
  @IsNotEmpty({ message: '用户名不能为空' })
  @MaxLength(64)
  public username!: string;

  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  @MaxLength(128)
  public password!: string;
}

/** 刷新 DTO */
export class RefreshDto {
  @IsString()
  @IsNotEmpty({ message: 'refreshToken 不能为空' })
  public refreshToken!: string;
}

/** 登出 DTO */
export class LogoutDto {
  @IsString()
  public refreshToken?: string;
}

/** 改密 DTO */
export class ChangePasswordDto implements ChangePasswordRequest {
  @IsString()
  @IsNotEmpty({ message: '原密码不能为空' })
  public oldPassword!: string;

  @IsString()
  @MinLength(8, { message: '新密码长度不得少于 8 位' })
  @MaxLength(128)
  public newPassword!: string;
}

/**
 * 认证接口（架构 §5）。
 * POST /api/auth/login · /refresh · /logout · /change-password · GET /profile
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 登录：无需认证 */
  @Public()
  @Post('login')
  public async login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResponse> {
    const ip = this.clientIp(req);
    return this.authService.login(dto.username, dto.password, ip);
  }

  /** 刷新令牌：无需认证（自带 refresh token 校验） */
  @Public()
  @Post('refresh')
  public async refresh(@Body() dto: RefreshDto): Promise<RefreshResponse> {
    return this.authService.refresh(dto.refreshToken);
  }

  /** 登出：吊销 refresh token */
  @Post('logout')
  public async logout(
    @Body() dto: LogoutDto,
    @CurrentUser('userId') userId: string,
  ): Promise<{ loggedOut: boolean }> {
    await this.authService.logout(dto.refreshToken, userId);
    return { loggedOut: true };
  }

  /** 当前用户权限快照 */
  @Get('profile')
  public async profile(@CurrentUser('userId') userId: string): Promise<PermissionSnapshot> {
    return this.authService.profile(userId);
  }

  /** 修改密码 */
  @Post('change-password')
  public async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser('userId') userId: string,
  ): Promise<{ changed: boolean }> {
    await this.authService.changePassword(userId, dto.oldPassword, dto.newPassword);
    return { changed: true };
  }

  private clientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return (req.ip ?? req.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  }
}
