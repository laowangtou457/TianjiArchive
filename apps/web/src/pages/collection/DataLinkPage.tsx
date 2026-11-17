import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { api, ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

interface ExtRecord {
  id: string;
  category: string;
  title: string;
  bodyJson: Record<string, unknown>;
  status: string;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
}
interface ExtPage { list: ExtRecord[]; total: number }

const CATEGORY = 'DATALINK_BATCH';
const DOMAIN = 'IMPORT_EXPORT' as const;
const STATUS_OPTIONS = ['DRAFT', 'PRELINKED', 'CONFIRMED', 'REJECTED'];

/** 电子文件挂接（对齐泰坦：建立批次 / 规则设置 / 预挂接管理 / 确认挂接 / 挂接明细） */
export function DataLinkPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExtRecord | null>(null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('DRAFT');
  const [jsonText, setJsonText] = useState('{}');

  const listQuery = useQuery({
    queryKey: ['extension', CATEGORY],
    queryFn: () => api.get<ExtPage>('/extension/records', { category: CATEGORY, size: 100 }),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const bodyJson = JSON.parse(jsonText) as Record<string, unknown>;
      if (editing) return api.patch<ExtRecord>(`/extension/records/${editing.id}`, { title, status, bodyJson });
      return api.post<ExtRecord>('/extension/records', { category: CATEGORY, title, status, bodyJson });
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '批次已保存' : '挂接批次已建立', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, { variant: 'error' }),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.post<ExtRecord>(`/extension/records/${id}/action`, { action }),
    onSuccess: (_r, vars) => {
      enqueueSnackbar(vars.action === 'confirm' ? '挂接已确认' : '预挂接已执行', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => { enqueueSnackbar('批次已删除', { variant: 'success' }); void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] }); },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null); setTitle(''); setStatus('DRAFT');
    setJsonText('{\n  "rule": "按档号匹配",\n  "packageCount": 0,\n  "matched": 0\n}');
    setDialogOpen(true);
  };
  const openEdit = (row: ExtRecord): void => {
    setEditing(row); setTitle(row.title); setStatus(row.status);
    setJsonText(JSON.stringify(row.bodyJson, null, 2)); setDialogOpen(true);
  };

  const rows = listQuery.data?.list ?? [];

  return (
    <AppLayout title="电子文件挂接" subtitle="建立批次 → 规则设置 → 预挂接 → 确认挂接">
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          bodyJson 记录挂接规则与预挂接结果（规则、匹配数、失败清单）。「预挂接」生成候选结果，「确认挂接」正式写入档案。
        </Alert>
        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">挂接批次（{rows.length}）</Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" onClick={() => void listQuery.refetch()}>刷新</Button>
                <PermGate domain={DOMAIN} op="WRITE">
                  <Button variant="contained" onClick={openCreate}>+ 建立批次</Button>
                </PermGate>
              </Stack>
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>批次名称</TableCell>
                  <TableCell width="120">状态</TableCell>
                  <TableCell width="150">创建时间</TableCell>
                  <TableCell width="300" align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && !listQuery.isLoading && (
                  <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary">暂无挂接批次。</Typography></TableCell></TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.title}</TableCell>
                    <TableCell><Chip size="small" label={row.status} /></TableCell>
                    <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => openEdit(row)}>规则 / 明细</Button>
                      <PermGate domain={DOMAIN} op="WRITE">
                        <Button size="small" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'execute' })}>预挂接</Button>
                      </PermGate>
                      <PermGate domain={DOMAIN} op="APPROVE">
                        <Button size="small" color="primary" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'confirm' })}>确认挂接</Button>
                      </PermGate>
                      <PermGate domain={DOMAIN} op="DELETE">
                        <Button size="small" color="error" disabled={removeMutation.isPending} onClick={() => { if (window.confirm(`删除批次「${row.title}」？`)) removeMutation.mutate(row.id); }}>删除</Button>
                      </PermGate>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Stack>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{editing ? '规则设置与挂接明细' : '建立挂接批次'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="批次名称" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth autoFocus />
            <TextField select label="状态" value={status} onChange={(e) => setStatus(e.target.value)} fullWidth>
              {STATUS_OPTIONS.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <TextField
              label="规则 / 预挂接结果（JSON）"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              multiline minRows={10} fullWidth
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: 12 } }}
              helperText="示例字段：rule / packageCount / matched / failures"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>保存</Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
