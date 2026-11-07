import { useMemo, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
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
import ReactECharts from 'echarts-for-react';
import {
  RETENTION_LABELS,
  BORROW_STATUS_LABELS,
  type BorrowStatsReport,
  type IntakeReport,
  type StockReport,
  type StockReportRow,
} from '@tianji/shared';
import { reportApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

/** 字节 → 人类可读 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 百分比 */
function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * 统计报表页（F-07）。
 *
 * 三类报表：库存统计（全宗/年度/门类/保管期限四维）、接收统计（按月）、借阅统计。
 * 所有报表数据均在服务端按权限过滤（AccessFilterBuilder.buildSql），
 * 前端不额外过滤，避免"看起来有数据但实际越权"的错觉。
 * 支持导出 Excel（含中文文件名，后端 RFC5987 编码）。
 */
export function ReportPage(): ReactElement {
  const { enqueueSnackbar } = useSnackbar();
  const [tab, setTab] = useState<number>(0);
  const [yearFrom, setYearFrom] = useState<string>('');
  const [yearTo, setYearTo] = useState<string>('');
  const [exporting, setExporting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const params = useMemo<Record<string, unknown>>(() => {
    const p: Record<string, unknown> = {};
    if (yearFrom) p.yearFrom = Number(yearFrom);
    if (yearTo) p.yearTo = Number(yearTo);
    return p;
  }, [yearFrom, yearTo]);

  const stockQuery = useQuery({
    queryKey: ['report-stock', params],
    queryFn: () => reportApi.stock(params),
    enabled: tab === 0,
  });

  const intakeQuery = useQuery({
    queryKey: ['report-intake', params],
    queryFn: () => reportApi.intake(params),
    enabled: tab === 1,
  });

  const borrowQuery = useQuery({
    queryKey: ['report-borrow'],
    queryFn: () => reportApi.borrow(),
    enabled: tab === 2,
  });

  /** 导出 */
  const doExport = async (kind: 'stock' | 'intake' | 'borrow'): Promise<void> => {
    setExporting(true);
    setError(null);
    try {
      if (kind === 'stock') await reportApi.exportStock(params);
      else if (kind === 'intake') await reportApi.exportIntake(params);
      else await reportApi.exportBorrow();
      enqueueSnackbar('导出完成，文件已开始下载', { variant: 'success' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const stock: StockReport | undefined = stockQuery.data;
  const intake: IntakeReport | undefined = intakeQuery.data;
  const borrow: BorrowStatsReport | undefined = borrowQuery.data;

  /** 库存四维图表配置 */
  const stockChartOption = useMemo(() => {
    const rows: StockReportRow[] = stock?.byFonds ?? [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 60, right: 30, top: 30, bottom: 60 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.label || r.key),
        axisLabel: { rotate: rows.length > 8 ? 35 : 0, fontSize: 11 },
      },
      yAxis: { type: 'value', name: '件数' },
      series: [
        {
          name: '件数',
          type: 'bar',
          data: rows.map((r) => r.itemCount),
          itemStyle: { color: '#1a2b7a' },
          barMaxWidth: 36,
          label: { show: true, position: 'top', fontSize: 10 },
        },
      ],
    };
  }, [stock]);

  /** 年度分布（饼图） */
  const yearPieOption = useMemo(() => {
    const rows: StockReportRow[] = stock?.byYear ?? [];
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} 件 ({d}%)' },
      legend: { type: 'scroll', orient: 'vertical', right: 8, top: 12, textStyle: { fontSize: 11 } },
      series: [
        {
          type: 'pie',
          radius: ['38%', '66%'],
          center: ['38%', '50%'],
          data: rows.map((r) => ({ name: r.label || r.key, value: r.itemCount })),
          label: { fontSize: 10 },
        },
      ],
    };
  }, [stock]);

  /** 接收趋势（折线） */
  const intakeChartOption = useMemo(() => {
    const rows = intake?.rows ?? [];
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 60, right: 30, top: 40, bottom: 50 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => `${r.year}-${String(r.month).padStart(2, '0')}`),
        axisLabel: { rotate: 40, fontSize: 10 },
      },
      yAxis: { type: 'value', name: '数量' },
      series: [
        {
          name: '案卷',
          type: 'line',
          smooth: true,
          data: rows.map((r) => r.volumeCount),
          itemStyle: { color: '#2b6cb0' },
        },
        {
          name: '文件',
          type: 'line',
          smooth: true,
          data: rows.map((r) => r.itemCount),
          itemStyle: { color: '#1a2b7a' },
        },
        {
          name: '电子文件',
          type: 'bar',
          data: rows.map((r) => r.fileCount),
          itemStyle: { color: '#cbd5e0' },
          barMaxWidth: 22,
        },
      ],
    };
  }, [intake]);

  /** 借阅按月柱状 */
  const borrowMonthOption = useMemo(() => {
    const rows = borrow?.byMonth ?? [];
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 60, right: 30, top: 40, bottom: 50 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.label || r.key),
        axisLabel: { rotate: 35, fontSize: 10 },
      },
      yAxis: { type: 'value', name: '单数' },
      series: [
        {
          name: '借阅单',
          type: 'bar',
          data: rows.map((r) => r.orderCount),
          itemStyle: { color: '#1a2b7a' },
          barMaxWidth: 28,
        },
        {
          name: '未归还',
          type: 'bar',
          data: rows.map((r) => r.orderCount - r.returnedCount),
          itemStyle: { color: '#dd6b20' },
          barMaxWidth: 28,
        },
      ],
    };
  }, [borrow]);

  /** 借阅状态分布 */
  const borrowStatusOption = useMemo(() => {
    const rows = borrow?.byStatus ?? [];
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { orient: 'vertical', right: 8, top: 12, textStyle: { fontSize: 11 } },
      series: [
        {
          type: 'pie',
          radius: ['36%', '64%'],
          center: ['36%', '52%'],
          data: rows.map((r) => ({
            name: BORROW_STATUS_LABELS[r.key as keyof typeof BORROW_STATUS_LABELS] ?? r.label,
            value: r.orderCount,
          })),
          label: { fontSize: 10 },
        },
      ],
    };
  }, [borrow]);

  return (
    <AppLayout
      title="统计报表"
      subtitle="库存 / 接收 / 借阅三类报表 · 数据按当前用户权限范围统计 · 支持导出 Excel"
      actions={
        <PermGate domain="REPORT" op="EXPORT">
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              onClick={() => void doExport('stock')}
              disabled={exporting || tab !== 0}
            >
              导出库存
            </Button>
            <Button
              size="small"
              onClick={() => void doExport('intake')}
              disabled={exporting || tab !== 1}
            >
              导出接收
            </Button>
            <Button
              size="small"
              onClick={() => void doExport('borrow')}
              disabled={exporting || tab !== 2}
            >
              导出借阅
            </Button>
          </Stack>
        </PermGate>
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card sx={{ mb: 1.5 }}>
        <CardContent sx={{ py: 1, px: 1.5 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Tabs value={tab} onChange={(_e, v: number) => setTab(v)} sx={{ minHeight: 34 }}>
              <Tab label="库存统计" sx={{ minHeight: 34, py: 0.5 }} />
              <Tab label="接收统计" sx={{ minHeight: 34, py: 0.5 }} />
              <Tab label="借阅统计" sx={{ minHeight: 34, py: 0.5 }} />
            </Tabs>
            <Box sx={{ flex: 1 }} />
            {tab !== 2 && (
              <>
                <TextField
                  size="small"
                  label="起始年度"
                  type="number"
                  value={yearFrom}
                  onChange={(e) => setYearFrom(e.target.value)}
                  sx={{ width: 120 }}
                />
                <TextField
                  size="small"
                  label="截止年度"
                  type="number"
                  value={yearTo}
                  onChange={(e) => setYearTo(e.target.value)}
                  sx={{ width: 120 }}
                />
                <Button
                  size="small"
                  onClick={() => {
                    setYearFrom('');
                    setYearTo('');
                  }}
                >
                  重置
                </Button>
              </>
            )}
          </Stack>
        </CardContent>
      </Card>

      {/* ---------- 库存统计 ---------- */}
      {tab === 0 && (
        <>
          <Stack direction="row" spacing={1.5} sx={{ mb: 1.5 }}>
            {[
              { label: '案卷总数', value: stock?.totalVolumes ?? 0, unit: '卷' },
              { label: '文件总数', value: stock?.totalItems ?? 0, unit: '件' },
              { label: '电子文件', value: stock?.totalFiles ?? 0, unit: '个' },
              { label: '占用容量', value: formatBytes(stock?.totalBytes ?? 0), unit: '' },
            ].map((c) => (
              <Card key={c.label} sx={{ flex: 1 }}>
                <CardContent sx={{ py: 1.25 }}>
                  <Typography variant="caption" color="text.secondary">
                    {c.label}
                  </Typography>
                  <Typography sx={{ fontSize: 22, fontWeight: 700, color: '#1a2b7a' }}>
                    {c.value}
                    <Typography component="span" variant="caption" sx={{ ml: 0.5 }}>
                      {c.unit}
                    </Typography>
                  </Typography>
                </CardContent>
              </Card>
            ))}
          </Stack>

          <Stack direction="row" spacing={1.5} sx={{ mb: 1.5 }}>
            <Card sx={{ flex: 1.6 }}>
              <CardContent sx={{ p: 1 }}>
                <Typography variant="subtitle2" sx={{ pl: 1 }}>
                  各全宗库存（件数）
                </Typography>
                <ReactECharts
                  option={stockChartOption}
                  style={{ height: 260 }}
                  notMerge
                  lazyUpdate
                />
              </CardContent>
            </Card>
            <Card sx={{ flex: 1 }}>
              <CardContent sx={{ p: 1 }}>
                <Typography variant="subtitle2" sx={{ pl: 1 }}>
                  年度分布
                </Typography>
                <ReactECharts option={yearPieOption} style={{ height: 260 }} notMerge />
              </CardContent>
            </Card>
          </Stack>

          <Card>
            <CardContent sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                明细（按全宗）
              </Typography>
              <Table size="small" className="dense-table">
                <TableHead>
                  <TableRow>
                    <TableCell>维度值</TableCell>
                    <TableCell align="right">案卷数</TableCell>
                    <TableCell align="right">文件数</TableCell>
                    <TableCell align="right">电子文件</TableCell>
                    <TableCell align="right">占用容量</TableCell>
                    <TableCell align="right">占比</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(stock?.byFonds ?? []).map((r) => (
                    <TableRow key={`f-${r.key}`}>
                      <TableCell>{r.label || r.key}</TableCell>
                      <TableCell align="right">{r.volumeCount}</TableCell>
                      <TableCell align="right">{r.itemCount}</TableCell>
                      <TableCell align="right">{r.fileCount}</TableCell>
                      <TableCell align="right">{formatBytes(r.totalBytes)}</TableCell>
                      <TableCell align="right">{formatRatio(r.ratio)}</TableCell>
                    </TableRow>
                  ))}
                  {(stock?.byFonds ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                        暂无数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>

              <Divider sx={{ my: 1.5 }} />

              <Stack direction="row" spacing={1.5}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    按保管期限
                  </Typography>
                  <Table size="small" className="dense-table">
                    <TableBody>
                      {(stock?.byRetention ?? []).map((r) => (
                        <TableRow key={`r-${r.key}`}>
                          <TableCell>
                            {RETENTION_LABELS[r.key as keyof typeof RETENTION_LABELS] ??
                              r.label ??
                              r.key}
                          </TableCell>
                          <TableCell align="right">{r.itemCount} 件</TableCell>
                          <TableCell align="right">{formatRatio(r.ratio)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    按门类
                  </Typography>
                  <Table size="small" className="dense-table">
                    <TableBody>
                      {(stock?.byCategory ?? []).map((r) => (
                        <TableRow key={`c-${r.key}`}>
                          <TableCell>{r.label || r.key}</TableCell>
                          <TableCell align="right">{r.itemCount} 件</TableCell>
                          <TableCell align="right">{formatRatio(r.ratio)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </>
      )}

      {/* ---------- 接收统计 ---------- */}
      {tab === 1 && (
        <>
          <Card sx={{ mb: 1.5 }}>
            <CardContent sx={{ p: 1 }}>
              <Typography variant="subtitle2" sx={{ pl: 1 }}>
                按月接收趋势（共 {intake?.totalItems ?? 0} 件）
              </Typography>
              <ReactECharts option={intakeChartOption} style={{ height: 300 }} notMerge />
            </CardContent>
          </Card>

          <Card>
            <CardContent sx={{ p: 1.5 }}>
              <Table size="small" className="dense-table">
                <TableHead>
                  <TableRow>
                    <TableCell>年月</TableCell>
                    <TableCell align="right">新增案卷</TableCell>
                    <TableCell align="right">新增文件</TableCell>
                    <TableCell align="right">电子文件</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(intake?.rows ?? []).map((r) => (
                    <TableRow key={`${r.year}-${r.month}`}>
                      <TableCell>
                        {r.year}-{String(r.month).padStart(2, '0')}
                      </TableCell>
                      <TableCell align="right">{r.volumeCount}</TableCell>
                      <TableCell align="right">{r.itemCount}</TableCell>
                      <TableCell align="right">{r.fileCount}</TableCell>
                    </TableRow>
                  ))}
                  {(intake?.rows ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                        所选区间内无接收数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {/* ---------- 借阅统计 ---------- */}
      {tab === 2 && (
        <>
          <Stack direction="row" spacing={1.5} sx={{ mb: 1.5 }}>
            {[
              { label: '借阅单总数', value: borrow?.totalOrders ?? 0, color: '#1a2b7a' },
              { label: '已归还', value: borrow?.totalReturned ?? 0, color: '#2f855a' },
              { label: '逾期', value: borrow?.totalOverdue ?? 0, color: '#c53030' },
            ].map((c) => (
              <Card key={c.label} sx={{ flex: 1 }}>
                <CardContent sx={{ py: 1.25 }}>
                  <Typography variant="caption" color="text.secondary">
                    {c.label}
                  </Typography>
                  <Typography sx={{ fontSize: 22, fontWeight: 700, color: c.color }}>
                    {c.value}
                  </Typography>
                </CardContent>
              </Card>
            ))}
            <Card sx={{ flex: 2 }}>
              <CardContent sx={{ p: 1 }}>
                <ReactECharts option={borrowStatusOption} style={{ height: 110 }} notMerge />
              </CardContent>
            </Card>
          </Stack>

          <Card sx={{ mb: 1.5 }}>
            <CardContent sx={{ p: 1 }}>
              <Typography variant="subtitle2" sx={{ pl: 1 }}>
                按月借阅量
              </Typography>
              <ReactECharts option={borrowMonthOption} style={{ height: 280 }} notMerge />
            </CardContent>
          </Card>

          <Card>
            <CardContent sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                借阅热度 Top 10
              </Typography>
              <Table size="small" className="dense-table">
                <TableHead>
                  <TableRow>
                    <TableCell width={44}>#</TableCell>
                    <TableCell width={170}>档号</TableCell>
                    <TableCell>题名</TableCell>
                    <TableCell align="right" width={90}>
                      借阅次数
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(borrow?.topItems ?? []).map((t, i) => (
                    <TableRow key={t.itemId}>
                      <TableCell>{i + 1}</TableCell>
                      <TableCell className="mono">{t.danghao}</TableCell>
                      <TableCell>{t.title}</TableCell>
                      <TableCell align="right">{t.count}</TableCell>
                    </TableRow>
                  ))}
                  {(borrow?.topItems ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                        暂无借阅记录
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </AppLayout>
  );
}
