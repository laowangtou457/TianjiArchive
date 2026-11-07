import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Pagination,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import {
  OPEN_FLAG_LABELS,
  RETENTION_LABELS,
  RETENTION_VALUES,
  SECURITY_LEVEL_LABELS,
  SECURITY_LEVEL_RANK,
  SECURITY_LEVEL_VALUES,
  ITEM_STATUS_LABELS,
  type FacetBucket,
  type FulltextSearchQuery,
  type SearchHit,
  type SecurityLevel,
  type Retention,
} from '@tianji/shared';
import { searchApi, fondsApi, categoryApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { ArchiveNo, SecurityChip } from '../../components/ArchiveNo';
import { useAuthStore } from '../../stores/authStore';

/** 分面维度定义 */
interface FacetSpec {
  key: 'fonds' | 'year' | 'retention' | 'securityLevel' | 'category';
  title: string;
}

const FACET_SPECS: FacetSpec[] = [
  { key: 'fonds', title: '全宗' },
  { key: 'securityLevel', title: '密级' },
  { key: 'retention', title: '保管期限' },
  { key: 'year', title: '年度' },
  { key: 'category', title: '门类' },
];

/** 高亮片段渲染：把 <em> 转成 mark.hl（不使用 dangerouslySetInnerHTML，防注入） */
function HighlightedText(props: { hit: SearchHit; field: string }): ReactElement | null {
  const { hit, field } = props;
  const hl = hit.highlights.find((h) => h.field === field);
  if (!hl || hl.fragments.length === 0) return null;
  const raw = hl.fragments.join(' … ');
  // 用 <em>…</em> 分割成 [普通文本, 高亮文本] 交替数组
  const parts = raw.split(/<\/?em>/);
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
      {parts.map((seg, i) =>
        i % 2 === 1 ? (
          <mark className="hl" key={`${field}-${i}`}>
            {seg}
          </mark>
        ) : (
          <span key={`${field}-${i}`}>{seg}</span>
        ),
      )}
    </Typography>
  );
}

/**
 * 综合检索页（F-05 / P0-A）。
 *
 * 两个 Tab：
 *   1. 全文检索 —— 走 Elasticsearch（IK 分词），带分面聚合 + 高亮 + 相关度排序；
 *   2. 条件检索 —— 走 PostgreSQL 组合条件（结构化字段精确/范围匹配）。
 *
 * 权限：服务端 AccessFilterBuilder 已在 ES filter 与 SQL where 中注入，
 *      前端拿到的命中结果天然不会越权（密级 + 数据范围）。
 */
export function SearchPage(): ReactElement {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const profile = useAuthStore((s) => s.profile);

  const [tab, setTab] = useState<number>(0);
  const [keyword, setKeyword] = useState<string>('');
  const [submitted, setSubmitted] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [size] = useState<number>(20);
  const [sort, setSort] = useState<NonNullable<FulltextSearchQuery['sort']>>('relevance');
  const [levels, setLevels] = useState<SecurityLevel[]>([]);
  const [retentions, setRetentions] = useState<Retention[]>([]);
  const [yearFrom, setYearFrom] = useState<string>('');
  const [yearTo, setYearTo] = useState<string>('');
  const [fondsFilter, setFondsFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [saveName, setSaveName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const fondsQuery = useQuery({ queryKey: ['fonds'], queryFn: () => fondsApi.list() });
  const categoryQuery = useQuery({ queryKey: ['categories'], queryFn: () => categoryApi.list() });
  const historyQuery = useQuery({ queryKey: ['search-history'], queryFn: () => searchApi.history() });
  const savedQuery = useQuery({ queryKey: ['search-saved'], queryFn: () => searchApi.saved() });

  /** 组装全文检索参数 */
  const query: FulltextSearchQuery = useMemo(() => {
    const q: FulltextSearchQuery = { page, size, sort };
    if (submitted) q.q = submitted;
    if (levels.length > 0) q.level = levels;
    if (retentions.length > 0) q.retention = retentions;
    if (fondsFilter.length > 0) q.fonds = fondsFilter;
    if (categoryFilter.length > 0) q.category = categoryFilter;
    const from = Number(yearFrom);
    if (yearFrom && Number.isFinite(from)) q.yearFrom = from;
    const to = Number(yearTo);
    if (yearTo && Number.isFinite(to)) q.yearTo = to;
    return q;
  }, [
    page,
    size,
    sort,
    submitted,
    levels,
    retentions,
    fondsFilter,
    categoryFilter,
    yearFrom,
    yearTo,
  ]);

  const searchQuery = useQuery({
    queryKey: ['search-fulltext', query],
    queryFn: () => searchApi.fulltext(query),
    enabled: tab === 0,
    placeholderData: (prev) => prev,
  });

  /** 记录检索历史（每次结果返回后刷新历史列表） */
  useEffect(() => {
    if (searchQuery.isSuccess) {
      void qc.invalidateQueries({ queryKey: ['search-history'] });
    }
  }, [searchQuery.isSuccess, searchQuery.dataUpdatedAt, qc]);

  /** 提交检索 */
  const submit = useCallback((): void => {
    setPage(1);
    setSubmitted(keyword.trim());
  }, [keyword]);

  /** 保存检索条件 */
  const saveMutation = useMutation({
    mutationFn: async () => {
      const name = saveName.trim();
      if (!name) throw new Error('请填写检索条件名称');
      return searchApi.save(name, query as Record<string, unknown>, false);
    },
    onSuccess: () => {
      enqueueSnackbar('检索条件已保存', { variant: 'success' });
      setSaveName('');
      void qc.invalidateQueries({ queryKey: ['search-saved'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  /** 索引重建 */
  const reindexMutation = useMutation({
    mutationFn: () => searchApi.reindex(),
    onSuccess: (r) => {
      enqueueSnackbar(`索引重建完成：成功 ${r.indexed}，失败 ${r.failed}`, {
        variant: r.failed > 0 ? 'warning' : 'success',
      });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : '索引重建失败');
    },
  });

  /** 分面点击 → 切换过滤条件 */
  const toggleFacet = (facet: FacetSpec['key'], key: string): void => {
    if (facet === 'fonds') {
      setFondsFilter((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
      );
    } else if (facet === 'category') {
      setCategoryFilter((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
      );
    } else if (facet === 'securityLevel') {
      const level = key as SecurityLevel;
      setLevels((prev) => (prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]));
    } else if (facet === 'retention') {
      const ret = key as Retention;
      setRetentions((prev) => (prev.includes(ret) ? prev.filter((r) => r !== ret) : [...prev, ret]));
    } else {
      setYearFrom(key);
      setYearTo(key);
    }
    setPage(1);
  };

  const result = searchQuery.data;
  const hits: SearchHit[] = result?.list ?? [];
  const total: number = result?.total ?? 0;
  const pageCount: number = Math.max(1, Math.ceil(total / size));

  /** 当前是否命中某个分面键 */
  const isFacetActive = (facet: FacetSpec['key'], key: string): boolean => {
    if (facet === 'fonds') return fondsFilter.includes(key);
    if (facet === 'category') return categoryFilter.includes(key);
    if (facet === 'securityLevel') return levels.includes(key as SecurityLevel);
    if (facet === 'retention') return retentions.includes(key as Retention);
    return yearFrom === key && yearTo === key;
  };

  const renderFacetBuckets = (facet: FacetSpec, buckets: FacetBucket[]): ReactElement => (
    <Box key={facet.key} sx={{ mb: 1.5 }}>
      <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
        {facet.title}
      </Typography>
      <List dense disablePadding>
        {buckets.length === 0 && (
          <Typography variant="caption" color="text.disabled" sx={{ pl: 1 }}>
            无数据
          </Typography>
        )}
        {buckets.slice(0, 12).map((b) => (
          <ListItemButton
            key={`${facet.key}-${b.key}`}
            selected={isFacetActive(facet.key, b.key)}
            onClick={() => toggleFacet(facet.key, b.key)}
            sx={{ py: 0.15, borderRadius: 1 }}
          >
            <ListItemText
              primary={b.label || b.key}
              primaryTypographyProps={{ variant: 'body2', noWrap: true }}
            />
            <Chip label={b.count} size="small" variant="outlined" sx={{ height: 18 }} />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );

  return (
    <AppLayout
      title="综合检索"
      subtitle="全文检索（IK 分词 + 分面）与条件检索（组合筛选）· 结果已按权限自动过滤"
      actions={
        <Tooltip title="仅管理员可执行，重建全量索引">
          <span>
            <Button
              size="small"
              onClick={() => reindexMutation.mutate()}
              disabled={reindexMutation.isPending}
            >
              重建索引
            </Button>
          </span>
        </Tooltip>
      }
    >
      <Paper sx={{ p: 1.5, mb: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            fullWidth
            size="small"
            placeholder="输入关键词检索题名、责任者、文号、全文（支持空格分隔多词）"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            InputProps={{
              startAdornment: <InputAdornment position="start">⌕</InputAdornment>,
            }}
          />
          <Button variant="contained" onClick={submit} sx={{ minWidth: 96 }}>
            检索
          </Button>
          <Button onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? '收起筛选' : '高级筛选'}
          </Button>
        </Stack>

        <Tabs
          value={tab}
          onChange={(_e, v: number) => setTab(v)}
          sx={{ mt: 1, minHeight: 34, borderBottom: '1px solid #e2e8f0' }}
        >
          <Tab label="全文检索" sx={{ minHeight: 34, py: 0.5 }} />
          <Tab label="条件检索" sx={{ minHeight: 34, py: 0.5 }} />
        </Tabs>

        <Collapse in={showAdvanced}>
          <Stack direction="row" spacing={1.5} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
            <TextField
              select
              size="small"
              label="密级"
              value=""
              onChange={(e) => {
                const v = e.target.value as SecurityLevel;
                if (v) setLevels((prev) => (prev.includes(v) ? prev : [...prev, v]));
              }}
              sx={{ width: 130 }}
            >
              <MenuItem value="">不限</MenuItem>
              {SECURITY_LEVEL_VALUES.filter(
                (l) =>
                  !profile ||
                  SECURITY_LEVEL_RANK[l] <= SECURITY_LEVEL_RANK[profile.maxSecurityLevel],
              ).map((l) => (
                <MenuItem key={l} value={l}>
                  {SECURITY_LEVEL_LABELS[l]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="保管期限"
              value=""
              onChange={(e) => {
                const v = e.target.value as Retention;
                if (v) setRetentions((prev) => (prev.includes(v) ? prev : [...prev, v]));
              }}
              sx={{ width: 140 }}
            >
              <MenuItem value="">不限</MenuItem>
              {RETENTION_VALUES.map((r) => (
                <MenuItem key={r} value={r}>
                  {RETENTION_LABELS[r]}
                </MenuItem>
              ))}
            </TextField>
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
            <TextField
              select
              size="small"
              label="排序"
              value={sort}
              onChange={(e) =>
                setSort(e.target.value as NonNullable<FulltextSearchQuery['sort']>)
              }
              sx={{ width: 150 }}
            >
              <MenuItem value="relevance">相关度</MenuItem>
              <MenuItem value="dateDesc">日期降序</MenuItem>
              <MenuItem value="dateAsc">日期升序</MenuItem>
              <MenuItem value="danghaoAsc">档号升序</MenuItem>
            </TextField>
            <Divider orientation="vertical" flexItem />
            <TextField
              size="small"
              label="检索条件名称"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              sx={{ width: 180 }}
            />
            <Button
              size="small"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              保存检索
            </Button>
          </Stack>

          {(levels.length > 0 ||
            retentions.length > 0 ||
            fondsFilter.length > 0 ||
            categoryFilter.length > 0) && (
            <Stack direction="row" spacing={0.5} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
              {levels.map((l) => (
                <Chip
                  key={`lv-${l}`}
                  size="small"
                  label={`密级：${SECURITY_LEVEL_LABELS[l]}`}
                  onDelete={() => setLevels((prev) => prev.filter((x) => x !== l))}
                />
              ))}
              {retentions.map((r) => (
                <Chip
                  key={`rt-${r}`}
                  size="small"
                  label={`期限：${RETENTION_LABELS[r]}`}
                  onDelete={() => setRetentions((prev) => prev.filter((x) => x !== r))}
                />
              ))}
              {fondsFilter.map((f) => (
                <Chip
                  key={`fd-${f}`}
                  size="small"
                  label={`全宗：${fondsQuery.data?.find((x) => x.id === f)?.fondsNo ?? f}`}
                  onDelete={() => setFondsFilter((prev) => prev.filter((x) => x !== f))}
                />
              ))}
              {categoryFilter.map((c) => (
                <Chip
                  key={`ct-${c}`}
                  size="small"
                  label={`门类：${categoryQuery.data?.find((x) => x.id === c)?.name ?? c}`}
                  onDelete={() => setCategoryFilter((prev) => prev.filter((x) => x !== c))}
                />
              ))}
              <Button
                size="small"
                onClick={() => {
                  setLevels([]);
                  setRetentions([]);
                  setFondsFilter([]);
                  setCategoryFilter([]);
                  setYearFrom('');
                  setYearTo('');
                }}
              >
                清空筛选
              </Button>
            </Stack>
          )}
        </Collapse>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        {/* 分面侧栏 */}
        <Card sx={{ width: 220, flex: '0 0 220px' }}>
          <CardContent sx={{ p: 1.25 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              分面筛选
            </Typography>
            {searchQuery.isLoading && <CircularProgress size={18} />}
            {result &&
              FACET_SPECS.map((spec) => renderFacetBuckets(spec, result.facets[spec.key] ?? []))}
            {!result && !searchQuery.isLoading && (
              <Typography variant="caption" color="text.secondary">
                执行检索后显示分面
              </Typography>
            )}
          </CardContent>
        </Card>

        {/* 结果列表 */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {tab === 0 && (
            <Card>
              <CardContent sx={{ p: 1.5 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                  <Typography variant="body2" color="text.secondary">
                    {searchQuery.isFetching
                      ? '检索中…'
                      : result
                        ? `共 ${total} 条 · 耗时 ${result.took} ms`
                        : '输入关键词开始检索'}
                  </Typography>
                  {result && (
                    <Typography variant="caption" color="text.secondary">
                      密级上限：{profile ? SECURITY_LEVEL_LABELS[profile.maxSecurityLevel] : '-'}
                    </Typography>
                  )}
                </Stack>

                {hits.length === 0 && !searchQuery.isLoading && result && (
                  <Box sx={{ py: 6, textAlign: 'center' }}>
                    <Typography color="text.secondary">未检索到符合条件的档案</Typography>
                    <Typography variant="caption" color="text.disabled">
                      可能原因：关键词未命中、密级不足、或数据范围不覆盖
                    </Typography>
                  </Box>
                )}

                {hits.map((hit) => (
                  <Box
                    key={hit.id}
                    sx={{
                      py: 1.25,
                      borderBottom: '1px solid #eef2f7',
                      '&:last-of-type': { borderBottom: 'none' },
                    }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <ArchiveNo value={hit.danghao} copyable voided={hit.status === 'VOID'} />
                      <SecurityChip level={hit.securityLevel} />
                      <Chip
                        size="small"
                        variant="outlined"
                        label={RETENTION_LABELS[hit.retention] ?? hit.retention}
                      />
                      <Chip
                        size="small"
                        variant="outlined"
                        label={OPEN_FLAG_LABELS[hit.openFlag] ?? hit.openFlag}
                      />
                      {hit.status !== 'ARCHIVED' && (
                        <Chip
                          size="small"
                          color="warning"
                          variant="outlined"
                          label={ITEM_STATUS_LABELS[hit.status] ?? hit.status}
                        />
                      )}
                    </Stack>
                    <Typography
                      variant="subtitle2"
                      sx={{ mt: 0.5, cursor: 'pointer', '&:hover': { color: '#1a2b7a' } }}
                      onClick={() => window.open(`/items/${hit.id}`, '_self')}
                    >
                      {hit.title}
                    </Typography>
                    <Stack direction="row" spacing={2} sx={{ mt: 0.25 }}>
                      <Typography variant="caption" color="text.secondary">
                        年度：{hit.year || '-'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        责任者：{hit.responsible || '-'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        文件：{hit.fileCount} 个{hit.hasPreview ? '（可预览）' : ''}
                      </Typography>
                      {hit.score !== null && (
                        <Typography variant="caption" color="text.disabled">
                          相关度 {hit.score.toFixed(2)}
                        </Typography>
                      )}
                    </Stack>
                    <HighlightedText hit={hit} field="title" />
                    <HighlightedText hit={hit} field="fulltext" />
                  </Box>
                ))}

                {pageCount > 1 && (
                  <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
                    <Pagination
                      size="small"
                      count={pageCount}
                      page={page}
                      onChange={(_e, p) => setPage(p)}
                    />
                  </Box>
                )}
              </CardContent>
            </Card>
          )}

          {tab === 1 && (
            <ConditionalSearchPanel
              onError={(msg) => setError(msg)}
              onOpenItem={(id) => window.open(`/items/${id}`, '_self')}
            />
          )}
        </Box>

        {/* 右侧：历史 + 保存的检索 */}
        {tab === 0 && (
          <Box sx={{ width: 260, flex: '0 0 260px' }}>
            <Card sx={{ mb: 1.5 }}>
              <CardContent sx={{ p: 1.25 }}>
                <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                  最近检索
                </Typography>
                {(historyQuery.data ?? []).length === 0 && (
                  <Typography variant="caption" color="text.secondary">
                    暂无记录
                  </Typography>
                )}
                {(historyQuery.data ?? []).slice(0, 8).map((h) => (
                  <Box
                    key={h.id}
                    sx={{ py: 0.35, cursor: 'pointer', '&:hover': { bgcolor: '#f7fafc' } }}
                    onClick={() => {
                      setKeyword(h.keyword ?? '');
                      setSubmitted(h.keyword ?? '');
                      setPage(1);
                    }}
                  >
                    <Typography variant="caption" noWrap display="block">
                      {h.keyword || '(空条件)'}
                    </Typography>
                    <Typography variant="caption" color="text.disabled">
                      {h.resultCount} 条 · {h.tookMs}ms
                    </Typography>
                  </Box>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardContent sx={{ p: 1.25 }}>
                <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                  已保存检索
                </Typography>
                {(savedQuery.data ?? []).length === 0 && (
                  <Typography variant="caption" color="text.secondary">
                    暂无保存
                  </Typography>
                )}
                {(savedQuery.data ?? []).map((s) => (
                  <Stack
                    key={s.id}
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    sx={{ py: 0.25 }}
                  >
                    <Typography
                      variant="caption"
                      noWrap
                      sx={{ cursor: 'pointer', flex: 1 }}
                      onClick={() => {
                        const q = s.query as FulltextSearchQuery;
                        setKeyword(q.q ?? '');
                        setSubmitted(q.q ?? '');
                        setPage(1);
                      }}
                    >
                      {s.name}
                    </Typography>
                    <IconButton
                      size="small"
                      onClick={() => {
                        void searchApi.removeSaved(s.id).then(() => {
                          void qc.invalidateQueries({ queryKey: ['search-saved'] });
                        });
                      }}
                    >
                      ✕
                    </IconButton>
                  </Stack>
                ))}
              </CardContent>
            </Card>
          </Box>
        )}
      </Stack>
    </AppLayout>
  );
}

/** 条件检索面板：结构化字段组合（走后端 /search/conditional → PG SQL） */
interface ConditionalSearchPanelProps {
  onError: (msg: string) => void;
  onOpenItem: (id: string) => void;
}

interface ConditionRow {
  /** 行唯一键 */
  uid: number;
  field: string;
  operator: 'eq' | 'ne' | 'in' | 'like' | 'gte' | 'lte' | 'between' | 'isNull' | 'notNull';
  value: string;
  value2: string;
}

const CONDITION_FIELDS: Array<{ value: string; label: string }> = [
  { value: 'danghao', label: '档号' },
  { value: 'title', label: '题名' },
  { value: 'responsible', label: '责任者' },
  { value: 'year', label: '年度' },
  { value: 'docDate', label: '成文日期' },
  { value: 'retention', label: '保管期限' },
  { value: 'securityLevel', label: '密级' },
  { value: 'status', label: '状态' },
  { value: 'openFlag', label: '开放标识' },
  { value: 'archiveCode', label: '文号' },
  { value: 'subject', label: '主题词' },
];

let uidSeq = 1;

function ConditionalSearchPanel(props: ConditionalSearchPanelProps): ReactElement {
  const { onError, onOpenItem } = props;
  const [rows, setRows] = useState<ConditionRow[]>([
    { uid: uidSeq++, field: 'title', operator: 'like', value: '', value2: '' },
  ]);
  const [logic, setLogic] = useState<'AND' | 'OR'>('AND');
  const [page, setPage] = useState<number>(1);
  const [size] = useState<number>(20);
  const [resultState, setResultState] = useState<{
    list: SearchHit[];
    total: number;
    took: number;
  } | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const filters = rows
        .filter((r) => {
          if (r.operator === 'isNull' || r.operator === 'notNull') return true;
          if (r.operator === 'between') return r.value !== '' && r.value2 !== '';
          return r.value !== '';
        })
        .map((r) => {
          if (r.operator === 'between') {
            return { field: r.field, operator: r.operator, value: [r.value, r.value2] };
          }
          if (r.operator === 'in') {
            return {
              field: r.field,
              operator: r.operator,
              value: r.value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s !== ''),
            };
          }
          return { field: r.field, operator: r.operator, value: r.value };
        });
      if (filters.length === 0) throw new Error('至少填写一个检索条件');
      return searchApi.conditional({ filters, logic, page, size });
    },
    onSuccess: (r) => {
      setResultState({ list: r.list, total: r.total, took: r.took });
    },
    onError: (err: unknown) => {
      onError(err instanceof ApiError ? err.message : '条件检索失败');
    },
  });

  const updateRow = (uid: number, patch: Partial<ConditionRow>): void => {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  };

  return (
    <Card>
      <CardContent sx={{ p: 1.5 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          条件组合（{logic === 'AND' ? '全部满足' : '任一满足'}）
        </Typography>

        {rows.map((row) => (
          <Stack key={row.uid} direction="row" spacing={1} sx={{ mb: 1 }} alignItems="center">
            <TextField
              select
              size="small"
              label="字段"
              value={row.field}
              onChange={(e) => updateRow(row.uid, { field: e.target.value })}
              sx={{ width: 140 }}
            >
              {CONDITION_FIELDS.map((f) => (
                <MenuItem key={f.value} value={f.value}>
                  {f.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="运算"
              value={row.operator}
              onChange={(e) =>
                updateRow(row.uid, {
                  operator: e.target.value as ConditionRow['operator'],
                })
              }
              sx={{ width: 110 }}
            >
              <MenuItem value="eq">等于</MenuItem>
              <MenuItem value="ne">不等于</MenuItem>
              <MenuItem value="like">包含</MenuItem>
              <MenuItem value="in">属于（逗号分隔）</MenuItem>
              <MenuItem value="gte">大于等于</MenuItem>
              <MenuItem value="lte">小于等于</MenuItem>
              <MenuItem value="between">区间</MenuItem>
              <MenuItem value="isNull">为空</MenuItem>
              <MenuItem value="notNull">不为空</MenuItem>
            </TextField>
            {row.operator !== 'isNull' && row.operator !== 'notNull' && (
              <TextField
                size="small"
                label="值"
                value={row.value}
                onChange={(e) => updateRow(row.uid, { value: e.target.value })}
                sx={{ flex: 1 }}
              />
            )}
            {row.operator === 'between' && (
              <TextField
                size="small"
                label="到"
                value={row.value2}
                onChange={(e) => updateRow(row.uid, { value2: e.target.value })}
                sx={{ flex: 1 }}
              />
            )}
            <Button
              size="small"
              color="error"
              onClick={() => setRows((prev) => prev.filter((r) => r.uid !== row.uid))}
            >
              删除
            </Button>
          </Stack>
        ))}

        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            size="small"
            onClick={() =>
              setRows((prev) => [
                ...prev,
                { uid: uidSeq++, field: 'title', operator: 'like', value: '', value2: '' },
              ])
            }
          >
            + 添加条件
          </Button>
          <TextField
            select
            size="small"
            label="逻辑"
            value={logic}
            onChange={(e) => setLogic(e.target.value as 'AND' | 'OR')}
            sx={{ width: 110 }}
          >
            <MenuItem value="AND">AND 全部</MenuItem>
            <MenuItem value="OR">OR 任一</MenuItem>
          </TextField>
          <Button
            variant="contained"
            size="small"
            onClick={() => {
              setPage(1);
              mutation.mutate();
            }}
            disabled={mutation.isPending}
          >
            执行检索
          </Button>
          {resultState && (
            <Typography variant="caption" color="text.secondary">
              共 {resultState.total} 条 · {resultState.took} ms
            </Typography>
          )}
        </Stack>

        <Divider sx={{ my: 1.5 }} />

        {(resultState?.list ?? []).length === 0 && resultState && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
            无匹配结果
          </Typography>
        )}

        {(resultState?.list ?? []).map((hit) => (
          <Box
            key={hit.id}
            sx={{ py: 1, borderBottom: '1px solid #eef2f7', cursor: 'pointer' }}
            onClick={() => onOpenItem(hit.id)}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <ArchiveNo value={hit.danghao} voided={hit.status === 'VOID'} />
              <SecurityChip level={hit.securityLevel} />
              <Typography variant="subtitle2">{hit.title}</Typography>
            </Stack>
            <Stack direction="row" spacing={2}>
              <Typography variant="caption" color="text.secondary">
                {hit.year || '-'} · {RETENTION_LABELS[hit.retention] ?? hit.retention} ·{' '}
                {ITEM_STATUS_LABELS[hit.status] ?? hit.status}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                责任者：{hit.responsible || '-'}
              </Typography>
            </Stack>
          </Box>
        ))}

        {resultState && resultState.total > size && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
            <Pagination
              size="small"
              count={Math.max(1, Math.ceil(resultState.total / size))}
              page={page}
              onChange={(_e, p) => {
                setPage(p);
                mutation.mutate();
              }}
            />
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
