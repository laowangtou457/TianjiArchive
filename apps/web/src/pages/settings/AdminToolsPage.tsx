import { useState, type ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
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
interface ExtPage {
  list: ExtRecord[];
  total: number;
}

type FieldType = 'text' | 'select' | 'date' | 'number';

interface FieldDef {
  key: string;
  label: string;
  type?: FieldType;
  options?: string[];
  required?: boolean;
  placeholder?: string;
}

interface ToolConfig {
  category: string;
  title: string;
  subtitle: string;
  /** 标题字段 label（表格首列） */
  titleLabel: string;
  domain: 'PARAM' | 'BACKUP' | 'REPORT';
  fields: FieldDef[];
  statuses: string[];
}

/**
 * 系统辅助工具（机构 / 补丁 / 光盘导出）。
 *
 * 泰坦这三个功能各占一个菜单，但都是「清单 + 增删改」的配置型页面。
 * 这里用同一套结构化表单渲染（不是让用户填 JSON），按路由切换配置，
 * 既保证导航上每个功能都能点进去，也避免三份几乎一样的代码。
 */
const CONFIGS: Record<string, ToolConfig> = {
  '/system/org': {
    category: 'ORG',
    title: '机构管理',
    subtitle: '维护立档单位 / 内部机构树，供著录与权限范围引用',
    titleLabel: '机构名称',
    domain: 'PARAM',
    statuses: ['ACTIVE', 'INACTIVE'],
    fields: [
      { key: 'name', label: '机构名称', required: true, placeholder: '如：综合办公室' },
      { key: 'code', label: '机构编码', placeholder: '如：ORG-001' },
      { key: 'parent', label: '上级机构', placeholder: '留空表示一级机构' },
      { key: 'leader', label: '负责人' },
      { key: 'phone', label: '联系电话' },
      { key: 'note', label: '备注' },
    ],
  },
  '/system/patch': {
    category: 'PATCH',
    title: '补丁管理',
    subtitle: '记录系统补丁版本与安装情况，便于回溯升级历史',
    titleLabel: '补丁编号',
    domain: 'BACKUP',
    statuses: ['PLANNED', 'APPLIED', 'ROLLED_BACK'],
    fields: [
      { key: 'patchNo', label: '补丁编号', required: true, placeholder: '如：TJ-2026-011' },
      { key: 'version', label: '目标版本', placeholder: '如：v1.4.2' },
      { key: 'installedAt', label: '安装日期', type: 'date' },
      { key: 'content', label: '补丁说明' },
      { key: 'operator', label: '执行人' },
    ],
  },
  '/export-cd': {
    category: 'CD_EXPORT',
    title: '光盘导出',
    subtitle: '按批次导出离线副本：登记条目范围、介质与份数',
    titleLabel: '导出批次名',
    domain: 'REPORT',
    statuses: ['DRAFT', 'EXPORTED', 'VERIFIED'],
    fields: [
      { key: 'batchName', label: '批次名', required: true, placeholder: '如：2026 年度文书档案离线备份' },
      { key: 'media', label: '介质类型', type: 'select', options: ['DVD-R', 'BD-R', '移动硬盘'] },
      { key: 'copies', label: '份数', type: 'number' },
      { key: 'scope', label: '条目范围', placeholder: '全宗 / 年度 / 档号区间' },
      { key: 'operator', label: '经办人' },
    ],
  },
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '启用',
  INACTIVE: '停用',
  PLANNED: '待安装',
  APPLIED: '已安装',
  ROLLED_BACK: '已回滚',
  DRAFT: '草稿',
  EXPORTED: '已导出',
  VERIFIED: '已校验',
};

function emptyForm(fields: FieldDef[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.key, '']));
}

export function AdminToolsPage(): ReactElement {
  const { pathname } = useLocation();
  const config = CONFIGS[pathname] ?? CONFIGS['/system/org'];
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExtRecord | null>(null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState(config.statuses[0]);
  const [form, setForm] = useState<Record<string, string>>(() => emptyForm(config.fields));

  const listQuery = useQuery({
    queryKey: ['extension', config.category],
    queryFn: () => api.get<ExtPage>('/extension/records', { category: config.category, size: 100 }),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const requiredField = config.fields.find((f) => f.required && !form[f.key]?.trim());
      if (requiredField) throw new Error(`请填写${requiredField.label}`);
      if (!title.trim()) throw new Error(`请填写${config.titleLabel}`);
      const bodyJson: Record<string, unknown> = {};
      for (const f of config.fields) {
        const v = form[f.key]?.trim();
        if (v) bodyJson[f.key] = f.type === 'number' ? Number(v) : v;
      }
      if (editing) {
        return api.patch<ExtRecord>(`/extension/records/${editing.id}`, { title: title.trim(), status, bodyJson });
      }
      return api.post<ExtRecord>('/extension/records', {
        category: config.category,
        title: title.trim(),
        status,
        bodyJson,
      });
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '已保存' : '已新增', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', config.category] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => {
      enqueueSnackbar('已删除', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['extension', config.category] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null);
    setTitle('');
    setStatus(config.statuses[0]);
    setForm(emptyForm(config.fields));
    setDialogOpen(true);
  };

  const openEdit = (row: ExtRecord): void => {
    setEditing(row);
    setTitle(row.title);
    setStatus(row.status);
    const next = emptyForm(config.fields);
    for (const f of config.fields) {
      const v = row.bodyJson[f.key];
      next[f.key] = v === undefined || v === null ? '' : String(v);
    }
    setForm(next);
    setDialogOpen(true);
  };

  const rows = listQuery.data?.list ?? [];

  return (
    <AppLayout
      title={config.title}
      subtitle={config.subtitle}
      actions={
        <PermGate domain={config.domain} op="WRITE">
          <Button size="small" variant="contained" onClick={openCreate}>
            + 新增
          </Button>
        </PermGate>
      }
    >
      <Card>
        <CardContent>
          {listQuery.isError ? (
            <Alert severity="error">{(listQuery.error as Error).message}</Alert>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{config.titleLabel}</TableCell>
                  {config.fields.slice(1, 4).map((f) => (
                    <TableCell key={f.key}>{f.label}</TableCell>
                  ))}
                  <TableCell width={100}>状态</TableCell>
                  <TableCell width={160}>创建时间</TableCell>
                  <TableCell width={140} align="right">
                    操作
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <Typography py={4} textAlign="center" color="text.secondary">
                        {listQuery.isLoading ? '加载中…' : '暂无记录'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.title}</TableCell>
                    {config.fields.slice(1, 4).map((f) => (
                      <TableCell key={f.key}>
                        {row.bodyJson[f.key] === undefined || row.bodyJson[f.key] === ''
                          ? '—'
                          : String(row.bodyJson[f.key])}
                      </TableCell>
                    ))}
                    <TableCell>
                      <Chip size="small" label={STATUS_LABEL[row.status] ?? row.status} />
                    </TableCell>
                    <TableCell>{new Date(row.createdAt).toLocaleString('zh-CN')}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => openEdit(row)}>
                        编辑
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => removeMutation.mutate(row.id)}
                      >
                        删除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editing ? `编辑${config.title}` : `新增${config.title}`}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <TextField
              size="small"
              label={config.titleLabel}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
            {config.fields.slice(1).map((f) => (
              <TextField
                key={f.key}
                size="small"
                label={f.label}
                type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
                select={f.type === 'select'}
                value={form[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                InputLabelProps={f.type === 'date' ? { shrink: true } : undefined}
              >
                {f.type === 'select'
                  ? (f.options ?? []).map((o) => (
                      <MenuItem key={o} value={o}>
                        {o}
                      </MenuItem>
                    ))
                  : undefined}
              </TextField>
            ))}
            <TextField
              size="small"
              select
              label="状态"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {config.statuses.map((s) => (
                <MenuItem key={s} value={s}>
                  {STATUS_LABEL[s] ?? s}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
