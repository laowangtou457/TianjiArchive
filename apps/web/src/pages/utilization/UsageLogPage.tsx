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
interface AuditRow {
  id: string;
  username: string | null;
  action: string;
  objectType: string | null;
  objectId: string | null;
  result: string;
  createdAt: string;
}
interface AuditPage { list?: AuditRow[]; items?: AuditRow[]; total: number }

const CATEGORY = 'USAGE_LOG';
const STATUS_OPTIONS = ['DRAFT', 'REGISTERED', 'RETURNED'];

/** 利用日志（对齐泰坦：利用登记 / 查看借阅单 / 利用情况管理；数据来自 extension_record 与 audit_log） */
export function UsageLogPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [editing, setEditing] = useState<ExtRecord | null>(null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('REGISTERED');
  const [jsonText, setJsonText] = useState('{}');

  const listQuery = useQuery({
    queryKey: ['extension', CATEGORY],
    queryFn: () => api.get<ExtPage>('/extension/records', { category: CATEGORY, size: 100 }),
  });

  const auditQuery = useQuery({
    queryKey: ['extension', CATEGORY, 'audit'],
    queryFn: () => api.get<AuditPage>('/audit-logs', { objectType: 'ITEM', size: 50 }),
    enabled: auditOpen,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const bodyJson = JSON.parse(jsonText) as Record<string, unknown>;
      if (editing) return api.patch<ExtRecord>(`/extension/records/${editing.id}`, { title, status, bodyJson });
      return api.post<ExtRecord>('/extension/records', { category: CATEGORY, title, status, bodyJson });
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '利用记录已保存' : '利用登记已创建', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => { enqueueSnackbar('已删除', { variant: 'success' }); void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] }); },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null); setTitle(''); setStatus('REGISTERED');
    setJsonText('{\n  "borrowNo": "",\n  "borrower": "",\n  "purpose": ""\n}');
    setDialogOpen(true);
  };
  const openEdit = (row: ExtRecord): void => {
    setEditing(row); setTitle(row.title); setStatus(row.status);
    setJsonText(JSON.stringify(row.bodyJson, null, 2)); setDialogOpen(true);
  };

  const rows = listQuery.data?.list ?? [];
  const auditRows = auditQuery.data?.list ?? auditQuery.data?.items ?? [];

  return (
    <AppLayout title="利用日志" subtitle="利用登记 / 查看借阅单 / 利用情况管理">
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          利用登记存于 extension_record（category=USAGE_LOG）；系统真实操作留痕可在「审计日志」中交叉核对。
        </Alert>
        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">利用登记（{rows.length}）</Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" onClick={() => setAuditOpen(true)}>查看审计日志</Button>
                <Button variant="outlined" onClick={() => void listQuery.refetch()}>刷新</Button>
                <PermGate domain="PARAM" op="WRITE">
                  <Button variant="contained" onClick={openCreate}>+ 利用登记</Button>
                </PermGate>
              </Stack>
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>登记标题 / 借阅单</TableCell>
                  <TableCell width="110">状态</TableCell>
                  <TableCell width="150">创建时间</TableCell>
                  <TableCell width="200" align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && !listQuery.isLoading && (
                  <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary">暂无利用登记。</Typography></TableCell></TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.title}</TableCell>
                    <TableCell><Chip size="small" label={row.status} /></TableCell>
                    <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => openEdit(row)}>查看 / 编辑</Button>
                      <PermGate domain="PARAM" op="DELETE">
                        <Button size="small" color="error" disabled={removeMutation.isPending} onClick={() => { if (window.confirm(`删除「${row.title}」？`)) removeMutation.mutate(row.id); }}>删除</Button>
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
        <DialogTitle>{editing ? '查看 / 编辑利用记录' : '利用登记'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="登记标题" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth autoFocus />
            <TextField select label="状态" value={status} onChange={(e) => setStatus(e.target.value)} fullWidth>
              {STATUS_OPTIONS.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <TextField
              label="借阅单 / 利用情况（JSON）"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              multiline minRows={10} fullWidth
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: 12 } }}
              helperText="示例字段：borrowNo / borrower / purpose"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>保存</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={auditOpen} onClose={() => setAuditOpen(false)} fullWidth maxWidth="lg">
        <DialogTitle>审计日志（利用相关操作留痕）</DialogTitle>
        <DialogContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>操作人</TableCell>
                <TableCell>动作</TableCell>
                <TableCell>对象</TableCell>
                <TableCell>结果</TableCell>
                <TableCell>时间</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {auditRows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.username ?? '—'}</TableCell>
                  <TableCell>{r.action}</TableCell>
                  <TableCell>{r.objectType ?? '—'} / {r.objectId ?? '—'}</TableCell>
                  <TableCell><Chip size="small" label={r.result} /></TableCell>
                  <TableCell>{new Date(r.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {auditQuery.isError && <Alert severity="error" sx={{ mt: 2 }}>审计日志加载失败（需要 AUDIT_LOG 读权限）</Alert>}
        </DialogContent>
        <DialogActions><Button onClick={() => setAuditOpen(false)}>关闭</Button></DialogActions>
      </Dialog>
    </AppLayout>
  );
}
