import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
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

const CATEGORY = 'TEMPLATE';
const DOMAIN = 'PARAM' as const;
const STATUS_OPTIONS = ['DRAFT', 'ENABLED', 'DISABLED'];

/** 分类模板（对齐泰坦：档号设置 / 主题词 / 列表视图 / 著录视图 / 著录字段设置 / 复制模板） */
export function TemplatePage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupRow, setGroupRow] = useState<ExtRecord | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
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
      enqueueSnackbar(editing ? '模板已保存' : '模板已新增', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, { variant: 'error' }),
  });

  const groupMutation = useMutation({
    mutationFn: async () => {
      if (!groupRow) throw new Error('未选择模板');
      return api.patch<ExtRecord>(`/extension/records/${groupRow.id}`, {
        bodyJson: { ...groupRow.bodyJson, groups },
      });
    },
    onSuccess: () => {
      enqueueSnackbar('著录视图分组已保存', { variant: 'success' });
      setGroupOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '保存失败', { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => { enqueueSnackbar('已删除', { variant: 'success' }); void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] }); },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null); setTitle(''); setStatus('DRAFT');
    setJsonText('{\n  "danghao": {},\n  "subjectWords": [],\n  "listView": [],\n  "groups": ["基本信息", "保管信息"]\n}');
    setDialogOpen(true);
  };
  const openEdit = (row: ExtRecord): void => {
    setEditing(row); setTitle(row.title); setStatus(row.status);
    setJsonText(JSON.stringify(row.bodyJson, null, 2)); setDialogOpen(true);
  };
  const openGroups = (row: ExtRecord): void => {
    const raw = row.bodyJson.groups;
    setGroupRow(row);
    setGroups(Array.isArray(raw) ? raw.map(String) : ['基本信息', '保管信息', '电子文件']);
    setGroupOpen(true);
  };
  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= groups.length) return;
    const next = [...groups];
    [next[index], next[target]] = [next[target], next[index]];
    setGroups(next);
  };

  const rows = listQuery.data?.list ?? [];

  return (
    <AppLayout title="分类模板" subtitle="档号设置 / 主题词 / 列表视图 / 著录视图 / 字段分组配置">
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          模板配置以 JSON 存于 extension_record。bodyJson.groups 定义「著录视图分组」，可在分组可视化中上下移动调整顺序。
        </Alert>
        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">分类模板（{rows.length}）</Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" onClick={() => void listQuery.refetch()}>刷新</Button>
                <PermGate domain={DOMAIN} op="WRITE">
                  <Button variant="contained" onClick={openCreate}>+ 新增模板</Button>
                </PermGate>
              </Stack>
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>模板名称</TableCell>
                  <TableCell width="110">状态</TableCell>
                  <TableCell width="150">创建时间</TableCell>
                  <TableCell width="320" align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && !listQuery.isLoading && (
                  <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary">暂无分类模板。</Typography></TableCell></TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.title}</TableCell>
                    <TableCell><Chip size="small" label={row.status} /></TableCell>
                    <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" color="primary" onClick={() => openGroups(row)}>著录视图分组</Button>
                      <Button size="small" onClick={() => openEdit(row)}>配置</Button>
                      <PermGate domain={DOMAIN} op="DELETE">
                        <Button size="small" color="error" disabled={removeMutation.isPending} onClick={() => { if (window.confirm(`删除模板「${row.title}」？`)) removeMutation.mutate(row.id); }}>删除</Button>
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
        <DialogTitle>{editing ? '编辑分类模板' : '新增分类模板'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="模板名称" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth autoFocus />
            <TextField select label="状态" value={status} onChange={(e) => setStatus(e.target.value)} fullWidth>
              {STATUS_OPTIONS.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <TextField
              label="模板配置（JSON：档号设置 / 主题词 / 列表视图 / 著录视图 / 字段分组）"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              multiline minRows={12} fullWidth
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: 12 } }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>保存</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={groupOpen} onClose={() => setGroupOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>著录视图分组 · {groupRow?.title ?? ''}</DialogTitle>
        <DialogContent>
          <Typography variant="caption" color="text.secondary">用 ↑ ↓ 调整分组顺序（可视化编辑，保存后写回 bodyJson.groups）</Typography>
          <Stack spacing={1} mt={2}>
            {groups.map((g, i) => (
              <Box key={`${g}-${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 1, border: '1px solid #e2e8f0', borderRadius: 1, p: 1 }}>
                <Chip size="small" label={`${i + 1}`} />
                <Typography sx={{ flex: 1 }}>{g}</Typography>
                <Tooltip title="上移"><span><IconButton size="small" disabled={i === 0} onClick={() => move(i, -1)}>↑</IconButton></span></Tooltip>
                <Tooltip title="下移"><span><IconButton size="small" disabled={i === groups.length - 1} onClick={() => move(i, 1)}>↓</IconButton></span></Tooltip>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setGroupOpen(false)}>取消</Button>
          <Button variant="contained" disabled={groupMutation.isPending} onClick={() => groupMutation.mutate()}>保存分组</Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
