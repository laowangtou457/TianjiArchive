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
import { archiveApi } from '../../api';
import { api, ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { ItemPicker, type ItemOption } from '../../components/ItemPicker';
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

interface TransferEntry {
  id: string;
  danghao: string;
  title: string;
  year?: number;
}

interface TransferBody {
  transferType?: 'PHYSICAL' | 'ELECTRONIC';
  targetUnit?: string;
  reason?: string;
  entries?: TransferEntry[];
  checkScheme?: string;
  confirmedAt?: string;
}

const CATEGORY = 'TRANSFER';
const DOMAIN = 'IMPORT_EXPORT' as const;

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '待确认',
  CONFIRMED: '已确认',
  REJECTED: '已退回',
};

const TYPE_LABEL: Record<string, string> = {
  PHYSICAL: '实体档案',
  ELECTRONIC: '电子档案',
};

/** 移交条目清单导出（本地 JSON，便于线下交接签字） */
function downloadRecord(row: ExtRecord): void {
  const blob = new Blob([JSON.stringify({ title: row.title, bodyJson: row.bodyJson }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${row.title}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * 档案移交（实体 + 电子合并，对齐泰坦「实体档案移交 / 电子档案移交」）。
 *
 * 泰坦是两个菜单两套页面，但业务动作完全一致（增加 / 修改 / 删除 / 管理条目 / 查看移交包 / 下载 / 检测方案），
 * 差别只在移交对象的载体。这里合并成一个页面，用「移交类型」区分：
 * 减少一次菜单跳转，也避免同一批档案被重复建两张单。
 */
export function TransferPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [typeTab, setTypeTab] = useState<'ALL' | 'PHYSICAL' | 'ELECTRONIC'>('ALL');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExtRecord | null>(null);
  const [title, setTitle] = useState('');
  const [transferType, setTransferType] = useState<'PHYSICAL' | 'ELECTRONIC'>('ELECTRONIC');
  const [targetUnit, setTargetUnit] = useState('');
  const [reason, setReason] = useState('');
  const [entries, setEntries] = useState<ItemOption[]>([]);
  const [viewing, setViewing] = useState<ExtRecord | null>(null);
  const [schemeOpen, setSchemeOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['extension', CATEGORY],
    queryFn: () => api.get<ExtPage>('/extension/records', { category: CATEGORY, size: 100 }),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error('请填写移交单名称');
      if (entries.length === 0) throw new Error('请至少选择一条移交档案');
      const bodyJson: TransferBody = {
        transferType,
        targetUnit: targetUnit.trim(),
        reason: reason.trim(),
        entries: entries.map((e) => ({ id: e.id, danghao: e.danghao, title: e.title, year: e.year })),
        checkScheme: '四性检测（真实性/完整性/可用性/安全性）',
      };
      if (editing) {
        return api.patch<ExtRecord>(`/extension/records/${editing.id}`, {
          title: title.trim(),
          status: editing.status,
          bodyJson,
        });
      }
      return api.post<ExtRecord>('/extension/records', {
        category: CATEGORY,
        title: title.trim(),
        status: 'PENDING',
        bodyJson,
      });
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '移交单已保存' : '移交单已创建', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, { variant: 'error' }),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api.post<ExtRecord>(`/extension/records/${id}/action`, { action }),
    onSuccess: () => {
      enqueueSnackbar('操作成功', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/extension/records/${id}`),
    onSuccess: () => {
      enqueueSnackbar('移交单已删除', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['extension', CATEGORY] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null);
    setTitle('');
    setTransferType(typeTab === 'PHYSICAL' ? 'PHYSICAL' : 'ELECTRONIC');
    setTargetUnit('');
    setReason('');
    setEntries([]);
    setDialogOpen(true);
  };

  const openEdit = (row: ExtRecord): void => {
    const body = row.bodyJson as TransferBody;
    setEditing(row);
    setTitle(row.title);
    setTransferType(body.transferType === 'PHYSICAL' ? 'PHYSICAL' : 'ELECTRONIC');
    setTargetUnit(body.targetUnit ?? '');
    setReason(body.reason ?? '');
    setEntries(
      (body.entries ?? []).map((e) => ({ id: e.id, danghao: e.danghao, title: e.title, year: e.year })),
    );
    setDialogOpen(true);
  };

  const allRows = useMemo(() => listQuery.data?.list ?? [], [listQuery.data]);
  const rows = useMemo(() => {
    if (typeTab === 'ALL') return allRows;
    return allRows.filter((r) => (r.bodyJson as TransferBody).transferType === typeTab);
  }, [allRows, typeTab]);

  const fetchItems = async (keyword: string): Promise<ItemOption[]> => {
    const res = await archiveApi.listItems({ keyword, size: 20, page: 1 });
    return res.list.map((i) => ({
      id: i.id,
      danghao: i.danghao,
      title: i.title,
      year: i.year,
      retention: i.retention,
      securityLevel: i.securityLevel,
    }));
  };

  return (
    <AppLayout
      title="档案移交"
      subtitle="实体与电子档案统一移交：建单 → 管理条目 → 查看移交包 → 下载 → 确认"
    >
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          移交单条目通过「档号/题名自动补全」选择，不需要手工抄档号；电子档案移交额外记录四性检测方案。
        </Alert>

        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
              <Tabs
                value={typeTab}
                onChange={(_e, v: 'ALL' | 'PHYSICAL' | 'ELECTRONIC') => setTypeTab(v)}
              >
                <Tab value="ALL" label={`全部（${allRows.length}）`} />
                <Tab
                  value="PHYSICAL"
                  label={`实体档案（${allRows.filter((r) => (r.bodyJson as TransferBody).transferType === 'PHYSICAL').length}）`}
                />
                <Tab
                  value="ELECTRONIC"
                  label={`电子档案（${allRows.filter((r) => (r.bodyJson as TransferBody).transferType === 'ELECTRONIC').length}）`}
                />
              </Tabs>
              <PermGate domain={DOMAIN} op="WRITE">
                <Button variant="contained" size="small" onClick={openCreate}>
                  + 新增移交单
                </Button>
              </PermGate>
            </Stack>

            {listQuery.isError ? (
              <Alert severity="error">{(listQuery.error as Error).message}</Alert>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>移交单</TableCell>
                    <TableCell>类型</TableCell>
                    <TableCell>接收单位</TableCell>
                    <TableCell align="right">条目数</TableCell>
                    <TableCell>状态</TableCell>
                    <TableCell>创建时间</TableCell>
                    <TableCell align="right">操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <Typography py={4} textAlign="center" color="text.secondary">
                          {listQuery.isLoading ? '加载中…' : '暂无移交单'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((row) => {
                    const body = row.bodyJson as TransferBody;
                    return (
                      <TableRow key={row.id} hover>
                        <TableCell>{row.title}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            color={body.transferType === 'PHYSICAL' ? 'default' : 'info'}
                            label={TYPE_LABEL[body.transferType ?? 'ELECTRONIC']}
                          />
                        </TableCell>
                        <TableCell>{body.targetUnit || '—'}</TableCell>
                        <TableCell align="right">{body.entries?.length ?? 0}</TableCell>
                        <TableCell>
                          <Chip size="small" label={STATUS_LABEL[row.status] ?? row.status} />
                        </TableCell>
                        <TableCell>{new Date(row.createdAt).toLocaleString('zh-CN')}</TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          <Button size="small" onClick={() => setViewing(row)}>
                            查看移交包
                          </Button>
                          <Button size="small" onClick={() => downloadRecord(row)}>
                            下载
                          </Button>
                          {body.transferType === 'ELECTRONIC' && (
                            <Button size="small" onClick={() => setSchemeOpen(true)}>
                              检测方案
                            </Button>
                          )}
                          <Button size="small" onClick={() => openEdit(row)}>
                            管理条目
                          </Button>
                          {row.status !== 'CONFIRMED' && (
                            <PermGate domain={DOMAIN} op="WRITE">
                              <Button
                                size="small"
                                color="success"
                                onClick={() =>
                                  actionMutation.mutate({ id: row.id, action: 'confirm' })
                                }
                              >
                                确认
                              </Button>
                            </PermGate>
                          )}
                          <Button
                            size="small"
                            color="error"
                            onClick={() => removeMutation.mutate(row.id)}
                          >
                            删除
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </Stack>

      {/* 新增 / 编辑（管理条目） */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{editing ? '编辑移交单 / 管理条目' : '新增移交单'}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <TextField
              label="移交单名称"
              size="small"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：2026 年度办公室文书档案移交"
            />
            <Stack direction="row" spacing={2}>
              <TextField
                select
                label="移交类型"
                size="small"
                value={transferType}
                onChange={(e) => setTransferType(e.target.value as 'PHYSICAL' | 'ELECTRONIC')}
                sx={{ width: 200 }}
              >
                <MenuItem value="ELECTRONIC">电子档案</MenuItem>
                <MenuItem value="PHYSICAL">实体档案</MenuItem>
              </TextField>
              <TextField
                label="接收单位 / 接收人"
                size="small"
                value={targetUnit}
                onChange={(e) => setTargetUnit(e.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>
            <TextField
              label="移交原因 / 说明"
              size="small"
              multiline
              minRows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Divider />
            <ItemPicker
              label="移交条目（输入档号或题名检索）"
              value={entries}
              onChange={setEntries}
              fetcher={fetchItems}
              helperText="已选条目会写入移交包；确认后作为交接清单留档"
            />
            <Typography variant="body2" color="text.secondary">
              已选 {entries.length} 条
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button
            variant="contained"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 查看移交包 */}
      <Dialog open={Boolean(viewing)} onClose={() => setViewing(null)} maxWidth="md" fullWidth>
        <DialogTitle>移交包 · {viewing?.title}</DialogTitle>
        <DialogContent dividers>
          {viewing && (
            <Stack spacing={1.5}>
              <Typography variant="body2">
                类型：{TYPE_LABEL[(viewing.bodyJson as TransferBody).transferType ?? 'ELECTRONIC']} ｜
                接收单位：{(viewing.bodyJson as TransferBody).targetUnit || '—'} ｜ 状态：
                {STATUS_LABEL[viewing.status] ?? viewing.status}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                说明：{(viewing.bodyJson as TransferBody).reason || '—'}
              </Typography>
              <Divider />
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>#</TableCell>
                    <TableCell>档号</TableCell>
                    <TableCell>题名</TableCell>
                    <TableCell>年度</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {((viewing.bodyJson as TransferBody).entries ?? []).map((e, idx) => (
                    <TableRow key={e.id}>
                      <TableCell>{idx + 1}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{e.danghao}</TableCell>
                      <TableCell>{e.title}</TableCell>
                      <TableCell>{e.year ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewing(null)}>关闭</Button>
          {viewing && <Button onClick={() => downloadRecord(viewing)}>下载 JSON</Button>}
        </DialogActions>
      </Dialog>

      {/* 检测方案 */}
      <Dialog open={schemeOpen} onClose={() => setSchemeOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>电子档案移交 · 四性检测方案</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1}>
            <Typography variant="body2">真实性：核对电子签名 / 哈希与来源系统记录。</Typography>
            <Typography variant="body2">完整性：校验件数、页数与元数据必填项。</Typography>
            <Typography variant="body2">可用性：抽样打开原文，确认格式可读。</Typography>
            <Typography variant="body2">安全性：病毒扫描 + 密级标识检查。</Typography>
            <Alert severity="info" variant="outlined" sx={{ mt: 1 }}>
              检测执行入口在「系统安全 → 四性检测」；本方案随移交包一并留档。
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSchemeOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
