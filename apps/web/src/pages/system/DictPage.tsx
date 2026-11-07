import { useMemo, useState, type ReactElement } from 'react';
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
  Divider,
  List,
  ListItemButton,
  ListItemText,
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
import type { DictItemDto } from '@tianji/shared';
import { dictApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

/** 内置字典类型（与后端 seed 一致，作为左侧导航的提示） */
const KNOWN_DICT_TYPES: Array<{ type: string; label: string }> = [
  { type: 'retention', label: '保管期限' },
  { type: 'security_level', label: '密级' },
  { type: 'open_flag', label: '开放标识' },
  { type: 'item_status', label: '档案状态' },
  { type: 'borrow_mode', label: '借阅方式' },
  { type: 'org_type', label: '机构类型' },
  { type: 'carrier_type', label: '载体类型' },
  { type: 'file_format', label: '文件格式' },
];

/**
 * 数据字典管理页（F-14）。
 *
 * 左侧按 dictType 分组，右侧编辑该字典下的条目（code / label / sort / inUse）。
 * 内置条目（builtin=true）不可删除，只可停用 —— 避免破坏枚举语义。
 */
export function DictPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [activeType, setActiveType] = useState<string>('retention');
  const [draftType, setDraftType] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DictItemDto | null>(null);

  const [formCode, setFormCode] = useState<string>('');
  const [formLabel, setFormLabel] = useState<string>('');
  const [formSort, setFormSort] = useState<number>(0);
  const [formInUse, setFormInUse] = useState<boolean>(true);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);

  const allQuery = useQuery({ queryKey: ['dicts-all'], queryFn: () => dictApi.all() });

  /** 全部字典（引用稳定，避免下游 useMemo 每次重算） */
  const all: Record<string, DictItemDto[]> = useMemo(
    () => allQuery.data ?? {},
    [allQuery.data],
  );
  const typeKeys: string[] = useMemo(() => {
    const keys = new Set<string>([...KNOWN_DICT_TYPES.map((k) => k.type), ...Object.keys(all)]);
    return Array.from(keys);
  }, [all]);

  const items: DictItemDto[] = all[activeType] ?? [];

  /** 新增/编辑 */
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!activeType) throw new Error('请先选择字典类型');
      if (formCode.trim().length === 0) throw new Error('请填写字典码');
      if (formLabel.trim().length === 0) throw new Error('请填写显示名');
      return dictApi.upsert({
        id: editing?.id,
        dictType: activeType,
        code: formCode.trim(),
        label: formLabel.trim(),
        sort: formSort,
        inUse: formInUse,
      });
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '字典项已更新' : '字典项已新增', { variant: 'success' });
      setDialogOpen(false);
      setEditing(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['dicts-all'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  /** 删除 */
  const removeMutation = useMutation({
    mutationFn: (id: string) => dictApi.remove(id),
    onSuccess: () => {
      enqueueSnackbar('字典项已删除', { variant: 'info' });
      void qc.invalidateQueries({ queryKey: ['dicts-all'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : '删除失败（可能被引用或为内置项）');
    },
  });

  /** 快速切换启用 */
  const toggleMutation = useMutation({
    mutationFn: (item: DictItemDto) =>
      dictApi.upsert({
        id: item.id,
        dictType: item.dictType,
        code: item.code,
        label: item.label,
        sort: item.sort,
        inUse: !item.inUse,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dicts-all'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : '切换失败');
    },
  });

  const openCreate = (): void => {
    setEditing(null);
    setFormCode('');
    setFormLabel('');
    setFormSort(items.length > 0 ? Math.max(...items.map((i) => i.sort)) + 1 : 0);
    setFormInUse(true);
    setDialogOpen(true);
  };

  const openEdit = (item: DictItemDto): void => {
    setEditing(item);
    setFormCode(item.code);
    setFormLabel(item.label);
    setFormSort(item.sort);
    setFormInUse(item.inUse);
    setDialogOpen(true);
  };

  return (
    <AppLayout
      title="数据字典"
      subtitle="统一维护下拉选项与编码映射 · 内置项仅可停用不可删除"
      actions={
        <PermGate domain="DICT" op="WRITE">
          <Button size="small" variant="contained" onClick={openCreate}>
            新增字典项
          </Button>
        </PermGate>
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Card sx={{ width: 230, flex: '0 0 230px' }}>
          <CardContent sx={{ p: 1 }}>
            <Typography variant="subtitle2" sx={{ px: 1, mb: 0.5 }}>
              字典类型
            </Typography>
            <List dense disablePadding>
              {typeKeys.map((t) => {
                const known = KNOWN_DICT_TYPES.find((k) => k.type === t);
                const count = (all[t] ?? []).length;
                return (
                  <ListItemButton
                    key={t}
                    selected={activeType === t}
                    onClick={() => setActiveType(t)}
                    sx={{ borderRadius: 1 }}
                  >
                    <ListItemText
                      primary={known?.label ?? t}
                      secondary={t}
                      primaryTypographyProps={{ variant: 'body2' }}
                      secondaryTypographyProps={{ variant: 'caption' }}
                    />
                    <Chip label={count} size="small" variant="outlined" sx={{ height: 18 }} />
                  </ListItemButton>
                );
              })}
            </List>
            <Divider sx={{ my: 1 }} />
            <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
              可自定义新类型，输入后点「切换」即可。
            </Typography>
            <Stack direction="row" spacing={0.5} sx={{ px: 1, mt: 0.5 }}>
              <TextField
                size="small"
                placeholder="新类型"
                value={draftType}
                onChange={(e) => setDraftType(e.target.value)}
                sx={{ flex: 1 }}
              />
              <Button
                size="small"
                onClick={() => {
                  const t = draftType.trim();
                  if (t) {
                    setActiveType(t);
                    setDraftType('');
                  }
                }}
              >
                切换
              </Button>
            </Stack>
          </CardContent>
        </Card>

        <Card sx={{ flex: 1, minWidth: 0 }}>
          <CardContent sx={{ p: 1.5 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              字典类型：<span className="mono">{activeType}</span>
            </Typography>

            <Table size="small" className="dense-table">
              <TableHead>
                <TableRow>
                  <TableCell width={70}>排序</TableCell>
                  <TableCell width={150}>字典码</TableCell>
                  <TableCell>显示名</TableCell>
                  <TableCell width={90}>状态</TableCell>
                  <TableCell width={90}>内置</TableCell>
                  <TableCell width={160}>操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      该字典类型下暂无条目
                    </TableCell>
                  </TableRow>
                )}
                {items.map((item) => (
                  <TableRow key={item.id} hover>
                    <TableCell>{item.sort}</TableCell>
                    <TableCell className="mono">{item.code}</TableCell>
                    <TableCell>{item.label}</TableCell>
                    <TableCell>
                      <Switch
                        size="small"
                        checked={item.inUse}
                        onChange={() => toggleMutation.mutate(item)}
                      />
                    </TableCell>
                    <TableCell>
                      {item.builtin ? (
                        <Chip label="内置" size="small" variant="outlined" sx={{ height: 18 }} />
                      ) : (
                        <Typography variant="caption" color="text.disabled">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5}>
                        <PermGate domain="DICT" op="WRITE">
                          <Button size="small" onClick={() => openEdit(item)}>
                            编辑
                          </Button>
                        </PermGate>
                        <PermGate domain="DICT" op="DELETE">
                          <Button
                            size="small"
                            color="error"
                            disabled={item.builtin}
                            onClick={() => {
                              if (window.confirm(`确认删除字典项「${item.label}」？`)) {
                                removeMutation.mutate(item.id);
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
      </Stack>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{editing ? '编辑字典项' : '新增字典项'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField size="small" label="字典类型" value={activeType} disabled />
            <TextField
              size="small"
              label="字典码 *"
              value={formCode}
              onChange={(e) => setFormCode(e.target.value)}
              helperText="程序内部使用的编码，建议大写英文/数字"
            />
            <TextField
              size="small"
              label="显示名 *"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
            />
            <TextField
              size="small"
              type="number"
              label="排序"
              value={formSort}
              onChange={(e) => setFormSort(Number(e.target.value) || 0)}
            />
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2">启用</Typography>
              <Switch checked={formInUse} onChange={(e) => setFormInUse(e.target.checked)} />
            </Stack>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
