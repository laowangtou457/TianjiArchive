import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControlLabel,
  MenuItem,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TablePagination,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import {
  BORROW_MODE_LABELS,
  BORROW_STATUS_LABELS,
  BORROW_STATUS_VALUES,
  type ApprovalAction,
  type BorrowMode,
  type BorrowOrderDto,
  type BorrowStatus,
} from '@tianji/shared';
import { borrowApi, archiveApi, type BorrowRulesDto } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { ArchiveNo, SecurityChip } from '../../components/ArchiveNo';
import { PermGate } from '../../components/PermGate';
import { useAuthStore } from '../../stores/authStore';
import { printBorrowSlip } from '../../utils/print';

/** 状态对应的 MUI 颜色 */
const STATUS_COLOR: Record<BorrowStatus, 'default' | 'warning' | 'info' | 'success' | 'error'> = {
  PENDING: 'warning',
  APPROVED: 'info',
  REJECTED: 'error',
  LENT: 'info',
  RETURNED: 'success',
  OVERDUE: 'error',
  CANCELLED: 'default',
};

/**
 * 默认归还日期（按后端下发的默认借期推算）。
 *
 * 参数来自 `GET /borrow/config`（sys_param），不在前端硬编码，
 * 否则管理员改了 `borrow.default_days` 前端仍预填旧值，用户提交即被后端拒绝。
 */
function defaultDueDate(defaultDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + defaultDays);
  return d.toISOString().slice(0, 10);
}

/**
 * 借阅管理页（F-06）。
 *
 * 覆盖全流程：申请 → 审批（按密级路由 1/2 级）→ 借出 → 归还 / 续借 / 逾期催还。
 * 权限口径（与后端一致）：
 *   - 申请：BORROW_APPLY / WRITE
 *   - 审批：BORROW_APPROVE / APPROVE
 *   - 借出与归还登记：BORROW_RETURN / WRITE
 */
export function BorrowPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const profile = useAuthStore((s) => s.profile);

  const [tab, setTab] = useState<number>(0);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [size, setSize] = useState<number>(20);
  const [keyword, setKeyword] = useState<string>('');
  const [mineOnly, setMineOnly] = useState<boolean>(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [approveTarget, setApproveTarget] = useState<BorrowOrderDto | null>(null);
  const [approveOpinion, setApproveOpinion] = useState<string>('');
  const [returnTarget, setReturnTarget] = useState<BorrowOrderDto | null>(null);
  const [returnRemark, setReturnRemark] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  /** 申请表单 */
  const [formItemId, setFormItemId] = useState<string>('');
  const [formPurpose, setFormPurpose] = useState<string>('');
  const [formMode, setFormMode] = useState<BorrowMode>('ONLINE');
  const [formDue, setFormDue] = useState<string>('');
  const [itemSearch, setItemSearch] = useState<string>('');

  /**
   * 借阅规则：来自后端 sys_param（公开接口）。
   *
   * 前端**不再硬编码** 90/1/30 —— 管理员改参数后，这里的预填值、
   * 续借按钮可用性、提示文案会同步变化，与后端校验永远同源。
   * 加载中先用保守兜底（按钮不置灰、日期留空），拿到后立即校正。
   */
  const rulesQuery = useQuery({
    queryKey: ['borrow-config'],
    queryFn: () => borrowApi.config(),
    staleTime: 60_000,
  });
  const rules: BorrowRulesDto = rulesQuery.data ?? {
    maxTotalDays: 90,
    minDays: 1,
    maxRenewalCount: 1,
    maxRenewalDays: 30,
    defaultDays: 30,
    hint: '',
  };

  // 规则到达后回填默认应还日（只回填一次，用户改动后不覆盖）
  const [dueTouched, setDueTouched] = useState<boolean>(false);
  const effectiveDue = formDue || (dueTouched ? '' : defaultDueDate(rules.defaultDays));

  const listQuery = useQuery({
    queryKey: ['borrow-orders', statusFilter, mineOnly, page, size, keyword, tab],
    queryFn: () =>
      borrowApi.list({
        page,
        size,
        status: statusFilter || undefined,
        mine: tab === 1 ? true : mineOnly || undefined,
        keyword: keyword || undefined,
      }),
  });

  const statsQuery = useQuery({
    queryKey: ['borrow-stats'],
    queryFn: () => borrowApi.stats(),
  });

  const detailQuery = useQuery({
    queryKey: ['borrow-detail', detailId],
    queryFn: () => borrowApi.detail(detailId as string),
    enabled: detailId !== null,
  });

  /** 可选档案（检索题名） */
  const itemOptionsQuery = useQuery({
    queryKey: ['borrow-item-options', itemSearch],
    queryFn: () => archiveApi.listItems({ page: 1, size: 20, keyword: itemSearch || undefined }),
    enabled: createOpen,
  });

  /** 通用刷新 */
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['borrow-orders'] });
    void qc.invalidateQueries({ queryKey: ['borrow-stats'] });
    void qc.invalidateQueries({ queryKey: ['borrow-detail'] });
  };

  /** 创建申请 */
  const createMutation = useMutation({
    mutationFn: async () => {
      if (!formItemId) throw new Error('请选择要借阅的档案');
      if (formPurpose.trim().length < 5) throw new Error('借阅目的至少 5 个字');
      if (!effectiveDue) throw new Error('请选择预计归还日期');
      return borrowApi.create({
        itemId: formItemId,
        purpose: formPurpose.trim(),
        mode: formMode,
        expectReturn: effectiveDue,
      });
    },
    onSuccess: (r) => {
      enqueueSnackbar(`借阅申请已提交：${r.orderNo}`, { variant: 'success' });
      setCreateOpen(false);
      setFormItemId('');
      setFormPurpose('');
      setFormMode('ONLINE');
      setFormDue('');
      setDueTouched(false);
      setError(null);
      invalidate();
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  /** 审批 */
  const approveMutation = useMutation({
    mutationFn: async (action: ApprovalAction) => {
      if (!approveTarget) throw new Error('未选择借阅单');
      if (approveOpinion.trim().length < 2) throw new Error('审批意见至少 2 个字');
      return borrowApi.approve(approveTarget.id, action, approveOpinion.trim());
    },
    onSuccess: (r) => {
      enqueueSnackbar(
        r.status === 'APPROVED'
          ? '审批通过，已完成全部审核'
          : r.status === 'PENDING'
            ? '一级审批通过，流转至二级审批'
            : '已驳回',
        { variant: r.status === 'REJECTED' ? 'warning' : 'success' },
      );
      setApproveTarget(null);
      setApproveOpinion('');
      setError(null);
      invalidate();
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  /** 借出 */
  const lendMutation = useMutation({
    mutationFn: (id: string) => borrowApi.lend(id),
    onSuccess: () => {
      enqueueSnackbar('已登记借出', { variant: 'success' });
      invalidate();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : '借出登记失败'),
  });

  /** 归还 */
  const returnMutation = useMutation({
    mutationFn: async () => {
      if (!returnTarget) throw new Error('未选择借阅单');
      return borrowApi.giveBack(returnTarget.id, returnRemark.trim() || undefined);
    },
    onSuccess: () => {
      enqueueSnackbar('归还登记完成', { variant: 'success' });
      setReturnTarget(null);
      setReturnRemark('');
      invalidate();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : '归还登记失败'),
  });

  /** 撤销 */
  const cancelMutation = useMutation({
    mutationFn: (id: string) => borrowApi.cancel(id),
    onSuccess: () => {
      enqueueSnackbar('申请已撤销', { variant: 'info' });
      invalidate();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : '撤销失败'),
  });

  /** 续借 */
  const renewMutation = useMutation({
    mutationFn: (id: string) => borrowApi.renew(id),
    onSuccess: () => {
      enqueueSnackbar(`续借成功（本单已续借 ${rules.maxRenewalCount > 0 ? '1' : '0'} 次，上限 ${rules.maxRenewalCount} 次）`, {
        variant: 'success',
      });
      invalidate();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : '续借失败'),
  });

  const rows: BorrowOrderDto[] = listQuery.data?.items ?? [];
  const total: number = listQuery.data?.total ?? 0;

  const stats = statsQuery.data;
  const statCards = useMemo(
    () => [
      { label: '借阅单总数', value: stats?.totalOrders ?? 0, color: '#1a2b7a' },
      { label: '已归还', value: stats?.totalReturned ?? 0, color: '#2f855a' },
      { label: '逾期未还', value: stats?.totalOverdue ?? 0, color: '#c53030' },
    ],
    [stats],
  );

  /** 是否为当前用户可审批的单据（申请人不能自审） */
  const canApproveOrder = (o: BorrowOrderDto): boolean => {
    if (o.status !== 'PENDING') return false;
    if (o.applicantId === profile?.userId) return false;
    return true;
  };

  return (
    <AppLayout
      title="借阅管理"
      subtitle="申请 → 审批（秘密级两级）→ 借出 → 归还 / 续借 / 逾期催还"
      actions={
        <PermGate domain="BORROW_APPLY" op="WRITE">
          <Button size="small" variant="contained" onClick={() => setCreateOpen(true)}>
            新建借阅申请
          </Button>
        </PermGate>
      }
    >
      {/* 统计卡片 */}
      <Stack direction="row" spacing={1.5} sx={{ mb: 1.5 }}>
        {statCards.map((c) => (
          <Card key={c.label} sx={{ flex: 1 }}>
            <CardContent sx={{ py: 1.25 }}>
              <Typography variant="caption" color="text.secondary">
                {c.label}
              </Typography>
              <Typography sx={{ fontSize: 24, fontWeight: 700, color: c.color, lineHeight: 1.2 }}>
                {c.value}
              </Typography>
            </CardContent>
          </Card>
        ))}
        <Card sx={{ flex: 2 }}>
          <CardContent sx={{ py: 1.25 }}>
            <Typography variant="caption" color="text.secondary">
              借阅热度 Top
            </Typography>
            {(stats?.topItems ?? []).slice(0, 3).map((t, i) => (
              <Stack key={t.itemId} direction="row" spacing={1} alignItems="center">
                <Typography variant="caption" sx={{ width: 14, color: 'text.disabled' }}>
                  {i + 1}
                </Typography>
                <ArchiveNo value={t.danghao} />
                <Typography variant="caption" noWrap sx={{ flex: 1 }}>
                  {t.title}
                </Typography>
                <Chip label={`${t.count} 次`} size="small" variant="outlined" sx={{ height: 18 }} />
              </Stack>
            ))}
            {(stats?.topItems ?? []).length === 0 && (
              <Typography variant="caption" color="text.disabled">
                暂无借阅记录
              </Typography>
            )}
          </CardContent>
        </Card>
      </Stack>

      <Card>
        <CardContent sx={{ p: 1.5 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Tabs
              value={tab}
              onChange={(_e, v: number) => {
                setTab(v);
                setPage(1);
              }}
              sx={{ minHeight: 34 }}
            >
              <Tab label="全部借阅单" sx={{ minHeight: 34, py: 0.5 }} />
              <Tab label="我的申请" sx={{ minHeight: 34, py: 0.5 }} />
              <Tab label="待我审批" sx={{ minHeight: 34, py: 0.5 }} />
            </Tabs>
            <Box sx={{ flex: 1 }} />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={mineOnly}
                  onChange={(e) => {
                    setMineOnly(e.target.checked);
                    setPage(1);
                  }}
                />
              }
              label={<Typography variant="caption">只看我的</Typography>}
            />
            <TextField
              select
              size="small"
              label="状态"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              sx={{ width: 140 }}
            >
              <MenuItem value="">全部</MenuItem>
              {BORROW_STATUS_VALUES.map((s) => (
                <MenuItem key={s} value={s}>
                  {BORROW_STATUS_LABELS[s]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              label="单号/档号/题名"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              sx={{ width: 200 }}
            />
          </Stack>

          {error && (
            <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Table size="small" className="dense-table">
            <TableHead>
              <TableRow>
                <TableCell width={140}>单号</TableCell>
                <TableCell width={150}>档号</TableCell>
                <TableCell>题名</TableCell>
                <TableCell width={90}>密级</TableCell>
                <TableCell width={100}>方式</TableCell>
                <TableCell width={90}>状态</TableCell>
                <TableCell width={110}>预计归还</TableCell>
                <TableCell width={110}>申请人</TableCell>
                <TableCell width={220}>操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {listQuery.isLoading && (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 4 }}>
                    加载中…
                  </TableCell>
                </TableRow>
              )}
              {!listQuery.isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    暂无借阅单
                  </TableCell>
                </TableRow>
              )}
              {rows.map((o) => (
                <TableRow
                  key={o.id}
                  hover
                  selected={tab === 2 ? canApproveOrder(o) : false}
                >
                  <TableCell>
                    <Typography variant="caption" className="mono" sx={{ cursor: 'pointer' }} onClick={() => setDetailId(o.id)}>
                      {o.orderNo}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <ArchiveNo value={o.itemDanghao} copyable />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" noWrap sx={{ maxWidth: 280 }}>
                      {o.itemTitle}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <SecurityChip level={o.itemSecurityLevel} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{BORROW_MODE_LABELS[o.mode] ?? o.mode}</Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      <Chip
                        size="small"
                        label={BORROW_STATUS_LABELS[o.status] ?? o.status}
                        color={STATUS_COLOR[o.status]}
                        variant="outlined"
                      />
                      {o.overdue && (
                        <Chip size="small" color="error" label="逾期" sx={{ height: 18 }} />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">
                      {o.expectReturn?.slice(0, 10) ?? '-'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{o.applicantName}</Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      <Button size="small" onClick={() => setDetailId(o.id)}>
                        详情
                      </Button>
                      {canApproveOrder(o) && (
                        <PermGate domain="BORROW_APPROVE" op="APPROVE">
                          <Button
                            size="small"
                            color="primary"
                            onClick={() => {
                              setApproveTarget(o);
                              setApproveOpinion('');
                            }}
                          >
                            审批
                          </Button>
                        </PermGate>
                      )}
                      {o.status === 'APPROVED' && (
                        <PermGate domain="BORROW_RETURN" op="WRITE">
                          <Button
                            size="small"
                            onClick={() => lendMutation.mutate(o.id)}
                            disabled={lendMutation.isPending}
                          >
                            登记借出
                          </Button>
                        </PermGate>
                      )}
                      {(o.status === 'LENT' || o.status === 'OVERDUE') && (
                        <PermGate domain="BORROW_RETURN" op="WRITE">
                          <Button
                            size="small"
                            color="success"
                            onClick={() => {
                              setReturnTarget(o);
                              setReturnRemark('');
                            }}
                          >
                            归还
                          </Button>
                        </PermGate>
                      )}
                      <Tooltip title="打印 A4 档案利用单（含利用者、档号、审批意见与签字栏）">
                        <Button size="small" onClick={() => printBorrowSlip(o)}>
                          利用单
                        </Button>
                      </Tooltip>
                      {/* BR-06-4/BR-06-5：仅「已借出且未逾期、未续过」可续借。
                          逾期单与待审批单不展示按钮，避免用户触发必然失败的请求。 */}
                      {o.status === 'LENT' &&
                        !o.overdue &&
                        o.applicantId === profile?.userId &&
                        o.renewCount < rules.maxRenewalCount && (
                          <Tooltip title={rules.hint}>
                            <Button
                              size="small"
                              onClick={() => renewMutation.mutate(o.id)}
                              disabled={renewMutation.isPending}
                            >
                              续借
                            </Button>
                          </Tooltip>
                        )}
                      {(o.status === 'PENDING' || o.status === 'APPROVED') &&
                        o.applicantId === profile?.userId && (
                          <Button
                            size="small"
                            color="inherit"
                            onClick={() => cancelMutation.mutate(o.id)}
                            disabled={cancelMutation.isPending}
                          >
                            撤销
                          </Button>
                        )}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <TablePagination
            component="div"
            count={total}
            page={page - 1}
            rowsPerPage={size}
            rowsPerPageOptions={[10, 20, 50]}
            onPageChange={(_e, p) => setPage(p + 1)}
            onRowsPerPageChange={(e) => {
              setSize(Number(e.target.value));
              setPage(1);
            }}
            labelRowsPerPage="每页"
            labelDisplayedRows={({ from, to, count }) => `${from}-${to} / 共 ${count} 条`}
          />
        </CardContent>
      </Card>

      {/* 新建申请 */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>新建借阅申请</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField
              size="small"
              label="搜索档案（题名/档号）"
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              placeholder="输入关键词后从下方列表选择"
            />
            <TextField
              select
              size="small"
              label="借阅档案 *"
              value={formItemId}
              onChange={(e) => setFormItemId(e.target.value)}
              helperText={`当前候选 ${itemOptionsQuery.data?.total ?? 0} 条`}
            >
              {(itemOptionsQuery.data?.list ?? []).map((it) => (
                <MenuItem key={it.id} value={it.id}>
                  {it.danghao} — {it.title}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              label="借阅目的 *（≥5 字）"
              value={formPurpose}
              onChange={(e) => setFormPurpose(e.target.value)}
              multiline
              minRows={2}
            />
            <TextField
              select
              size="small"
              label="借阅方式"
              value={formMode}
              onChange={(e) => setFormMode(e.target.value as BorrowMode)}
            >
              <MenuItem value="ONLINE">{BORROW_MODE_LABELS.ONLINE}</MenuItem>
              <MenuItem value="ORIGINAL">{BORROW_MODE_LABELS.ORIGINAL}</MenuItem>
            </TextField>
            <TextField
              size="small"
              type="date"
              label="预计归还日期 *"
              value={effectiveDue}
              onChange={(e) => {
                setFormDue(e.target.value);
                setDueTouched(true);
              }}
              InputLabelProps={{ shrink: true }}
            />
            <Alert severity="info">
              秘密级档案需两级审批（档案管理员初审 → 领导/查档审批人终审）；其余为一级审批。
              申请人不得审批自己的单据，两级须由不同审批人完成。
            </Alert>
            <Alert severity="info" icon={false}>
              {rules.hint ||
                `借期自借出日起最长 ${rules.maxTotalDays} 天，可续借 ${rules.maxRenewalCount} 次。`}
            </Alert>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            提交申请
          </Button>
        </DialogActions>
      </Dialog>

      {/* 审批 */}
      <Dialog open={approveTarget !== null} onClose={() => setApproveTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>审批借阅申请</DialogTitle>
        <DialogContent>
          {approveTarget && (
            <Stack spacing={1} sx={{ mt: 1 }}>
              <Typography variant="body2">
                单号：<span className="mono">{approveTarget.orderNo}</span>
              </Typography>
              <Typography variant="body2">题名：{approveTarget.itemTitle}</Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2">密级：</Typography>
                <SecurityChip level={approveTarget.itemSecurityLevel} />
                {approveTarget.itemSecurityLevel === 'SECRET' && (
                  <Chip size="small" color="warning" label="需两级审批" sx={{ height: 18 }} />
                )}
              </Stack>
              <Typography variant="body2">目的：{approveTarget.purpose}</Typography>
              <Divider />
              <Typography variant="caption" color="text.secondary">
                已审批记录
              </Typography>
              {approveTarget.approvals.length === 0 && (
                <Typography variant="caption" color="text.disabled">
                  尚无
                </Typography>
              )}
              {approveTarget.approvals.map((a) => (
                <Typography key={a.id} variant="caption" display="block">
                  第 {a.level} 级 · {a.approverName} ·{' '}
                  {a.action === 'APPROVE' ? '同意' : '驳回'} · {a.opinion ?? ''}
                </Typography>
              ))}
              <TextField
                size="small"
                label="审批意见 *（≥2 字）"
                value={approveOpinion}
                onChange={(e) => setApproveOpinion(e.target.value)}
                multiline
                minRows={2}
              />
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            color="error"
            onClick={() => approveMutation.mutate('REJECT')}
            disabled={approveMutation.isPending}
          >
            驳回
          </Button>
          <Button
            variant="contained"
            onClick={() => approveMutation.mutate('APPROVE')}
            disabled={approveMutation.isPending}
          >
            同意
          </Button>
        </DialogActions>
      </Dialog>

      {/* 归还 */}
      <Dialog open={returnTarget !== null} onClose={() => setReturnTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>归还登记</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Typography variant="body2">
              {returnTarget?.orderNo} — {returnTarget?.itemTitle}
            </Typography>
            {returnTarget?.overdue && (
              <Alert severity="warning">
                该单据已逾期，请核实是否产生逾期记录（系统将写入审计日志）。
              </Alert>
            )}
            <TextField
              size="small"
              label="归还说明（可选）"
              value={returnRemark}
              onChange={(e) => setReturnRemark(e.target.value)}
              multiline
              minRows={2}
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReturnTarget(null)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => returnMutation.mutate()}
            disabled={returnMutation.isPending}
          >
            确认归还
          </Button>
        </DialogActions>
      </Dialog>

      {/* 详情抽屉 */}
      <Drawer anchor="right" open={detailId !== null} onClose={() => setDetailId(null)}>
        <Box sx={{ width: 420, p: 2 }}>
          <Typography variant="h6" sx={{ mb: 1.5 }}>
            借阅单详情
          </Typography>
          {detailQuery.isLoading && <Typography variant="body2">加载中…</Typography>}
          {detailQuery.data && (
            <Stack spacing={1.25}>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  单号
                </Typography>
                <Typography className="mono">{detailQuery.data.orderNo}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  档案
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <ArchiveNo value={detailQuery.data.itemDanghao} copyable />
                  <SecurityChip level={detailQuery.data.itemSecurityLevel} />
                </Stack>
                <Typography variant="body2">{detailQuery.data.itemTitle}</Typography>
              </Box>
              <Divider />
              <Stack direction="row" spacing={3}>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    状态
                  </Typography>
                  <Typography variant="body2">
                    {BORROW_STATUS_LABELS[detailQuery.data.status]}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    方式
                  </Typography>
                  <Typography variant="body2">
                    {BORROW_MODE_LABELS[detailQuery.data.mode]}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    续借次数
                  </Typography>
                  <Typography variant="body2">{detailQuery.data.renewCount}</Typography>
                </Box>
              </Stack>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  借阅目的
                </Typography>
                <Typography variant="body2">{detailQuery.data.purpose}</Typography>
              </Box>
              <Stack direction="row" spacing={3}>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    申请时间
                  </Typography>
                  <Typography variant="body2">
                    {detailQuery.data.createdAt?.slice(0, 16).replace('T', ' ')}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    预计归还
                  </Typography>
                  <Typography variant="body2">{detailQuery.data.expectReturn?.slice(0, 10)}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    实际归还
                  </Typography>
                  <Typography variant="body2">
                    {detailQuery.data.actualReturn?.slice(0, 10) ?? '—'}
                  </Typography>
                </Box>
              </Stack>
              <Divider />
              <Typography variant="subtitle2">审批流转</Typography>
              {detailQuery.data.approvals.length === 0 && (
                <Typography variant="caption" color="text.disabled">
                  暂无审批记录
                </Typography>
              )}
              {detailQuery.data.approvals.map((a) => (
                <Box key={a.id} sx={{ p: 1, bgcolor: '#f7fafc', borderRadius: 1 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Chip
                      size="small"
                      label={`${a.level} 级`}
                      variant="outlined"
                      sx={{ height: 18 }}
                    />
                    <Typography variant="caption">{a.approverName}</Typography>
                    <Chip
                      size="small"
                      label={a.action === 'APPROVE' ? '同意' : '驳回'}
                      color={a.action === 'APPROVE' ? 'success' : 'error'}
                      variant="outlined"
                      sx={{ height: 18 }}
                    />
                  </Stack>
                  <Typography variant="caption" display="block" sx={{ mt: 0.25 }}>
                    意见：{a.opinion || '（无）'}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    {a.actedAt?.slice(0, 16).replace('T', ' ')}
                  </Typography>
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      </Drawer>
    </AppLayout>
  );
}
