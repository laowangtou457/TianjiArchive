import { useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TablePagination,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import {
  ITEM_STATUS_LABELS,
  type ItemDto,
  type ItemStatus,
} from '@tianji/shared';
import { archiveApi } from '../../api';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';
import { exportItems } from '../../utils/exportItems';
import { printItems } from '../../utils/printCatalog';

/**
 * 未归文件搜集（对齐泰坦「收集 → 文书文件 / 照片 / 录音 / 录像 / 电子文件」）。
 *
 * 数据模型直接复用 archive_item 的归档阶段，而不是另建一张「暂存表」：
 *   DRAFT 未处理 → PRE_ARCHIVED 预归档 → SUBMITTED 待审核 → ARCHIVED 已归档
 *   NO_ARCHIVE 无需归档（旁路，可撤回）
 *
 * 这样「搜集」与「著录」看到的是同一份数据，不会出现两边状态对不上。
 * 门类页签按 category_code 过滤（文书/照片/录音/录像/电子）。
 */

interface CategoryTab {
  code: string;
  label: string;
}

/** 与泰坦 typecode 对齐的门类编码 */
const CATEGORY_TABS: CategoryTab[] = [
  { code: '', label: '全部' },
  { code: 'WSWG', label: '文书文件' },
  { code: 'ZPWG', label: '照片文件' },
  { code: 'LYWG', label: '录音文件' },
  { code: 'LXWG', label: '录像文件' },
  { code: 'WSDW', label: '电子文件' },
];

interface StatusTab {
  key: ItemStatus;
  label: string;
}

const STATUS_TABS: StatusTab[] = [
  { key: 'DRAFT', label: '未处理' },
  { key: 'PRE_ARCHIVED', label: '预归档' },
  { key: 'SUBMITTED', label: '待审核' },
  { key: 'ARCHIVED', label: '已归档' },
  { key: 'NO_ARCHIVE', label: '无需归档' },
];

const PAGE_SIZES = [20, 50, 100];

export function CollectionStagingPage(): ReactElement {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [categoryCode, setCategoryCode] = useState<string>('');
  const [statusTab, setStatusTab] = useState<ItemStatus>('DRAFT');
  const [keyword, setKeyword] = useState<string>('');
  const [keywordInput, setKeywordInput] = useState<string>('');
  const [page, setPage] = useState<number>(0);
  const [size, setSize] = useState<number>(20);
  const [selected, setSelected] = useState<string[]>([]);

  const listQuery = useQuery({
    queryKey: ['staging-items', categoryCode, statusTab, keyword, page, size],
    queryFn: () =>
      archiveApi.listItems({
        page: page + 1,
        size,
        status: statusTab,
        keyword: keyword || undefined,
        categoryCode: categoryCode || undefined,
      }),
  });

  const rows = useMemo(() => listQuery.data?.list ?? [], [listQuery.data]);
  const total = listQuery.data?.total ?? 0;

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['staging-items'] });
    void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    setSelected([]);
  };

  const stageMutation = useMutation({
    mutationFn: async ({ action, ids }: { action: string; ids: string[] }) => {
      switch (action) {
        case 'pre-archive':
          return archiveApi.stagePreArchive(ids);
        case 'cancel-pre-archive':
          return archiveApi.stageCancelPreArchive(ids);
        case 'submit':
          return archiveApi.stageSubmit(ids);
        case 'confirm':
          return archiveApi.stageConfirm(ids);
        case 'no-archive':
          return archiveApi.stageNoArchive(ids);
        case 'withdraw-no-archive':
          return archiveApi.stageWithdrawNoArchive(ids);
        default:
          throw new Error(`未知操作：${action}`);
      }
    },
    onSuccess: (_res, vars) => {
      enqueueSnackbar(`已处理 ${vars.ids.length} 条`, { variant: 'success' });
      refresh();
    },
    onError: (err: unknown) =>
      enqueueSnackbar((err as Error).message || '操作失败', { variant: 'error' }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await archiveApi.deleteItem(id);
      return ids.length;
    },
    onSuccess: (n) => {
      enqueueSnackbar(`已移入回收站 ${n} 条`, { variant: 'success' });
      refresh();
    },
    onError: (err: unknown) => enqueueSnackbar((err as Error).message || '删除失败', { variant: 'error' }),
  });

  const allChecked = useMemo(
    () => rows.length > 0 && rows.every((r) => selected.includes(r.id)),
    [rows, selected],
  );

  const toggleAll = (): void => {
    setSelected(allChecked ? [] : rows.map((r) => r.id));
  };

  const toggleOne = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const rowActions = (row: ItemDto): Array<{ label: string; action: string }> => {
    switch (row.status) {
      case 'DRAFT':
        return [
          { label: '预归档', action: 'pre-archive' },
          { label: '无需归档', action: 'no-archive' },
        ];
      case 'PRE_ARCHIVED':
        return [
          { label: '提交审核', action: 'submit' },
          { label: '撤销预归档', action: 'cancel-pre-archive' },
        ];
      case 'SUBMITTED':
        return [{ label: '确认归档', action: 'confirm' }];
      case 'NO_ARCHIVE':
        return [{ label: '撤回未处理', action: 'withdraw-no-archive' }];
      default:
        return [];
    }
  };

  return (
    <AppLayout
      title="未归文件搜集"
      subtitle="文件进馆后的第一站：未处理 → 预归档 → 待审核 → 已归档；也可标记无需归档"
      actions={
        <Stack direction="row" spacing={1}>
          <Button size="small" onClick={() => navigate('/import')}>
            批量导入
          </Button>
          <Button size="small" variant="contained" onClick={() => navigate('/catalog')}>
            去著录
          </Button>
        </Stack>
      }
    >
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          本页按归档阶段筛选条目。门类页签对应泰坦的「文书 / 照片 / 录音 / 录像 / 电子文件」；
          条目的门类由著录时的分类号决定，未设置门类的条目只在「全部」中出现。
        </Alert>

        <Card>
          <CardContent>
            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" mb={1}>
              <Tabs
                value={categoryCode}
                onChange={(_e, v: string) => {
                  setCategoryCode(v);
                  setPage(0);
                  setSelected([]);
                }}
                variant="scrollable"
                scrollButtons="auto"
                sx={{ minHeight: 36 }}
              >
                {CATEGORY_TABS.map((c) => (
                  <Tab key={c.code || 'all'} value={c.code} label={c.label} sx={{ minHeight: 36 }} />
                ))}
              </Tabs>
              <Box sx={{ flex: 1 }} />
              <TextField
                size="small"
                placeholder="档号 / 题名 / 责任者"
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setKeyword(keywordInput.trim());
                    setPage(0);
                  }
                }}
                sx={{ width: 220 }}
              />
              <Button
                size="small"
                onClick={() => {
                  setKeyword(keywordInput.trim());
                  setPage(0);
                }}
              >
                检索
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setKeywordInput('');
                  setKeyword('');
                  setPage(0);
                }}
              >
                重置
              </Button>
            </Stack>

            <Tabs
              value={statusTab}
              onChange={(_e, v: ItemStatus) => {
                setStatusTab(v);
                setPage(0);
                setSelected([]);
              }}
              sx={{ borderBottom: 1, borderColor: 'divider', mb: 1 }}
            >
              {STATUS_TABS.map((t) => (
                <Tab key={t.key} value={t.key} label={t.label} />
              ))}
            </Tabs>

            <Stack direction="row" spacing={1} alignItems="center" mb={1} flexWrap="wrap">
              <Typography variant="body2" color="text.secondary">
                当前页签共 <strong>{total}</strong> 条
              </Typography>
              <Box sx={{ flex: 1 }} />
              <PermGate domain="ITEM" op="WRITE">
                <Button
                  size="small"
                  disabled={selected.length === 0}
                  onClick={() => {
                    const action =
                      statusTab === 'DRAFT'
                        ? 'pre-archive'
                        : statusTab === 'PRE_ARCHIVED'
                          ? 'submit'
                          : statusTab === 'SUBMITTED'
                            ? 'confirm'
                            : statusTab === 'NO_ARCHIVE'
                              ? 'withdraw-no-archive'
                              : '';
                    if (!action) return;
                    stageMutation.mutate({ action, ids: selected });
                  }}
                >
                  批量{statusTab === 'DRAFT' ? '预归档' : statusTab === 'SUBMITTED' ? '确认归档' : '流转'}
                  {selected.length > 0 ? `（${selected.length}）` : ''}
                </Button>
                <Button
                  size="small"
                  color="error"
                  disabled={selected.length === 0}
                  onClick={() => deleteMutation.mutate(selected)}
                >
                  删除
                </Button>
              </PermGate>
              <Button
                size="small"
                onClick={() => void exportItems({ keyword: keyword || undefined, status: statusTab }, 'csv')}
              >
                导出 CSV
              </Button>
              <Button size="small" onClick={() => printItems(rows)}>
                打印
              </Button>
            </Stack>

            {listQuery.isError ? (
              <Alert severity="error">{(listQuery.error as Error).message}</Alert>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox">
                      <Checkbox checked={allChecked} indeterminate={selected.length > 0 && !allChecked} onChange={toggleAll} />
                    </TableCell>
                    <TableCell>档号</TableCell>
                    <TableCell>题名</TableCell>
                    <TableCell>责任者</TableCell>
                    <TableCell>年度</TableCell>
                    <TableCell>密级</TableCell>
                    <TableCell>状态</TableCell>
                    <TableCell align="right">操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8}>
                        <Box py={4} textAlign="center" color="text.secondary">
                          {listQuery.isLoading ? '加载中…' : `「${ITEM_STATUS_LABELS[statusTab]}」下暂无文件`}
                        </Box>
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((row) => (
                    <TableRow key={row.id} hover>
                      <TableCell padding="checkbox">
                        <Checkbox checked={selected.includes(row.id)} onChange={() => toggleOne(row.id)} />
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{row.danghao}</TableCell>
                      <TableCell>
                        <Button
                          size="small"
                          sx={{ textTransform: 'none', textAlign: 'left', p: 0, minWidth: 0 }}
                          onClick={() => navigate(`/items/${row.id}`)}
                        >
                          {row.title}
                        </Button>
                      </TableCell>
                      <TableCell>{row.responsible ?? '—'}</TableCell>
                      <TableCell>{row.year}</TableCell>
                      <TableCell>{row.securityLevel}</TableCell>
                      <TableCell>
                        <Chip size="small" label={ITEM_STATUS_LABELS[row.status]} />
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        <Button size="small" onClick={() => navigate(`/items/${row.id}`)}>
                          {row.status === 'DRAFT' ? '著录' : '编辑'}
                        </Button>
                        {rowActions(row).map((a) => (
                          <Button
                            key={a.action}
                            size="small"
                            onClick={() => stageMutation.mutate({ action: a.action, ids: [row.id] })}
                          >
                            {a.label}
                          </Button>
                        ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <TablePagination
              component="div"
              count={total}
              page={page}
              onPageChange={(_e, p) => setPage(p)}
              rowsPerPage={size}
              onRowsPerPageChange={(e) => {
                setSize(Number.parseInt(e.target.value, 10));
                setPage(0);
              }}
              rowsPerPageOptions={PAGE_SIZES}
              labelRowsPerPage="每页"
            />
          </CardContent>
        </Card>
      </Stack>
    </AppLayout>
  );
}
