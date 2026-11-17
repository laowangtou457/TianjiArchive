import { type ReactElement } from 'react';
import { Box, Chip, Paper, Typography } from '@mui/material';
import {
  ROLE_LABELS,
  type RoleCode,
  type WorkflowDefDto,
  type WorkflowNodeDto,
} from '@tianji/shared';

const ROLE_COLOR: Record<string, 'default' | 'primary' | 'secondary' | 'warning' | 'success'> = {
  R0: 'warning',
  R1: 'primary',
  R2: 'secondary',
  R3: 'success',
  R4: 'warning',
  '*': 'default',
};

function connector(label?: string): ReactElement {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 0.25 }}>
      <Box sx={{ width: 2, height: 18, bgcolor: '#94a3b8' }} />
      {label && (
        <Typography variant="caption" sx={{ color: '#64748b', my: -0.25 }}>
          {label}
        </Typography>
      )}
      <Box
        sx={{
          width: 0,
          height: 0,
          borderLeft: '6px solid transparent',
          borderRight: '6px solid transparent',
          borderTop: '8px solid #94a3b8',
        }}
      />
    </Box>
  );
}

function NodeCard(props: { node: WorkflowNodeDto; index: number; total: number }): ReactElement {
  const { node, index, total } = props;
  const isLast = index === total - 1;
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        width: 'min(680px, 100%)',
        mx: 'auto',
        bgcolor: isLast ? '#f0f7ff' : '#fff',
        borderColor: isLast ? '#7ba7d7' : '#e2e8f0',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Box
          sx={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            bgcolor: isLast ? '#7ba7d7' : '#4f6bed',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {node.seq}
        </Box>
        <Typography sx={{ fontWeight: 600 }}>{node.name}</Typography>
        <Chip
          size="small"
          color={ROLE_COLOR[node.roleCode] ?? 'default'}
          variant="filled"
          label={`审批角色：${node.roleCode === '*' ? '不限角色' : `${node.roleCode} ${ROLE_LABELS[node.roleCode as RoleCode] ?? ''}`}`}
        />
        <Box sx={{ flex: 1 }} />
        {isLast && node.onApprove && (
          <Chip size="small" color="success" variant="outlined" label={`通过后执行：${node.onApprove}`} />
        )}
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, mt: 0.75, flexWrap: 'wrap' }}>
        <Typography variant="caption" color="text.secondary">
          权限域：{node.permDomain || '（无，仅按角色收件）'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          允许驳回：{node.allowReject === false ? '否' : '是'}
        </Typography>
        {node.timeoutHours ? (
          <Typography variant="caption" color="text.secondary">
            超时提醒：{node.timeoutHours} 小时
          </Typography>
        ) : null}
        <Typography variant="caption" color="text.secondary">
          同角色多人时按「岗位待办池」先到先办
        </Typography>
      </Box>
    </Paper>
  );
}

/**
 * 审批流程图（纵向）：发起 → 逐环节卡片（标注审批角色/权限域/回调）→ 结束。
 * 纯 CSS 绘制，无第三方图形库依赖；卡片随容器自适应。
 */
export function WorkflowGraph(props: { def: WorkflowDefDto }): ReactElement {
  const { def } = props;
  const nodes = [...def.nodes].sort((a, b) => a.seq - b.seq);
  return (
    <Box sx={{ py: 2 }}>
      {/* 发起 */}
      <Box
        sx={{
          width: 140,
          mx: 'auto',
          textAlign: 'center',
          py: 0.75,
          px: 2,
          borderRadius: 999,
          bgcolor: '#eef2ff',
          border: '1px solid #c3cdf7',
          fontWeight: 600,
          color: '#1f359b',
        }}
      >
        发起申请
      </Box>
      <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: '#64748b', mt: 0.5 }}>
        {def.code} · v{def.version} · {def.enabled ? '启用中' : '已停用'}
      </Typography>
      {connector()}

      {nodes.map((n, i) => (
        <Box key={n.id ?? n.seq}>
          <NodeCard node={n} index={i} total={nodes.length} />
          {i < nodes.length - 1 && connector('通过')}
        </Box>
      ))}

      {connector('末环节通过后执行业务回调')}

      {/* 结束 */}
      <Box
        sx={{
          width: 140,
          mx: 'auto',
          textAlign: 'center',
          py: 0.75,
          px: 2,
          borderRadius: 999,
          bgcolor: '#f0fdf4',
          border: '1px solid #86c79a',
          fontWeight: 600,
          color: '#15803d',
        }}
      >
        审批完成
      </Box>

      {nodes.some((n) => n.allowReject !== false) && (
        <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: '#b45309', mt: 1.5 }}>
          ※ 任一环节「驳回」→ 流程立即终止（REJECTED），发起人需修改后重新提交；驳回须填写意见
        </Typography>
      )}
    </Box>
  );
}
