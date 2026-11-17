import { useEffect, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Pagination,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { AuditLogDto, ElectronicFileDto } from '@tianji/shared';
import { fileApi } from '../api';
import { ApiError } from '../api/client';

const PAGE_SIZE = 20;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 文件查看记录弹窗：展示该电子文件被谁、何时预览/下载（强制留痕的审计记录），
 * 支持导出 CSV。数据源为 audit_log（objectType=ELECTRONIC_FILE）。
 */
export function ViewLogsDialog(props: {
  file: ElectronicFileDto | null;
  open: boolean;
  onClose: () => void;
}): ReactElement {
  const { file, open, onClose } = props;
  const [page, setPage] = useState(1);
  const { enqueueSnackbar } = useSnackbar();

  // 换文件回到第一页
  useEffect(() => {
    setPage(1);
  }, [file?.id]);

  const logsQuery = useQuery({
    queryKey: ['file-view-logs', file?.id, page],
    queryFn: () => fileApi.viewLogs(file!.id, { page, size: PAGE_SIZE }),
    enabled: open && Boolean(file),
  });

  const rows = (logsQuery.data?.list ?? []) as AuditLogDto[];
  const total = logsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const doExport = async (): Promise<void> => {
    if (!file) return;
    try {
      await fileApi.exportViewLogs(file.id, `${file.filename}-查看记录.csv`);
      enqueueSnackbar('查看记录导出已开始下载', { variant: 'success' });
    } catch (err) {
      enqueueSnackbar(err instanceof ApiError ? err.message : '导出失败', { variant: 'error' });
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>查看记录 · {file?.filename ?? ''}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          共 {total} 条留痕（含在线预览与下载）。本弹窗的打开与导出行为本身同样写入审计日志。
        </Typography>

        {logsQuery.isLoading && (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        )}

        {logsQuery.isError && (
          <Alert severity="warning">
            {logsQuery.error instanceof ApiError ? logsQuery.error.message : '加载查看记录失败'}
          </Alert>
        )}

        {!logsQuery.isLoading && !logsQuery.isError && (
          <>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width={170}>时间</TableCell>
                  <TableCell width={130}>操作人</TableCell>
                  <TableCell width={90}>动作</TableCell>
                  <TableCell width={90}>结果</TableCell>
                  <TableCell width={130}>IP</TableCell>
                  <TableCell>耗时</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} align="center" sx={{ color: 'text.secondary' }}>
                      暂无查看记录（该文件尚未被预览或下载）
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{fmtTime(r.createdAt)}</TableCell>
                    <TableCell>{r.username ?? r.userId ?? '—'}</TableCell>
                    <TableCell>{r.action === 'DOWNLOAD' ? '下载' : '在线预览'}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={r.result === 'SUCCESS' ? 'success' : r.result === 'DENIED' ? 'warning' : 'error'}
                        label={r.result}
                      />
                    </TableCell>
                    <TableCell>{r.ip ?? '—'}</TableCell>
                    <TableCell>{r.durationMs != null ? `${r.durationMs} ms` : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {total > PAGE_SIZE && (
              <Stack alignItems="center" sx={{ pt: 1.5 }}>
                <Pagination size="small" count={totalPages} page={page} onChange={(_, p) => setPage(p)} />
              </Stack>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void doExport()} disabled={rows.length === 0}>
          导出 CSV
        </Button>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
