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
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
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

const DOMAIN = 'BACKUP' as const;
const TABS = [
  { key: 'ERMS_PACKAGE', label: '封装包' },
  { key: 'ERMS_PLAN', label: '计划设置' },
  { key: 'ERMS_TASK', label: '任务设置' },
  { key: 'ERMS_STORE', label: '电子库房' },
] as const;
const STATUS_OPTIONS = ['DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'RESET'];

/** 长期保管（对齐泰坦 ERMS：封装包 / 手工执行 / 计划设置 / 任务设置 / 状态重置 / 电子库房） */
export function ErmsPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [category, setCategory] = useState<string>(TABS[0].key);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExtRecord | null>(null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('DRAFT');
  const [jsonText, setJsonText] = useState('{}');

  const listQuery = useQuery({
    queryKey: ['extension', category],
    queryFn: () => api.get<ExtPage>('/extension/records', { category, size: 100 }),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const bodyJson = JSON.parse(jsonText) as Record<string, unknown>;
      if (editing) return api.patch<ExtRecord>(`/extension/records/${editing.id}`, { title, status, bodyJson });
      return api.post<ExtRecord>('/extension/records', { category, title, status, bodyJson });
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '已保存' : '已新增', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', category] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, { variant: 'error' }),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action, bodyJson }: { id: string; action: string; bodyJson?: Record<string, unknown> }) =>
      api.post<ExtRecord>(`/extension/records/${id}/action`, { action, bodyJson }),
    onSuccess: () => { enqueueSnackbar('操作成功', { variant: 'success' }); void qc.invalidateQueries({ queryKey: ['extension', category] }); },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => { enqueueSnackbar('已删除', { variant: 'success' }); void qc.invalidateQueries({ queryKey: ['extension', category] }); },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null); setTitle(''); setStatus('DRAFT');
    setJsonText('{\n  "packageNo": "",\n  "schedule": "",\n  "storePath": ""\n}');
    setDialogOpen(true);
  };
  const openEdit = (row: ExtRecord): void => {
    setEditing(row); setTitle(row.title); setStatus(row.status);
    setJsonText(JSON.stringify(row.bodyJson, null, 2)); setDialogOpen(true);
  };

  const rows = listQuery.data?.list ?? [];
  const currentTab = TABS.find((t) => t.key === category)?.label ?? '';

  return (
    <AppLayout title="长期保管" subtitle="封装包 / 手工执行 / 计划设置 / 任务设置 / 电子库房">
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          长期保管执行动作（execute）会写入强制审计日志。状态重置通过编辑状态为 DRAFT 完成。
        </Alert>
        <Card>
          <CardContent>
            <Tabs value={category} onChange={(_e, v: string) => setCategory(v)} sx={{ mb: 2 }}>
              {TABS.map((t) => <Tab key={t.key} value={t.key} label={t.label} />)}
            </Tabs>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">{currentTab}（{rows.length}）</Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" onClick={() => void listQuery.refetch()}>刷新</Button>
                <PermGate domain={DOMAIN} op="WRITE">
                  <Button variant="contained" onClick={openCreate}>+ 新增</Button>
                </PermGate>
              </Stack>
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>名称</TableCell>
                  <TableCell width="110">状态</TableCell>
                  <TableCell width="150">创建时间</TableCell>
                  <TableCell width="300" align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && !listQuery.isLoading && (
                  <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary">暂无{currentTab}记录。</Typography></TableCell></TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.title}</TableCell>
                    <TableCell><Chip size="small" label={row.status} /></TableCell>
                    <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => openEdit(row)}>编辑</Button>
                      <PermGate domain={DOMAIN} op="WRITE">
                        <Button size="small" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'execute' })}>手工执行</Button>
                        {category === 'ERMS_PACKAGE' && (
                          <Button size="small" color="warning" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'confirm', bodyJson: { reset: true } })}>状态重置</Button>
                        )}
                      </PermGate>
                      <PermGate domain={DOMAIN} op="DELETE">
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
        <DialogTitle>{editing ? `编辑${currentTab}` : `新增${currentTab}`}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="名称" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth autoFocus />
            <TextField select label="状态" value={status} onChange={(e) => setStatus(e.target.value)} fullWidth>
              {STATUS_OPTIONS.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <TextField
              label="配置（JSON）"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              multiline minRows={10} fullWidth
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: 12 } }}
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
