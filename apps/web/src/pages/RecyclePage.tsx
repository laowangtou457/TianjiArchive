import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import type { RecycleBinDto } from '@tianji/shared';
import { recycleApi } from '../api';
import { ApiError } from '../api/client';
import { AppLayout } from '../components/AppLayout';
import { PermGate } from '../components/PermGate';

/** 对象类型中文 */
const OBJECT_TYPE_LABEL: Record<string, string> = {
  VOLUME: '案卷',
  ITEM: '文件',
  FILE: '电子文件',
};

/** 剩余天数（可为负 = 已过期待清理） */
function daysLeft(purgeAfter: string): number {
  const end = new Date(purgeAfter).getTime();
  if (Number.isNaN(end)) return 0;
  return Math.ceil((end - Date.now()) / 86400000);
}

/**
 * 回收站页（F-18）。
 *
 * 软删除对象的保留期由后端参数 `recycle.retention_days` 决定（此处展示每条记录的实际到期日），
 * 期间可还原（还原时校验档号是否被重新占用）；
 * 超期由每日 04:00 的定时任务物理清理，也支持手动立即清除。
 */
export function RecyclePage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [objectType, setObjectType] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [size, setSize] = useState<number>(20);
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['recycle', objectType, page, size],
    queryFn: () =>
      recycleApi.list({
        page,
        size,
        objectType: objectType || undefined,
      } as Record<string, unknown>),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => recycleApi.restore(id),
    onSuccess: () => {
      enqueueSnackbar('已还原到原位置', { variant: 'success' });
      setError(null);
      void qc.invalidateQueries({ queryKey: ['recycle'] });
      void qc.invalidateQueries({ queryKey: ['archive-items'] });
      void qc.invalidateQueries({ queryKey: ['archive-volumes'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : '还原失败（档号可能已被占用）');
    },
  });

  const purgeMutation = useMutation({
    mutationFn: (id: string) => recycleApi.purge(id),
    onSuccess: () => {
      enqueueSnackbar('已永久删除（不可恢复）', { variant: 'warning' });
      setError(null);
      void qc.invalidateQueries({ queryKey: ['recycle'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : '清除失败');
    },
  });

  const rows: RecycleBinDto[] = listQuery.data?.list ?? [];
  const total: number = listQuery.data?.total ?? 0;

  return (
    <AppLayout
      title="回收站"
      subtitle="软删除对象在保留期内可还原 · 超期自动物理清理（每日 04:00）· 保留天数见各记录到期时间"
      actions={
        <Stack direction="row" spacing={1}>
          <TextField
            select
            size="small"
            label="对象类型"
            value={objectType}
            onChange={(e) => {
              setObjectType(e.target.value);
              setPage(1);
            }}
            sx={{ width: 130 }}
          >
            <MenuItem value="">全部</MenuItem>
            <MenuItem value="VOLUME">案卷</MenuItem>
            <MenuItem value="ITEM">文件</MenuItem>
            <MenuItem value="FILE">电子文件</MenuItem>
          </TextField>
        </Stack>
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
                <TableCell width={100}>类型</TableCell>
                <TableCell>对象</TableCell>
                <TableCell width={120}>删除人</TableCell>
                <TableCell width={150}>删除时间</TableCell>
                <TableCell width={150}>清理时间</TableCell>
                <TableCell width={110}>剩余</TableCell>
                <TableCell width={150}>操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {listQuery.isLoading && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                    加载中…
                  </TableCell>
                </TableRow>
              )}
              {!listQuery.isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    回收站为空
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => {
                const left = daysLeft(r.purgeAfter);
                return (
                  <TableRow key={r.id} hover>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={OBJECT_TYPE_LABEL[r.objectType] ?? r.objectType}
                        sx={{ height: 18 }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" className="mono">
                        {r.objectLabel ?? r.objectId}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">{r.deletedByName ?? r.deletedBy ?? '—'}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" className="mono">
                        {r.deletedAt?.slice(0, 19).replace('T', ' ')}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" className="mono">
                        {r.purgeAfter?.slice(0, 19).replace('T', ' ')}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={left <= 0 ? 'error' : left <= 3 ? 'warning' : 'default'}
                        label={left <= 0 ? '待清理' : `${left} 天`}
                        sx={{ height: 18 }}
                      />
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5}>
                        <PermGate domain="RECYCLE" op="WRITE">
                          <Button
                            size="small"
                            disabled={!r.canRestore || restoreMutation.isPending}
                            onClick={() => restoreMutation.mutate(r.id)}
                          >
                            还原
                          </Button>
                        </PermGate>
                        <PermGate domain="RECYCLE" op="DELETE">
                          <Button
                            size="small"
                            color="error"
                            disabled={purgeMutation.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `确认永久删除「${r.objectLabel ?? r.objectId}」？该操作不可恢复。`,
                                )
                              ) {
                                purgeMutation.mutate(r.id);
                              }
                            }}
                          >
                            彻底删除
                          </Button>
                        </PermGate>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              提示：还原因档号被占用而失败时，请先在著录中处理冲突档号（作废或重编）后再还原。
            </Typography>
          </Box>

          <TablePagination
            component="div"
            count={total}
            page={page - 1}
            rowsPerPage={size}
            rowsPerPageOptions={[10, 20, 50]}
            onPageChange={(_e, p) => setPage(p + 1)}
            onRowsPerPageChange={(e) => {
              setSize(Number(e.target.value));
              setPage(1);
            }}
            labelRowsPerPage="每页"
            labelDisplayedRows={({ from, to, count }) => `${from}-${to} / 共 ${count} 条`}
          />
        </CardContent>
      </Card>
    </AppLayout>
  );
}
