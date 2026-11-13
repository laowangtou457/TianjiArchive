import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControl,
  FormControlLabel,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import {
  APPRAISAL_DECISION_LABELS,
  APPRAISAL_TASK_STATUS_LABELS,
  RETENTION_LABELS,
  RETENTION_VALUES,
  type AppraisalDecision,
  type AppraisalEntryDto,
  type AppraisalTaskDto,
  type Retention,
} from '@tianji/shared';
import { appraisalApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { ArchiveNo } from '../../components/ArchiveNo';
import { PermGate } from '../../components/PermGate';

/** 状态色 */
const STATUS_COLOR: Record<string, 'default' | 'info' | 'success' | 'warning'> = {
  DRAFT: 'default',
  IN_PROGRESS: 'info',
  FINISHED: 'success',
  CANCELLED: 'warning',
};

const DECISION_COLOR: Record<AppraisalDecision, 'default' | 'success' | 'info' | 'warning' | 'error'> = {
  PENDING: 'default',
  KEEP: 'success',
  EXTEND: 'info',
  TRANSFER: 'warning',
  DESTROY: 'error',
};

/** 处置动作 → 需要的附加输入（延期要新期限，销毁要理由） */
interface DecideDialogState {
  decision: Exclude<AppraisalDecision, 'PENDING'>;
  ids: string[];
}

/**
 * 档案鉴定页（F-19）。
 *
 * 交互模型（对齐泰坦「鉴定任务 → 任务处理 → 鉴定处置表」）：
 *   建任务（圈定范围，自动生成到期明细）→ 逐件/批量给结论 → 执行处置
 *   → 销毁结论额外走审批流（引擎页面「审批中心」可看到待办）。
 *
 * 关键提示：执行是**不可逆的业务动作**（改期限、入回收站），
 * 因此执行前强制二次确认，并展示将要发生的四类动作数量。
 */
export function AppraisalPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  const [active, setActive] = useState<AppraisalTaskDto | null>(null);
  const [entryPage, setEntryPage] = useState(0);
  const [decisionFilter, setDecisionFilter] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [decideDialog, setDecideDialog] = useState<DecideDialogState | null>(null);
  const [reasonInput, setReasonInput] = useState('');
  const [retentionInput, setRetentionInput] = useState<Retention>('PERM');

  const listQuery = useQuery({
    queryKey: ['appraisal-tasks', status, keyword, page, size],
    queryFn: () => appraisalApi.list({ status: status || undefined, keyword: keyword || undefined, page: page + 1, size }),
  });

  const entriesQuery = useQuery({
    queryKey: ['appraisal-entries', active?.id, decisionFilter, entryPage],
    queryFn: () =>
      appraisalApi.entries(active?.id as string, {
        decision: decisionFilter || undefined,
        page: entryPage + 1,
        size: 20,
      }),
    enabled: Boolean(active?.id),
  });

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['appraisal-tasks'] });
    void qc.invalidateQueries({ queryKey: ['appraisal-entries'] });
  };

  const createMutation = useMutation({
    mutationFn: appraisalApi.create,
    onSuccess: (task) => {
      enqueueSnackbar(`任务 ${task.taskNo} 已创建，生成明细 ${task.total} 件`, { variant: 'success' });
      setCreateOpen(false);
      refresh();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '创建失败', { variant: 'error' }),
  });

  const decideMutation = useMutation({
    mutationFn: (payload: {
      decision: Exclude<AppraisalDecision, 'PENDING'>;
      ids: string[];
      reason?: string;
      retentionAfter?: Retention;
    }) =>
      appraisalApi.decide(active?.id as string, {
        ids: payload.ids,
        decision: payload.decision,
        reason: payload.reason,
        retentionAfter: payload.retentionAfter,
      }),
    onSuccess: (res, payload) => {
      enqueueSnackbar(`${APPRAISAL_DECISION_LABELS[payload.decision]}：${res.updated} 件`, {
        variant: 'success',
      });
      setSelected([]);
      setDecideDialog(null);
      setReasonInput('');
      refresh();
      if (active) {
        void appraisalApi.detail(active.id).then(setActive);
      }
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '处置失败', { variant: 'error' }),
  });

  const executeMutation = useMutation({
    mutationFn: (id: string) => appraisalApi.execute(id),
    onSuccess: (res) => {
      enqueueSnackbar(
        `执行完成：保管 ${res.kept}／延期 ${res.extended}／移交 ${res.transferred}／销毁 ${res.destroyed}` +
          (res.pendingApproval ? `；${res.pendingApproval} 件销毁待审批` : ''),
        { variant: res.pendingApproval ? 'warning' : 'success' },
      );
      refresh();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '执行失败', { variant: 'error' }),
  });

  const submitDestroyMutation = useMutation({
    mutationFn: (id: string) => appraisalApi.submitDestroy(id),
    onSuccess: (task) => {
      enqueueSnackbar(`销毁审批已提交（实例 ${task.workflowInstanceId?.slice(0, 8)}…）`, {
        variant: 'success',
      });
      setActive(task);
      refresh();
    },
    onError: (err) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '提交审批失败', { variant: 'error' }),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => appraisalApi.cancel(id),
    onSuccess: () => {
      enqueueSnackbar('任务已作废', { variant: 'success' });
      refresh();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '作废失败', { variant: 'error' }),
  });

  const rows = listQuery.data?.items ?? [];
  const entryRows = useMemo(() => entriesQuery.data?.items ?? [], [entriesQuery.data]);

  const allChecked = useMemo(
    () => entryRows.length > 0 && entryRows.every((r) => selected.includes(r.id)),
    [entryRows, selected],
  );

  const toggleAll = (): void => {
    if (allChecked) setSelected((s) => s.filter((id) => !entryRows.some((r) => r.id === id)));
    else setSelected((s) => [...new Set([...s, ...entryRows.map((r) => r.id)])]);
  };

  const openDecide = (decision: Exclude<AppraisalDecision, 'PENDING'>, ids: string[]): void => {
    if (ids.length === 0) {
      enqueueSnackbar('请先勾选要处置的条目', { variant: 'warning' });
      return;
    }
    setReasonInput('');
    setRetentionInput('PERM');
    setDecideDialog({ decision, ids });
  };

  const confirmDecide = (): void => {
    if (!decideDialog) return;
    decideMutation.mutate({
      decision: decideDialog.decision,
      ids: decideDialog.ids,
      reason: reasonInput.trim() || undefined,
      retentionAfter: decideDialog.decision === 'EXTEND' ? retentionInput : undefined,
    });
  };

  return (
    <AppLayout title="档案鉴定">
      <Stack spacing={2}>
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField
              size="small"
              label="任务号 / 名称"
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                setPage(0);
              }}
              sx={{ width: 220 }}
            />
            <FormControl size="small" sx={{ width: 150 }}>
              <InputLabel>状态</InputLabel>
              <Select
                label="状态"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(0);
                }}
              >
                <MenuItem value="">全部</MenuItem>
                {Object.entries(APPRAISAL_TASK_STATUS_LABELS).map(([k, v]) => (
                  <MenuItem key={k} value={k}>
                    {v}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Box sx={{ flex: 1 }} />
            <PermGate domain="APPRAISAL" op="WRITE">
              <Button variant="contained" onClick={() => setCreateOpen(true)}>
                新建鉴定任务
              </Button>
            </PermGate>
          </Stack>
        </Card>

        <Card variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={130}>任务号</TableCell>
                <TableCell>任务名称</TableCell>
                <TableCell width={130}>年度区间</TableCell>
                <TableCell width={100}>状态</TableCell>
                <TableCell width={230}>鉴定进度</TableCell>
                <TableCell width={200}>待办操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((t) => {
                const decided = t.total - t.pending;
                const pct = t.total > 0 ? Math.round((decided / t.total) * 100) : 0;
                return (
                  <TableRow key={t.id} hover>
                    <TableCell>
                      <ArchiveNo value={t.taskNo} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{t.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {t.basis ?? '未填写期限依据'}
                        {t.fondsName ? `｜${t.fondsName}` : '｜全库范围'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {t.yearFrom}–{t.yearTo}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={APPRAISAL_TASK_STATUS_LABELS[t.status]}
                        color={STATUS_COLOR[t.status]}
                      />
                      {t.workflowStatus === 'RUNNING' && (
                        <Chip size="small" label="销毁审批中" color="warning" sx={{ ml: 0.5 }} />
                      )}
                      {t.workflowStatus === 'APPROVED' && (
                        <Chip size="small" label="销毁已批" color="error" sx={{ ml: 0.5 }} />
                      )}
                    </TableCell>
                    <TableCell>
                      <LinearProgress variant="determinate" value={pct} sx={{ height: 6, borderRadius: 3 }} />
                      <Typography variant="caption" color="text.secondary">
                        已鉴定 {decided}/{t.total}｜继续 {t.keep}｜延期 {t.extend}｜移交 {t.transfer}｜销毁 {t.destroy}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        <Button
                          size="small"
                          onClick={() => {
                            setActive(t);
                            setEntryPage(0);
                            setDecisionFilter('');
                            setSelected([]);
                          }}
                        >
                          明细
                        </Button>
                        <PermGate domain="APPRAISAL" op="WRITE">
                          <Tooltip title="把已表的处置结论落到档案表（销毁需先过审批）">
                            <span>
                              <Button
                                size="small"
                                disabled={decided === 0 || executeMutation.isPending}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `确认执行？将应用 ${decided} 件的处置结论（销毁件写入回收站，可还原）。`,
                                    )
                                  ) {
                                    executeMutation.mutate(t.id);
                                  }
                                }}
                              >
                                执行
                              </Button>
                            </span>
                          </Tooltip>
                        </PermGate>
                        {t.destroy > 0 && t.workflowStatus !== 'APPROVED' && (
                          <PermGate domain="APPRAISAL" op="WRITE">
                            <Button
                              size="small"
                              color="error"
                              disabled={submitDestroyMutation.isPending}
                              onClick={() => submitDestroyMutation.mutate(t.id)}
                            >
                              提交销毁审批
                            </Button>
                          </PermGate>
                        )}
                        <PermGate domain="APPRAISAL" op="WRITE">
                          <Button
                            size="small"
                            color="warning"
                            disabled={t.status === 'FINISHED' || t.status === 'CANCELLED'}
                            onClick={() => {
                              if (window.confirm('确认作废该鉴定任务？（明细保留，不执行任何处置）')) {
                                cancelMutation.mutate(t.id);
                              }
                            }}
                          >
                            作废
                          </Button>
                        </PermGate>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    {listQuery.isLoading ? '加载中…' : '暂无鉴定任务。点击右上「新建鉴定任务」按年度/期限圈定到期档案。'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={listQuery.data?.total ?? 0}
            page={page}
            onPageChange={(_, p) => setPage(p)}
            rowsPerPage={size}
            onRowsPerPageChange={(e) => {
              setSize(Number(e.target.value));
              setPage(0);
            }}
            rowsPerPageOptions={[10, 20, 50]}
            labelRowsPerPage="每页"
          />
        </Card>
      </Stack>

      {/* ---------------------------------------------------------- 明细抽屉 */}
      <Drawer
        anchor="right"
        open={Boolean(active)}
        onClose={() => setActive(null)}
        PaperProps={{ sx: { width: 'min(1080px, 96vw)' } }}
      >
        <Box sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="h6">{active?.name}</Typography>
            <Chip size="small" label={active ? APPRAISAL_TASK_STATUS_LABELS[active.status] : ''} />
            <Box sx={{ flex: 1 }} />
            <Button onClick={() => setActive(null)}>关闭</Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            任务号 {active?.taskNo}｜{active?.yearFrom}–{active?.yearTo}｜共 {active?.total} 件｜
            待鉴定 {active?.pending} 件
          </Typography>

          {active?.workflowStatus === 'RUNNING' && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              销毁审批流转中，请到「审批中心」处理；审批通过后销毁件会自动执行（无需再次点执行）。
            </Alert>
          )}

          <Divider sx={{ my: 2 }} />

          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ width: 150 }}>
              <InputLabel>处置结论</InputLabel>
              <Select
                label="处置结论"
                value={decisionFilter}
                onChange={(e) => {
                  setDecisionFilter(e.target.value);
                  setEntryPage(0);
                  setSelected([]);
                }}
              >
                <MenuItem value="">全部</MenuItem>
                {Object.entries(APPRAISAL_DECISION_LABELS).map(([k, v]) => (
                  <MenuItem key={k} value={k}>
                    {v}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="body2" color="text.secondary">
              已选 {selected.length} 件
            </Typography>
            <Box sx={{ flex: 1 }} />
            <PermGate domain="APPRAISAL" op="WRITE">
              <Stack direction="row" spacing={1}>
                <Button size="small" variant="outlined" onClick={() => openDecide('KEEP', selected)}>
                  继续保管
                </Button>
                <Button size="small" variant="outlined" color="info" onClick={() => openDecide('EXTEND', selected)}>
                  延期保管
                </Button>
                <Button size="small" variant="outlined" color="warning" onClick={() => openDecide('TRANSFER', selected)}>
                  移交
                </Button>
                <Button size="small" variant="outlined" color="error" onClick={() => openDecide('DESTROY', selected)}>
                  销毁
                </Button>
              </Stack>
            </PermGate>
          </Stack>

          <Table size="small" sx={{ mt: 1 }}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox size="small" checked={allChecked} onChange={toggleAll} />
                </TableCell>
                <TableCell width={200}>档号</TableCell>
                <TableCell>题名</TableCell>
                <TableCell width={70}>年度</TableCell>
                <TableCell width={110}>原期限</TableCell>
                <TableCell width={130}>结论</TableCell>
                <TableCell width={200}>意见</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entryRows.map((e: AppraisalEntryDto) => (
                <TableRow key={e.id} hover selected={selected.includes(e.id)}>
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={selected.includes(e.id)}
                      onChange={(ev) =>
                        setSelected((s) => (ev.target.checked ? [...s, e.id] : s.filter((x) => x !== e.id)))
                      }
                      disabled={e.executed}
                    />
                  </TableCell>
                  <TableCell>
                    <ArchiveNo value={e.danghao} />
                  </TableCell>
                  <TableCell sx={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.title}
                  </TableCell>
                  <TableCell>{e.year}</TableCell>
                  <TableCell>{RETENTION_LABELS[e.retentionBefore]}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={
                        e.decision === 'EXTEND' && e.retentionAfter
                          ? `延期→${RETENTION_LABELS[e.retentionAfter]}`
                          : APPRAISAL_DECISION_LABELS[e.decision]
                      }
                      color={DECISION_COLOR[e.decision]}
                    />
                    {e.executed && <Chip size="small" label="已执行" sx={{ ml: 0.5 }} />}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.reason ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
              {entryRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    {entriesQuery.isLoading ? '加载中…' : '该筛选条件下没有明细'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={entriesQuery.data?.total ?? 0}
            page={entryPage}
            onPageChange={(_, p) => setEntryPage(p)}
            rowsPerPage={20}
            rowsPerPageOptions={[20]}
            labelRowsPerPage="每页"
          />
        </Box>
      </Drawer>

      {/* ---------------------------------------------------------- 新建任务 */}
      <CreateTaskDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        submitting={createMutation.isPending}
        onSubmit={(body) => createMutation.mutate(body)}
      />

      {/* ---------------------------------------------------------- 处置确认 */}
      <Dialog open={Boolean(decideDialog)} onClose={() => setDecideDialog(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          处置确认：{decideDialog ? APPRAISAL_DECISION_LABELS[decideDialog.decision] : ''}（
          {decideDialog?.ids.length ?? 0} 件）
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {decideDialog?.decision === 'EXTEND' && (
              <FormControl fullWidth size="small">
                <InputLabel>新的保管期限</InputLabel>
                <Select
                  label="新的保管期限"
                  value={retentionInput}
                  onChange={(e) => setRetentionInput(e.target.value as Retention)}
                >
                  {RETENTION_VALUES.filter((r) => r !== 'Y10').map((r) => (
                    <MenuItem key={r} value={r}>
                      {RETENTION_LABELS[r]}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
            <TextField
              label={decideDialog?.decision === 'DESTROY' ? '鉴定意见（必填）' : '鉴定意见（选填）'}
              multiline
              minRows={3}
              value={reasonInput}
              onChange={(e) => setReasonInput(e.target.value)}
              helperText={
                decideDialog?.decision === 'DESTROY'
                  ? '销毁不可逆（进回收站可还原），必须写明理由；提交后还需走审批流'
                  : '建议写明依据（如“仍有查考价值”“已到保管期限且无继续保存必要”）'
              }
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDecideDialog(null)}>取消</Button>
          <Button
            variant="contained"
            color={decideDialog?.decision === 'DESTROY' ? 'error' : 'primary'}
            disabled={
              decideMutation.isPending ||
              (decideDialog?.decision === 'DESTROY' && reasonInput.trim().length === 0)
            }
            onClick={confirmDecide}
          >
            确认
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}

/** 新建任务弹窗：只暴露业务上说得清的筛选项 */
function CreateTaskDialog(props: {
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (body: {
    name: string;
    yearFrom: number;
    yearTo: number;
    retentions: Retention[];
    dueOnly: boolean;
    basis?: string;
    remark?: string;
  }) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [yearFrom, setYearFrom] = useState(new Date().getFullYear() - 30);
  const [yearTo, setYearTo] = useState(new Date().getFullYear());
  const [retentions, setRetentions] = useState<Retention[]>(['Y10', 'Y30']);
  const [dueOnly, setDueOnly] = useState(true);
  const [basis, setBasis] = useState('DA/T 22-2015 文书档案保管期限表');
  const [remark, setRemark] = useState('');

  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>新建鉴定任务</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="任务名称"
            size="small"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：2026 年度到期档案鉴定"
            required
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label="起始年度"
              type="number"
              size="small"
              value={yearFrom}
              onChange={(e) => setYearFrom(Number(e.target.value))}
            />
            <TextField
              label="结束年度"
              type="number"
              size="small"
              value={yearTo}
              onChange={(e) => setYearTo(Number(e.target.value))}
            />
          </Stack>
          <FormControl size="small">
            <InputLabel>纳入的保管期限</InputLabel>
            <Select
              multiple
              label="纳入的保管期限"
              value={retentions}
              onChange={(e) => setRetentions(e.target.value as Retention[])}
              renderValue={(v) => (v as Retention[]).map((r) => RETENTION_LABELS[r]).join('、')}
            >
              {RETENTION_VALUES.map((r) => (
                <MenuItem key={r} value={r}>
                  {RETENTION_LABELS[r]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControlLabel
            control={<Switch checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} />}
            label="仅鉴定已到期的档案（永久不参评；10 年满 10 年、30 年满 30 年）"
          />
          <TextField
            label="期限依据"
            size="small"
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
          />
          <TextField
            label="备注"
            size="small"
            multiline
            minRows={2}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
          />
          <Alert severity="info">
            提示：任务只为「已归档」的件生成明细；生成后可在明细里逐件或批量给结论，
            结论可反复修改，点「执行」才真正改库。
          </Alert>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>取消</Button>
        <Button
          variant="contained"
          disabled={props.submitting || name.trim().length === 0}
          onClick={() =>
            props.onSubmit({
              name: name.trim(),
              yearFrom,
              yearTo,
              retentions,
              dueOnly,
              basis: basis.trim() || undefined,
              remark: remark.trim() || undefined,
            })
          }
        >
          创建并生成明细
        </Button>
      </DialogActions>
    </Dialog>
  );
}
