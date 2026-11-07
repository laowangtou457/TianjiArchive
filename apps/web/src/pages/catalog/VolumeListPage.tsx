import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import {
  RETENTION_LABELS,
  RETENTION_VALUES,
  SECURITY_LEVEL_VALUES,
  SECURITY_LEVEL_LABELS,
  type Retention,
  type SecurityLevel,
  type VolumeDto,
} from '@tianji/shared';
import { archiveApi, categoryApi, fondsApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { ArchiveNo, SecurityChip } from '../../components/ArchiveNo';
import { PermGate } from '../../components/PermGate';

/** 新建案卷表单 */
interface VolumeForm {
  fondsId: string;
  categoryId: string | null;
  title: string;
  responsible: string;
  year: number;
  retention: Retention;
  securityLevel: SecurityLevel;
  keywords: string;
  note: string;
}

/**
 * 案卷列表与著录（F-03）。
 * 档号由后端按规则生成，前端不提供档号输入框（避免与规则冲突）。
 */
export function VolumeListPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [fondsFilter, setFondsFilter] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState<VolumeForm>({
    fondsId: '',
    categoryId: null,
    title: '',
    responsible: '',
    year: new Date().getFullYear(),
    retention: 'PERM',
    securityLevel: 'PUBLIC',
    keywords: '',
    note: '',
  });

  const fondsQuery = useQuery({ queryKey: ['fonds'], queryFn: () => fondsApi.list() });
  const categoryQuery = useQuery({ queryKey: ['categories'], queryFn: () => categoryApi.list() });

  const listQuery = useQuery({
    queryKey: ['volumes', page, size, keyword, fondsFilter],
    queryFn: () =>
      archiveApi.listVolumes({
        page: page + 1,
        size,
        keyword: keyword || undefined,
        fondsId: fondsFilter || undefined,
      }),
  });

  const createMutation = useMutation({
    mutationFn: async (): Promise<VolumeDto> => {
      return archiveApi.createVolume({
        fondsId: form.fondsId,
        categoryId: form.categoryId || null,
        title: form.title.trim(),
        responsible: form.responsible.trim() || null,
        year: form.year,
        retention: form.retention,
        securityLevel: form.securityLevel,
        keywords: form.keywords
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        note: form.note.trim() || null,
      });
    },
    onSuccess: (v) => {
      enqueueSnackbar(`案卷已创建，档号 ${v.danghao}`, { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['volumes'] });
    },
    onError: (err: unknown) => {
      setFormError(err instanceof ApiError ? err.message : '创建失败');
    },
  });

  const confirmMutation = useMutation({
    mutationFn: (id: string) => archiveApi.confirmVolume(id),
    onSuccess: (r) => {
      enqueueSnackbar(`已确认归档，同步 ${r.confirmed} 件`, { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['volumes'] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  const fondsOptions = useMemo(() => fondsQuery.data ?? [], [fondsQuery.data]);
  const categoryOptions = useMemo(() => categoryQuery.data ?? [], [categoryQuery.data]);

  const submit = (): void => {
    setFormError(null);
    if (!form.fondsId) return setFormError('请选择全宗');
    if (!form.title.trim()) return setFormError('案卷题名不能为空');
    if (form.year < 1900 || form.year > 2100) return setFormError('年度不合法');
    createMutation.mutate();
  };

  return (
    <AppLayout
      title="档案著录 · 案卷"
      subtitle="档号由系统按规则生成，入库后不可修改（唯一通道为作废重编）"
      actions={
        <PermGate domain="VOLUME" op="WRITE">
          <Button variant="contained" size="small" onClick={() => setDialogOpen(true)}>
            新建案卷
          </Button>
        </PermGate>
      }
    >
      <Stack direction="row" spacing={1.5} sx={{ mb: 1.5 }} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          label="搜索题名 / 档号"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(0);
          }}
          sx={{ width: 260 }}
        />
        <TextField
          select
          label="全宗"
          value={fondsFilter}
          onChange={(e) => {
            setFondsFilter(e.target.value);
            setPage(0);
          }}
          sx={{ width: 200 }}
        >
          <MenuItem value="">全部</MenuItem>
          {fondsOptions.map((f) => (
            <MenuItem key={f.id} value={f.id}>
              {f.fondsNo} {f.name}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      {listQuery.error && <Alert severity="error">加载失败</Alert>}

      <Paper>
        <Table size="small" className="dense-table">
          <TableHead>
            <TableRow>
              <TableCell width={210}>档号</TableCell>
              <TableCell>案卷题名</TableCell>
              <TableCell width={110}>年度</TableCell>
              <TableCell width={110}>保管期限</TableCell>
              <TableCell width={90}>密级</TableCell>
              <TableCell width={80}>件数</TableCell>
              <TableCell width={100}>状态</TableCell>
              <TableCell width={170}>操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {listQuery.isLoading && (
              <TableRow>
                <TableCell colSpan={8} align="center">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!listQuery.isLoading && (listQuery.data?.list ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ color: 'text.secondary' }}>
                  暂无数据
                </TableCell>
              </TableRow>
            )}
            {(listQuery.data?.list ?? []).map((v) => (
              <TableRow key={v.id}>
                <TableCell>
                  <ArchiveNo value={v.danghao} copyable />
                </TableCell>
                <TableCell>{v.title}</TableCell>
                <TableCell>{v.year}</TableCell>
                <TableCell>{RETENTION_LABELS[v.retention]}</TableCell>
                <TableCell>
                  <SecurityChip level={v.securityLevel} />
                </TableCell>
                <TableCell>{v.itemCount}</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={v.status === 'ARCHIVED' ? '已归档' : v.status === 'VOID' ? '已作废' : '草稿'}
                    color={v.status === 'ARCHIVED' ? 'success' : v.status === 'VOID' ? 'error' : 'default'}
                    variant="outlined"
                  />
                </TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5}>
                    <Button size="small" href={`/catalog/${v.id}`}>
                      卷内文件
                    </Button>
                    <PermGate domain="ARCHIVE_CONFIRM" op="APPROVE">
                      <Tooltip title={v.status === 'ARCHIVED' ? '已归档' : '确认归档并级联卷内件'}>
                        <span>
                          <Button
                            size="small"
                            disabled={v.status === 'ARCHIVED' || confirmMutation.isPending}
                            onClick={() => confirmMutation.mutate(v.id)}
                          >
                            归档
                          </Button>
                        </span>
                      </Tooltip>
                    </PermGate>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <TablePagination
          component="div"
          count={listQuery.data?.total ?? 0}
          page={page}
          onPageChange={(_e, p) => setPage(p)}
          rowsPerPage={size}
          onRowsPerPageChange={(e) => {
            setSize(Number(e.target.value));
            setPage(0);
          }}
          rowsPerPageOptions={[20, 50, 100]}
          labelRowsPerPage="每页"
          labelDisplayedRows={({ from, to, count }) => `${from}-${to} / ${count}`}
        />
      </Paper>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm">
        <DialogTitle>新建案卷</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info">
              案卷档号由「档号规则」自动生成（如 WS-2024-Y-0001），如需重新编排请在「档号规则」中试算。
            </Alert>
            <TextField
              select
              label="全宗 *"
              value={form.fondsId}
              onChange={(e) => setForm({ ...form, fondsId: e.target.value })}
              fullWidth
            >
              {fondsOptions.map((f) => (
                <MenuItem key={f.id} value={f.id}>
                  {f.fondsNo} {f.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="门类"
              value={form.categoryId ?? ''}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value || null })}
              fullWidth
              helperText="门类决定动态著录字段集"
            >
              <MenuItem value="">使用全宗默认规则</MenuItem>
              {categoryOptions.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.code} {c.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="案卷题名 *"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              fullWidth
              multiline
              minRows={2}
            />
            <TextField
              label="责任者"
              value={form.responsible}
              onChange={(e) => setForm({ ...form, responsible: e.target.value })}
              fullWidth
            />
            <Stack direction="row" spacing={2}>
              <TextField
                label="年度 *"
                type="number"
                value={form.year}
                onChange={(e) => setForm({ ...form, year: Number(e.target.value) })}
                fullWidth
              />
              <TextField
                select
                label="保管期限 *"
                value={form.retention}
                onChange={(e) => setForm({ ...form, retention: e.target.value as Retention })}
                fullWidth
              >
                {RETENTION_VALUES.map((r) => (
                  <MenuItem key={r} value={r}>
                    {RETENTION_LABELS[r]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                label="密级 *"
                value={form.securityLevel}
                onChange={(e) => setForm({ ...form, securityLevel: e.target.value as SecurityLevel })}
                fullWidth
              >
                {SECURITY_LEVEL_VALUES.map((l) => (
                  <MenuItem key={l} value={l}>
                    {SECURITY_LEVEL_LABELS[l]}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            <TextField
              label="关键词"
              value={form.keywords}
              onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              fullWidth
              helperText="多个关键词用逗号分隔，用于全文检索加权"
            />
            <TextField
              label="备注"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              fullWidth
              multiline
              minRows={2}
            />
            {formError && <Alert severity="error">{formError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" onClick={submit} disabled={createMutation.isPending}>
            {createMutation.isPending ? '创建中…' : '创建并取号'}
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
