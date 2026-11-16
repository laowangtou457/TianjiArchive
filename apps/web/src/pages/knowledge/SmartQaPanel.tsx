import { useState, type ReactElement } from 'react';
import { useMutation } from '@tanstack/react-query';
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
import { useQuery } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { SECURITY_LEVEL_LABELS, type RagAskResult, type RagChunkHit } from '@tianji/shared';
import { ragApi } from '../../api';
import { ApiError } from '../../api/client';
import { ArchiveNo } from '../../components/ArchiveNo';

/**
 * 智能问答面板（检索增强 + 引用溯源）。
 *
 * 复用点：知识库页（/knowledge）与综合检索页「智能问答」选项卡共用同一实现，
 * 保证两处行为一致 —— 回答只依据有权访问的档案片段，并给出档号引用。
 *
 * showTopics=true 时附「主题聚合」卡片（点词即问），供知识库页使用；
 * 综合检索页的选项卡只保留问答本体，不带主题聚合。
 */
export function SmartQaPanel(options: { showTopics?: boolean }): ReactElement {
  const { showTopics = false } = options;
  const { enqueueSnackbar } = useSnackbar();
  const [question, setQuestion] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const [result, setResult] = useState<RagAskResult | null>(null);
  const [rawHits, setRawHits] = useState<RagChunkHit[] | null>(null);

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

  const busy = askMutation.isPending || retrieveMutation.isPending;

  const ask = (q: string): void => {
    const text = q.trim();
    if (text.length === 0) return;
    setQuestion(text);
    askMutation.mutate(text);
  };

  return (
    <Stack spacing={2}>
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

      {/* ---------------------------------------------------------- 主题聚合（可选） */}
      {showTopics && (
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
      )}
    </Stack>
  );
}
