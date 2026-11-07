import type { ReactElement, ReactNode } from 'react';
import { useAuthStore } from '../stores/authStore';
import { checkPermission, type OperationType, type PermissionDomain } from '@tianji/shared';
import { Tooltip } from '@mui/material';

/** PermGate 属性 */
export interface PermGateProps {
  domain: PermissionDomain;
  op: OperationType;
  /** 是否连同密级/范围一起判定（默认 false，仅判定功能域操作） */
  withLevel?: boolean;
  /** 密级（withLevel=true 时生效） */
  level?: 'PUBLIC' | 'INTERNAL' | 'SECRET';
  /** 放行的 children；无权限时渲染 fallback（默认 null） */
  children: ReactNode;
  /** 无权限时的替代内容 */
  fallback?: ReactNode;
  /**
   * 无权限时是否用 Tooltip 包裹并提供中文原因（PRD：按钮置灰 + title 说明）。
   * 仅在 fallback 未指定时生效。
   */
  explain?: boolean;
}

/**
 * 权限门：前端展示态控制。
 *
 * 注意（重要）：前端仅用于「置灰/隐藏 + 提示原因」，服务端 PermissionGuard 才是最终裁决。
 * 判定函数与后端同源（@tianji/shared 的 checkPermission），保证口径一致。
 */
export function PermGate(props: PermGateProps): ReactElement | null {
  const { domain, op, withLevel = false, level, children, fallback, explain = true } = props;
  const profile = useAuthStore((s) => s.profile);

  const result = checkPermission(profile, domain, op, withLevel && level ? { level } : undefined);

  if (result.allowed) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;

  const node = (
    <span
      style={{ display: 'inline-block', cursor: 'not-allowed', opacity: 0.55 }}
      aria-disabled="true"
    >
      {children}
    </span>
  );
  if (!explain) return node;
  return (
    <Tooltip title={result.reason || '无权限执行该操作'}>
      <span style={{ display: 'inline-block' }}>{node}</span>
    </Tooltip>
  );
}
