import { type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ragApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';
import { SmartQaPanel } from './SmartQaPanel';

/**
 * 档案知识库（P4 RAG / Wiki）。
 *
 * 三个区块：
 *   1) 引擎状态：向量库形态、嵌入/生成模型是否可用、已建块数 —— 「能不能用」先讲清楚；
 *   2) 智能问答：检索增强 + 引用溯源（与综合检索页「智能问答」选项卡共用 SmartQaPanel）；
 *   3) 主题聚合：在 SmartQaPanel 内部（showTopics），点词即问。
 *
 * 降级路径对用户可见：模型不可用时会明确说「这是检索摘录，不是模型归纳」，
 * 绝不把检索结果包装成 AI 结论。
 */
export function KnowledgePage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const statusQuery = useQuery({ queryKey: ['rag-status'], queryFn: ragApi.status });

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

        {/* --------------------------------- 智能问答 + 主题聚合（共用面板） */}
        <SmartQaPanel showTopics />
      </Stack>
    </AppLayout>
  );
}
