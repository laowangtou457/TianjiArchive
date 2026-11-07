import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import {
  DANGHAO_SEGMENT_LABELS,
  DANGHAO_SEGMENT_VALUES,
  DEFAULT_DANGHAO_TEMPLATE,
  RESET_CYCLE_LABELS,
  ResetCycle,
  describeTemplate,
  isSerialSegment,
  renderDanghao,
  validateTemplate,
  type DanghaoSegment,
  type DanghaoSegmentType,
  type DanghaoTemplate,
} from '@tianji/shared';
import { danghaoApi, fondsApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

/**
 * 段类型中文名（与共享常量同源，此处仅做展示增强）。
 */
const SEGMENT_LABELS: Record<DanghaoSegmentType, string> = {
  ...DANGHAO_SEGMENT_LABELS,
  CATALOG: '目录号/门类',
  VOLUME: '案卷号（流水）',
  ITEM: '件号（流水）',
};

/** 默认段编排：全宗号-年度-机构-保管期限-卷号-件号 */
const DEFAULT_SEGMENTS: DanghaoSegment[] = DEFAULT_DANGHAO_TEMPLATE.segments.map((s) => ({ ...s }));

/**
 * 档号规则配置页（F-02，DA/T 22-2015 §5.3）。
 *
 * 关键约定：
 *   1. 模板必须包含至少一个流水段（VOLUME / ITEM），流水段之后只允许流水段或纯字面量段；
 *   2. 规则变更只影响新著录（"新号新规则"），历史档号不可变；
 *   3. 右侧「服务端试算」调用后端 peek 接口，不消耗序列号。
 */
export function RuleConfigPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [fondsId, setFondsId] = useState<string>('');
  const [segments, setSegments] = useState<DanghaoSegment[]>(DEFAULT_SEGMENTS);
  const [separator, setSeparator] = useState<string>('-');
  const [resetCycle, setResetCycle] = useState<ResetCycle>('YEAR');
  const [previewYear, setPreviewYear] = useState<number>(new Date().getFullYear());
  const [preview, setPreview] = useState<{ volume: string; items: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fondsQuery = useQuery({ queryKey: ['fonds'], queryFn: () => fondsApi.list() });
  const rulesQuery = useQuery({
    queryKey: ['danghao-rules', fondsId],
    queryFn: () => danghaoApi.list(fondsId || undefined),
  });

  const template: DanghaoTemplate = useMemo(
    () => ({ segments, separator }),
    [segments, separator],
  );

  /** 与后端完全同源的模板校验 */
  const errors: string[] = useMemo(() => validateTemplate(template), [template]);
  const isValid: boolean = errors.length === 0;

  /** 前端本地试算（占位序列值 12/7，仅用于直观预览形状） */
  const localPreview: string = useMemo(() => {
    try {
      return renderDanghao(
        template,
        {
          fondsNo: 'A036',
          catalogNo: 'WS',
          year: previewYear,
          orgCode: 'ZHC',
          retentionCode: 'Y',
          volumeNo: 12,
          itemNo: 7,
        },
        { strict: false },
      );
    } catch {
      return '（模板不完整，无法生成）';
    }
  }, [template, previewYear]);

  /** 保存规则 */
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!fondsId) throw new Error('请先选择适用全宗');
      if (!isValid) throw new Error(errors.join('；'));
      return danghaoApi.create({
        fondsId,
        categoryId: null,
        segments,
        separator,
        resetCycle,
        zeroPad: 4,
        active: true,
      });
    },
    onSuccess: () => {
      enqueueSnackbar('档号规则已保存（仅对新著录生效）', { variant: 'success' });
      setError(null);
      void qc.invalidateQueries({ queryKey: ['danghao-rules'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  /** 服务端试算（不消耗序列） */
  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!fondsId) throw new Error('请先选择适用全宗');
      return danghaoApi.preview({
        fondsId,
        year: previewYear,
        retentionCode: 'Y',
        count: 5,
      });
    },
    onSuccess: (r) => {
      setPreview({ volume: r.volumeDanghao, items: r.itemDanghaos });
      setError(null);
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : '试算失败');
    },
  });

  /** 更新某段的局部字段 */
  const updateSegment = (index: number, patch: Partial<DanghaoSegment>): void => {
    setSegments((prev) => prev.map((seg, i) => (i === index ? { ...seg, ...patch } : seg)));
  };

  /** 追加段：流水段默认补零 4 位，其余段默认不固定值 */
  const addSegment = (type: DanghaoSegmentType): void => {
    setSegments((prev) => [...prev, { type, pad: isSerialSegment(type) ? 4 : 0 }]);
  };

  /** 删除段 */
  const removeSegment = (index: number): void => {
    setSegments((prev) => prev.filter((_, i) => i !== index));
  };

  /** 段说明文案 */
  const segmentHint = (type: DanghaoSegmentType): string => {
    if (type === 'YEAR') return '取著录年度四位数，补零 4 位';
    if (type === 'RETENTION') return '取保管期限代码 Y / 30 / 10';
    if (type === 'VOLUME' || type === 'ITEM') return '流水段：补零位数决定序号宽度';
    if (type === 'FONDS') return '取全宗号，如 A036';
    if (type === 'CATALOG') return '取目录号或门类代码';
    return '取机构代码，如 BGS';
  };

  return (
    <AppLayout
      title="档号规则配置"
      subtitle="DA/T 22-2015 §5.3 · 规则变更仅影响新著录，历史档号不可变"
      actions={
        <PermGate domain="DANGHAO_RULE" op="WRITE">
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              onClick={() => previewMutation.mutate()}
              disabled={!fondsId || previewMutation.isPending}
            >
              服务端试算
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => saveMutation.mutate()}
              disabled={!fondsId || !isValid || saveMutation.isPending}
            >
              保存规则
            </Button>
          </Stack>
        </PermGate>
      }
    >
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Card sx={{ flex: 1, minWidth: 0 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              模板编排
            </Typography>

            <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
              <TextField
                select
                size="small"
                label="适用全宗 *"
                value={fondsId}
                onChange={(e) => setFondsId(e.target.value)}
                sx={{ width: 240 }}
              >
                {(fondsQuery.data ?? []).map((f) => (
                  <MenuItem key={f.id} value={f.id}>
                    {f.fondsNo} {f.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                label="分隔符"
                value={separator}
                onChange={(e) => setSeparator(e.target.value.slice(0, 2))}
                sx={{ width: 100 }}
                helperText="不能含字母数字"
              />
              <TextField
                select
                size="small"
                label="流水重置周期"
                value={resetCycle}
                onChange={(e) => setResetCycle(e.target.value as ResetCycle)}
                sx={{ width: 170 }}
              >
                {(Object.keys(RESET_CYCLE_LABELS) as ResetCycle[]).map((c) => (
                  <MenuItem key={c} value={c}>
                    {RESET_CYCLE_LABELS[c]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                label="试算年度"
                type="number"
                value={previewYear}
                onChange={(e) => setPreviewYear(Number(e.target.value) || new Date().getFullYear())}
                sx={{ width: 130 }}
              />
            </Stack>

            <Divider sx={{ mb: 1.5 }} />

            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, bgcolor: '#f7fafc' }}>
              <Typography variant="caption" color="text.secondary">
                本地形状预览（占位序列：卷 12 / 件 7）
              </Typography>
              <Typography className="mono" sx={{ fontSize: 16, mt: 0.5 }}>
                {localPreview}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {describeTemplate(template)}
              </Typography>
            </Paper>

            <Table size="small" className="dense-table">
              <TableHead>
                <TableRow>
                  <TableCell width={44}>#</TableCell>
                  <TableCell width={170}>段类型</TableCell>
                  <TableCell width={110}>补零位数</TableCell>
                  <TableCell width={130}>前缀字面量</TableCell>
                  <TableCell width={140}>固定值</TableCell>
                  <TableCell>说明</TableCell>
                  <TableCell width={64}>操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {segments.map((seg, idx) => (
                  <TableRow key={`${seg.type}-${idx}`}>
                    <TableCell>{idx + 1}</TableCell>
                    <TableCell>
                      <TextField
                        select
                        size="small"
                        value={seg.type}
                        onChange={(e) =>
                          updateSegment(idx, { type: e.target.value as DanghaoSegmentType })
                        }
                        fullWidth
                      >
                        {DANGHAO_SEGMENT_VALUES.map((t) => (
                          <MenuItem key={t} value={t}>
                            {SEGMENT_LABELS[t]}
                          </MenuItem>
                        ))}
                      </TextField>
                    </TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        type="number"
                        value={seg.pad ?? 0}
                        onChange={(e) =>
                          updateSegment(idx, { pad: Math.max(0, Number(e.target.value) || 0) })
                        }
                        inputProps={{ min: 0, max: 10 }}
                        fullWidth
                      />
                    </TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        value={seg.literal ?? ''}
                        onChange={(e) => updateSegment(idx, { literal: e.target.value })}
                        placeholder="如 D / N"
                        fullWidth
                      />
                    </TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        value={seg.fixed ?? ''}
                        onChange={(e) => updateSegment(idx, { fixed: e.target.value })}
                        placeholder="如 WS"
                        fullWidth
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {segmentHint(seg.type)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Button size="small" color="error" onClick={() => removeSegment(idx)}>
                        删除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
              <Typography
                variant="caption"
                sx={{ alignSelf: 'center', color: 'text.secondary' }}
              >
                添加段：
              </Typography>
              {DANGHAO_SEGMENT_VALUES.map((t) => (
                <Chip
                  key={t}
                  label={SEGMENT_LABELS[t]}
                  onClick={() => addSegment(t)}
                  variant="outlined"
                  size="small"
                />
              ))}
            </Stack>

            {!isValid && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  模板校验未通过
                </Typography>
                {errors.map((msg, i) => (
                  <Typography key={`${msg}-${i}`} variant="caption" display="block">
                    · {msg}
                  </Typography>
                ))}
              </Alert>
            )}
            {error && (
              <Alert severity="error" sx={{ mt: 1.5 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
          </CardContent>
        </Card>

        <Box sx={{ width: 340, flex: '0 0 340px' }}>
          <Card sx={{ mb: 1.5 }}>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1 }}>
                服务端试算结果
              </Typography>
              {!preview && (
                <Typography variant="body2" color="text.secondary">
                  选择全宗后点击「服务端试算」，展示真实序列的下一个档号（不占用号）。
                </Typography>
              )}
              {preview && (
                <Stack spacing={1}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      案卷档号
                    </Typography>
                    <Typography className="mono" sx={{ fontSize: 15 }}>
                      {preview.volume || '（模板无卷号段）'}
                    </Typography>
                  </Box>
                  <Divider />
                  <Typography variant="caption" color="text.secondary">
                    件级档号（连续 5 个）
                  </Typography>
                  {preview.items.map((d, i) => (
                    <Typography key={`${d}-${i}`} className="mono">
                      {d}
                    </Typography>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1 }}>
                全宗已有规则
              </Typography>
              {(rulesQuery.data ?? []).length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  暂无规则（未配置时使用系统默认模板）
                </Typography>
              )}
              {(rulesQuery.data ?? []).map((r) => (
                <Box key={r.id} sx={{ mb: 1, p: 1, bgcolor: '#f7fafc', borderRadius: 1 }}>
                  <Typography variant="caption" className="mono" display="block">
                    {describeTemplate({ segments: r.segments, separator: r.separator })}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {RESET_CYCLE_LABELS[r.resetCycle] ?? r.resetCycle} ·{' '}
                    {r.active ? '启用' : '停用'}
                  </Typography>
                </Box>
              ))}
              <Divider sx={{ my: 1 }} />
              <Typography variant="caption" color="text.secondary">
                并发取号由数据库原子自增 + 唯一索引双重保障，压测脚本见
                apps/api/src/scripts/danghao-concurrency-bench.ts。
              </Typography>
            </CardContent>
          </Card>
        </Box>
      </Stack>
    </AppLayout>
  );
}
