import { useMemo, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
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
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_VALUES,
  MANDATORY_AUDIT_ACTIONS,
  type AuditAction,
  type AuditLogDto,
} from '@tianji/shared';
import { auditApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

/** 结果标签样式 */
const RESULT_COLOR: Record<string, 'success' | 'error' | 'warning'> = {
  SUCCESS: 'success',
  FAILURE: 'error',
  DENIED: 'warning',
};

/** 结果中文 */
const RESULT_LABEL: Record<string, string> = {
  SUCCESS: '成功',
  FAILURE: '失败',
  DENIED: '拒绝',
};

/** 默认时间范围：最近 7 天 */
function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 7);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

/**
 * 操作日志页（F-10）。
 *
 * 覆盖强制留痕动作（检索 / 预览 / 下载 / 登录 / 权限变更 / 审批 / 删除 / 作废 / 导出 / 备份）。
 * 日志按月分区存储（BRIN 索引 + RANGE 分区），查询必须带时间范围以走分区裁剪。
 */
export function AuditPage(): ReactElement {
  const { enqueueSnackbar } = useSnackbar();
  const init = defaultRange();

  const [from, setFrom] = useState<string>(init.from);
  const [to, setTo] = useState<string>(init.to);
  const [action, setAction] = useState<string>('');
  const [objectType, setObjectType] = useState<string>('');
  const [keyword, setKeyword] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [size, setSize] = useState<number>(30);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<boolean>(false);

  const params = useMemo<Record<string, unknown>>(() => {
    const p: Record<string, unknown> = { page, size };
    if (from) p.from = `${from}T00:00:00.000Z`;
    if (to) p.to = `${to}T23:59:59.999Z`;
    if (action) p.action = [action];
    if (objectType) p.objectType = objectType;
    if (keyword) p.keyword = keyword;
    return p;
  }, [page, size, from, to, action, objectType, keyword]);

  const logsQuery = useQuery({
    queryKey: ['audit-logs', params],
    queryFn: () => auditApi.list(params),
  });

  const rows = (logsQuery.data?.list ?? []) as unknown as AuditLogDto[];
  const total: number = logsQuery.data?.total ?? 0;

  /** 导出 CSV */
  const doExport = async (): Promise<void> => {
    setExporting(true);
    setError(null);
    try {
      await auditApi.export(params);
      enqueueSnackbar('日志导出已开始下载', { variant: 'success' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <AppLayout
      title="操作日志"
      subtitle="强制留痕：检索 / 预览 / 下载 / 登录 / 权限变更 / 审批 / 删除 / 作废 / 导出 / 备份"
      actions={
        <PermGate domain="AUDIT_LOG" op="EXPORT">
          <Button size="small" onClick={() => void doExport()} disabled={exporting}>
            导出 CSV
          </Button>
        </PermGate>
      }
    >
      <Card sx={{ mb: 1.5 }}>
        <CardContent sx={{ py: 1.25, px: 1.5 }}>
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField
              size="small"
              type="date"
              label="开始日期"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
              InputLabelProps={{ shrink: true }}
              sx={{ width: 160 }}
            />
            <TextField
              size="small"
              type="date"
              label="结束日期"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
              InputLabelProps={{ shrink: true }}
              sx={{ width: 160 }}
            />
            <TextField
              select
              size="small"
              label="动作"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
              sx={{ width: 150 }}
            >
              <MenuItem value="">全部</MenuItem>
              {AUDIT_ACTION_VALUES.map((a) => (
                <MenuItem key={a} value={a}>
                  {AUDIT_ACTION_LABELS[a]}
                  {MANDATORY_AUDIT_ACTIONS.includes(a) ? '（强制）' : ''}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              label="对象类型"
              value={objectType}
              onChange={(e) => {
                setObjectType(e.target.value);
                setPage(1);
              }}
              sx={{ width: 150 }}
              placeholder="如 ITEM / FILE"
            />
            <TextField
              size="small"
              label="关键词（用户/对象ID）"
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                setPage(1);
              }}
              sx={{ width: 210 }}
            />
            <Button
              size="small"
              onClick={() => {
                const d = defaultRange();
                setFrom(d.from);
                setTo(d.to);
                setAction('');
                setObjectType('');
                setKeyword('');
                setPage(1);
              }}
            >
              重置
            </Button>
            <Typography variant="caption" color="text.secondary">
              共 {total} 条
            </Typography>
          </Stack>
        </CardContent>
      </Card>

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
                <TableCell width={140}>时间</TableCell>
                <TableCell width={100}>用户</TableCell>
                <TableCell width={90}>动作</TableCell>
                <TableCell width={110}>对象类型</TableCell>
                <TableCell width={140}>对象 ID</TableCell>
                <TableCell width={70}>结果</TableCell>
                <TableCell width={120}>IP</TableCell>
                <TableCell width={80}>耗时</TableCell>
                <TableCell width={60}>详情</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {logsQuery.isLoading && (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 4 }}>
                    加载中…
                  </TableCell>
                </TableRow>
              )}
              {!logsQuery.isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    所选条件下无日志记录
                  </TableCell>
                </TableRow>
              )}
              {rows.map((log) => {
                const id = String(log.id ?? '');
                const actionLabel =
                  AUDIT_ACTION_LABELS[log.action as AuditAction] ?? String(log.action ?? '-');
                const isExpanded = expandedId === id;
                const detailJson = log.detail ? JSON.stringify(log.detail, null, 2) : '';
                return (
                  <TableRow key={id} hover>
                    <TableCell>
                      <Typography variant="caption" className="mono">
                        {String(log.createdAt ?? '').slice(0, 19).replace('T', ' ')}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {log.username ?? log.userId ?? '系统'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={actionLabel}
                        variant="outlined"
                        color={MANDATORY_AUDIT_ACTIONS.includes(log.action) ? 'primary' : 'default'}
                        sx={{ height: 18 }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">{log.objectType ?? '—'}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="caption"
                        className="mono"
                        noWrap
                        sx={{ maxWidth: 140, display: 'block' }}
                      >
                        {log.objectId ?? '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={RESULT_LABEL[log.result] ?? log.result}
                        color={RESULT_COLOR[log.result] ?? 'default'}
                        variant="outlined"
                        sx={{ height: 18 }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" className="mono">
                        {log.ip ?? '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {log.durationMs === null || log.durationMs === undefined
                          ? '—'
                          : `${log.durationMs}ms`}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {detailJson ? (
                        <Button
                          size="small"
                          onClick={() => setExpandedId(isExpanded ? null : id)}
                        >
                          {isExpanded ? '收起' : '查看'}
                        </Button>
                      ) : (
                        <Typography variant="caption" color="text.disabled">
                          —
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {/* 详情展开区 */}
          {expandedId && (
            <Collapse in>
              <Box sx={{ mt: 1, p: 1.5, bgcolor: '#f7fafc', borderRadius: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  日志详情（JSON）
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    mt: 0.5,
                    fontSize: 11,
                    fontFamily: 'Consolas, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {JSON.stringify(
                    rows.find((r) => String(r.id) === expandedId)?.detail ?? {},
                    null,
                    2,
                  )}
                </Box>
              </Box>
            </Collapse>
          )}

          <TablePagination
            component="div"
            count={total}
            page={page - 1}
            rowsPerPage={size}
            rowsPerPageOptions={[20, 30, 50, 100]}
            onPageChange={(_e, p) => setPage(p + 1)}
            onRowsPerPageChange={(e) => {
              setSize(Number(e.target.value));
              setPage(1);
            }}
            labelRowsPerPage="每页"
            labelDisplayedRows={({ from: f, to: t, count }) => `${f}-${t} / 共 ${count} 条`}
          />
        </CardContent>
      </Card>
    </AppLayout>
  );
}
