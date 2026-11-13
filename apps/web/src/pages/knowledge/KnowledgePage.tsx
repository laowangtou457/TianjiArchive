import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { SECURITY_LEVEL_LABELS, type RagAskResult, type RagChunkHit } from '@tianji/shared';
import { ragApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { ArchiveNo } from '../../components/ArchiveNo';
import { PermGate } from '../../components/PermGate';

/**
 * 档案知识库（P4 RAG / Wiki）。
 *
 * 三个区块：
 *   1) 引擎状态：向量库形态、嵌入/生成模型是否可用、已建块数 —— 「能不能用」先讲清楚；
 *   2) 智能问答：检索增强 + 引用溯源（每个结论都能点回原档，这是档案问答的底线）；
 *   3) 主题聚合：按主题词看馆藏分布，点词即问。
 *
 * 降级路径对用户可见：模型不可用时会明确说「这是检索摘录，不是模型归纳」，
 * 绝不把检索结果包装成 AI 结论。
 */
export function KnowledgePage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [question, setQuestion] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const [result, setResult] = useState<RagAskResult | null>(null);
  const [rawHits, setRawHits] = useState<RagChunkHit[] | null>(null);

  const statusQuery = useQuery({ queryKey: ['rag-status'], queryFn: ragApi.status });
  const topicsQuery = useQuery({ queryKey: ['wiki-topics'], queryFn: () => ragApi.topics(36) });

  const askMutation = useMutation({
    mutationFn: (q: string) => ragApi.ask(q, 6),
    onSuccess: (res, q) => {
      setResult(res);
      setRawHits(null);
      setLastQuery(q);
      if (res.degraded) {
        enqueueSnackbar('生成模型不可用，已返回检索摘录（未经归纳）', { variant: 'warning' });
      }
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '问答失败', { variant: 'error' }),
  });

  const retrieveMutation = useMutation({
    mutationFn: (q: string) => ragApi.retrieve(q, 8),
    onSuccess: (res, q) => {
      setRawHits(res.hits);
      setResult(null);
      setLastQuery(q);
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '检索失败', { variant: 'error' }),
  });

  const reindexMutation = useMutation({
    mutationFn: () => ragApi.reindex({ limit: 200 }),
    onSuccess: (r) => {
      enqueueSnackbar(`本次建库：${r.items} 件 / ${r.chunks} 块（耗时 ${Math.round(r.tookMs / 1000)}s）`, {
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['rag-status'] });
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '建库失败', { variant: 'error' }),
  });

  const status = statusQuery.data;
  const busy = askMutation.isPending || retrieveMutation.isPending;

  const ask = (q: string): void => {
    const text = q.trim();
    if (text.length === 0) return;
    setQuestion(text);
    askMutation.mutate(text);
  };

  return (
    <AppLayout title="档案知识库">
      <Stack spacing={2}>
        {/* ---------------------------------------------------------- 引擎状态 */}
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
            <Stack spacing={0.3}>
              <Typography variant="subtitle2">检索引擎</Typography>
              <Stack direction="row" spacing={0.5}>
                <Chip
                  size="small"
                  label={status?.vectorStore === 'PGVECTOR' ? 'pgvector' : '数组回退'}
                  color={status?.vectorStore === 'PGVECTOR' ? 'success' : 'warning'}
                />
                <Chip
                  size="small"
                  label={`嵌入 ${status?.embeddingModel ?? '-'}`}
                  color={status?.embeddingAvailable ? 'success' : 'default'}
                />
                <Chip
                  size="small"
                  label={`生成 ${status?.llmModel ?? '-'}`}
                  color={status?.llmAvailable ? 'success' : 'default'}
                />
              </Stack>
            </Stack>
            <Divider orientation="vertical" flexItem />
            <Stack spacing={0.3}>
              <Typography variant="subtitle2">已建向量</Typography>
              <Typography variant="body2" color="text.secondary">
                {status?.itemCount ?? 0} 件 / {status?.chunkCount ?? 0} 块
                {status?.lastIndexedAt
                  ? `｜最近 ${new Date(status.lastIndexedAt).toLocaleString()}`
                  : '｜尚未建库'}
              </Typography>
            </Stack>
            <Box sx={{ flex: 1 }} />
            <PermGate domain="PARAM" op="WRITE">
              <Button
                variant="outlined"
                size="small"
                disabled={reindexMutation.isPending}
                onClick={() => reindexMutation.mutate()}
              >
                {reindexMutation.isPending ? '建库中…' : '增量建库（200 件）'}
              </Button>
            </PermGate>
          </Stack>
          {status && !status.embeddingAvailable && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              嵌入模型不可用：问答会降级为全文词法召回 + 抽取式摘要。
              检查 Ollama 是否运行、模型是否已拉取（当前期望 {status.embeddingModel}）。
            </Alert>
          )}
        </Card>

        {/* ---------------------------------------------------------- 问答 */}
        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            智能问答
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              fullWidth
              size="small"
              placeholder="例如：馆藏里关于电子文件四性检测的要求有哪些？"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) ask(question);
              }}
            />
            <Button variant="contained" disabled={busy} onClick={() => ask(question)}>
              提问
            </Button>
            <Button
              variant="outlined"
              disabled={busy}
              onClick={() => {
                const q = question.trim();
                if (q) retrieveMutation.mutate(q);
              }}
            >
              只看片段
            </Button>
          </Stack>

          {busy && (
            <Box sx={{ mt: 2 }}>
              <LinearProgress />
              <Typography variant="caption" color="text.secondary">
                正在检索并生成（8B 模型约 5–15 秒）
              </Typography>
            </Box>
          )}

          {result && !busy && (
            <Box sx={{ mt: 2 }}>
              {result.degraded && (
                <Alert severity="warning" sx={{ mb: 1.5 }}>
                  {result.note ?? '生成模型不可用，以下为检索摘录'}
                </Alert>
              )}
              <Card variant="outlined" sx={{ p: 2, bgcolor: 'action.hover' }}>
                <Typography
                  variant="body1"
                  sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.9, fontSize: '0.95rem' }}
                >
                  {result.answer}
                </Typography>
              </Card>
              <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
                <Chip size="small" label={result.mode === 'VECTOR' ? '向量+词法混合召回' : '词法召回'} />
                <Chip size="small" label={`${Math.round(result.tookMs / 100) / 10}s`} />
                {result.model && <Chip size="small" label={result.model} />}
              </Stack>
              {result.citations.length > 0 && (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Typography variant="subtitle2" sx={{ mb: 1 }}>
                    依据（{result.citations.length}）
                  </Typography>
                  <Stack spacing={1}>
                    {result.citations.map((c) => (
                      <Card key={`${c.itemId}-${c.chunkNo}`} variant="outlined" sx={{ p: 1.5 }}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Chip size="small" label={`[${c.index}]`} />
                          <ArchiveNo value={c.danghao} />
                          <Typography variant="body2" sx={{ flex: 1 }} noWrap>
                            {c.title}
                          </Typography>
                          <Link
                            href={`/catalog?item=${c.itemId}`}
                            underline="hover"
                            variant="caption"
                          >
                            打开原件
                          </Link>
                        </Stack>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                          {c.snippet}…
                        </Typography>
                      </Card>
                    ))}
                  </Stack>
                </>
              )}
            </Box>
          )}

          {rawHits && !busy && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                检索片段（{rawHits.length}）
              </Typography>
              <Stack spacing={1}>
                {rawHits.map((h) => (
                  <Card key={h.chunkId} variant="outlined" sx={{ p: 1.5 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip size="small" label={h.score.toFixed(2)} />
                      <ArchiveNo value={h.danghao} />
                      <Typography variant="body2" sx={{ flex: 1 }} noWrap>
                        {h.title}
                      </Typography>
                      <Chip size="small" label={SECURITY_LEVEL_LABELS[h.securityLevel]} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      {h.content.slice(0, 220)}…
                    </Typography>
                  </Card>
                ))}
                {rawHits.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    没有命中片段（未建库或语义/词法都不匹配）
                  </Typography>
                )}
              </Stack>
            </Box>
          )}

          {!result && !rawHits && !busy && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              问一句试试。回答只依据您有权访问的档案片段，并给出档号引用。
            </Typography>
          )}
          {lastQuery && (result || rawHits) && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              上一次查询：{lastQuery}
            </Typography>
          )}
        </Card>

        {/* ---------------------------------------------------------- 主题聚合 */}
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="subtitle1">主题聚合</Typography>
            <Typography variant="caption" color="text.secondary">
              按主题词看您可访问范围内的馆藏分布，点词直接提问
            </Typography>
          </Stack>
          {topicsQuery.isLoading && <CircularProgress size={20} sx={{ mt: 2 }} />}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
            {(topicsQuery.data ?? []).map((t) => (
              <Chip
                key={t.keyword}
                label={`${t.keyword} · ${t.count}`}
                onClick={() => ask(`关于「${t.keyword}」的档案有哪些内容？`)}
                variant="outlined"
                title={t.sampleTitles.join(' / ')}
              />
            ))}
            {(topicsQuery.data ?? []).length === 0 && !topicsQuery.isLoading && (
              <Typography variant="body2" color="text.secondary">
                暂无主题词数据（条目未著录主题词）
              </Typography>
            )}
          </Box>
        </Card>
      </Stack>
    </AppLayout>
  );
}
