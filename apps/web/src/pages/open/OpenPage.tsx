import { useState, type ReactElement } from 'react';
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
  Drawer,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
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
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import {
  OPEN_BATCH_STATUS_LABELS,
  OPEN_DECISION_LABELS,
  SECURITY_LEVEL_LABELS,
  type OpenBatchDto,
  type OpenDecision,
  type OpenReviewDto,
  type SecurityLevel,
} from '@tianji/shared';
import { openApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { ArchiveNo } from '../../components/ArchiveNo';
import { PermGate } from '../../components/PermGate';

const STATUS_COLOR: Record<string, 'default' | 'info' | 'success' | 'warning'> = {
  DRAFT: 'default',
  IN_PROGRESS: 'info',
  APPROVING: 'warning',
  FINISHED: 'success',
  CANCELLED: 'default',
};

const DECISION_COLOR: Record<OpenDecision, 'default' | 'success' | 'info' | 'warning' | 'error'> = {
  PENDING: 'default',
  OPEN_ENTRY: 'info',
  OPEN_FULLTEXT: 'success',
  DENY: 'error',
  REREVIEW: 'warning',
};

/**
 * 开放管理页（F-19）。
 *
 * 流程：建批次（圈定范围）→ 逐件给结论（条目开放/原文开放/不开放/再审查）
 * → 提交审批（审批人可在「审批中心」处理）→ 通过后自动应用开放标识。
 *
 * 一个刻意的设计：**提交审批时未审核的件一律按「不开放」收口**。
 * 开放是授权扩大，必须显式表态；「忘了审」不能变成「默认开放」。
 */
export function OpenPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [tab, setTab] = useState(0);
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [active, setActive] = useState<OpenBatchDto | null>(null);
  const [reviewPage, setReviewPage] = useState(0);
  const [decisionFilter, setDecisionFilter] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [reasonDialog, setReasonDialog] = useState<{
    decision: Exclude<OpenDecision, 'PENDING'>;
    ids: string[];
  } | null>(null);
  const [reason, setReason] = useState('');

  const listQuery = useQuery({
    queryKey: ['open-batches', status, keyword, page],
    queryFn: () =>
      openApi.list({ status: status || undefined, keyword: keyword || undefined, page: page + 1, size: 20 }),
    enabled: tab === 0,
  });

  const rereviewQuery = useQuery({
    queryKey: ['open-rereview', page],
    queryFn: () => openApi.rereview({ page: page + 1, size: 20 }),
    enabled: tab === 1,
  });

  const reviewsQuery = useQuery({
    queryKey: ['open-reviews', active?.id, decisionFilter, reviewPage],
    queryFn: () =>
      openApi.reviews(active?.id as string, {
        decision: decisionFilter || undefined,
        page: reviewPage + 1,
        size: 20,
      }),
    enabled: Boolean(active?.id),
  });

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['open-batches'] });
    void qc.invalidateQueries({ queryKey: ['open-reviews'] });
    void qc.invalidateQueries({ queryKey: ['open-rereview'] });
  };

  const createMutation = useMutation({
    mutationFn: openApi.create,
    onSuccess: (b) => {
      enqueueSnackbar(`批次 ${b.batchNo} 已创建，待审 ${b.total} 件`, { variant: 'success' });
      setCreateOpen(false);
      refresh();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '创建失败', { variant: 'error' }),
  });

  const reviewMutation = useMutation({
    mutationFn: (payload: { decision: Exclude<OpenDecision, 'PENDING'>; ids: string[]; reason?: string }) =>
      openApi.review(active?.id as string, payload),
    onSuccess: (res, payload) => {
      enqueueSnackbar(`${OPEN_DECISION_LABELS[payload.decision]}：${res.updated} 件`, {
        variant: 'success',
      });
      setSelected([]);
      setReasonDialog(null);
      setReason('');
      refresh();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '审核失败', { variant: 'error' }),
  });

  const submitMutation = useMutation({
    mutationFn: (id: string) => openApi.submit(id),
    onSuccess: (b) => {
      enqueueSnackbar(
        `已提交审批（未审核件按不开放收口）。请到「审批中心」以 R1 身份处理实例。`,
        { variant: 'success' },
      );
      setActive(b);
      refresh();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '提交失败', { variant: 'error' }),
  });

  const applyMutation = useMutation({
    mutationFn: (id: string) => openApi.apply(id),
    onSuccess: (r) => {
      enqueueSnackbar(
        `开放标识已应用：条目开放 ${r.openedEntry}／原文开放 ${r.openedFulltext}／不开放 ${r.denied}`,
        { variant: 'success' },
      );
      refresh();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '应用失败', { variant: 'error' }),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => openApi.cancel(id),
    onSuccess: () => {
      enqueueSnackbar('批次已作废', { variant: 'success' });
      refresh();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '作废失败', { variant: 'error' }),
  });

  const rows = listQuery.data?.items ?? [];
  const reviewRows = reviewsQuery.data?.items ?? [];

  const submitReview = (decision: Exclude<OpenDecision, 'PENDING'>): void => {
    if (selected.length === 0) {
      enqueueSnackbar('请先勾选要审核的条目', { variant: 'warning' });
      return;
    }
    if (decision === 'DENY' || decision === 'REREVIEW') {
      setReason('');
      setReasonDialog({ decision, ids: selected });
      return;
    }
    reviewMutation.mutate({ decision, ids: selected });
  };

  return (
    <AppLayout title="开放管理">
      <Stack spacing={2}>
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField
              size="small"
              label="批次号 / 名称"
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
                {Object.entries(OPEN_BATCH_STATUS_LABELS).map(([k, v]) => (
                  <MenuItem key={k} value={k}>
                    {v}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Box sx={{ flex: 1 }} />
            <PermGate domain="APPRAISAL" op="WRITE">
              <Button variant="contained" onClick={() => setCreateOpen(true)}>
                新建开放批次
              </Button>
            </PermGate>
          </Stack>
        </Card>

        <Tabs value={tab} onChange={(_, v) => { setTab(v); setPage(0); }}>
          <Tab label="开放批次" />
          <Tab label={`再审查队列${rereviewQuery.data?.total ? `（${rereviewQuery.data.total}）` : ''}`} />
        </Tabs>

        {tab === 0 && (
          <Card variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width={130}>批次号</TableCell>
                  <TableCell>批次名称</TableCell>
                  <TableCell width={100}>状态</TableCell>
                  <TableCell width={300}>审核结论分布</TableCell>
                  <TableCell width={260}>操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id} hover>
                    <TableCell>
                      <ArchiveNo value={b.batchNo} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{b.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {b.yearFrom ?? '不限'}–{b.yearTo ?? '不限'}｜
                        {b.securityLevels.length
                          ? b.securityLevels.map((l) => SECURITY_LEVEL_LABELS[l]).join('/')
                          : '全部密级'}
                        ｜共 {b.total} 件
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={OPEN_BATCH_STATUS_LABELS[b.status]} color={STATUS_COLOR[b.status]} />
                      {b.workflowStatus === 'RUNNING' && (
                        <Chip size="small" color="warning" label="审批中" sx={{ ml: 0.5 }} />
                      )}
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        <Chip size="small" label={`未处理 ${b.pending}`} />
                        <Chip size="small" color="info" label={`条目开放 ${b.openedEntry}`} />
                        <Chip size="small" color="success" label={`原文开放 ${b.openedFulltext}`} />
                        <Chip size="small" color="error" label={`不开放 ${b.denied}`} />
                        <Chip size="small" color="warning" label={`再审查 ${b.rereview}`} />
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        <Button
                          size="small"
                          onClick={() => {
                            setActive(b);
                            setReviewPage(0);
                            setDecisionFilter('');
                            setSelected([]);
                          }}
                        >
                          明细
                        </Button>
                        <PermGate domain="APPRAISAL" op="WRITE">
                          <Button
                            size="small"
                            disabled={
                              b.status === 'APPROVING' || b.status === 'FINISHED' || b.status === 'CANCELLED'
                            }
                            onClick={() => submitMutation.mutate(b.id)}
                          >
                            提交审批
                          </Button>
                        </PermGate>
                        {b.workflowStatus === 'APPROVED' && b.status !== 'FINISHED' && (
                          <Button size="small" color="success" onClick={() => applyMutation.mutate(b.id)}>
                            应用标识
                          </Button>
                        )}
                        <PermGate domain="APPRAISAL" op="WRITE">
                          <Button
                            size="small"
                            color="warning"
                            disabled={b.status === 'FINISHED' || b.status === 'CANCELLED'}
                            onClick={() => {
                              if (window.confirm('确认作废该批次？')) cancelMutation.mutate(b.id);
                            }}
                          >
                            作废
                          </Button>
                        </PermGate>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                      {listQuery.isLoading ? '加载中…' : '暂无开放批次'}
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
              rowsPerPage={20}
              rowsPerPageOptions={[20]}
              labelRowsPerPage="每页"
            />
          </Card>
        )}

        {tab === 1 && (
          <Card variant="outlined">
            <Alert severity="info" sx={{ m: 2 }}>
              再审查件不改变任何开放标识（仍是控制使用）。补足依据后请**新建批次**重审，
              同一批次内不支持改判 —— 这样才能保留「上次为什么没开放」的依据。
            </Alert>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width={200}>档号</TableCell>
                  <TableCell>题名</TableCell>
                  <TableCell width={80}>年度</TableCell>
                  <TableCell width={100}>密级</TableCell>
                  <TableCell width={280}>存疑原因</TableCell>
                  <TableCell width={150}>审核人</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(rereviewQuery.data?.items ?? []).map((r: OpenReviewDto) => (
                  <TableRow key={r.id} hover>
                    <TableCell>
                      <ArchiveNo value={r.danghao} />
                    </TableCell>
                    <TableCell>{r.title}</TableCell>
                    <TableCell>{r.year}</TableCell>
                    <TableCell>{SECURITY_LEVEL_LABELS[r.securityLevel]}</TableCell>
                    <TableCell>{r.reason ?? '—'}</TableCell>
                    <TableCell>{r.reviewerName ?? '—'}</TableCell>
                  </TableRow>
                ))}
                {(rereviewQuery.data?.items ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                      再审查队列为空
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        )}
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
            <Chip size="small" label={active ? OPEN_BATCH_STATUS_LABELS[active.status] : ''} />
            <Box sx={{ flex: 1 }} />
            <Button onClick={() => setActive(null)}>关闭</Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            批次号 {active?.batchNo}｜共 {active?.total} 件｜未处理 {active?.pending} 件
          </Typography>

          {active?.status === 'APPROVING' && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              已提交审批，明细锁定。审批人可在「审批中心」处理；通过后开放标识自动应用。
            </Alert>
          )}

          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ my: 2 }}>
            <FormControl size="small" sx={{ width: 160 }}>
              <InputLabel>审核结论</InputLabel>
              <Select
                label="审核结论"
                value={decisionFilter}
                onChange={(e) => {
                  setDecisionFilter(e.target.value);
                  setReviewPage(0);
                  setSelected([]);
                }}
              >
                <MenuItem value="">全部</MenuItem>
                {Object.entries(OPEN_DECISION_LABELS).map(([k, v]) => (
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
                <Button size="small" variant="outlined" color="info" onClick={() => submitReview('OPEN_ENTRY')}>
                  条目开放
                </Button>
                <Button size="small" variant="outlined" color="success" onClick={() => submitReview('OPEN_FULLTEXT')}>
                  原文开放
                </Button>
                <Button size="small" variant="outlined" color="error" onClick={() => submitReview('DENY')}>
                  不开放
                </Button>
                <Button size="small" variant="outlined" color="warning" onClick={() => submitReview('REREVIEW')}>
                  再审查
                </Button>
              </Stack>
            </PermGate>
          </Stack>

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    checked={reviewRows.length > 0 && reviewRows.every((r) => selected.includes(r.id))}
                    onChange={(e) => {
                      if (e.target.checked) setSelected(reviewRows.map((r) => r.id));
                      else setSelected([]);
                    }}
                  />
                </TableCell>
                <TableCell width={190}>档号</TableCell>
                <TableCell>题名</TableCell>
                <TableCell width={70}>年度</TableCell>
                <TableCell width={80}>密级</TableCell>
                <TableCell width={120}>结论</TableCell>
                <TableCell width={220}>理由</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {reviewRows.map((r) => (
                <TableRow key={r.id} hover selected={selected.includes(r.id)}>
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={selected.includes(r.id)}
                      disabled={Boolean(r.appliedAt)}
                      onChange={(e) =>
                        setSelected((s) => (e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id)))
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <ArchiveNo value={r.danghao} />
                  </TableCell>
                  <TableCell sx={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.title}
                  </TableCell>
                  <TableCell>{r.year}</TableCell>
                  <TableCell>{SECURITY_LEVEL_LABELS[r.securityLevel]}</TableCell>
                  <TableCell>
                    <Chip size="small" label={OPEN_DECISION_LABELS[r.decision]} color={DECISION_COLOR[r.decision]} />
                    {r.appliedAt && <Chip size="small" label="已应用" sx={{ ml: 0.5 }} />}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.reason ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
              {reviewRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    {reviewsQuery.isLoading ? '加载中…' : '没有符合条件的明细'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={reviewsQuery.data?.total ?? 0}
            page={reviewPage}
            onPageChange={(_, p) => setReviewPage(p)}
            rowsPerPage={20}
            rowsPerPageOptions={[20]}
            labelRowsPerPage="每页"
          />
        </Box>
      </Drawer>

      {/* ---------------------------------------------------------- 新建批次 */}
      <CreateBatchDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        submitting={createMutation.isPending}
        onSubmit={(body) => createMutation.mutate(body)}
      />

      {/* ---------------------------------------------------------- 理由输入 */}
      <Dialog open={Boolean(reasonDialog)} onClose={() => setReasonDialog(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {reasonDialog ? OPEN_DECISION_LABELS[reasonDialog.decision] : ''}（{reasonDialog?.ids.length ?? 0} 件）
        </DialogTitle>
        <DialogContent>
          <TextField
            sx={{ mt: 1 }}
            fullWidth
            multiline
            minRows={3}
            label={reasonDialog?.decision === 'DENY' ? '不开放理由（必填）' : '存疑原因（必填）'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            helperText="例：涉及个人隐私；包含未公开的会议记录；需征求移交单位意见"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReasonDialog(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={reason.trim().length === 0 || reviewMutation.isPending}
            onClick={() => {
              if (!reasonDialog) return;
              reviewMutation.mutate({
                decision: reasonDialog.decision,
                ids: reasonDialog.ids,
                reason: reason.trim(),
              });
            }}
          >
            确认
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}

function CreateBatchDialog(props: {
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (body: {
    name: string;
    yearFrom?: number;
    yearTo?: number;
    securityLevels?: SecurityLevel[];
    unopenedOnly: boolean;
  }) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [yearFrom, setYearFrom] = useState<string>('');
  const [yearTo, setYearTo] = useState<string>('');
  const [levels, setLevels] = useState<SecurityLevel[]>([]);

  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>新建开放批次</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="批次名称"
            size="small"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：2026 年第一批开放审核"
            required
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label="起始年度（可空）"
              size="small"
              value={yearFrom}
              onChange={(e) => setYearFrom(e.target.value)}
            />
            <TextField
              label="结束年度（可空）"
              size="small"
              value={yearTo}
              onChange={(e) => setYearTo(e.target.value)}
            />
          </Stack>
          <FormControl size="small">
            <InputLabel>纳入密级（空 = 全部）</InputLabel>
            <Select
              multiple
              label="纳入密级（空 = 全部）"
              value={levels}
              onChange={(e) => setLevels(e.target.value as SecurityLevel[])}
              renderValue={(v) =>
                (v as SecurityLevel[]).length
                  ? (v as SecurityLevel[]).map((l) => SECURITY_LEVEL_LABELS[l]).join('、')
                  : '全部密级'
              }
            >
              {(Object.keys(SECURITY_LEVEL_LABELS) as SecurityLevel[]).map((l) => (
                <MenuItem key={l} value={l}>
                  {SECURITY_LEVEL_LABELS[l]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Alert severity="info">
            候选件为「已归档且未开放」的档案。批次生成后可逐件给结论，
            也可直接提交审批 —— 未审核件会自动按「不开放」收口。
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
              yearFrom: yearFrom ? Number(yearFrom) : undefined,
              yearTo: yearTo ? Number(yearTo) : undefined,
              securityLevels: levels.length ? levels : undefined,
              unopenedOnly: true,
            })
          }
        >
          创建批次
        </Button>
      </DialogActions>
    </Dialog>
  );
}
