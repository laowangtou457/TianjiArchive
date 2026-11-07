/**
 * 前端 API 客户端。
 *
 * 职责：
 *   - 统一 baseURL（/api）+ 统一响应信封解包（{code,data,message}）；
 *   - 自动附带 accessToken，遇到 401/1009 自动用 refreshToken 续期并重放请求；
 *   - 续期失败则清空登录态并跳转 /login；
 *   - 错误统一转换为 ApiError（携带业务 code/message/details），便于页面直接展示 message。
 */
import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ApiResponse, RefreshResponse } from '@tianji/shared';

/** 业务异常 */
export class ApiError extends Error {
  public readonly code: number;
  public readonly httpStatus: number;
  public readonly details: unknown;

  public constructor(code: number, message: string, httpStatus = 400, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** 令牌存储键 */
const ACCESS_KEY = 'tianji.accessToken';
const REFRESH_KEY = 'tianji.refreshToken';

export const tokenStore = {
  getAccess(): string | null {
    return localStorage.getItem(ACCESS_KEY);
  },
  getRefresh(): string | null {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh: string): void {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear(): void {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

/** 401 回调（由 authStore 注册，避免循环依赖） */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

/** 认证相关路径不附加令牌、不重试 */
const AUTH_PATHS = ['/auth/login', '/auth/refresh', '/health'];

/** 原始 axios 实例 */
const http: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

/** 请求拦截：附加令牌 */
http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const url = config.url ?? '';
  if (!AUTH_PATHS.some((p) => url.startsWith(p))) {
    const token = tokenStore.getAccess();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** 刷新中的请求队列（并发 401 只刷新一次） */
let refreshing: Promise<string> | null = null;

/** 刷新令牌 */
async function refreshAccessToken(): Promise<string> {
  const refreshToken = tokenStore.getRefresh();
  if (!refreshToken) throw new ApiError(1002, '登录已过期，请重新登录', 401);

  const res = await axios.post<ApiResponse<RefreshResponse>>(
    '/api/auth/refresh',
    { refreshToken },
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.data.code !== 0 || !res.data.data?.accessToken) {
    throw new ApiError(res.data.code, res.data.message ?? '刷新令牌失败', 401);
  }
  tokenStore.set(res.data.data.accessToken, res.data.data.refreshToken);
  return res.data.data.accessToken;
}

/** 响应拦截：解包信封 + 401 续期 */
http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiResponse<unknown>>) => {
    const status = error.response?.status ?? 0;
    const body = error.response?.data;
    const original = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;

    // 401：尝试续期一次（业务码 1009 令牌过期 / 1002 未登录 / 1008 令牌无效）
    if (
      status === 401 &&
      original &&
      !original._retried &&
      !AUTH_PATHS.some((p) => (original.url ?? '').startsWith(p))
    ) {
      original._retried = true;
      try {
        if (!refreshing) {
          refreshing = refreshAccessToken().finally(() => {
            refreshing = null;
          });
        }
        const token = await refreshing;
        original.headers = { ...(original.headers ?? {}), Authorization: `Bearer ${token}` };
        return http.request(original);
      } catch {
        tokenStore.clear();
        onUnauthorized?.();
        throw new ApiError(1002, '登录已过期，请重新登录', 401);
      }
    }

    const code = body?.code ?? statusToCode(status);
    const message = body?.message ?? error.message ?? '网络请求失败';
    if (status === 403) {
      throw new ApiError(code, message || '无权限执行该操作', 403, body?.data);
    }
    throw new ApiError(code, message, status, body?.data);
  },
);

/** HTTP 状态 → 业务码（后端不可达时兜底） */
function statusToCode(status: number): number {
  if (status === 0) return 5001;
  if (status === 400) return 1001;
  if (status === 401) return 1002;
  if (status === 403) return 1003;
  if (status === 404) return 1004;
  if (status === 409) return 1005;
  if (status === 413) return 4003;
  if (status === 429) return 1006;
  return 5000;
}

/** 解包并返回 data */
async function unwrap<T>(promise: Promise<{ data: ApiResponse<T> }>): Promise<T> {
  const res = await promise;
  const body = res.data;
  if (body && typeof body.code === 'number' && body.code !== 0) {
    throw new ApiError(body.code, body.message ?? '请求失败', 200, body.data);
  }
  return body.data;
}

/** 便捷方法 */
export const api = {
  get: <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
    unwrap<T>(http.get<ApiResponse<T>>(url, { params })),

  post: <T>(url: string, data?: unknown): Promise<T> =>
    unwrap<T>(http.post<ApiResponse<T>>(url, data)),

  patch: <T>(url: string, data?: unknown): Promise<T> =>
    unwrap<T>(http.patch<ApiResponse<T>>(url, data)),

  put: <T>(url: string, data?: unknown): Promise<T> =>
    unwrap<T>(http.put<ApiResponse<T>>(url, data)),

  delete: <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
    unwrap<T>(http.delete<ApiResponse<T>>(url, { params })),

  /** 下载二进制（报表导出、审计日志导出） */
  download: async (url: string, params?: Record<string, unknown>, filename?: string): Promise<void> => {
    const res = await http.get<Blob>(url, { params, responseType: 'blob' });
    const blob = res.data;
    const cd = String(res.headers['content-disposition'] ?? '');
    const match = /filename\*=UTF-8''([^;]+)/.exec(cd);
    const name = filename ?? (match ? decodeURIComponent(match[1]) : 'download.bin');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  },
};

export { http };
