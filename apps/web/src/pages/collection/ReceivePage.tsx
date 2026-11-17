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

/** 通用扩展记录（对应后端 extension_record） */
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

interface ExtPage {
  list: ExtRecord[];
  total: number;
}

const CATEGORY = 'RECEIVE_PACKAGE';
const DOMAIN = 'IMPORT_EXPORT' as const;
const STATUS_OPTIONS = ['DRAFT', 'PENDING', 'CONFIRMED', 'REJECTED'];

/** 电子档案接收（对齐泰坦「电子档案接收」节点：上传 / 查看接收包 / 确认 / 退回） */
export function ReceivePage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExtRecord | null>(null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('PENDING');
  const [jsonText, setJsonText] = useState('{}');

  const listQuery = useQuery({
    queryKey: ['extension', CATEGORY],
    queryFn: () => api.get<ExtPage>('/extension/records', { category: CATEGORY, size: 100 }),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const bodyJson = JSON.parse(jsonText) as Record<string, unknown>;
      if (editing) {
        return api.patch<ExtRecord>(`/extension/records/${editing.id}`, { title, status, bodyJson });
      }
      return api.post<ExtRecord>('/extension/records', { category: CATEGORY, title, status, bodyJson });
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '接收包已保存' : '接收包已创建', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, { variant: 'error' }),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api.post<ExtRecord>(`/extension/records/${id}/action`, { action }),
    onSuccess: (_res, vars) => {
      enqueueSnackbar(vars.action === 'confirm' ? '接收包已确认' : '接收包已退回', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => {
      enqueueSnackbar('接收包已删除', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null);
    setTitle('');
    setStatus('PENDING');
    setJsonText('{\n  "packageNo": "",\n  "source": "",\n  "fileCount": 0\n}');
    setDialogOpen(true);
  };

  const openEdit = (row: ExtRecord): void => {
    setEditing(row);
    setTitle(row.title);
    setStatus(row.status);
    setJsonText(JSON.stringify(row.bodyJson, null, 2));
    setDialogOpen(true);
  };

  const rows = listQuery.data?.list ?? [];

  return (
    <AppLayout title="电子档案接收" subtitle="上传接收包 → 查看接收包 → 确认 / 退回">
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          接收包以清单形式登记；bodyJson 中可填写接收包编号、来源、文件数量等。确认后进入归档流程，退回需填写原因。
        </Alert>
        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">接收包（{rows.length}）</Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" onClick={() => void listQuery.refetch()}>刷新</Button>
                <PermGate domain={DOMAIN} op="WRITE">
                  <Button variant="contained" onClick={openCreate}>+ 上传接收包</Button>
                </PermGate>
              </Stack>
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>接收包名称</TableCell>
                  <TableCell width="120">状态</TableCell>
                  <TableCell width="150">创建时间</TableCell>
                  <TableCell width="260" align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && !listQuery.isLoading && (
                  <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary">暂无接收包。</Typography></TableCell></TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.title}</TableCell>
                    <TableCell><Chip size="small" label={row.status} /></TableCell>
                    <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => openEdit(row)}>查看 / 编辑</Button>
                      <PermGate domain={DOMAIN} op="APPROVE">
                        <Button size="small" color="success" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'confirm' })}>确认</Button>
                        <Button size="small" color="warning" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'reject' })}>退回</Button>
                      </PermGate>
                      <PermGate domain={DOMAIN} op="DELETE">
                        <Button size="small" color="error" disabled={removeMutation.isPending} onClick={() => { if (window.confirm(`删除接收包「${row.title}」？`)) removeMutation.mutate(row.id); }}>删除</Button>
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
        <DialogTitle>{editing ? '查看 / 编辑接收包' : '上传接收包（登记）'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="接收包名称" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth autoFocus />
            <TextField select label="状态" value={status} onChange={(e) => setStatus(e.target.value)} fullWidth>
              {STATUS_OPTIONS.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <TextField
              label="接收清单（JSON）"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              multiline
              minRows={10}
              fullWidth
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: 12 } }}
              helperText="示例字段：packageNo / source / fileCount / 检测方案"
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
