/**
 * 认证状态（Zustand）。
 *
 * 职责：
 *   - 保存登录态（token + 权限快照），持久化到 localStorage 的只有 token；
 *   - 启动时若已有 token 则拉取 /auth/profile 恢复快照（保证权限实时）；
 *   - 提供 can() 判定，供 PermGate 组件与按钮置灰使用（口径与后端 checkPermission 一致）。
 */
import { create } from 'zustand';
import {
  checkPermission,
  type OperationType,
  type PermissionDomain,
  type PermissionSnapshot,
  type RoleCode,
  type SecurityLevel,
} from '@tianji/shared';
import { authApi } from '../api';
import { ApiError, setUnauthorizedHandler, tokenStore } from '../api/client';

interface AuthState {
  /** 权限快照（未登录为 null） */
  profile: PermissionSnapshot | null;
  /** 是否已完成启动恢复（避免路由守卫误跳） */
  ready: boolean;
  /** 登录中 */
  loading: boolean;
  /** 错误提示 */
  error: string | null;

  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** 是否具备某功能域操作权限 */
  can: (domain: PermissionDomain, op: OperationType) => boolean;
  /** 是否具备任一角色 */
  hasRole: (...roles: RoleCode[]) => boolean;
  /** 密级是否足够 */
  canLevel: (level: SecurityLevel) => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  profile: null,
  ready: false,
  loading: false,
  error: null,

  /** 登录 */
  login: async (username: string, password: string): Promise<void> => {
    set({ loading: true, error: null });
    try {
      const res = await authApi.login({ username, password });
      tokenStore.set(res.accessToken, res.refreshToken);
      set({ profile: res.profile, ready: true, loading: false, error: null });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '登录失败，请检查网络';
      set({ loading: false, error: message });
      throw err instanceof Error ? err : new Error(message);
    }
  },

  /** 登出（尽力通知后端吊销，失败也清本地） */
  logout: async (): Promise<void> => {
    const refresh = tokenStore.getRefresh();
    try {
      await authApi.logout(refresh ?? undefined);
    } catch {
      // 忽略：本地清理优先
    }
    tokenStore.clear();
    set({ profile: null, ready: true, error: null });
  },

  /** 启动恢复：有 token 则拉快照 */
  bootstrap: async (): Promise<void> => {
    if (!tokenStore.getAccess()) {
      set({ ready: true, profile: null });
      return;
    }
    try {
      const profile = await authApi.profile();
      set({ profile, ready: true });
    } catch {
      tokenStore.clear();
      set({ profile: null, ready: true });
    }
  },

  /** 手动刷新快照（权限变更后） */
  refreshProfile: async (): Promise<void> => {
    try {
      const profile = await authApi.profile();
      set({ profile });
    } catch {
      set({ profile: null });
    }
  },

  /** 权限判定 */
  can: (domain: PermissionDomain, op: OperationType): boolean => {
    const { profile } = get();
    return checkPermission(profile, domain, op).allowed;
  },

  /** 角色判定 */
  hasRole: (...roles: RoleCode[]): boolean => {
    const { profile } = get();
    if (!profile) return false;
    if (roles.length === 0) return profile.roles.length > 0;
    return roles.some((r) => profile.roles.includes(r));
  },

  /** 密级判定 */
  canLevel: (level: SecurityLevel): boolean => {
    const { profile } = get();
    if (!profile) return false;
    const rank: Record<SecurityLevel, number> = { PUBLIC: 0, INTERNAL: 1, SECRET: 2 };
    return rank[level] <= rank[profile.maxSecurityLevel];
  },
}));

/** 401 时统一清空登录态 */
setUnauthorizedHandler(() => {
  useAuthStore.setState({ profile: null, ready: true });
});
