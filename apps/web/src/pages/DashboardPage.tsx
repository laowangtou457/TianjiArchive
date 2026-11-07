import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import ReactECharts from 'echarts-for-react';
import { dashboardApi } from '../api';
import { AppLayout } from '../components/AppLayout';
import { useAuthStore } from '../stores/authStore';

/** 指标卡 */
function StatCard(props: { label: string; value: number | string; hint?: string; color?: string }): ReactElement {
  const { label, value, hint, color = '#1a2b7a' } = props;
  return (
    <Card>
      <CardContent sx={{ py: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography sx={{ fontSize: 26, fontWeight: 700, color, lineHeight: 1.3 }}>{value}</Typography>
        {hint && (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 工作台（F-13）。
 * 数据全部按当前用户权限过滤（后端 DashboardService 走 AccessFilterBuilder）。
 */
export function DashboardPage(): ReactElement {
  const profile = useAuthStore((s) => s.profile);
  const logout = useAuthStore((s) => s.logout);

  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: () => dashboardApi.summary(),
    refetchInterval: 60_000,
  });

  const intakeOption = {
    grid: { left: 40, right: 12, top: 20, bottom: 26 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: (data?.intakeByMonth ?? []).map((x) => x.month),
      axisLabel: { fontSize: 10 },
    },
    yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
    series: [
      {
        type: 'bar',
        data: (data?.intakeByMonth ?? []).map((x) => x.itemCount),
        itemStyle: { color: '#4f6ef7' },
        barMaxWidth: 26,
      },
    ],
  };

  return (
    <AppLayout
      title="工作台"
      subtitle={`${profile?.displayName ?? ''}（${profile?.roles.join(' / ') ?? ''}）· 密级上限 ${profile?.maxSecurityLevel ?? ''}`}
      actions={
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" label={`全宗授权：${profile?.fondsIds === null ? '全部' : `${profile?.fondsIds?.length ?? 0} 个`}`} />
          <Button size="small" onClick={() => void logout()}>
            退出
          </Button>
        </Stack>
      }
    >
      {error && <Alert severity="error" sx={{ mb: 2 }}>工作台数据加载失败，请稍后重试</Alert>}

      <Grid container spacing={1.5}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard label="待著录（草稿）" value={data?.pendingCatalog ?? 0} hint="进入「档案著录」继续" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard label="待审批借阅" value={data?.pendingApproval ?? 0} color="#c05621" hint="进入「借阅管理」处理" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard label="我的待归还" value={data?.pendingReturn ?? 0} color="#2f855a" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard label="鉴定到期（P1 预留）" value={data?.appraisalDue ?? 0} color="#718096" />
        </Grid>

        <Grid item xs={12} md={4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1 }}>
                馆藏概览
              </Typography>
              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between">
                  <span>全宗数</span>
                  <b>{data?.stock.totalFonds ?? 0}</b>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <span>档案件数</span>
                  <b>{data?.stock.totalItems ?? 0}</b>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <span>电子文件数</span>
                  <b>{data?.stock.totalFiles ?? 0}</b>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <span>电子容量</span>
                  <b>{((data?.stock.totalBytes ?? 0) / 1024 / 1024 / 1024).toFixed(2)} GB</b>
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={8}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6">近 6 个月入库趋势</Typography>
              {isLoading ? (
                <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>加载中…</Box>
              ) : (
                <ReactECharts option={intakeOption} style={{ height: 200 }} notMerge />
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1 }}>
                借阅热门档案 Top5
              </Typography>
              {(data?.borrowTopItems ?? []).length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  暂无借阅记录
                </Typography>
              ) : (
                <List dense disablePadding>
                  {data?.borrowTopItems.map((item, idx) => (
                    <ListItem key={`${item.danghao}-${idx}`} disableGutters divider={idx < (data?.borrowTopItems.length ?? 0) - 1}>
                      <ListItemText
                        primary={item.title || '（无题名）'}
                        secondary={<span className="mono">{item.danghao}</span>}
                        primaryTypographyProps={{ fontSize: 13, noWrap: true }}
                      />
                      <Chip size="small" label={`${item.count} 次`} />
                    </ListItem>
                  ))}
                </List>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1 }}>
                我的最近检索
              </Typography>
              {(data?.recentSearches ?? []).length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  暂无检索记录
                </Typography>
              ) : (
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  {data?.recentSearches.map((k, idx) => (
                    <Chip
                      key={`${k}-${idx}`}
                      label={k}
                      onClick={() => {
                        window.location.href = `/search?q=${encodeURIComponent(k)}`;
                      }}
                    />
                  ))}
                </Stack>
              )}
              <Divider sx={{ my: 1.5 }} />
              <Typography variant="caption" color="text.secondary">
                提示：检索、预览、下载均强制记录操作日志（合规要求）
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </AppLayout>
  );
}
