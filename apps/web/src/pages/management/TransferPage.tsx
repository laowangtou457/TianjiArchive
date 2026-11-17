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

const CATEGORY = 'TRANSFER';
const DOMAIN = 'IMPORT_EXPORT' as const;
const STATUS_OPTIONS = ['DRAFT', 'PENDING', 'CONFIRMED', 'REJECTED'];

/** 本地下载（不依赖后端文件接口，演示清单导出） */
function downloadRecord(row: ExtRecord): void {
  const blob = new Blob([JSON.stringify({ title: row.title, bodyJson: row.bodyJson }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${row.title}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** 移交管理（对齐泰坦：增加 / 修改 / 删除 / 管理条目 / 查看移交包 / 下载 / 四性检测 / 确认） */
export function TransferPage(): ReactElement {
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
      enqueueSnackbar(editing ? '移交包已保存' : '移交包已创建', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, { variant: 'error' }),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.post<ExtRecord>(`/extension/records/${id}/action`, { action }),
    onSuccess: () => { enqueueSnackbar('操作成功', { variant: 'success' }); void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] }); },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => { enqueueSnackbar('移交包已删除', { variant: 'success' }); void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] }); },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null); setTitle(''); setStatus('DRAFT');
    setJsonText('{\n  "entries": [],\n  "target": "",\n  "checkScheme": ""\n}');
    setDialogOpen(true);
  };
  const openEdit = (row: ExtRecord): void => {
    setEditing(row); setTitle(row.title); setStatus(row.status);
    setJsonText(JSON.stringify(row.bodyJson, null, 2)); setDialogOpen(true);
  };

  const rows = listQuery.data?.list ?? [];

  return (
    <AppLayout title="移交管理" subtitle="电子 / 实体档案移交：管理条目 → 查看移交包 → 下载 → 确认">
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          bodyJson.entries 保存移交条目清单；四性检测通过「四性检测」页执行，检测结果回写到 bodyJson.fourNature。
        </Alert>
        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">移交包（{rows.length}）</Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" onClick={() => void listQuery.refetch()}>刷新</Button>
                <PermGate domain={DOMAIN} op="WRITE">
                  <Button variant="contained" onClick={openCreate}>+ 新增移交包</Button>
                </PermGate>
              </Stack>
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>移交包名称</TableCell>
                  <TableCell width="110">状态</TableCell>
                  <TableCell width="150">创建时间</TableCell>
                  <TableCell width="360" align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && !listQuery.isLoading && (
                  <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary">暂无移交包。</Typography></TableCell></TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.title}</TableCell>
                    <TableCell><Chip size="small" label={row.status} /></TableCell>
                    <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => openEdit(row)}>管理条目</Button>
                      <Button size="small" onClick={() => downloadRecord(row)}>下载</Button>
                      <PermGate domain={DOMAIN} op="WRITE">
                        <Button size="small" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'check' })}>四性检测</Button>
                      </PermGate>
                      <PermGate domain={DOMAIN} op="APPROVE">
                        <Button size="small" color="primary" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'confirm' })}>确认移交</Button>
                      </PermGate>
                      <PermGate domain={DOMAIN} op="DELETE">
                        <Button size="small" color="error" disabled={removeMutation.isPending} onClick={() => { if (window.confirm(`删除移交包「${row.title}」？`)) removeMutation.mutate(row.id); }}>删除</Button>
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
        <DialogTitle>{editing ? '管理移交条目' : '新增移交包'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="移交包名称" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth autoFocus />
            <TextField select label="状态" value={status} onChange={(e) => setStatus(e.target.value)} fullWidth>
              {STATUS_OPTIONS.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <TextField
              label="移交条目 / 配置（JSON）"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              multiline minRows={12} fullWidth
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: 12 } }}
              helperText="示例字段：entries / target / checkScheme"
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
