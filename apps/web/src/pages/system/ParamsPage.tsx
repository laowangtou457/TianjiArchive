import { useMemo, useState, type ReactElement } from 'react';
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
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import type { ParamConflict, ParamDef, ParamMetaDto, ParamGroup } from '@tianji/shared';
import { paramApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

/**
 * 分组展示顺序与标题 —— **只管展示**。
 *
 * 参数本身、默认值、区间、可编辑性、说明一律来自后端 `/params/meta`
 * （`PARAM_DEFS` 的直出）。之所以还保留这张表，是因为后端只给 `grp` 枚举值
 * （`borrow`/`security`…），中文标题属于纯展示信息，放在前端更合适；
 * 且若后端新增了未登记的分组，下面有「其他参数」兜底，不会静默丢失。
 */
const GROUP_TITLES: Readonly<Record<ParamGroup, { title: string; hint: string }>> = {
  borrow: { title: '借阅规则', hint: '借期上限、续借次数与天数、逾期提醒（新申请/新续借生效）' },
  preview: { title: '预览与下载', hint: '水印开关与文案、下载模式（下一请求即时生效）' },
  security: { title: '安全策略', hint: '会话超时、密码策略、登录锁定、权限缓存（直读库，即时生效）' },
  recycle: { title: '回收站', hint: '保留天数（已有记录不重算到期时间）' },
  backup: { title: '备份', hint: '保留份数' },
  log: { title: '日志与审计', hint: '保留年限、慢查询阈值（合规固化项不可改）' },
  file: { title: '文件', hint: '上传大小与扩展名白名单' },
  import: { title: '导入', hint: '单批行数上限' },
  search: { title: '检索', hint: '分页与索引' },
  extract: { title: '内容抽取', hint: '并发与超时' },
};

/** 分组展示顺序（未列出的排在最后） */
const GROUP_ORDER: readonly ParamGroup[] = [
  'borrow',
  'preview',
  'security',
  'recycle',
  'backup',
  'log',
  'file',
  'import',
  'search',
  'extract',
];

/** 确认级别的视觉标识（PRD 5.5.2） */
function confirmChip(level: ParamMetaDto['confirm']): ReactElement | null {
  if (level === 'HIGH') {
    return <Chip label="高" size="small" color="error" variant="outlined" sx={{ height: 18 }} />;
  }
  if (level === 'MEDIUM') {
    return <Chip label="中" size="small" color="warning" variant="outlined" sx={{ height: 18 }} />;
  }
  return null;
}

/**
 * 系统参数配置页（F-14）。
 *
 * **单一源驱动**：页面不维护任何参数 key / 默认值 / 区间字面量，
 * 全部来自 `GET /params/meta`（`PARAM_DEFS` 直出）+ `GET /params`（当前值）。
 * 这样管理端与后端永远不会因「各写一份」而漂移。
 *
 * 交互要点：
 *  - `editable=false`（PR-P7 合规固化项）置灰并给出说明，不允许修改；
 *  - 保存前调 `/params/check` 做跨参数预检（C-1~C-5），**一次性展示全部冲突**；
 *  - `enum` 型渲染为下拉，避免手输错值；
 *  - `note` 有值时以 tooltip 展示，保留 PRD 的例外说明给管理员看。
 */
export function ParamsPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [editing, setEditing] = useState<ParamMetaDto | null>(null);
  const [newValue, setNewValue] = useState<string>('');
  const [conflicts, setConflicts] = useState<ParamConflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');

  /** 元数据（定义）与当前值分两个请求：定义几乎不变，值变化频繁 */
  const metaQuery = useQuery({ queryKey: ['params-meta'], queryFn: () => paramApi.meta() });
  const listQuery = useQuery({ queryKey: ['params'], queryFn: () => paramApi.list() });

  const defMap = useMemo<Map<string, ParamDef>>(() => {
    const m = new Map<string, ParamDef>();
    for (const d of metaQuery.data ?? []) m.set(d.key, d);
    return m;
  }, [metaQuery.data]);

  const rows: ParamMetaDto[] = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!editing) throw new Error('未选择参数');
      const items = [{ key: editing.key, value: newValue.trim() }];

      // 保存前预检：一次性拿到全部冲突，避免「存一次报一条」
      const found = await paramApi.check(items);
      if (found.length > 0) {
        const blocking = found.filter((c) => c.blocking);
        setConflicts(found);
        if (blocking.length > 0) {
          throw new Error(`存在 ${blocking.length} 项阻断性冲突，请先修正`);
        }
      }

      await paramApi.save(editing.key, newValue.trim());
      return items.length;
    },
    onSuccess: () => {
      enqueueSnackbar('参数已保存', { variant: 'success' });
      setEditing(null);
      setNewValue('');
      setConflicts([]);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['params'] });
      // 借阅规则等运行期口径可能被前端缓存，一并失效
      void qc.invalidateQueries({ queryKey: ['borrow-config'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  /** 按 grp 分组（顺序由 GROUP_ORDER 决定，未登记分组兜底到最后） */
  const grouped = useMemo(() => {
    const lower = filter.trim().toLowerCase();
    const matched = lower
      ? rows.filter(
          (p) =>
            p.key.toLowerCase().includes(lower) ||
            (p.label ?? '').toLowerCase().includes(lower) ||
            (p.consumer ?? '').toLowerCase().includes(lower),
        )
      : rows;

    const buckets = new Map<ParamGroup, ParamMetaDto[]>();
    for (const row of matched) {
      const list = buckets.get(row.grp) ?? [];
      list.push(row);
      buckets.set(row.grp, list);
    }

    const ordered: Array<{ grp: ParamGroup; title: string; hint: string; list: ParamMetaDto[] }> = [];
    const push = (grp: ParamGroup): void => {
      const list = buckets.get(grp);
      if (!list || list.length === 0) return;
      const meta = GROUP_TITLES[grp];
      ordered.push({
        grp,
        title: meta?.title ?? grp,
        hint: meta?.hint ?? '未登记分组',
        list,
      });
      buckets.delete(grp);
    };
    for (const grp of GROUP_ORDER) push(grp);
    // 兜底：后端新增了前端未登记的分组，也不能丢
    for (const grp of Array.from(buckets.keys())) push(grp);
    return ordered;
  }, [rows, filter]);

  const openEdit = (p: ParamMetaDto): void => {
    setEditing(p);
    setNewValue(p.value);
    setConflicts([]);
    setError(null);
  };

  const editingDef = editing ? defMap.get(editing.key) : undefined;
  const isEnum = editingDef?.type === 'enum';
  const isLoading = metaQuery.isLoading || listQuery.isLoading;

  return (
    <AppLayout
      title="系统参数"
      subtitle="参数定义以后端 PARAM_DEFS 为唯一源 · 保存前自动做跨参数校验"
      actions={
        <TextField
          size="small"
          placeholder="搜索 key / 名称 / 消费方"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          sx={{ width: 240 }}
        />
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {isLoading && <Typography variant="body2">加载中…</Typography>}

      {!isLoading && rows.length === 0 && (
        <Card>
          <CardContent>
            <Typography color="text.secondary">
              暂无参数定义。请确认后端已加载 <span className="mono">PARAM_DEFS</span> 并执行种子初始化。
            </Typography>
          </CardContent>
        </Card>
      )}

      {grouped.map((g) => (
        <Card key={g.grp} sx={{ mb: 1.5 }}>
          <CardContent sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 1 }}>
              <Typography variant="subtitle2">{g.title}</Typography>
              <Typography variant="caption" color="text.secondary">
                {g.hint}
              </Typography>
            </Stack>
            <Table size="small" className="dense-table">
              <TableHead>
                <TableRow>
                  <TableCell width={240}>key</TableCell>
                  <TableCell width={150}>名称</TableCell>
                  <TableCell>当前值</TableCell>
                  <TableCell width={110}>区间 / 默认</TableCell>
                  <TableCell width={110}>更新时间</TableCell>
                  <TableCell width={80}>操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {g.list.map((p) => {
                  return (
                    <TableRow key={p.key} hover>
                      <TableCell>
                        <Typography variant="body2" className="mono">
                          {p.key}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Tooltip
                            title={
                              <Box>
                                <div>{p.consumer || '—'}</div>
                                {p.note && <div style={{ marginTop: 4 }}>备注：{p.note}</div>}
                              </Box>
                            }
                          >
                            <Typography variant="body2">{p.label || '—'}</Typography>
                          </Tooltip>
                          {confirmChip(p.confirm)}
                          {!p.editable && (
                            <Chip
                              label="固化"
                              size="small"
                              color="default"
                              variant="outlined"
                              sx={{ height: 18 }}
                            />
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Tooltip title={p.value}>
                          <Typography variant="body2" className="mono" noWrap sx={{ maxWidth: 320 }}>
                            {p.value === '' ? '(空)' : p.value}
                          </Typography>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">
                          {p.rangeText} · 默认 {p.default}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption">—</Typography>
                      </TableCell>
                      <TableCell>
                        {p.editable ? (
                          <PermGate domain="PARAM" op="WRITE">
                            <Button size="small" onClick={() => openEdit(p)}>
                              修改
                            </Button>
                          </PermGate>
                        ) : (
                          <Tooltip title="合规固化项，出厂口径不可修改（PR-P7）">
                            <span>
                              <Button size="small" disabled>
                                修改
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} maxWidth="sm" fullWidth>
        <DialogTitle>修改参数</DialogTitle>
        <DialogContent>
          {editing && (
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  key
                </Typography>
                <Typography className="mono">{editing.key}</Typography>
              </Box>

              <Box>
                <Typography variant="caption" color="text.secondary">
                  {editing.label}（{editing.rangeText}，默认 {editing.default}）
                </Typography>
                {editing.consumer && (
                  <Typography variant="caption" display="block" color="text.secondary">
                    影响：{editing.consumer}
                  </Typography>
                )}
              </Box>

              {isEnum ? (
                <TextField
                  size="small"
                  select
                  label="新值 *"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  helperText={`可选值：${(editingDef?.enumValues ?? []).join(' / ')}`}
                >
                  {(editingDef?.enumValues ?? []).map((v) => (
                    <MenuItem key={v} value={v}>
                      {v}
                    </MenuItem>
                  ))}
                </TextField>
              ) : (
                <TextField
                  size="small"
                  label="新值 *"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  multiline={newValue.length > 60}
                  minRows={newValue.length > 60 ? 3 : 1}
                  helperText={`当前值：${editing.value === '' ? '(空)' : editing.value}`}
                />
              )}

              {editing.note && <Alert severity="info">{editing.note}</Alert>}

              {conflicts.length > 0 && (
                <Alert severity={conflicts.some((c) => c.blocking) ? 'error' : 'warning'}>
                  <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                    存在 {conflicts.length} 项参数冲突：
                  </Typography>
                  {conflicts.map((c, i) => (
                    <Typography key={`${c.code}-${i}`} variant="body2">
                      · [{c.code}] {c.message}
                      {c.blocking ? '（阻断）' : '（提示）'}
                    </Typography>
                  ))}
                </Alert>
              )}

              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || newValue.trim() === ''}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
