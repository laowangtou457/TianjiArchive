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
  LinearProgress,
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

interface FourNature {
  authenticity: number;
  integrity: number;
  availability: number;
  security: number;
  demo: true;
  checkedAt: string;
  details: Array<{ name: string; ok: boolean; message: string }>;
}

const CATEGORY = 'ERCHECK_ITEM';
const DOMAIN = 'BACKUP' as const;
const STATUS_OPTIONS = ['DRAFT', 'ENABLED', 'CHECKED', 'DISABLED'];

const DEMO_RESULT: FourNature = {
  authenticity: 96,
  integrity: 98,
  availability: 94,
  security: 97,
  demo: true,
  checkedAt: '',
  details: [
    { name: '真实性', ok: true, message: '元数据签名链与来源标识校验通过（演示数据）' },
    { name: '完整性', ok: true, message: '条目数量与校验和一致（演示数据）' },
    { name: '可用性', ok: true, message: '格式可解析、载体可读取（演示数据）' },
    { name: '安全性', ok: true, message: '密级标识与访问控制策略齐备（演示数据）' },
  ],
};

const NATURE_KEYS: Array<{ key: keyof Pick<FourNature, 'authenticity' | 'integrity' | 'availability' | 'security'>; label: string; color: 'primary' | 'success' | 'info' | 'warning' }> = [
  { key: 'authenticity', label: '真实性', color: 'primary' },
  { key: 'integrity', label: '完整性', color: 'success' },
  { key: 'availability', label: '可用性', color: 'info' },
  { key: 'security', label: '安全性', color: 'warning' },
];

/** 四性检测（对齐泰坦：检测项设置 / 增加·删除·修改 / 真实性·完整性·可用性·安全性检测） */
export function ErCheckPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExtRecord | null>(null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('ENABLED');
  const [jsonText, setJsonText] = useState('{}');
  const [result, setResult] = useState<FourNature | null>(null);
  const [checkedTarget, setCheckedTarget] = useState('');

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
      enqueueSnackbar(editing ? '检测项已保存' : '检测项已新增', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, { variant: 'error' }),
  });

  const checkMutation = useMutation({
    mutationFn: ({ id, target }: { id: string; target: string }) =>
      api.post<ExtRecord & { checkResult?: FourNature }>(`/extension/records/${id}/action`, {
        action: 'check',
        bodyJson: { target },
      }),
    onSuccess: (res, vars) => {
      setResult(res.checkResult ?? { ...DEMO_RESULT, checkedAt: new Date().toISOString() });
      setCheckedTarget(vars.target);
      enqueueSnackbar('检测完成', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '检测失败', { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => { enqueueSnackbar('检测项已删除', { variant: 'success' }); void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] }); },
    onError: (err: unknown) => enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null); setTitle(''); setStatus('ENABLED');
    setJsonText('{\n  "checks": ["真实性", "完整性", "可用性", "安全性"],\n  "scheme": "默认检测方案"\n}');
    setDialogOpen(true);
  };
  const openEdit = (row: ExtRecord): void => {
    setEditing(row); setTitle(row.title); setStatus(row.status);
    setJsonText(JSON.stringify(row.bodyJson, null, 2)); setDialogOpen(true);
  };

  const rows = listQuery.data?.list ?? [];

  return (
    <AppLayout title="四性检测" subtitle="检测项设置与真实性 / 完整性 / 可用性 / 安全性检测">
      <Stack spacing={2}>
        <Alert severity="warning" variant="outlined">
          检测结果为后端模拟值，标注「演示数据」；接入真实检测引擎后替换 Service 的 simulateFourNature 实现即可。
        </Alert>

        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>检测结果{checkedTarget ? ` · ${checkedTarget}` : ''}</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 2 }}>
              {NATURE_KEYS.map(({ key, label, color }) => (
                <Box key={key} sx={{ border: '1px solid #e2e8f0', borderRadius: 2, p: 2 }}>
                  <Typography variant="caption" color="text.secondary">{label}</Typography>
                  <Typography variant="h4" color={`${color}.main`}>{result?.[key] ?? DEMO_RESULT[key]}</Typography>
                  <LinearProgress variant="determinate" value={result?.[key] ?? DEMO_RESULT[key]} color={color} sx={{ mt: 1, height: 6, borderRadius: 3 }} />
                  <Typography variant="caption" color="text.secondary">演示数据</Typography>
                </Box>
              ))}
            </Box>
            {result && (
              <Stack spacing={0.5} mt={2}>
                <Typography variant="caption" color="text.secondary">检测时间：{new Date(result.checkedAt).toLocaleString()}</Typography>
                {result.details.map((d) => (
                  <Typography key={d.name} variant="body2">· {d.name}：{d.message}</Typography>
                ))}
              </Stack>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">检测项 / 方案（{rows.length}）</Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" onClick={() => void listQuery.refetch()}>刷新</Button>
                <PermGate domain={DOMAIN} op="WRITE"><Button variant="contained" onClick={openCreate}>+ 新增检测项</Button></PermGate>
              </Stack>
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>检测项 / 方案名称</TableCell>
                  <TableCell width="110">状态</TableCell>
                  <TableCell width="150">创建时间</TableCell>
                  <TableCell width="240" align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && !listQuery.isLoading && (
                  <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary">暂无检测项。</Typography></TableCell></TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.title}</TableCell>
                    <TableCell><Chip size="small" label={row.status} /></TableCell>
                    <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => openEdit(row)}>编辑</Button>
                      <PermGate domain={DOMAIN} op="WRITE">
                        <Button size="small" color="primary" disabled={checkMutation.isPending} onClick={() => checkMutation.mutate({ id: row.id, target: row.title })}>执行检测</Button>
                      </PermGate>
                      <PermGate domain={DOMAIN} op="DELETE">
                        <Button size="small" color="error" disabled={removeMutation.isPending} onClick={() => { if (window.confirm(`删除检测项「${row.title}」？`)) removeMutation.mutate(row.id); }}>删除</Button>
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
        <DialogTitle>{editing ? '编辑检测项' : '新增检测项'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="检测项名称" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth autoFocus />
            <TextField select label="状态" value={status} onChange={(e) => setStatus(e.target.value)} fullWidth>
              {STATUS_OPTIONS.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <TextField label="检测配置（JSON）" value={jsonText} onChange={(e) => setJsonText(e.target.value)} multiline minRows={10} fullWidth InputProps={{ sx: { fontFamily: 'monospace', fontSize: 12 } }} helperText="示例：{ checks, scheme }" />
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
