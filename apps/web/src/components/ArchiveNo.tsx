import type { ReactElement } from 'react';
import { Chip, Tooltip } from '@mui/material';
import { SECURITY_LEVEL_LABELS, type SecurityLevel } from '@tianji/shared';

/** 档号展示属性 */
export interface ArchiveNoProps {
  value: string;
  /** 是否等宽字体（默认 true） */
  mono?: boolean;
  /** 是否可复制（默认 false） */
  copyable?: boolean;
  /** 是否标红（作废档号） */
  voided?: boolean;
}

/**
 * 档号展示组件：等宽字体 + 可选复制 + 作废样式。
 * 档号是档案的唯一业务标识，视觉上必须稳定可核对。
 */
export function ArchiveNo(props: ArchiveNoProps): ReactElement {
  const { value, mono = true, copyable = false, voided = false } = props;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 忽略：浏览器拒绝剪贴板权限
    }
  };

  return (
    <Tooltip title={copyable ? '点击复制档号' : value}>
      <span
        onClick={copyable ? () => void copy() : undefined}
        style={{
          fontFamily: mono ? 'Consolas, "Courier New", monospace' : undefined,
          fontSize: '0.8125rem',
          color: voided ? '#c53030' : '#1a202c',
          textDecoration: voided ? 'line-through' : 'none',
          cursor: copyable ? 'pointer' : 'default',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </Tooltip>
  );
}

/** 密级标签 */
export function SecurityChip(props: { level: SecurityLevel }): ReactElement {
  const { level } = props;
  const color = level === 'SECRET' ? 'error' : level === 'INTERNAL' ? 'warning' : 'success';
  return (
    <Chip
      label={SECURITY_LEVEL_LABELS[level] ?? level}
      color={color}
      size="small"
      variant="outlined"
    />
  );
}
