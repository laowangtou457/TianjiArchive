import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  Pagination,
} from '@mui/material';
import { useParams } from 'react-router-dom';
import { useSnackbar } from 'notistack';
import {
  BORROW_MODE_LABELS,
  ITEM_STATUS_LABELS,
  ITEM_STATUS_VALUES,
  OPEN_SCOPE_LABELS,
  BorrowMode,
  ItemStatus,
  type ElectronicFileDto,
  type ItemDto,
  type MetadataFieldDef,
  type VolumeDto,
} from '@tianji/shared';
import { archiveApi, borrowApi, categoryApi, fileApi } from '../../api';
import { ApiError, api } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { ArchiveNo, SecurityChip } from '../../components/ArchiveNo';
import { FilePreview } from '../../components/FilePreview';
import { FileUploader } from '../../components/FileUploader';
import { MetadataForm, validateForm, type FormValues } from '../../components/MetadataForm';
import { PermGate } from '../../components/PermGate';
import { ViewLogsDialog } from '../../components/ViewLogsDialog';
import { downloadCsv, downloadXml } from '../../utils/exportItems';
import { printCatalog, printItems, printVolume } from '../../utils/printCatalog';

/** 批量修改可选的字段（档号不可改，故不在列表内） */
interface BatchFieldDef {
  key: string;
  label: string;
  type: 'text' | 'date' | 'number' | 'enum';
  options?: Array<{ value: string; label: string }>;
}
const BATCH_FIELDS: BatchFieldDef[] = [
  { key: 'title', label: '题名', type: 'text' },
  { key: 'responsible', label: '责任者', type: 'text' },
  { key: 'docNo', label: '文号', type: 'text' },
  { key: 'docDate', label: '形成日期', type: 'date' },
  { key: 'classNo', label: '分类号', type: 'text' },
  { key: 'note', label: '备注', type: 'text' },
  { key: 'pages', label: '页数', type: 'number' },
  {
    key: 'retention',
    label: '保管期限',
    type: 'enum',
    options: [
      { value: 'PERM', label: '永久' },
      { value: 'Y30', label: '定期 30 年' },
      { value: 'Y10', label: '定期 10 年' },
    ],
  },
  {
    key: 'securityLevel',
    label: '密级',
    type: 'enum',
    options: [
      { value: 'PUBLIC', label: '公开' },
      { value: 'INTERNAL', label: '内部' },
      { value: 'SECRET', label: '秘密' },
    ],
  },
];

interface BatchMutationBody {
  ids: string[];
  patch: Record<string, unknown>;
  mode?: 'set' | 'replace';
  search?: string;
}
interface ReorderMutationBody {
  ids: string[];
  by: 'danghao' | 'title';
  order: 'asc' | 'desc';
}

/**
 * 卷内文件著录（F-04）+ 电子文件挂接（F-08）+ 作废重编（合规唯一通道）。
 *
 * 页面路由：
 *   /catalog/:volumeId → 该卷下的件列表（可新增件、上传文件、预览、归档）
 *   /items/:itemId     → 直接打开某件的详情
 */
export function ItemEditorPage(): ReactElement {
  const { volumeId, itemId } = useParams<{ volumeId?: string; itemId?: string }>();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  // ---------------------------------------------------------------- 数据
  const volumeQuery = useQuery({
    queryKey: ['volume', volumeId],
    queryFn: () => archiveApi.volumeDetail(volumeId as string),
    enabled: Boolean(volumeId),
  });

  // 卷内件列表：服务端分页（每页 50）+ 服务端阶段筛选。
  // ⚠️ 必须走专用端点 volumeItems（/archive/volumes/:id/items）：曾用通用
  // listItems 传 volumeId，但通用接口 controller 不接收该参数，过滤被丢弃，
  // 导致每个案卷都显示同一批全库条目（串卷 bug）。
  const [page, setPage] = useState(1);
  const [stageFilter, setStageFilter] = useState<string>('ALL');
  const PAGE_SIZE = 50;
  const itemsQuery = useQuery({
    queryKey: ['items', volumeId, page, stageFilter],
    queryFn: () =>
      archiveApi.volumeItems(volumeId as string, {
        page,
        size: PAGE_SIZE,
        status: stageFilter === 'ALL' ? undefined : stageFilter,
      }),
    enabled: Boolean(volumeId),
  });

  // 阶段计数：服务端 GROUP BY 全卷统计（服务端分页后不能拿当前页当总数）
  const statsQuery = useQuery({
    queryKey: ['item-stats', volumeId],
    queryFn: () => archiveApi.volumeItemStats(volumeId as string),
    enabled: Boolean(volumeId),
  });

  // 换卷/换筛选时回到第一页，并清空跨页多选
  useEffect(() => {
    setPage(1);
    setCheckedIds([]);
  }, [volumeId, stageFilter]);

  const itemQuery = useQuery({
    queryKey: ['item', itemId],
    queryFn: () => archiveApi.itemDetail(itemId as string),
    enabled: Boolean(itemId),
  });

  const categoryQuery = useQuery({ queryKey: ['categories'], queryFn: () => categoryApi.list() });

  // ---------------------------------------------------------------- 当前编辑的件
  const [selected, setSelected] = useState<ItemDto | null>(null);
  const [formValues, setFormValues] = useState<FormValues>({});
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<ElectronicFileDto[]>([]);
  const [previewFile, setPreviewFile] = useState<ElectronicFileDto | null>(null);
  const [viewLogsFile, setViewLogsFile] = useState<ElectronicFileDto | null>(null);
  const [voidDialog, setVoidDialog] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  // ---------------------------------------------------------------- P5 批量操作 / 导出 / 打印
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchDialog, setBatchDialog] = useState<{ mode: 'set' | 'replace' } | null>(null);
  const [batchField, setBatchField] = useState('title');
  const [batchValue, setBatchValue] = useState('');
  const [batchSearch, setBatchSearch] = useState('');
  const [reorderDialog, setReorderDialog] = useState(false);
  const [reorderBy, setReorderBy] = useState<'danghao' | 'title'>('danghao');
  const [reorderOrder, setReorderOrder] = useState<'asc' | 'desc'>('asc');
  const [exportAnchor, setExportAnchor] = useState<HTMLElement | null>(null);
  const [printAnchor, setPrintAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const it = itemQuery.data ?? null;
    if (it) {
      setSelected(it);
      setFormValues({ ...(it.extra ?? {}), ...it } as unknown as FormValues);
    }
  }, [itemQuery.data]);

  // 文件列表随选中件加载
  useEffect(() => {
    if (!selected) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    fileApi
      .listByItem(selected.id)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  /** 字段定义：按门类过滤 level=ITEM/BOTH */
  const itemFields: MetadataFieldDef[] = useMemo(() => {
    const volume = volumeQuery.data;
    const category = (categoryQuery.data ?? []).find((c) => c.id === volume?.categoryId);
    const schema = category?.fieldSchema ?? [];
    const onlyItem = schema.filter((f) => !f.level || f.level === 'ITEM' || f.level === 'BOTH');
    if (onlyItem.length > 0) return onlyItem;
    // 兜底：至少提供核心字段，保证可著录
    return [
      { key: 'danghao', label: '档号', type: 'string', required: true, core: true, readonly: true, order: 0 },
      { key: 'title', label: '题名', type: 'string', required: true, core: true, order: 1, maxLength: 500 },
      { key: 'responsible', label: '责任者', type: 'string', required: true, core: true, order: 2 },
      { key: 'docNo', label: '文号', type: 'string', required: false, order: 3 },
      { key: 'docDate', label: '文件形成日期', type: 'date', required: true, core: true, order: 4 },
      { key: 'pages', label: '页数', type: 'number', required: false, order: 5 },
      { key: 'keywords', label: '关键词', type: 'tags', required: false, order: 6 },
      { key: 'note', label: '备注', type: 'text', required: false, order: 7 },
    ];
  }, [volumeQuery.data, categoryQuery.data]);

  // ---------------------------------------------------------------- 变更
  const saveMutation = useMutation({
    mutationFn: async (): Promise<ItemDto> => {
      if (!selected) throw new Error('未选中档案');
      return archiveApi.updateItem(selected.id, {
        title: String(formValues.title ?? ''),
        responsible: String(formValues.responsible ?? ''),
        docNo: (formValues.docNo as string) ?? null,
        docDate: String(formValues.docDate ?? ''),
        year: Number(formValues.year ?? new Date().getFullYear()),
        retention: formValues.retention,
        securityLevel: formValues.securityLevel,
        classNo: (formValues.classNo as string) ?? null,
        keywords: Array.isArray(formValues.keywords) ? formValues.keywords : [],
        pages: formValues.pages === undefined || formValues.pages === null ? null : Number(formValues.pages),
        note: (formValues.note as string) ?? null,
        openFlag: formValues.openFlag,
      });
    },
    onSuccess: (it) => {
      enqueueSnackbar('已保存', { variant: 'success' });
      setSelected(it);
      void qc.invalidateQueries({ queryKey: ['items', volumeId] });
      void qc.invalidateQueries({ queryKey: ['item', itemId] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '保存失败', { variant: 'error' }),
  });

  const createMutation = useMutation({
    mutationFn: async (): Promise<ItemDto> => {
      if (!volumeId) throw new Error('缺少案卷');
      return archiveApi.createItemInVolume(volumeId, {
        title: String(formValues.title ?? ''),
        responsible: String(formValues.responsible ?? ''),
        docNo: (formValues.docNo as string) ?? null,
        docDate: String(formValues.docDate ?? new Date().toISOString().slice(0, 10)),
        pages: formValues.pages === undefined || formValues.pages === null ? null : Number(formValues.pages),
        keywords: Array.isArray(formValues.keywords) ? formValues.keywords : [],
        note: (formValues.note as string) ?? null,
      });
    },
    onSuccess: (it) => {
      enqueueSnackbar(`件已创建，档号 ${it.danghao}`, { variant: 'success' });
      setSelected(it);
      setFormValues({ ...(it.extra ?? {}), ...it } as unknown as FormValues);
      void qc.invalidateQueries({ queryKey: ['items', volumeId] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '创建失败', { variant: 'error' }),
  });

  const voidMutation = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error('未选中档案');
      return archiveApi.voidReassign(selected.id, voidReason.trim(), true);
    },
    onSuccess: (r) => {
      enqueueSnackbar(`已作废重编：${r.oldDanghao} → ${r.newDanghao ?? '（未重编）'}`, {
        variant: 'success',
      });
      setVoidDialog(false);
      setVoidReason('');
      void qc.invalidateQueries({ queryKey: ['items', volumeId] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '作废失败', { variant: 'error' }),
  });

  const submitMutation = useMutation({
    mutationFn: (id: string) => archiveApi.stageSubmit([id]),
    onSuccess: () => {
      enqueueSnackbar('已提交审核', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['items', volumeId] });
      void qc.invalidateQueries({ queryKey: ['item', itemId] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '提交失败', { variant: 'error' }),
  });

  // ---------------------------------------------------------------- 阶段流转（对齐泰坦收集链路）
  const [rejectDialog, setRejectDialog] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const stageMutation = useMutation({
    mutationFn: async (args: { action: 'pre' | 'cancelPre' | 'confirm' | 'noArchive' | 'withdrawNoArchive' }) => {
      if (!selected) throw new Error('未选中档案');
      const ids = [selected.id];
      switch (args.action) {
        case 'pre':
          return archiveApi.stagePreArchive(ids);
        case 'cancelPre':
          return archiveApi.stageCancelPreArchive(ids);
        case 'confirm':
          return archiveApi.stageConfirm(ids);
        case 'noArchive':
          return archiveApi.stageNoArchive(ids);
        case 'withdrawNoArchive':
          return archiveApi.stageWithdrawNoArchive(ids);
      }
    },
    onSuccess: (r) => {
      const ok = r?.updated ?? 0;
      const bad = r?.failed ?? [];
      if (ok > 0) enqueueSnackbar(`操作成功（${ok} 件）`, { variant: 'success' });
      if (bad.length > 0) enqueueSnackbar(bad[0].reason, { variant: 'warning' });
      void qc.invalidateQueries({ queryKey: ['items', volumeId] });
      void qc.invalidateQueries({ queryKey: ['item', itemId] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  const rejectMutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('未选中档案');
      return archiveApi.stageReject([selected.id], rejectReason.trim());
    },
    onSuccess: () => {
      enqueueSnackbar('已驳回，条目回到未处理', { variant: 'success' });
      setRejectDialog(false);
      setRejectReason('');
      void qc.invalidateQueries({ queryKey: ['items', volumeId] });
      void qc.invalidateQueries({ queryKey: ['item', itemId] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '驳回失败', { variant: 'error' }),
  });

  // ---------------------------------------------------------------- P5 批量修改 / 替换 / 调序
  const batchMutation = useMutation({
    mutationFn: (body: BatchMutationBody) =>
      api.post<{ requested: number; updated: number; failed: Array<{ id: string; reason: string }> }>(
        '/archive/items/batch-update',
        body,
      ),
    onSuccess: (r) => {
      const bad = r.failed ?? [];
      enqueueSnackbar(
        `批量操作完成：成功 ${r.updated}/${r.requested} 条${bad.length ? `，失败 ${bad.length} 条（${bad[0].reason}）` : ''}`,
        { variant: bad.length ? 'warning' : 'success' },
      );
      setBatchDialog(null);
      setCheckedIds([]);
      void qc.invalidateQueries({ queryKey: ['items', volumeId] });
      void qc.invalidateQueries({ queryKey: ['item-stats', volumeId] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '批量操作失败', { variant: 'error' }),
  });

  const reorderMutation = useMutation({
    mutationFn: (body: ReorderMutationBody) =>
      api.post<{ requested: number; updated: number }>('/archive/items/batch-reorder', body),
    onSuccess: (r) => {
      enqueueSnackbar(`调序完成：已写入 ${r.updated}/${r.requested} 条序号`, { variant: 'success' });
      setReorderDialog(false);
      setCheckedIds([]);
      void qc.invalidateQueries({ queryKey: ['items', volumeId] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '调序失败', { variant: 'error' }),
  });

  // ---------------------------------------------------------------- 流转记录
  const stageLogsQuery = useQuery({
    queryKey: ['stageLogs', selected?.id],
    queryFn: () => archiveApi.stageLogs(selected!.id),
    enabled: Boolean(selected),
  });

  // ---------------------------------------------------------------- 左列阶段筛选
  // 阶段筛选已在服务端完成（queryKey 带 stageFilter），这里直接用返回页
  const filteredItems = itemsQuery.data?.list ?? [];

  // ---------------------------------------------------------------- 申请借阅（检索利用链路入口）
  const [borrowDialog, setBorrowDialog] = useState(false);
  const [borrowForm, setBorrowForm] = useState<{ purpose: string; mode: BorrowMode; expectReturn: string }>({
    purpose: '',
    mode: 'ONLINE',
    expectReturn: '',
  });
  const borrowMutation = useMutation({
    mutationFn: () =>
      borrowApi.create({
        itemId: selected?.id ?? '',
        purpose: borrowForm.purpose,
        mode: borrowForm.mode,
        expectReturn: borrowForm.expectReturn,
      }),
    onSuccess: () => {
      enqueueSnackbar('借阅申请已提交，等待审批', { variant: 'success' });
      setBorrowDialog(false);
      setBorrowForm({ purpose: '', mode: 'ONLINE', expectReturn: '' });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '借阅申请失败', { variant: 'error' }),
  });

  // ---------------------------------------------------------------- 视图
  const volume: VolumeDto | undefined = volumeQuery.data;
  const readOnly = selected?.status === 'ARCHIVED' || selected?.status === 'VOID';

  // 勾选优先：有勾选则针对勾选条目，否则针对当前卷/当前页全部
  const selectedItems = filteredItems.filter((it) => checkedIds.includes(it.id));
  const exportParams =
    checkedIds.length > 0
      ? { ids: checkedIds }
      : { volumeId: volumeId ?? '' };
  const printSource = checkedIds.length > 0 ? selectedItems : filteredItems;
  const fieldOptions = batchDialog?.mode === 'replace'
    ? BATCH_FIELDS.filter((f) => f.type === 'text')
    : BATCH_FIELDS;
  const currentField = BATCH_FIELDS.find((f) => f.key === batchField) ?? BATCH_FIELDS[0];

  const showApiError = (err: unknown, fallback: string): void => {
    enqueueSnackbar(err instanceof ApiError ? err.message : fallback, { variant: 'error' });
  };

  const runExport = (format: 'csv' | 'xml'): void => {
    const task = format === 'xml' ? downloadXml(exportParams) : downloadCsv(exportParams);
    void task.catch((err: unknown) => showApiError(err, '导出失败'));
  };

  const doPrintItems = (): void => {
    if (printSource.length === 0) {
      enqueueSnackbar('当前没有可打印的条目', { variant: 'warning' });
      return;
    }
    printItems(printSource, volume ? `卷内文件目录 · ${volume.danghao}` : '档案条目目录');
  };
  const doPrintVolume = (): void => {
    if (!volume) {
      enqueueSnackbar('未加载案卷信息', { variant: 'warning' });
      return;
    }
    printVolume(volume, printSource);
  };
  const doPrintCatalog = (): void => {
    if (printSource.length === 0) {
      enqueueSnackbar('当前没有可编目的条目', { variant: 'warning' });
      return;
    }
    printCatalog(printSource);
  };

  const doSave = (): void => {
    const errs = validateForm(itemFields, formValues);
    setFormErrors(errs);
    if (Object.keys(errs).length > 0) {
      enqueueSnackbar('请先修正表单错误', { variant: 'warning' });
      return;
    }
    if (selected && selected.status !== 'DRAFT' && selected.status !== 'PRE_ARCHIVED' && selected.status !== 'SUBMITTED') {
      enqueueSnackbar('该状态不可修改（已归档/无需归档/作废条目需先流转回未处理）', { variant: 'warning' });
      return;
    }
    if (selected) saveMutation.mutate();
    else createMutation.mutate();
  };

  return (
    <AppLayout
      title={volumeId ? `卷内文件 · ${volume?.danghao ?? ''}` : `档案详情 · ${selected?.danghao ?? ''}`}
      subtitle={volume ? `${volume.title}（${volume.year} 年，${volume.itemCount} 件）` : '按件著录并挂接电子文件'}
      actions={
        <Stack direction="row" spacing={1}>
          <Button size="small" onClick={() => window.history.back()}>
            返回
          </Button>
          <PermGate domain="ITEM" op="WRITE">
            <Button variant="contained" size="small" onClick={doSave} disabled={readOnly || saveMutation.isPending}>
              {saveMutation.isPending || createMutation.isPending ? '保存中…' : selected ? '保存修改' : '新增件'}
            </Button>
          </PermGate>
        </Stack>
      }
    >
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        {/* 左侧：件列表 */}
        {volumeId && (
          <Card sx={{ width: 300, flex: '0 0 300px' }}>
            <CardContent sx={{ p: 1 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="h6">卷内文件</Typography>
                <Stack direction="row" spacing={0.25}>
                  <PermGate domain="ITEM" op="READ">
                    <Button size="small" onClick={(e) => setExportAnchor(e.currentTarget)}>
                      导出
                    </Button>
                    <Button size="small" onClick={(e) => setPrintAnchor(e.currentTarget)}>
                      打印
                    </Button>
                  </PermGate>
                  <PermGate domain="ITEM" op="WRITE">
                    <Button
                      size="small"
                      onClick={() => {
                        setSelected(null);
                        setFormValues({ docDate: new Date().toISOString().slice(0, 10) });
                        setFormErrors({});
                        setFiles([]);
                      }}
                    >
                      + 新增
                    </Button>
                  </PermGate>
                </Stack>
              </Stack>
              <Divider sx={{ mb: 1 }} />
              {/* 本页全选（跨页请逐页勾选；导出/打印仅作用于已勾选或当前页） */}
              <Box sx={{ display: 'flex', alignItems: 'center', px: 0.25, mb: 0.5 }}>
                <Checkbox
                  size="small"
                  checked={filteredItems.length > 0 && checkedIds.length === filteredItems.length}
                  indeterminate={checkedIds.length > 0 && checkedIds.length < filteredItems.length}
                  disabled={filteredItems.length === 0}
                  onChange={(e) =>
                    setCheckedIds(e.target.checked ? filteredItems.map((it) => it.id) : [])
                  }
                  inputProps={{ 'aria-label': '全选本页条目' }}
                  sx={{ p: 0.25, mr: 0.25 }}
                />
                <Typography variant="caption" color="text.secondary">
                  全选本页（{filteredItems.length}）
                </Typography>
              </Box>
              {/* 阶段筛选（对齐泰坦：未处理/预归档/待审核/已归档/无需归档）
                  计数来自服务端全卷统计（item-stats），跨页准确 */}
              <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
                {['ALL', ...ITEM_STATUS_VALUES].map((s) => {
                  const stats = statsQuery.data ?? {};
                  const count =
                    s === 'ALL'
                      ? Object.values(stats).reduce((a, b) => a + b, 0)
                      : (stats[s] ?? 0);
                  return (
                    <Chip
                      key={s}
                      size="small"
                      clickable
                      color={stageFilter === s ? 'primary' : 'default'}
                      variant={stageFilter === s ? 'filled' : 'outlined'}
                      label={`${s === 'ALL' ? '全部' : ITEM_STATUS_LABELS[s as ItemStatus]} ${count}`}
                      onClick={() => setStageFilter(s)}
                    />
                  );
                })}
              </Stack>
              {filteredItems.length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  {stageFilter === 'ALL' ? '暂无件，点击「+ 新增」开始著录' : '该阶段暂无件'}
                </Typography>
              )}
              {filteredItems.map((it) => (
                <Box
                  key={it.id}
                  onClick={() => {
                    setSelected(it);
                    setFormValues({ ...(it.extra ?? {}), ...it } as unknown as FormValues);
                    setFormErrors({});
                  }}
                  sx={{
                    p: 0.5,
                    mb: 0.5,
                    cursor: 'pointer',
                    borderRadius: 1,
                    bgcolor: selected?.id === it.id ? '#eef2ff' : 'transparent',
                    '&:hover': { bgcolor: '#f7fafc' },
                  }}
                >
                  <Stack direction="row" spacing={0.25} alignItems="flex-start">
                    <Checkbox
                      size="small"
                      checked={checkedIds.includes(it.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        setCheckedIds((prev) =>
                          e.target.checked ? [...prev, it.id] : prev.filter((x) => x !== it.id),
                        )
                      }
                      inputProps={{ 'aria-label': `选择 ${it.danghao}` }}
                      sx={{ p: 0.25 }}
                    />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <ArchiveNo value={it.danghao} />
                        <Chip size="small" label={ITEM_STATUS_LABELS[it.status]} variant="outlined" />
                      </Stack>
                      <Typography variant="caption" noWrap display="block">
                        {it.title}
                      </Typography>
                    </Box>
                  </Stack>
                </Box>
              ))}
              {(itemsQuery.data?.total ?? 0) > PAGE_SIZE && (
                <Stack alignItems="center" sx={{ pt: 1, pb: 0.5, borderTop: '1px solid #e2e8f0' }}>
                  <Pagination
                    size="small"
                    count={Math.ceil((itemsQuery.data?.total ?? 0) / PAGE_SIZE)}
                    page={page}
                    onChange={(_, p) => setPage(p)}
                    color="primary"
                  />
                  <Typography variant="caption" color="text.secondary">
                    共 {itemsQuery.data?.total ?? 0} 件 · 第 {page}/
                    {Math.ceil((itemsQuery.data?.total ?? 0) / PAGE_SIZE)} 页
                  </Typography>
                </Stack>
              )}
            </CardContent>
          </Card>
        )}

        {/* 右侧：著录表单 + 文件 */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Card sx={{ mb: 1.5 }}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
                <Typography variant="h6">{selected ? '件级著录' : '新增件'}</Typography>
                {selected && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <SecurityChip level={selected.securityLevel} />
                    <Chip size="small" label={ITEM_STATUS_LABELS[selected.status]} />
                    {selected.openScope && selected.openScope !== 'NONE' && (
                      <Tooltip title="开放审核结论（P3）：条目开放=目录可查；原文开放=目录与原文均可查">
                        <Chip
                          size="small"
                          variant="outlined"
                          color={selected.openScope === 'FULLTEXT' ? 'success' : 'info'}
                          label={OPEN_SCOPE_LABELS[selected.openScope]}
                        />
                      </Tooltip>
                    )}
                    <PermGate domain="BORROW_APPLY" op="WRITE">
                      <Button size="small" color="primary" variant="outlined" onClick={() => setBorrowDialog(true)}>
                        申请借阅
                      </Button>
                    </PermGate>
                    {selected.status === ItemStatus.DRAFT && (
                      <PermGate domain="ITEM" op="WRITE">
                        <Stack direction="row" spacing={0.5}>
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={stageMutation.isPending}
                            onClick={() => stageMutation.mutate({ action: 'pre' })}
                          >
                            预归档
                          </Button>
                          <Button size="small" disabled={submitMutation.isPending} onClick={() => submitMutation.mutate(selected.id)}>
                            提交审核
                          </Button>
                          <Button
                            size="small"
                            color="inherit"
                            disabled={stageMutation.isPending}
                            onClick={() => stageMutation.mutate({ action: 'noArchive' })}
                          >
                            无需归档
                          </Button>
                        </Stack>
                      </PermGate>
                    )}
                    {selected.status === ItemStatus.PRE_ARCHIVED && (
                      <>
                        <PermGate domain="ITEM" op="WRITE">
                          <Button
                            size="small"
                            disabled={stageMutation.isPending}
                            onClick={() => stageMutation.mutate({ action: 'cancelPre' })}
                          >
                            撤消预归档
                          </Button>
                        </PermGate>
                        <PermGate domain="ITEM" op="WRITE">
                          <Button size="small" disabled={submitMutation.isPending} onClick={() => submitMutation.mutate(selected.id)}>
                            提交审核
                          </Button>
                        </PermGate>
                        <PermGate domain="ARCHIVE_CONFIRM" op="APPROVE">
                          <Button
                            size="small"
                            color="success"
                            variant="contained"
                            disabled={stageMutation.isPending}
                            onClick={() => stageMutation.mutate({ action: 'confirm' })}
                          >
                            确认归档
                          </Button>
                        </PermGate>
                      </>
                    )}
                    {selected.status === ItemStatus.SUBMITTED && (
                      <PermGate domain="ARCHIVE_CONFIRM" op="APPROVE">
                        <Stack direction="row" spacing={0.5}>
                          <Button
                            size="small"
                            color="success"
                            variant="contained"
                            disabled={stageMutation.isPending}
                            onClick={() => stageMutation.mutate({ action: 'confirm' })}
                          >
                            确认归档
                          </Button>
                          <Button size="small" color="warning" onClick={() => setRejectDialog(true)}>
                            不通过
                          </Button>
                        </Stack>
                      </PermGate>
                    )}
                    {selected.status === ItemStatus.NO_ARCHIVE && (
                      <PermGate domain="ITEM" op="WRITE">
                        <Button
                          size="small"
                          disabled={stageMutation.isPending}
                          onClick={() => stageMutation.mutate({ action: 'withdrawNoArchive' })}
                        >
                          撤回未处理
                        </Button>
                      </PermGate>
                    )}
                    <PermGate domain="ITEM" op="WRITE">
                      <Tooltip title="档号不可直接修改，作废后重新取号（全程留痕）">
                        <span>
                          <Button
                            size="small"
                            color="error"
                            disabled={selected.status === 'VOID'}
                            onClick={() => setVoidDialog(true)}
                          >
                            作废重编
                          </Button>
                        </span>
                      </Tooltip>
                    </PermGate>
                  </Stack>
                )}
              </Stack>

              <MetadataForm
                fields={itemFields}
                values={formValues}
                errors={formErrors}
                readOnly={readOnly}
                status={selected?.status}
                danghao={selected?.danghao}
                columns={2}
                onChange={(key, value) => setFormValues((prev) => ({ ...prev, [key]: value }))}
              />
            </CardContent>
          </Card>

          {selected && (
            <Card>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                  <Typography variant="h6">
                    电子文件（{files.length}）
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    入库自动记录 SHA-256；点击文件名在线预览（强制留痕）
                  </Typography>
                </Stack>

                <PermGate domain="FILE" op="WRITE">
                  <Box sx={{ mb: 1.5 }}>
                    <FileUploader
                      itemId={selected.id}
                      onUploaded={(f) => setFiles((prev) => [...prev, f])}
                    />
                  </Box>
                </PermGate>

                <Paper variant="outlined">
                  <Table size="small" className="dense-table">
                    <TableHead>
                      <TableRow>
                        <TableCell>文件名</TableCell>
                        <TableCell width={90}>大小</TableCell>
                        <TableCell width={120}>类型</TableCell>
                        <TableCell width={110}>抽取状态</TableCell>
                        <TableCell width={220}>SHA-256</TableCell>
                        <TableCell width={140}>操作</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {files.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={6} align="center" sx={{ color: 'text.secondary' }}>
                            暂无电子文件
                          </TableCell>
                        </TableRow>
                      )}
                      {files.map((f) => (
                        <TableRow key={f.id}>
                          <TableCell>
                            <Typography
                              component="span"
                              onClick={() => setPreviewFile(f)}
                              sx={{ cursor: 'pointer', color: '#1f359b', '&:hover': { textDecoration: 'underline' } }}
                            >
                              {f.filename}
                            </Typography>
                          </TableCell>
                          <TableCell>{(Number(f.size) / 1024).toFixed(1)} KB</TableCell>
                          <TableCell>{f.previewKind}</TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              variant="outlined"
                              color={f.extractStatus === 'OK' ? 'success' : f.extractStatus === 'FAILED' ? 'error' : 'default'}
                              label={f.extractStatus}
                            />
                          </TableCell>
                          <TableCell>
                            <span className="mono" title={f.sha256}>
                              {f.sha256.slice(0, 20)}…
                            </span>
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={0.5}>
                              <IconButton size="small" onClick={() => setPreviewFile(f)} title="预览">
                                ◉
                              </IconButton>
                              <Button size="small" onClick={() => setViewLogsFile(f)} title="查看记录（谁在何时预览/下载）">
                                记录
                              </Button>
                              <PermGate domain="FILE" op="WRITE">
                                <Button
                                  size="small"
                                  onClick={() => {
                                    void fileApi
                                      .integrityCheck(f.id)
                                      .then((r) =>
                                        enqueueSnackbar(
                                          `完整性 ${r.integrity}；期望 ${r.expectedSha256.slice(0, 12)}… 实际 ${r.actualSha256.slice(0, 12)}…`,
                                          { variant: r.integrity === 'PASS' ? 'success' : 'error' },
                                        ),
                                      )
                                      .catch((err: unknown) =>
                                        enqueueSnackbar(err instanceof ApiError ? err.message : '检测失败', {
                                          variant: 'error',
                                        }),
                                      );
                                  }}
                                >
                                  校验
                                </Button>
                              </PermGate>
                              <PermGate domain="FILE" op="DELETE">
                                <Button
                                  size="small"
                                  color="error"
                                  onClick={() => {
                                    void fileApi.remove(f.id).then(() => {
                                      setFiles((prev) => prev.filter((x) => x.id !== f.id));
                                      enqueueSnackbar('文件已删除', { variant: 'success' });
                                    });
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
                </Paper>
              </CardContent>
            </Card>
          )}

          {/* 阶段流转记录（全程留痕） */}
          {selected && (stageLogsQuery.data?.length ?? 0) > 0 && (
            <Card sx={{ mt: 1.5 }}>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  流转记录
                </Typography>
                <Stack spacing={0.5}>
                  {stageLogsQuery.data!.map((log) => (
                    <Stack key={log.id} direction="row" spacing={1} alignItems="center">
                      <Typography variant="caption" color="text.secondary" width={170}>
                        {new Date(log.createdAt).toLocaleString('zh-CN')}
                      </Typography>
                      <Chip size="small" variant="outlined" label={log.actionLabel} />
                      <Typography variant="caption">
                        {log.fromStatus ? `${ITEM_STATUS_LABELS[log.fromStatus]} → ${ITEM_STATUS_LABELS[log.toStatus]}` : ITEM_STATUS_LABELS[log.toStatus]}
                        {log.reason ? `（${log.reason}）` : ''}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {log.operatorName ?? ''}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          )}
        </Box>
      </Stack>

      {/* 预览弹窗 */}
      <FilePreview file={previewFile} open={Boolean(previewFile)} onClose={() => setPreviewFile(null)} allowDownload={false} />
      <ViewLogsDialog file={viewLogsFile} open={Boolean(viewLogsFile)} onClose={() => setViewLogsFile(null)} />

      {/* 作废重编 */}
      <Dialog open={voidDialog} onClose={() => setVoidDialog(false)} maxWidth="sm">
        <DialogTitle>作废重编（档号唯一变更通道）</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            作废后原档号会标记为作废并保留历史，新档号将按当前规则重新生成；本操作全程写入操作日志，不可撤销。
          </Alert>
          <TextField
            label="作废原因 *"
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            fullWidth
            multiline
            minRows={3}
            helperText="至少 5 个字，将记入审计日志"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setVoidDialog(false)}>取消</Button>
          <Button
            color="error"
            variant="contained"
            disabled={voidReason.trim().length < 5 || voidMutation.isPending}
            onClick={() => voidMutation.mutate()}
          >
            确认作废并重编
          </Button>
        </DialogActions>
      </Dialog>

      {/* 审核不通过（驳回原因必填，写入流转记录） */}
      <Dialog open={rejectDialog} onClose={() => setRejectDialog(false)} maxWidth="sm">
        <DialogTitle>审核不通过 · {selected?.danghao ?? ''}</DialogTitle>
        <DialogContent>
          <TextField
            label="不通过原因 *"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            fullWidth
            multiline
            minRows={3}
            sx={{ mt: 1 }}
            helperText="条目将回到「未处理」，原因记入流转记录与审计日志"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectDialog(false)}>取消</Button>
          <Button
            color="warning"
            variant="contained"
            disabled={rejectReason.trim().length < 2 || rejectMutation.isPending}
            onClick={() => rejectMutation.mutate()}
          >
            确认驳回
          </Button>
        </DialogActions>
      </Dialog>

      {/* 申请借阅 */}
      <Dialog open={borrowDialog} onClose={() => setBorrowDialog(false)} maxWidth="sm">
        <DialogTitle>申请借阅 · {selected?.danghao ?? ''}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1, minWidth: 380 }}>
            <TextField
              label="借阅事由 *"
              value={borrowForm.purpose}
              onChange={(e) => setBorrowForm({ ...borrowForm, purpose: e.target.value })}
              multiline
              minRows={2}
              helperText="将随申请单送审批人留存"
            />
            <TextField
              select
              label="借阅方式"
              value={borrowForm.mode}
              onChange={(e) => setBorrowForm({ ...borrowForm, mode: e.target.value as BorrowMode })}
              SelectProps={{ native: true }}
            >
              {Object.entries(BORROW_MODE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </TextField>
            <TextField
              label="期望归还日期 *"
              type="date"
              value={borrowForm.expectReturn}
              onChange={(e) => setBorrowForm({ ...borrowForm, expectReturn: e.target.value })}
              InputLabelProps={{ shrink: true }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBorrowDialog(false)}>取消</Button>
          <Button
            variant="contained"
            disabled={borrowForm.purpose.trim().length < 2 || !borrowForm.expectReturn || borrowMutation.isPending}
            onClick={() => borrowMutation.mutate()}
          >
            提交申请
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---------------------------------------------------------- P5 批量操作浮动栏 */}
      {checkedIds.length > 0 && (
        <Paper
          elevation={6}
          sx={{
            position: 'fixed',
            left: '50%',
            bottom: 24,
            transform: 'translateX(-50%)',
            zIndex: 1300,
            px: 2,
            py: 1,
            maxWidth: '92vw',
            overflowX: 'auto',
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" noWrap>
              已选 {checkedIds.length} 条
            </Typography>
            <Divider orientation="vertical" flexItem />
            <PermGate domain="ITEM" op="WRITE">
              <Button
                size="small"
                onClick={() => {
                  setBatchValue('');
                  setBatchSearch('');
                  setBatchDialog({ mode: 'set' });
                }}
              >
                批量修改
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setBatchValue('');
                  setBatchSearch('');
                  setBatchDialog({ mode: 'replace' });
                }}
              >
                批量替换
              </Button>
              <Button size="small" onClick={() => setReorderDialog(true)}>
                调序
              </Button>
              <Button
                size="small"
                onClick={() =>
                  enqueueSnackbar('批量著录暂未提供：请点击「+ 新增」逐件著录，后续将支持表格粘贴批量著录', {
                    variant: 'info',
                  })
                }
              >
                批量插入
              </Button>
            </PermGate>
            <Button size="small" onClick={() => runExport('csv')}>
              导出 CSV
            </Button>
            <Button size="small" onClick={doPrintItems}>
              打印所选
            </Button>
            <Button size="small" color="inherit" onClick={() => setCheckedIds([])}>
              清空
            </Button>
          </Stack>
        </Paper>
      )}

      {/* 导出菜单 */}
      <Menu anchorEl={exportAnchor} open={Boolean(exportAnchor)} onClose={() => setExportAnchor(null)}>
        <MenuItem
          onClick={() => {
            setExportAnchor(null);
            runExport('csv');
          }}
        >
          导出 CSV（Excel，UTF-8 BOM）
        </MenuItem>
        <MenuItem
          onClick={() => {
            setExportAnchor(null);
            runExport('xml');
          }}
        >
          导出 XML
        </MenuItem>
      </Menu>

      {/* 打印菜单 */}
      <Menu anchorEl={printAnchor} open={Boolean(printAnchor)} onClose={() => setPrintAnchor(null)}>
        <MenuItem
          onClick={() => {
            setPrintAnchor(null);
            doPrintItems();
          }}
        >
          打印条目目录
        </MenuItem>
        <MenuItem
          onClick={() => {
            setPrintAnchor(null);
            doPrintVolume();
          }}
        >
          打印卷内目录（含卷封）
        </MenuItem>
        <MenuItem
          onClick={() => {
            setPrintAnchor(null);
            doPrintCatalog();
          }}
        >
          打印编目清册（含分类统计）
        </MenuItem>
      </Menu>

      {/* 批量修改 / 替换 */}
      <Dialog
        open={Boolean(batchDialog)}
        onClose={() => setBatchDialog(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{batchDialog?.mode === 'replace' ? '批量替换字段值' : '批量修改字段'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info">
              将对已选 {checkedIds.length} 条记录执行
              {batchDialog?.mode === 'replace' ? '查找替换（仅文本字段生效）' : '统一赋值'}；档号不可修改。
            </Alert>
            {batchDialog?.mode === 'replace' && (
              <TextField
                label="查找值（子串匹配）"
                value={batchSearch}
                onChange={(e) => setBatchSearch(e.target.value)}
                fullWidth
                helperText="在选定字段中查找该值，并替换为下方新值"
              />
            )}
            <TextField
              select
              label="字段"
              value={batchField}
              onChange={(e) => {
                setBatchField(e.target.value);
                setBatchValue('');
              }}
              fullWidth
            >
              {fieldOptions.map((f) => (
                <MenuItem key={f.key} value={f.key}>
                  {f.label}
                </MenuItem>
              ))}
            </TextField>
            {currentField.type === 'enum' ? (
              <TextField
                select
                label="新值"
                value={batchValue}
                onChange={(e) => setBatchValue(e.target.value)}
                fullWidth
              >
                {(currentField.options ?? []).map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <TextField
                label="新值"
                type={currentField.type === 'number' ? 'number' : currentField.type === 'date' ? 'date' : 'text'}
                value={batchValue}
                onChange={(e) => setBatchValue(e.target.value)}
                fullWidth
                InputLabelProps={currentField.type === 'date' ? { shrink: true } : undefined}
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBatchDialog(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={
              batchMutation.isPending ||
              (batchDialog?.mode === 'replace' && batchSearch.trim() === '')
            }
            onClick={() => {
              const mode = batchDialog?.mode ?? 'set';
              const value =
                currentField.type === 'number'
                  ? batchValue === ''
                    ? null
                    : Number(batchValue)
                  : batchValue;
              batchMutation.mutate({
                ids: checkedIds,
                patch: { [batchField]: value },
                ...(mode === 'replace' ? { mode, search: batchSearch } : {}),
              });
            }}
          >
            确认{batchDialog?.mode === 'replace' ? '替换' : '修改'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 批量调序 */}
      <Dialog open={reorderDialog} onClose={() => setReorderDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle>批量调序（已选 {checkedIds.length} 条）</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info">
              按选定字段排序后批量写回序号（存入条目扩展字段 sortNo，物理表无独立列）。
            </Alert>
            <TextField
              select
              label="排序依据"
              value={reorderBy}
              onChange={(e) => setReorderBy(e.target.value as 'danghao' | 'title')}
              fullWidth
            >
              <MenuItem value="danghao">档号</MenuItem>
              <MenuItem value="title">题名</MenuItem>
            </TextField>
            <TextField
              select
              label="顺序"
              value={reorderOrder}
              onChange={(e) => setReorderOrder(e.target.value as 'asc' | 'desc')}
              fullWidth
            >
              <MenuItem value="asc">升序</MenuItem>
              <MenuItem value="desc">降序</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReorderDialog(false)}>取消</Button>
          <Button
            variant="contained"
            disabled={reorderMutation.isPending}
            onClick={() =>
              reorderMutation.mutate({ ids: checkedIds, by: reorderBy, order: reorderOrder })
            }
          >
            确认调序
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
