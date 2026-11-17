import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useSnackbar } from 'notistack';
import { api, ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

type DestroyStatus = 'PENDING' | 'APPROVED' | 'DESTROYED';

interface DestroyBatch {
  id: string;
  batchNo: string;
  reason: string;
  status: DestroyStatus;
  itemIds: string[];
  createdBy: string | null;
  createdAt: string;
}

interface DestroyEntry {
  id: string;
  batchId: string;
  itemId: string | null;
  danghao: string;
  title: string | null;
  result: string;
  createdAt: string;
}

interface DestroyExecuteResult {
  destroyed: number;
  failed: number;
}

const STATUS_LABEL: Record<DestroyStatus, string> = {
  PENDING: '待审核',
  APPROVED: '已审核',
  DESTROYED: '已销毁',
};

const STATUS_COLOR: Record<DestroyStatus, 'warning' | 'info' | 'success'> = {
  PENDING: 'warning',
  APPROVED: 'info',
  DESTROYED: 'success',
};

/** 销毁批次 P5：列表 + 新建（粘贴档号多行）+ 审核/执行 + 留痕明细，权限域 RECYCLE */
export function DestroyPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const [reason, setReason] = useState<string>('');
  const [danghaoText, setDanghaoText] = useState<string>('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [entriesMap, setEntriesMap] = useState<Record<string, DestroyEntry[]>>({});

  const batchesQuery = useQuery({
    queryKey: ['destroy-batches'],
    queryFn: (): Promise<DestroyBatch[]> => api.get('/destroy/batches'),
  });

  const showError = (err: unknown, fallback: string): void => {
    setError(err instanceof ApiError ? err.message : fallback);
  };

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['destroy-batches'] });
  };

  const createMutation = useMutation({
    mutationFn: (): Promise<DestroyBatch> =>
      api.post('/destroy/batches', {
        reason: reason.trim(),
        danghaos: danghaoText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      enqueueSnackbar('销毁批次已建立', { variant: 'success' });
      setDialogOpen(false);
      setReason('');
      setDanghaoText('');
      setError(null);
      invalidate();
    },
    onError: (err: unknown) => showError(err, '建立销毁批次失败'),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string): Promise<DestroyBatch> => api.post(`/destroy/batches/${id}/approve`),
    onSuccess: () => {
      enqueueSnackbar('批次已审核通过', { variant: 'success' });
      invalidate();
    },
    onError: (err: unknown) => showError(err, '审核失败'),
  });

  const executeMutation = useMutation({
    mutationFn: (id: string): Promise<DestroyExecuteResult> =>
      api.post(`/destroy/batches/${id}/execute`),
    onSuccess: (res) => {
      enqueueSnackbar(`销毁完成：成功 ${res.destroyed} 条，失败 ${res.failed} 条`, {
        variant: res.failed > 0 ? 'warning' : 'success',
      });
      invalidate();
    },
    onError: (err: unknown) => showError(err, '执行销毁失败'),
  });

  const toggleEntries = (batch: DestroyBatch): void => {
    if (expanded === batch.id) {
      setExpanded(null);
      return;
    }
    setExpanded(batch.id);
    if (!entriesMap[batch.id]) {
      void api
        .get<DestroyEntry[]>(`/destroy/batches/${batch.id}/entries`)
        .then((rows) => setEntriesMap((prev) => ({ ...prev, [batch.id]: rows })))
        .catch((err: unknown) => showError(err, '加载销毁明细失败'));
    }
  };

  const batches = batchesQuery.data ?? [];

  return (
    <AppLayout
      title="销毁批次"
      subtitle="建立销毁批次 → 审核 → 执行销毁 · 权限域 RECYCLE"
      actions={
        <PermGate domain="RECYCLE" op="WRITE">
          <Button
            size="small"
            variant="contained"
            color="error"
            onClick={() => setDialogOpen(true)}
          >
            新建销毁批次
          </Button>
        </PermGate>
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card>
        <CardContent sx={{ p: 1.5 }}>
          <Table size="small" className="dense-table">
            <TableHead>
              <TableRow>
                <TableCell width={40} />
                <TableCell width={160}>批次号</TableCell>
                <TableCell>销毁原因</TableCell>
                <TableCell width={100}>状态</TableCell>
                <TableCell width={90}>条目数</TableCell>
                <TableCell width={150}>建立时间</TableCell>
                <TableCell width={180}>操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {batches.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    暂无销毁批次，点击右上角「新建销毁批次」建立。
                  </TableCell>
                </TableRow>
              )}
              {batches.map((batch) => (
                <FragmentRow
                  key={batch.id}
                  batch={batch}
                  entries={entriesMap[batch.id] ?? []}
                  expanded={expanded === batch.id}
                  onToggle={() => toggleEntries(batch)}
                  onApprove={() => approveMutation.mutate(batch.id)}
                  onExecute={() => executeMutation.mutate(batch.id)}
                  approveDisabled={approveMutation.isPending}
                  executeDisabled={executeMutation.isPending}
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>新建销毁批次</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField
              size="small"
              label="销毁原因 *"
              multiline
              minRows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <TextField
              size="small"
              label="待销毁档号（每行一个）*"
              placeholder={'DA-2020-0001\nDA-2020-0002'}
              multiline
              minRows={8}
              value={danghaoText}
              onChange={(e) => setDanghaoText(e.target.value)}
              helperText="未匹配到档案条目的档号会标记为 NOT_FOUND，便于核对"
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !reason.trim() || !danghaoText.trim()}
          >
            建立批次
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}

/** 批次行 + 可展开的销毁明细（Fragment 辅助组件） */
function FragmentRow(props: {
  batch: DestroyBatch;
  entries: DestroyEntry[];
  expanded: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onExecute: () => void;
  approveDisabled: boolean;
  executeDisabled: boolean;
}): ReactElement {
  const { batch, entries, expanded, onToggle, onApprove, onExecute, approveDisabled, executeDisabled } =
    props;
  return (
    <>
      <TableRow hover>
        <TableCell>
          <Tooltip title={expanded ? '收起明细' : '查看明细'}>
            <IconButton size="small" onClick={onToggle}>
              <KeyboardArrowDownIcon
                sx={{ transform: expanded ? 'rotate(180deg)' : 'none', fontSize: 18 }}
              />
            </IconButton>
          </Tooltip>
        </TableCell>
        <TableCell className="mono">{batch.batchNo}</TableCell>
        <TableCell>{batch.reason}</TableCell>
        <TableCell>
          <Chip
            label={STATUS_LABEL[batch.status]}
            color={STATUS_COLOR[batch.status]}
            size="small"
            variant="outlined"
          />
        </TableCell>
        <TableCell>{batch.itemIds.length}</TableCell>
        <TableCell>
          <Typography variant="caption" color="text.secondary">
            {new Date(batch.createdAt).toLocaleString()}
          </Typography>
        </TableCell>
        <TableCell>
          <Stack direction="row" spacing={0.5}>
            <PermGate domain="RECYCLE" op="WRITE">
              <Button
                size="small"
                onClick={onApprove}
                disabled={batch.status !== 'PENDING' || approveDisabled}
              >
                审核
              </Button>
            </PermGate>
            <PermGate domain="RECYCLE" op="DELETE">
              <Button
                size="small"
                color="error"
                onClick={() => {
                  if (window.confirm(`确认执行销毁批次「${batch.batchNo}」？此操作不可撤销。`)) {
                    onExecute();
                  }
                }}
                disabled={batch.status !== 'APPROVED' || executeDisabled}
              >
                执行销毁
              </Button>
            </PermGate>
          </Stack>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={7} sx={{ p: 0, borderBottom: expanded ? undefined : 'none' }}>
          <Collapse in={expanded} unmountOnExit>
            <Table size="small" className="dense-table" sx={{ bgcolor: 'action.hover' }}>
              <TableHead>
                <TableRow>
                  <TableCell width={60}>#</TableCell>
                  <TableCell>档号</TableCell>
                  <TableCell>题名</TableCell>
                  <TableCell width={120}>结果</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {entries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} align="center" sx={{ color: 'text.secondary' }}>
                      暂无明细
                    </TableCell>
                  </TableRow>
                )}
                {entries.map((entry, idx) => (
                  <TableRow key={entry.id}>
                    <TableCell>{idx + 1}</TableCell>
                    <TableCell className="mono">{entry.danghao}</TableCell>
                    <TableCell>{entry.title || '—'}</TableCell>
                    <TableCell>
                      <Chip
                        label={entry.result}
                        size="small"
                        variant="outlined"
                        color={
                          entry.result === 'DESTROYED'
                            ? 'success'
                            : entry.result === 'PENDING'
                              ? 'default'
                              : 'error'
                        }
                        sx={{ height: 20 }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}
