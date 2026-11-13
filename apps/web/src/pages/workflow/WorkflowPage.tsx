import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Step,
  StepContent,
  StepLabel,
  Stepper,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import {
  ROLE_LABELS,
  WORKFLOW_BIZ_TYPE_LABELS,
  WORKFLOW_INSTANCE_STATUS_LABELS,
  type RoleCode,
  type WorkflowDefDto,
  type WorkflowInstanceDto,
  type WorkflowNodeDto,
} from '@tianji/shared';
import { workflowApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

const STATUS_COLOR: Record<string, 'default' | 'warning' | 'success' | 'error'> = {
  RUNNING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'default',
};

/**
 * 审批中心（F-07）。
 *
 * 三个页签对应三类使用者：
 *   我的待办 —— 审批人：按角色自动收件（岗位待办池，先到先办）；
 *   审批实例 —— 发起人/管理者：看全流程流转与时间线；
 *   流程配置 —— 系统管理员：定义环节、角色、回调（改流程不影响在途实例）。
 */
export function WorkflowPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [tab, setTab] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [actTarget, setActTarget] = useState<{ id: string; action: 'APPROVE' | 'REJECT' } | null>(null);
  const [opinion, setOpinion] = useState('');

  const tasksQuery = useQuery({ queryKey: ['workflow-my-tasks'], queryFn: workflowApi.myTasks });
  const instancesQuery = useQuery({
    queryKey: ['workflow-instances'],
    queryFn: () => workflowApi.instances({ page: 1, size: 50 }),
  });
  const defsQuery = useQuery({ queryKey: ['workflow-defs'], queryFn: workflowApi.defs });
  const detailQuery = useQuery({
    queryKey: ['workflow-detail', detailId],
    queryFn: () => workflowApi.detail(detailId as string),
    enabled: Boolean(detailId),
  });

  const actMutation = useMutation({
    mutationFn: (p: { id: string; action: 'APPROVE' | 'REJECT'; opinion: string }) =>
      workflowApi.act(p.id, p.action, p.opinion),
    onSuccess: (inst) => {
      enqueueSnackbar(`审批已${inst.status === 'APPROVED' ? '通过' : inst.status === 'REJECTED' ? '驳回' : '推进'}`, {
        variant: 'success',
      });
      setActTarget(null);
      setOpinion('');
      void qc.invalidateQueries({ queryKey: ['workflow-my-tasks'] });
      void qc.invalidateQueries({ queryKey: ['workflow-instances'] });
      void qc.invalidateQueries({ queryKey: ['workflow-detail'] });
      void qc.invalidateQueries({ queryKey: ['open-batches'] });
      void qc.invalidateQueries({ queryKey: ['appraisal-tasks'] });
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '处理失败', { variant: 'error' }),
  });

  const tasks = tasksQuery.data ?? [];
  const instances = instancesQuery.data?.items ?? [];

  return (
    <AppLayout title="审批中心">
      <Stack spacing={2}>
        <Alert severity="info">
          审批按「岗位待办」流转：同一角色的待办由该角色任一用户处理（先办先得），
          结论写入时间线且不可修改。驳回必须填写意见。
        </Alert>

        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label={`我的待办${tasks.length ? `（${tasks.length}）` : ''}`} />
          <Tab label="审批实例" />
          <Tab label="流程配置" />
        </Tabs>

        {tab === 0 && (
          <Card variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width={140}>业务类型</TableCell>
                  <TableCell>审批标题</TableCell>
                  <TableCell width={160}>当前环节</TableCell>
                  <TableCell width={120}>到达时间</TableCell>
                  <TableCell width={220}>操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {tasks.map((t) => (
                  <TableRow key={t.id} hover>
                    <TableCell>
                      <Chip size="small" label={WORKFLOW_BIZ_TYPE_LABELS[t.bizType as never] ?? t.bizType} />
                    </TableCell>
                    <TableCell>{t.title}</TableCell>
                    <TableCell>
                      {t.nodeName}
                      <Typography variant="caption" color="text.secondary" display="block">
                        第 {t.seq} 环节｜{t.roleCode === '*' ? '不限角色' : t.roleCode}
                      </Typography>
                    </TableCell>
                    <TableCell>{new Date(t.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1}>
                        <Button size="small" onClick={() => setDetailId(t.instanceId)}>
                          查看
                        </Button>
                        <Button
                          size="small"
                          color="success"
                          variant="outlined"
                          onClick={() => {
                            setOpinion('');
                            setActTarget({ id: t.instanceId, action: 'APPROVE' });
                          }}
                        >
                          同意
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          variant="outlined"
                          onClick={() => {
                            setOpinion('');
                            setActTarget({ id: t.instanceId, action: 'REJECT' });
                          }}
                        >
                          驳回
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
                {tasks.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                      {tasksQuery.isLoading ? '加载中…' : '暂无待办（您的角色当前没有待审批事项）'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        )}

        {tab === 1 && (
          <Card variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width={140}>业务类型</TableCell>
                  <TableCell>标题</TableCell>
                  <TableCell width={110}>状态</TableCell>
                  <TableCell width={110}>当前环节</TableCell>
                  <TableCell width={150}>发起人</TableCell>
                  <TableCell width={170}>发起时间</TableCell>
                  <TableCell width={90}>操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {instances.map((i: WorkflowInstanceDto) => (
                  <TableRow key={i.id} hover>
                    <TableCell>
                      <Chip size="small" label={WORKFLOW_BIZ_TYPE_LABELS[i.bizType]} />
                    </TableCell>
                    <TableCell>
                      {i.title}
                      {i.summary && (
                        <Typography variant="caption" color="text.secondary" display="block">
                          {i.summary}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={WORKFLOW_INSTANCE_STATUS_LABELS[i.status]}
                        color={STATUS_COLOR[i.status]}
                      />
                    </TableCell>
                    <TableCell>{i.currentNodeName ?? `第 ${i.currentSeq} 环节`}</TableCell>
                    <TableCell>{i.initiatorName ?? '—'}</TableCell>
                    <TableCell>{new Date(i.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Button size="small" onClick={() => setDetailId(i.id)}>
                        时间线
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {instances.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                      {instancesQuery.isLoading ? '加载中…' : '暂无审批实例'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        )}

        {tab === 2 && <DefsPanel defs={defsQuery.data ?? []} loading={defsQuery.isLoading} />}
      </Stack>

      {/* ---------------------------------------------------------- 时间线抽屉 */}
      <Drawer
        anchor="right"
        open={Boolean(detailId)}
        onClose={() => setDetailId(null)}
        PaperProps={{ sx: { width: 'min(720px, 96vw)' } }}
      >
        <Box sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="h6">审批时间线</Typography>
            <Box sx={{ flex: 1 }} />
            <Button onClick={() => setDetailId(null)}>关闭</Button>
          </Stack>
          {detailQuery.data && (
            <>
              <Typography variant="body2" sx={{ mt: 1 }}>
                {detailQuery.data.title}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {WORKFLOW_BIZ_TYPE_LABELS[detailQuery.data.bizType]}｜流程{' '}
                {detailQuery.data.defName}｜发起人 {detailQuery.data.initiatorName ?? '—'}
              </Typography>
              <Divider sx={{ my: 2 }} />
              <Stepper orientation="vertical" activeStep={detailQuery.data.tasks.length}>
                {detailQuery.data.tasks.map((t) => (
                  <Step key={t.id} completed={t.status !== 'PENDING'}>
                    <StepLabel
                      error={t.status === 'REJECTED'}
                      optional={
                        <Typography variant="caption" color="text.secondary">
                          {t.roleCode === '*' ? '不限角色' : t.roleCode}｜{t.status}
                        </Typography>
                      }
                    >
                      第 {t.seq} 环节：{t.nodeName}
                    </StepLabel>
                    <StepContent>
                      <Typography variant="body2">
                        {t.status === 'PENDING'
                          ? '待处理'
                          : `${t.actedByName ?? '—'} 于 ${t.actedAt ? new Date(t.actedAt).toLocaleString() : '—'}`}
                      </Typography>
                      {t.opinion && (
                        <Typography variant="body2" color="text.secondary">
                          意见：{t.opinion}
                        </Typography>
                      )}
                    </StepContent>
                  </Step>
                ))}
              </Stepper>
              {detailQuery.data.canAct && (
                <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                  <Button
                    variant="contained"
                    color="success"
                    onClick={() => {
                      setOpinion('');
                      setActTarget({ id: detailQuery.data!.id, action: 'APPROVE' });
                    }}
                  >
                    同意
                  </Button>
                  <Button
                    variant="outlined"
                    color="error"
                    onClick={() => {
                      setOpinion('');
                      setActTarget({ id: detailQuery.data!.id, action: 'REJECT' });
                    }}
                  >
                    驳回
                  </Button>
                </Stack>
              )}
            </>
          )}
          {detailQuery.isLoading && <Typography sx={{ mt: 2 }}>加载中…</Typography>}
        </Box>
      </Drawer>

      {/* ---------------------------------------------------------- 审批意见 */}
      <Dialog open={Boolean(actTarget)} onClose={() => setActTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{actTarget?.action === 'APPROVE' ? '审批同意' : '审批驳回'}</DialogTitle>
        <DialogContent>
          <TextField
            sx={{ mt: 1 }}
            fullWidth
            multiline
            minRows={3}
            label={actTarget?.action === 'REJECT' ? '驳回意见（必填）' : '审批意见'}
            value={opinion}
            onChange={(e) => setOpinion(e.target.value)}
            helperText={
              actTarget?.action === 'REJECT'
                ? '驳回后流程终止，发起人需修改单据并重新提交'
                : '意见会写入审批时间线，供后续追溯'
            }
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setActTarget(null)}>取消</Button>
          <Button
            variant="contained"
            color={actTarget?.action === 'REJECT' ? 'error' : 'primary'}
            disabled={
              actMutation.isPending ||
              (actTarget?.action === 'REJECT' && opinion.trim().length === 0)
            }
            onClick={() => {
              if (!actTarget) return;
              actMutation.mutate({ id: actTarget.id, action: actTarget.action, opinion: opinion.trim() });
            }}
          >
            确认
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}

/** 流程配置面板：查看/编辑环节（角色与回调是审批正确性的关键，做成一目了然的行内编辑） */
function DefsPanel(props: { defs: WorkflowDefDto[]; loading: boolean }): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [editing, setEditing] = useState<WorkflowDefDto | null>(null);
  const [nodes, setNodes] = useState<WorkflowNodeDto[]>([]);

  const saveMutation = useMutation({
    mutationFn: (p: { id: string; nodes: WorkflowNodeDto[] }) =>
      workflowApi.updateDef(p.id, { nodes: p.nodes }),
    onSuccess: () => {
      enqueueSnackbar('流程环节已保存（新版本生效，在途实例按原流程继续）', { variant: 'success' });
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['workflow-defs'] });
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '保存失败', { variant: 'error' }),
  });

  const toggleMutation = useMutation({
    mutationFn: (p: { id: string; enabled: boolean }) =>
      workflowApi.updateDef(p.id, { enabled: p.enabled }),
    onSuccess: () => {
      enqueueSnackbar('已更新启用状态', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['workflow-defs'] });
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  return (
    <>
      <Card variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell width={180}>流程编码</TableCell>
              <TableCell>名称</TableCell>
              <TableCell width={150}>业务类型</TableCell>
              <TableCell width={80}>版本</TableCell>
              <TableCell width={90}>状态</TableCell>
              <TableCell>环节流向</TableCell>
              <TableCell width={170}>操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {props.defs.map((d) => (
              <TableRow key={d.id} hover>
                <TableCell>{d.code}</TableCell>
                <TableCell>{d.name}</TableCell>
                <TableCell>{WORKFLOW_BIZ_TYPE_LABELS[d.bizType]}</TableCell>
                <TableCell>v{d.version}</TableCell>
                <TableCell>
                  <Chip size="small" label={d.enabled ? '启用' : '停用'} color={d.enabled ? 'success' : 'default'} />
                </TableCell>
                <TableCell>
                  {d.nodes
                    .map(
                      (n) =>
                        `${n.seq}. ${n.name}(${n.roleCode === '*' ? '不限' : n.roleCode}${
                          n.onApprove ? ' → 回调' : ''
                        })`,
                    )
                    .join('  ›  ')}
                </TableCell>
                <TableCell>
                  <PermGate domain="PARAM" op="WRITE">
                    <Stack direction="row" spacing={1}>
                      <Button
                        size="small"
                        onClick={() => {
                          setEditing(d);
                          setNodes(d.nodes.map((n) => ({ ...n })));
                        }}
                      >
                        编辑环节
                      </Button>
                      <Button
                        size="small"
                        color={d.enabled ? 'warning' : 'success'}
                        onClick={() => toggleMutation.mutate({ id: d.id, enabled: !d.enabled })}
                      >
                        {d.enabled ? '停用' : '启用'}
                      </Button>
                    </Stack>
                  </PermGate>
                </TableCell>
              </TableRow>
            ))}
            {props.defs.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                  {props.loading ? '加载中…' : '暂无流程定义'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)} maxWidth="md" fullWidth>
        <DialogTitle>编辑环节：{editing?.name}</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            环节按顺序执行；最后一个环节的「回调」决定审批通过后执行什么业务动作。
            改流程会生成新版本，**在途实例仍按原环节继续**。
          </Alert>
          <Stack spacing={1.5}>
            {nodes.map((n, idx) => (
              <Stack key={idx} direction="row" spacing={1} alignItems="center">
                <Typography sx={{ width: 24 }}>{idx + 1}</Typography>
                <TextField
                  size="small"
                  label="环节名称"
                  value={n.name}
                  onChange={(e) =>
                    setNodes((arr) => arr.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))
                  }
                  sx={{ width: 200 }}
                />
                <FormControl size="small" sx={{ width: 130 }}>
                  <InputLabel>处理角色</InputLabel>
                  <Select
                    label="处理角色"
                    value={n.roleCode}
                    onChange={(e) =>
                      setNodes((arr) =>
                        arr.map((x, i) => (i === idx ? { ...x, roleCode: e.target.value as RoleCode | '*' } : x)),
                      )
                    }
                  >
                    <MenuItem value="*">不限角色</MenuItem>
                    {(Object.keys(ROLE_LABELS) as RoleCode[]).map((r) => (
                      <MenuItem key={r} value={r}>
                        {r} {ROLE_LABELS[r]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <TextField
                  size="small"
                  label="权限域"
                  value={n.permDomain ?? ''}
                  onChange={(e) =>
                    setNodes((arr) => arr.map((x, i) => (i === idx ? { ...x, permDomain: e.target.value } : x)))
                  }
                  sx={{ width: 150 }}
                />
                <TextField
                  size="small"
                  label="通过回调"
                  value={n.onApprove ?? ''}
                  onChange={(e) =>
                    setNodes((arr) => arr.map((x, i) => (i === idx ? { ...x, onApprove: e.target.value } : x)))
                  }
                  sx={{ flex: 1 }}
                  helperText={idx === nodes.length - 1 ? '仅末环节生效，如 OPEN_BATCH_APPLY' : undefined}
                />
                <Tooltip title="删除该环节">
                  <span>
                    <IconButton
                      size="small"
                      disabled={nodes.length <= 1}
                      onClick={() => setNodes((arr) => arr.filter((_, i) => i !== idx))}
                    >
                      ✕
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
            ))}
            <Box>
              <Button
                size="small"
                onClick={() =>
                  setNodes((arr) => [
                    ...arr,
                    { seq: arr.length + 1, name: `环节 ${arr.length + 1}`, roleCode: 'R1', allowReject: true },
                  ])
                }
              >
                + 添加环节
              </Button>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={saveMutation.isPending}
            onClick={() => {
              if (!editing) return;
              saveMutation.mutate({
                id: editing.id,
                nodes: nodes.map((n, i) => ({ ...n, seq: i + 1 })),
              });
            }}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
