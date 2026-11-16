import { useState, type ReactElement } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
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
import {
  SECURITY_LEVEL_LABELS,
  type ElectronicFileDto,
  type RagAskResult,
  type RagChunkHit,
} from '@tianji/shared';
import { fileApi, ragApi } from '../../api';
import { ApiError } from '../../api/client';
import { ArchiveNo } from '../../components/ArchiveNo';
import { FilePreview } from '../../components/FilePreview';

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
  const navigate = useNavigate();
  const [question, setQuestion] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const [result, setResult] = useState<RagAskResult | null>(null);
  const [rawHits, setRawHits] = useState<RagChunkHit[] | null>(null);
  /** 「打开原件」预览中的电子文件 + 要跳转到的正文内容 */
  const [previewFile, setPreviewFile] = useState<ElectronicFileDto | null>(null);
  const [locateText, setLocateText] = useState<string | null>(null);

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

  /**
   * 打开原件：直接弹出在线预览，并跳转到正文中包含引用内容的页/段。
   *
   * 选文件策略：按可定位性排序（EPUB/文本可精确跳转，PDF 次之）；
   * 无可预览原件时退回著录详情页（不再只给一个著录列表页）。
   */
  const openOriginal = async (itemId: string, locate: string): Promise<void> => {
    try {
      const files = await fileApi.listByItem(itemId);
      const order: Record<string, number> = { EBOOK: 0, TEXT: 1, PDF: 2, IMAGE: 3, OFFICE: 4, AUDIO: 5, VIDEO: 6, NONE: 9 };
      const candidates = files
        .filter((f) => f.previewKind !== 'NONE')
        .sort((a, b) => (order[a.previewKind] ?? 8) - (order[b.previewKind] ?? 8));
      if (candidates.length === 0) {
        enqueueSnackbar('该条目暂无电子原件，已转到著录详情页', { variant: 'info' });
        navigate(`/items/${itemId}`);
        return;
      }
      setLocateText(locate);
      setPreviewFile(candidates[0]);
    } catch (err) {
      // 无 FILE 域权限等情况：至少把用户带到能看到条目信息的位置
      enqueueSnackbar(err instanceof ApiError ? err.message : '无法打开原件，已转到著录详情页', {
        variant: 'warning',
      });
      navigate(`/items/${itemId}`);
    }
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
                          component="button"
                          type="button"
                          underline="hover"
                          variant="caption"
                          onClick={() => void openOriginal(c.itemId, c.snippet)}
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
                    <Link
                      component="button"
                      type="button"
                      underline="hover"
                      variant="caption"
                      onClick={() => void openOriginal(h.itemId, h.content)}
                    >
                      打开原件
                    </Link>
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

      {/* ---------------------------------------------------------- 原件预览（直达引用出处） */}
      <FilePreview
        file={previewFile}
        open={Boolean(previewFile)}
        onClose={() => setPreviewFile(null)}
        allowDownload={false}
        locateText={locateText}
      />
    </Stack>
  );
}
