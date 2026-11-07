import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
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
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import type { CreateFondsDto, FondsDto } from '@tianji/shared';
import { fondsApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

/** 空表单 */
const EMPTY: CreateFondsDto = {
  fondsNo: '',
  name: '',
  orgName: '',
  yearStart: null,
  yearEnd: null,
  historyNote: '',
};

/**
 * 全宗管理（F-01）。
 * 全宗号全局唯一且创建后不可修改（停用后可检索不可新增）。
 */
export function FondsListPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FondsDto | null>(null);
  const [form, setForm] = useState<CreateFondsDto>(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({ queryKey: ['fonds'], queryFn: () => fondsApi.list() });

  const saveMutation = useMutation({
    mutationFn: async (): Promise<FondsDto> => {
      if (editing) {
        const { fondsNo: _ignored, ...rest } = form;
        return fondsApi.update(editing.id, rest);
      }
      return fondsApi.create(form);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '全宗已更新' : '全宗已创建', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['fonds'] });
    },
    onError: (err: unknown) => {
      setFormError(err instanceof ApiError ? err.message : '保存失败');
    },
  });

  const openCreate = (): void => {
    setEditing(null);
    setForm(EMPTY);
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (f: FondsDto): void => {
    setEditing(f);
    setForm({
      fondsNo: f.fondsNo,
      name: f.name,
      orgName: f.orgName,
      yearStart: f.yearStart,
      yearEnd: f.yearEnd,
      historyNote: f.historyNote,
      status: f.status,
    });
    setFormError(null);
    setDialogOpen(true);
  };

  const submit = (): void => {
    setFormError(null);
    if (!form.fondsNo.trim()) return setFormError('全宗号不能为空');
    if (form.fondsNo.length > 32) return setFormError('全宗号不得超过 32 字符');
    if (!form.name.trim()) return setFormError('全宗名称不能为空');
    saveMutation.mutate();
  };

  return (
    <AppLayout
      title="全宗管理"
      subtitle="DA/T 22-2015 §5.2 全宗号全局唯一，创建后不可修改"
      actions={
        <PermGate domain="FONDS" op="WRITE">
          <Button variant="contained" size="small" onClick={openCreate}>
            新增全宗
          </Button>
        </PermGate>
      }
    >
      {error && <Alert severity="error">加载失败，请稍后重试</Alert>}

      <Paper>
        <Table size="small" className="dense-table">
          <TableHead>
            <TableRow>
              <TableCell width={120}>全宗号</TableCell>
              <TableCell>全宗名称</TableCell>
              <TableCell width={160}>立档单位</TableCell>
              <TableCell width={130}>起止年度</TableCell>
              <TableCell width={110}>状态</TableCell>
              <TableCell width={160}>操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} align="center">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && (data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ color: 'text.secondary' }}>
                  暂无全宗，请先新增
                </TableCell>
              </TableRow>
            )}
            {(data ?? []).map((f) => (
              <TableRow key={f.id}>
                <TableCell>
                  <span className="mono">{f.fondsNo}</span>
                </TableCell>
                <TableCell>{f.name}</TableCell>
                <TableCell>{f.orgName ?? '-'}</TableCell>
                <TableCell>
                  {f.yearStart ?? '-'} ~ {f.yearEnd ?? '至今'}
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={f.status === 'ACTIVE' ? '启用' : '停用'}
                    color={f.status === 'ACTIVE' ? 'success' : 'default'}
                    variant="outlined"
                  />
                </TableCell>
                <TableCell>
                  <PermGate domain="FONDS" op="WRITE">
                    <Button size="small" onClick={() => openEdit(f)}>
                      编辑
                    </Button>
                  </PermGate>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm">
        <DialogTitle>{editing ? `编辑全宗 ${editing.fondsNo}` : '新增全宗'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="全宗号 *"
              value={form.fondsNo ?? ''}
              onChange={(e) => setForm({ ...form, fondsNo: e.target.value })}
              disabled={Boolean(editing)}
              helperText={editing ? '全宗号创建后不可修改' : '如 WS、001，全局唯一'}
              fullWidth
            />
            <TextField
              label="全宗名称 *"
              value={form.name ?? ''}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              fullWidth
            />
            <TextField
              label="立档单位"
              value={form.orgName ?? ''}
              onChange={(e) => setForm({ ...form, orgName: e.target.value })}
              fullWidth
            />
            <Stack direction="row" spacing={2}>
              <TextField
                label="起始年度"
                type="number"
                value={form.yearStart ?? ''}
                onChange={(e) =>
                  setForm({ ...form, yearStart: e.target.value ? Number(e.target.value) : null })
                }
                fullWidth
              />
              <TextField
                label="终止年度"
                type="number"
                value={form.yearEnd ?? ''}
                onChange={(e) =>
                  setForm({ ...form, yearEnd: e.target.value ? Number(e.target.value) : null })
                }
                fullWidth
                helperText="留空表示至今"
              />
            </Stack>
            <TextField
              label="全宗历史沿革"
              value={form.historyNote ?? ''}
              onChange={(e) => setForm({ ...form, historyNote: e.target.value })}
              fullWidth
              multiline
              minRows={2}
            />
            {editing && (
              <TextField
                select
                label="状态"
                value={form.status ?? 'ACTIVE'}
                onChange={(e) => setForm({ ...form, status: e.target.value as 'ACTIVE' | 'DISABLED' })}
                fullWidth
                helperText="停用后不可新增档案，但可检索"
              >
                <MenuItem value="ACTIVE">启用</MenuItem>
                <MenuItem value="DISABLED">停用</MenuItem>
              </TextField>
            )}
            {formError && <Alert severity="error">{formError}</Alert>}
            <Box>
              <Typography variant="caption" color="text.secondary">
                提示：全宗下的组织机构在「全宗详情」中维护；档号规则在「档号规则」页配置。
              </Typography>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" onClick={submit} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
