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
  Stack,
  Switch,
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

interface RetentionPlan {
  id: string;
  code: string;
  name: string;
  years: number;
  level: string;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PlanForm {
  code: string;
  name: string;
  years: string;
  level: string;
  description: string;
  enabled: boolean;
}

const EMPTY_FORM: PlanForm = {
  code: '',
  name: '',
  years: '30',
  level: 'Y30',
  description: '',
  enabled: true,
};

/** 保管期限表 P5：表格 + 新增/编辑对话框，权限域 DANGHAO_RULE */
export function RetentionPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<RetentionPlan | null>(null);
  const [form, setForm] = useState<PlanForm>(EMPTY_FORM);

  const plansQuery = useQuery({
    queryKey: ['retention-plans'],
    queryFn: (): Promise<RetentionPlan[]> => api.get('/retention/plans'),
  });

  const showError = (err: unknown, fallback: string): void => {
    setError(err instanceof ApiError ? err.message : fallback);
  };

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['retention-plans'] });
  };

  const saveMutation = useMutation({
    mutationFn: (): Promise<RetentionPlan> => {
      const body = {
        code: form.code.trim(),
        name: form.name.trim(),
        years: Number.parseInt(form.years, 10),
        level: form.level.trim(),
        description: form.description.trim() || null,
        enabled: form.enabled,
      };
      return editing
        ? api.patch(`/retention/plans/${editing.id}`, body)
        : api.post('/retention/plans', body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '保管期限已更新' : '保管期限已新增', { variant: 'success' });
      setDialogOpen(false);
      setEditing(null);
      setError(null);
      invalidate();
    },
    onError: (err: unknown) => showError(err, '保存失败'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string): Promise<{ removed: boolean }> => api.delete(`/retention/plans/${id}`),
    onSuccess: () => {
      enqueueSnackbar('保管期限已删除', { variant: 'info' });
      invalidate();
    },
    onError: (err: unknown) => showError(err, '删除失败'),
  });

  const toggleMutation = useMutation({
    mutationFn: (plan: RetentionPlan): Promise<RetentionPlan> =>
      api.patch(`/retention/plans/${plan.id}`, { enabled: !plan.enabled }),
    onSuccess: () => invalidate(),
    onError: (err: unknown) => showError(err, '切换启用状态失败'),
  });

  const openCreate = (): void => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (plan: RetentionPlan): void => {
    setEditing(plan);
    setForm({
      code: plan.code,
      name: plan.name,
      years: String(plan.years),
      level: plan.level,
      description: plan.description ?? '',
      enabled: plan.enabled,
    });
    setDialogOpen(true);
  };

  const plans = plansQuery.data ?? [];

  return (
    <AppLayout
      title="保管期限表"
      subtitle="维护保管期限等级与年限 · 权限域 DANGHAO_RULE"
      actions={
        <PermGate domain="DANGHAO_RULE" op="WRITE">
          <Button size="small" variant="contained" onClick={openCreate}>
            新增期限
          </Button>
        </PermGate>
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card>
        <CardContent sx={{ p: 1.5 }}>
          <Table size="small" className="dense-table">
            <TableHead>
              <TableRow>
                <TableCell width={140}>代码</TableCell>
                <TableCell>名称</TableCell>
                <TableCell width={100} align="right">
                  年限
                </TableCell>
                <TableCell width={110}>等级</TableCell>
                <TableCell>说明</TableCell>
                <TableCell width={80}>启用</TableCell>
                <TableCell width={150}>操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {plans.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    暂无保管期限方案，点击右上角「新增期限」建立。
                  </TableCell>
                </TableRow>
              )}
              {plans.map((plan) => (
                <TableRow key={plan.id} hover>
                  <TableCell className="mono">{plan.code}</TableCell>
                  <TableCell>{plan.name}</TableCell>
                  <TableCell align="right">{plan.years === -1 ? '永久' : plan.years}</TableCell>
                  <TableCell>
                    <Chip label={plan.level} size="small" variant="outlined" sx={{ height: 20 }} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {plan.description || '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <PermGate domain="DANGHAO_RULE" op="WRITE">
                      <Switch
                        size="small"
                        checked={plan.enabled}
                        onChange={() => toggleMutation.mutate(plan)}
                      />
                    </PermGate>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      <PermGate domain="DANGHAO_RULE" op="WRITE">
                        <Button size="small" onClick={() => openEdit(plan)}>
                          编辑
                        </Button>
                      </PermGate>
                      <PermGate domain="DANGHAO_RULE" op="DELETE">
                        <Button
                          size="small"
                          color="error"
                          onClick={() => {
                            if (window.confirm(`确认删除保管期限「${plan.name}」？`)) {
                              removeMutation.mutate(plan.id);
                            }
                          }}
                        >
                          删除
                        </Button>
                      </PermGate>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{editing ? '编辑保管期限' : '新增保管期限'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField
              size="small"
              label="代码 *"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              helperText="程序内部编码，建议大写英文/数字"
            />
            <TextField
              size="small"
              label="名称 *"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                type="number"
                label="年限 *"
                value={form.years}
                onChange={(e) => setForm({ ...form, years: e.target.value })}
                helperText="永久填 -1"
                sx={{ flex: 1 }}
              />
              <TextField
                size="small"
                label="等级"
                value={form.level}
                onChange={(e) => setForm({ ...form, level: e.target.value })}
                helperText="PERM / Y30 / Y10"
                sx={{ flex: 1 }}
              />
            </Stack>
            <TextField
              size="small"
              label="说明"
              multiline
              minRows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2">启用</Typography>
              <Switch
                size="small"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
            </Stack>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !form.code.trim() || !form.name.trim() || !form.years.trim()}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
