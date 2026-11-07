import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  LinearProgress,
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
import type { BackupRecordDto } from '@tianji/shared';
import { backupApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

/** 备份范围说明 */
const SCOPE_OPTIONS: Array<{ value: 'full' | 'db' | 'minio' | 'meta'; label: string; hint: string }> = [
  { value: 'full', label: '全量备份', hint: '数据库 + 对象存储' },
  { value: 'db', label: '仅数据库', hint: 'pg_dump 逻辑备份' },
  { value: 'minio', label: '仅对象存储', hint: 'MinIO 桶镜像同步' },
  { value: 'meta', label: '仅元数据', hint: '统计快照（无容器时的兜底）' },
];

/** 状态颜色 */
const STATUS_COLOR: Record<string, 'success' | 'warning' | 'error'> = {
  OK: 'success',
  RUNNING: 'warning',
  FAILED: 'error',
};

/** 状态中文 */
const STATUS_LABEL: Record<string, string> = {
  OK: '成功',
  RUNNING: '进行中',
  FAILED: '失败',
};

/** 字节格式化 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/**
 * 备份与恢复页（F-11）。
 *
 * 设计要点：
 *   1. 备份通过 BullMQ 异步执行（archive-backup 队列），页面只负责触发与查看；
 *   2. 无容器环境下「全量」会降级为元数据快照并明确提示，避免给人虚假安全感；
 *   3. 「恢复校验」只做可达性/完整性三项检查并给出恢复指引，不执行破坏性操作。
 */
export function BackupPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [scope, setScope] = useState<'full' | 'db' | 'minio' | 'meta'>('full');
  const [page, setPage] = useState<number>(1);
  const [size, setSize] = useState<number>(20);
  const [error, setError] = useState<string | null>(null);
  const [verifyTarget, setVerifyTarget] = useState<BackupRecordDto | null>(null);

  const listQuery = useQuery({
    queryKey: ['backups', page, size],
    queryFn: () => backupApi.list({ page, size }),
    refetchInterval: (q) => {
      // 有 RUNNING 记录时 5s 轮询
      const data = q.state.data as { list?: BackupRecordDto[] } | undefined;
      const hasRunning = (data?.list ?? []).some((r) => r.status === 'RUNNING');
      return hasRunning ? 5000 : false;
    },
  });

  const rateQuery = useQuery({
    queryKey: ['backup-rate'],
    queryFn: () => backupApi.successRate(),
  });

  const runMutation = useMutation({
    mutationFn: () => backupApi.run(scope),
    onSuccess: (r) => {
      enqueueSnackbar(
        r.status === 'RUNNING'
          ? '备份任务已入队，执行完成后此处会自动刷新'
          : `备份完成：${STATUS_LABEL[r.status] ?? r.status}`,
        { variant: r.status === 'FAILED' ? 'error' : 'success' },
      );
      void qc.invalidateQueries({ queryKey: ['backups'] });
      void qc.invalidateQueries({ queryKey: ['backup-rate'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (id: string) => backupApi.verifyRestore(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : '恢复校验失败');
    },
  });

  const rows: BackupRecordDto[] = listQuery.data?.list ?? [];
  const total: number = listQuery.data?.total ?? 0;
  const rate = rateQuery.data;
  const verifyResult = verifyMutation.data;

  return (
    <AppLayout
      title="备份与恢复"
      subtitle="数据库 + 对象存储定期备份 · 支持恢复可达性校验与恢复指引"
      actions={
        <PermGate domain="BACKUP" op="WRITE">
          <Button
            size="small"
            variant="contained"
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
          >
            立即备份
          </Button>
        </PermGate>
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} sx={{ mb: 1.5 }}>
        <Card sx={{ flex: 1 }}>
          <CardContent sx={{ py: 1.25 }}>
            <Typography variant="caption" color="text.secondary">
              备份成功率
            </Typography>
            <Typography sx={{ fontSize: 22, fontWeight: 700, color: '#1a2b7a' }}>
              {rate ? `${rate.rate.toFixed(1)}%` : '—'}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={rate?.rate ?? 0}
              sx={{ mt: 0.5, height: 5, borderRadius: 3 }}
              color={rate && rate.rate < 80 ? 'warning' : 'success'}
            />
            <Typography variant="caption" color="text.secondary">
              共 {rate?.total ?? 0} 次 · 成功 {rate?.ok ?? 0} · 失败 {rate?.failed ?? 0}
            </Typography>
          </CardContent>
        </Card>

        <Card sx={{ flex: 2 }}>
          <CardContent sx={{ py: 1.25 }}>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
              备份范围
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                select
                size="small"
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
                sx={{ width: 170 }}
              >
                {SCOPE_OPTIONS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </TextField>
              <Typography variant="caption" color="text.secondary">
                {SCOPE_OPTIONS.find((o) => o.value === scope)?.hint}
              </Typography>
            </Stack>
            <Alert severity="info" sx={{ mt: 1, py: 0.25 }}>
              全量备份依赖 Docker 容器（pg_dump / mc mirror）；容器不可用时自动降级为元数据快照，
              结果会明确标记为「元数据」，不会伪装成完整备份。
            </Alert>
          </CardContent>
        </Card>
      </Stack>

      <Card>
        <CardContent sx={{ p: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            备份记录
          </Typography>
          <Table size="small" className="dense-table">
            <TableHead>
              <TableRow>
                <TableCell width={200}>文件名</TableCell>
                <TableCell width={110}>大小</TableCell>
                <TableCell width={90}>状态</TableCell>
                <TableCell width={110}>数据库</TableCell>
                <TableCell width={110}>对象存储</TableCell>
                <TableCell width={150}>开始时间</TableCell>
                <TableCell width={150}>结束时间</TableCell>
                <TableCell width={140}>操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {listQuery.isLoading && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                    加载中…
                  </TableCell>
                </TableRow>
              )}
              {!listQuery.isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    尚无备份记录，点击「立即备份」创建第一份
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell>
                    <Typography variant="caption" className="mono" noWrap sx={{ maxWidth: 200 }}>
                      {r.filename}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{formatBytes(r.sizeBytes)}</Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={STATUS_LABEL[r.status] ?? r.status}
                      color={STATUS_COLOR[r.status] ?? 'default'}
                      variant="outlined"
                      sx={{ height: 18 }}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{r.dbStatus ?? '—'}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{r.minioStatus ?? '—'}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" className="mono">
                      {r.startedAt?.slice(0, 19).replace('T', ' ')}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" className="mono">
                      {r.finishedAt ? r.finishedAt.slice(0, 19).replace('T', ' ') : '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <PermGate domain="BACKUP" op="READ">
                      <Button
                        size="small"
                        onClick={() => {
                          setVerifyTarget(r);
                          verifyMutation.reset();
                          verifyMutation.mutate(r.id);
                        }}
                        disabled={r.status !== 'OK'}
                      >
                        恢复校验
                      </Button>
                    </PermGate>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

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

      {/* 恢复校验结果 */}
      <Dialog
        open={verifyTarget !== null}
        onClose={() => {
          setVerifyTarget(null);
          verifyMutation.reset();
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>恢复校验 · {verifyTarget?.filename}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ mt: 1 }}>
            {verifyMutation.isPending && (
              <Box>
                <Typography variant="body2">校验中…</Typography>
                <LinearProgress sx={{ mt: 1 }} />
              </Box>
            )}
            {verifyResult && (
              <>
                <Alert severity={verifyResult.ok ? 'success' : 'error'}>
                  {verifyResult.ok
                    ? '校验通过：备份对象可达、数据库连接正常、文件大小一致，可用于恢复。'
                    : '校验未通过，请查看下方明细并联系运维。'}
                </Alert>
                {verifyResult.checks.map((c) => (
                  <Stack key={c.name} direction="row" spacing={1} alignItems="center">
                    <Chip
                      size="small"
                      label={c.ok ? '通过' : '失败'}
                      color={c.ok ? 'success' : 'error'}
                      variant="outlined"
                      sx={{ height: 18, minWidth: 46 }}
                    />
                    <Typography variant="body2" sx={{ minWidth: 110 }}>
                      {c.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {c.message}
                    </Typography>
                  </Stack>
                ))}
                <Divider />
                <Typography variant="caption" color="text.secondary">
                  校验时间：{verifyResult.checkedAt?.slice(0, 19).replace('T', ' ')}
                </Typography>
                <Alert severity="warning">
                  恢复为破坏性操作，需由运维在服务器侧按《恢复指引》执行：
                  <br />
                  1. 停 API / extractor 容器；
                  <br />
                  2. <span className="mono">pg_restore -c -d tianji_archive &lt;db.dump&gt;</span>；
                  <br />
                  3. <span className="mono">mc mirror --overwrite backup/archive-original/</span>；
                  <br />
                  4. 重启容器并调用 <span className="mono">/api/health</span> 验证。
                </Alert>
              </>
            )}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setVerifyTarget(null);
              verifyMutation.reset();
            }}
          >
            关闭
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
