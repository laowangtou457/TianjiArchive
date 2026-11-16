import { useState, type ReactElement } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { SECURITY_LEVEL_LABELS, type WikiImportSourceDto } from '@tianji/shared';
import { wikiPageApi } from '../../api';
import { ApiError } from '../../api/client';

/**
 * 批量导入对话框（免费书籍 → 按类型建空间、按条目建页面）。
 *
 *   - 列出可导入类型与条目数，勾选后启动后台任务，轮询进度可取消；
 *   - 每页继承来源条目密级（同类型内密级混合不泄密）；
 *   - 中断/失败重跑幂等（已导入的条目自动跳过）；
 *   - dryRun 只统计不落库，用于先行核对分组。
 */
export function WikiImportDialog(options: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}): ReactElement {
  const { open, onClose, onImported } = options;
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState('');

  const sourcesQuery = useQuery({
    queryKey: ['wiki-import-sources'],
    queryFn: wikiPageApi.importSources,
    enabled: open,
  });
  const statusQuery = useQuery({
    queryKey: ['wiki-import-status'],
    queryFn: wikiPageApi.importStatus,
    enabled: open,
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });

  const errText = (err: unknown): string => (err instanceof ApiError ? err.message : '操作失败');

  const startMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      wikiPageApi.importStart({
        sources: [...selected],
        limitPerGroup: Number.parseInt(limit, 10) || 0,
        dryRun,
      }),
    onSuccess: () => {
      enqueueSnackbar('导入任务已启动', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['wiki-import-status'] });
    },
    onError: (err) => enqueueSnackbar(errText(err), { variant: 'error' }),
  });
  const cancelMutation = useMutation({
    mutationFn: wikiPageApi.importCancel,
    onSuccess: () => {
      enqueueSnackbar('已请求取消（当前页写完后停止）', { variant: 'info' });
      void qc.invalidateQueries({ queryKey: ['wiki-import-status'] });
    },
    onError: (err) => enqueueSnackbar(errText(err), { variant: 'error' }),
  });

  const sources = sourcesQuery.data ?? [];
  const status = statusQuery.data;
  const running = status?.running ?? false;
  const pct = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;

  const toggle = (s: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const finishAndClose = (): void => {
    onImported();
    onClose();
  };

  return (
    <Dialog open={open} onClose={running ? undefined : finishAndClose} maxWidth="md" fullWidth>
      <DialogTitle>批量导入：免费书籍 → Wiki</DialogTitle>
      <DialogContent>
        {running ? (
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} />
              <Typography variant="body2" sx={{ flex: 1 }}>
                正在导入 {status?.sources.join('、')} {status?.dryRun ? '（试运行，不落库）' : ''}
                {status?.currentTitle ? ` — ${status.currentTitle}` : ''}
              </Typography>
              <Button color="warning" onClick={() => cancelMutation.mutate()}>
                取消
              </Button>
            </Stack>
            <LinearProgress variant="determinate" value={pct} />
            <Typography variant="caption" color="text.secondary">
              {status?.done ?? 0} / {status?.total ?? 0}（新建 {status?.createdPages ?? 0} ｜ 跳过{' '}
              {status?.skipped ?? 0} ｜ 失败 {status?.failed ?? 0}）— 页面已切片入向量库，
              完成后可直接在「知识 Wiki」看到空间
            </Typography>
            {status?.lastError && (
              <Typography variant="caption" color="error">
                最近失败：{status.lastError}
              </Typography>
            )}
            {!running && status?.finishedAt && (
              <Button variant="contained" onClick={finishAndClose}>
                完成，刷新空间列表
              </Button>
            )}
          </Stack>
        ) : (
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              按书籍类型自动建空间，每个档案文档转成一个 Wiki 页面（正文取自已抽取的全文切片）。
              页面继承条目密级；已导入过的条目自动跳过，中断可重跑。
            </Typography>
            {sourcesQuery.isLoading && <CircularProgress size={20} />}
            <Card variant="outlined">
              {(sources).map((s: WikiImportSourceDto) => (
                <Stack
                  key={s.source}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  sx={{ px: 1.5, py: 0.75, borderBottom: '1px solid #f0f0f0' }}
                >
                  <Checkbox size="small" checked={selected.has(s.source)} onChange={() => toggle(s.source)} />
                  <Typography variant="body2" sx={{ flex: 1 }} noWrap>
                    {s.source}
                  </Typography>
                  <Chip
                    size="small"
                    label={SECURITY_LEVEL_LABELS[s.maxSecurityLevel]}
                    color={s.maxSecurityLevel === 'SECRET' ? 'error' : s.maxSecurityLevel === 'INTERNAL' ? 'warning' : 'success'}
                  />
                  <Chip size="small" label={`${s.itemCount} 件`} variant="outlined" />
                  {s.importedCount > 0 && (
                    <Chip size="small" label={`已导 ${s.importedCount}`} color="success" variant="outlined" />
                  )}
                </Stack>
              ))}
              {sources.length === 0 && !sourcesQuery.isLoading && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                  没有可导入的批量录入数据
                </Typography>
              )}
            </Card>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                label="每类上限（0=不限，试跑建议 3）"
                value={limit}
                onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ''))}
                sx={{ width: 220 }}
              />
              <Box sx={{ flex: 1 }} />
              <Button
                variant="outlined"
                disabled={selected.size === 0 || startMutation.isPending}
                onClick={() => startMutation.mutate(true)}
              >
                试运行（不落库）
              </Button>
              <Button
                variant="contained"
                disabled={selected.size === 0 || startMutation.isPending}
                onClick={() => startMutation.mutate(false)}
              >
                开始导入
              </Button>
            </Stack>
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}
