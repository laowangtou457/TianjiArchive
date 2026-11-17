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

const DOMAIN = 'PARAM' as const;
const TABS = [
  { key: 'AUX_ENTITY', label: '辅助实体' },
  { key: 'AUX_CONTAINER', label: '装具管理' },
] as const;
const STATUS_OPTIONS = ['DRAFT', 'STORED', 'OUT', 'UPDATED'];

/** 辅助实体（对齐泰坦：入库 / 出库 / 更新 / 装具管理 / 查看明细） */
export function AuxEntityPage(): ReactElement {
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
    mutationFn: ({ id, action }: { id: string; action: string }) => api.post<ExtRecord>(`/extension/records/${id}/action`, { action }),
    onSuccess: (_r, vars) => {
      enqueueSnackbar(vars.action === 'inbound' ? '已入库' : vars.action === 'outbound' ? '已出库' : '操作成功', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['extension', category] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => { enqueueSnackbar('已删除', { variant: 'success' }); void qc.invalidateQueries({ queryKey: ['extension', category] }); },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null); setTitle(''); setStatus('DRAFT');
    setJsonText(category === 'AUX_CONTAINER'
      ? '{\n  "type": "档案盒",\n  "spec": "",\n  "count": 0\n}'
      : '{\n  "code": "",\n  "location": "",\n  "owner": ""\n}');
    setDialogOpen(true);
  };
  const openEdit = (row: ExtRecord): void => {
    setEditing(row); setTitle(row.title); setStatus(row.status);
    setJsonText(JSON.stringify(row.bodyJson, null, 2)); setDialogOpen(true);
  };

  const rows = listQuery.data?.list ?? [];
  const currentTab = TABS.find((t) => t.key === category)?.label ?? '';

  return (
    <AppLayout title="辅助实体" subtitle="辅助实体入库 / 出库 / 更新与装具管理">
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          辅助实体与装具共用通用记录表，bodyJson 保存规格、位置、数量等字段；入库 / 出库动作强制留痕。
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
                      <Button size="small" onClick={() => openEdit(row)}>查看明细</Button>
                      <PermGate domain={DOMAIN} op="WRITE">
                        <Button size="small" color="primary" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'inbound' })}>入库</Button>
                        <Button size="small" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'outbound' })}>出库</Button>
                        <Button size="small" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate({ id: row.id, action: 'execute' })}>更新</Button>
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
              label="明细（JSON）"
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
