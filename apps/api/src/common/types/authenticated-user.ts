import type { PermissionSnapshot } from '@tianji/shared';

/**
 * 认证后的用户上下文（由 JwtAuthGuard 挂载到 request.currentUser）。
 * 与前端 PermissionSnapshot 同构，保证前后端判定口径一致。
 */
export interface AuthenticatedUser extends PermissionSnapshot {
  /** JWT 签发时间（秒） */
  iat?: number;
  /** JWT 过期时间（秒） */
  exp?: number;
  /** 会话 ID（用于刷新令牌吊销） */
  sessionId: string;
}

/** JWT access token 载荷 */
export interface JwtPayload {
  sub: string;
  username: string;
  sessionId: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

/** 登录审计补充信息 */
export interface LoginContext {
  ip: string;
  userAgent: string;
}
