import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import ReactECharts from 'echarts-for-react';
import AssignmentIcon from '@mui/icons-material/Assignment';
import BackupIcon from '@mui/icons-material/Backup';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import DescriptionIcon from '@mui/icons-material/Description';
import DownloadIcon from '@mui/icons-material/Download';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import GavelIcon from '@mui/icons-material/Gavel';
import RefreshIcon from '@mui/icons-material/Refresh';
import ScheduleIcon from '@mui/icons-material/Schedule';
import type { DashboardTodo } from '@tianji/shared';
import { dashboardApi } from '../api';
import { AppLayout, MENU } from '../components/AppLayout';
import { useAuthStore } from '../stores/authStore';
import { getRecentFeatures } from '../utils/recentFeatures';

/** 用户操作指南 PDF（随前端静态资源发布，位于 apps/web/public/） */
const GUIDES = [
  { label: '用户操作指南', filename: '天玑档案管理系统-用户操作指南.pdf', desc: '全功能操作与 FAQ' },
  { label: '利用平台指南', filename: '天玑档案管理系统-利用平台指南.pdf', desc: '检索 / 借阅 / 智能问答' },
  { label: '管理维护指南', filename: '天玑档案管理系统-管理维护指南.pdf', desc: '部署 / 备份 / 运维' },
] as const;

const GUIDE_URL = encodeURI(`/${GUIDES[0].filename}`);

/** 待办分类 → 图标与配色 */
const TODO_META: Record<DashboardTodo['category'], { color: string; icon: ReactElement }> = {
  CATALOG: { color: '#4f6ef7', icon: <AssignmentIcon fontSize="small" /> },
  BORROW: { color: '#c05621', icon: <ScheduleIcon fontSize="small" /> },
  WORKFLOW: { color: '#805ad5', icon: <GavelIcon fontSize="small" /> },
  APPRAISAL: { color: '#2f855a', icon: <FactCheckIcon fontSize="small" /> },
  BACKUP: { color: '#d69e2e', icon: <BackupIcon fontSize="small" /> },
  RECYCLE: { color: '#718096', icon: <DeleteSweepIcon fontSize="small" /> },
};

const STAT_TABS = ['档案统计', '原文统计', '利用统计', '最近一周登录情况'] as const;

/** 最近使用功能：无历史时展示的推荐入口 */
const DEFAULT_FEATURE_KEYS = [
  'catalog', 'search', 'import', 'borrow', 'audit', 'users',
  'receive', 'datalink', 'backup', 'report', 'wiki', 'workflow',
];
const TILE_COLORS = ['#e07b39', '#2f8f83', '#e07b39', '#805ad5', '#6b5bc7', '#2f8f83', '#319795', '#c9a227', '#d69e2e', '#4a5568', '#2b6cb0', '#3182ce'];

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

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 工作台（F-13）。
 * 数据全部按当前用户权限过滤（后端 DashboardService 走 AccessFilterBuilder）。
 * 首页四块对齐泰坦：待办事项 / 数据统计 / 使用指南 / 最近使用功能。
 */
export function DashboardPage(): ReactElement {
  const profile = useAuthStore((s) => s.profile);
  const logout = useAuthStore((s) => s.logout);

  const [todoCollapsed, setTodoCollapsed] = useState(false);
  const [todoShowAll, setTodoShowAll] = useState(false);
  const [statTab, setStatTab] = useState(0);

  const summaryQuery = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: () => dashboardApi.summary(),
    refetchInterval: 60_000,
  });
  const todoQuery = useQuery({
    queryKey: ['dashboard-todos'],
    queryFn: () => dashboardApi.todos(),
    refetchInterval: 60_000,
  });
  const statsQuery = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => dashboardApi.stats(),
    refetchInterval: 300_000,
  });

  const { data, isLoading, error } = summaryQuery;
  const todos = todoQuery.data ?? [];
  const stats = statsQuery.data;

  const features = useMemo(() => {
    const stored = getRecentFeatures(12);
    if (stored.length > 0) return stored;
    return DEFAULT_FEATURE_KEYS
      .map((key) => MENU.find((m) => m.key === key))
      .filter((m): m is (typeof MENU)[number] => Boolean(m))
      .map((m) => ({ key: m.key, label: m.label, path: m.path, icon: m.icon, ts: 0, count: 0 }));
  }, []);

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

  const statRows: Array<{ name: string; value: number }> =
    statTab === 0 ? (stats?.archive ?? [])
      : statTab === 1 ? (stats?.fulltext ?? [])
        : statTab === 2 ? (stats?.usage ?? [])
          : (stats?.login ?? []);

  const statOption = {
    grid: { left: 36, right: 10, top: 16, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: statRows.map((x) => x.name),
      axisLabel: { fontSize: 9, interval: 0, rotate: statTab === 3 ? 0 : 12 },
    },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
    series: [
      {
        type: 'bar',
        data: statRows.map((x) => x.value),
        itemStyle: { color: '#4f6ef7', borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 42,
      },
    ],
  };

  const visibleTodos = todoShowAll ? todos : todos.slice(0, 5);

  return (
    <AppLayout
      title="工作台"
      subtitle={`${profile?.displayName ?? ''}（${profile?.roles.join(' / ') ?? ''}）· 密级上限 ${profile?.maxSecurityLevel ?? ''}`}
      actions={
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" label={`全宗授权：${profile?.fondsIds === null ? '全部' : `${profile?.fondsIds?.length ?? 0} 个`}`} />
          <Button size="small" href={GUIDE_URL} download={GUIDES[0].filename} startIcon={<DownloadIcon />}>
            操作指南
          </Button>
          <Button size="small" onClick={() => void logout()}>
            退出
          </Button>
        </Stack>
      }
    >
      {error && <Alert severity="error" sx={{ mb: 2 }}>工作台数据加载失败，请稍后重试</Alert>}

      <Grid container spacing={1.5}>
        {/* ------------------------------------------------ 四块对齐泰坦首页 */}
        <Grid item xs={12} md={4}>
          <Card sx={{ height: '100%' }}>
            <CardContent sx={{ pb: 1 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="h6">待办事项</Typography>
                  {todos.length > 0 && <Chip size="small" color="primary" label={todos.length} />}
                </Stack>
                <Stack direction="row">
                  <Tooltip title="刷新待办">
                    <IconButton size="small" onClick={() => void todoQuery.refetch()}>
                      <RefreshIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={todoCollapsed ? '展开' : '折叠'}>
                    <IconButton size="small" onClick={() => setTodoCollapsed((v) => !v)}>
                      {todoCollapsed ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
              {!todoCollapsed && (
                todoQuery.isLoading ? (
                  <Box sx={{ py: 3, textAlign: 'center', color: 'text.secondary', fontSize: 13 }}>加载中…</Box>
                ) : todos.length === 0 ? (
                  <Box sx={{ py: 3, textAlign: 'center', color: 'text.secondary', fontSize: 13 }}>暂无待办事项</Box>
                ) : (
                  <>
                    <List dense disablePadding>
                      {visibleTodos.map((t) => {
                        const meta = TODO_META[t.category];
                        return (
                          <ListItemButton
                            key={t.id}
                            component="a"
                            href={t.path}
                            divider
                            sx={{ py: 0.8, px: 0.5 }}
                          >
                            <ListItemIcon sx={{ minWidth: 30, color: meta.color }}>{meta.icon}</ListItemIcon>
                            <ListItemText
                              primary={t.title}
                              secondary={`${t.detail} · ${formatTime(t.timestamp)}`}
                              primaryTypographyProps={{ fontSize: 12.5, fontWeight: 600, noWrap: true }}
                              secondaryTypographyProps={{ fontSize: 11, noWrap: true }}
                            />
                            <ChevronRightIcon fontSize="small" sx={{ color: '#a0aec0' }} />
                          </ListItemButton>
                        );
                      })}
                    </List>
                    {todos.length > 5 && (
                      <Button size="small" onClick={() => setTodoShowAll((v) => !v)} sx={{ mt: 0.5 }}>
                        {todoShowAll ? '收起' : `查看全部 ${todos.length} 条`}
                      </Button>
                    )}
                  </>
                )
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={5}>
          <Card sx={{ height: '100%' }}>
            <CardContent sx={{ pb: 1 }}>
              <Typography variant="h6" sx={{ mb: 0.5 }}>数据统计</Typography>
              <Tabs
                value={statTab}
                onChange={(_, v: number) => setStatTab(v)}
                variant="scrollable"
                scrollButtons="auto"
                sx={{ minHeight: 32, '& .MuiTab-root': { minHeight: 32, fontSize: 11, py: 0 } }}
              >
                {STAT_TABS.map((label) => <Tab key={label} label={label} />)}
              </Tabs>
              {statsQuery.isLoading ? (
                <Box sx={{ py: 4, textAlign: 'center', color: 'text.secondary', fontSize: 13 }}>加载中…</Box>
              ) : statRows.length === 0 ? (
                <Box sx={{ py: 4, textAlign: 'center', color: 'text.secondary', fontSize: 13 }}>暂无数据</Box>
              ) : (
                <ReactECharts option={statOption} style={{ height: 180 }} notMerge />
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={3}>
          <Card sx={{ height: '100%' }}>
            <CardContent sx={{ pb: 1 }}>
              <Typography variant="h6" sx={{ mb: 0.5 }}>使用指南</Typography>
              <List dense disablePadding>
                {GUIDES.map((g) => (
                  <ListItemButton
                    key={g.filename}
                    component="a"
                    href={encodeURI(`/${g.filename}`)}
                    download={g.filename}
                    divider
                    sx={{ py: 0.9, px: 0.5 }}
                  >
                    <ListItemIcon sx={{ minWidth: 30, color: '#1a2b7a' }}>
                      <DescriptionIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText
                      primary={g.label}
                      secondary={g.desc}
                      primaryTypographyProps={{ fontSize: 12.5, fontWeight: 600 }}
                      secondaryTypographyProps={{ fontSize: 10.5 }}
                    />
                    <DownloadIcon fontSize="small" sx={{ color: '#a0aec0' }} />
                  </ListItemButton>
                ))}
              </List>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12}>
          <Card>
            <CardContent sx={{ py: 1.2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="h6">最近使用功能</Typography>
                <Typography variant="caption" color="text.secondary">
                  根据您的菜单访问记录自动生成
                </Typography>
              </Stack>
              <Grid container spacing={1}>
                {features.map((f, idx) => (
                  <Grid item xs={6} sm={4} md={2} key={f.key}>
                    <ListItemButton
                      component="a"
                      href={f.path}
                      sx={{
                        flexDirection: 'column',
                        textAlign: 'center',
                        py: 1.2,
                        px: 0.5,
                        border: '1px solid #e8ecf5',
                        borderRadius: 1,
                        '&:hover': { borderColor: TILE_COLORS[idx % TILE_COLORS.length] },
                      }}
                    >
                      <Box
                        sx={{
                          width: 40,
                          height: 40,
                          borderRadius: 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          bgcolor: TILE_COLORS[idx % TILE_COLORS.length],
                          color: '#fff',
                          fontSize: 20,
                          mb: 0.6,
                        }}
                      >
                        {f.icon}
                      </Box>
                      <Typography variant="caption" sx={{ fontSize: 11.5, lineHeight: 1.2, whiteSpace: 'nowrap' }}>
                        {f.label}
                      </Typography>
                    </ListItemButton>
                  </Grid>
                ))}
              </Grid>
            </CardContent>
          </Card>
        </Grid>

        {/* ------------------------------------------------ 原有指标与概览 */}
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
          <StatCard label="鉴定到期" value={data?.appraisalDue ?? 0} color="#718096" hint="以「档案管理 → 鉴定」任务列表为准" />
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
