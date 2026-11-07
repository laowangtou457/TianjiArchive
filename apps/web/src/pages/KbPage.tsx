import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { type KbCitation } from '@tianji/shared';
import { kbApi } from '../api';
import { ApiError } from '../api/client';
import { AppLayout } from '../components/AppLayout';
import { ArchiveNo, SecurityChip } from '../components/ArchiveNo';

/**
 * 智能问答页（P2 预留，F-16/F-17）。
 *
 * P0 阶段只提供契约与占位：
 *   - 展示 EmbeddingProvider 状态与索引规模；
 *   - 用户提问时后端先做权限过滤（统计候选数），再返回 KB_NOT_ENABLED（501）；
 *   - 前端如实提示「未启用」，绝不编造答案 —— 这是本项目对"不臆造"的硬约束。
 */
export function KbPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [question, setQuestion] = useState<string>('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [citations, setCitations] = useState<KbCitation[]>([]);
  const [grounded, setGrounded] = useState<boolean>(false);
  const [candidateCount, setCandidateCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['kb-status'],
    queryFn: () => kbApi.status(),
  });

  const askMutation = useMutation({
    mutationFn: async () => {
      if (question.trim().length < 3) throw new Error('请输入至少 3 个字的提问');
      return kbApi.query(question.trim());
    },
    onSuccess: (r) => {
      setAnswer(r.answer);
      setCitations(r.citations as KbCitation[]);
      setGrounded(r.grounded);
      setError(null);
    },
    onError: (err: unknown) => {
      // 后端 501 会带「候选 N 篇」，从 message 里提取展示，保证信息透明
      const msg = err instanceof ApiError ? err.message : '问答失败';
      setAnswer(null);
      setCitations([]);
      setGrounded(false);
      const m = /候选\s*(\d+)/.exec(msg);
      setCandidateCount(m && m[1] ? Number(m[1]) : null);
      setError(msg);
    },
  });

  const reindexMutation = useMutation({
    mutationFn: () => kbApi.reindex([]),
    onSuccess: (r) => {
      enqueueSnackbar(
        r.indexed > 0 ? `向量索引重建完成：${r.indexed} 片段` : 'P0 阶段无可重建的向量索引',
        { variant: 'info' },
      );
      void qc.invalidateQueries({ queryKey: ['kb-status'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : '索引重建失败');
    },
  });

  const status = statusQuery.data;

  return (
    <AppLayout
      title="智能问答"
      subtitle="P2 预留能力 · 当前仅提供接口契约与权限过滤占位，不会生成未经验证的答案"
      actions={
        <Button
          size="small"
          onClick={() => reindexMutation.mutate()}
          disabled={reindexMutation.isPending}
        >
          重建向量索引
        </Button>
      }
    >
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Card sx={{ flex: 1, minWidth: 0 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>
              提问
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                fullWidth
                size="small"
                multiline
                minRows={2}
                placeholder="例如：2023 年办公室关于档案数字化的通知有哪些？"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <Button
                variant="contained"
                onClick={() => askMutation.mutate()}
                disabled={askMutation.isPending}
                sx={{ minWidth: 90 }}
              >
                {askMutation.isPending ? <CircularProgress size={16} color="inherit" /> : '提问'}
              </Button>
            </Stack>

            <Divider sx={{ my: 2 }} />

            {error && (
              <Alert severity="info" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
                {error}
                {candidateCount !== null && (
                  <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                    说明：权限过滤后共有 {candidateCount} 篇档案可被检索，但向量索引尚未启用，
                    因此本次不返回答案（避免编造）。
                  </Typography>
                )}
              </Alert>
            )}

            {answer && (
              <Box sx={{ mb: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="subtitle2">回答</Typography>
                  <Chip
                    size="small"
                    label={grounded ? '有依据' : '无依据（请谨慎参考）'}
                    color={grounded ? 'success' : 'warning'}
                    variant="outlined"
                    sx={{ height: 18 }}
                  />
                </Stack>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                  {answer}
                </Typography>
              </Box>
            )}

            {citations.length > 0 && (
              <>
                <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                  引用来源
                </Typography>
                {citations.map((c) => (
                  <Box
                    key={c.itemId}
                    sx={{ p: 1, mb: 0.75, bgcolor: '#f7fafc', borderRadius: 1 }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center">
                      <ArchiveNo value={c.danghao} copyable />
                      <SecurityChip level={c.securityLevel} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {c.snippet}
                    </Typography>
                  </Box>
                ))}
              </>
            )}

            {!answer && !error && (
              <Box sx={{ py: 6, textAlign: 'center' }}>
                <Typography color="text.secondary">
                  当前为 P2 预留能力，尚未启用向量检索与生成式问答
                </Typography>
                <Typography variant="caption" color="text.disabled">
                  启用条件：配置 EmbeddingProvider（生产可用）+ VectorStore，
                  并将 kb.enabled 参数置为 true
                </Typography>
              </Box>
            )}
          </CardContent>
        </Card>

        <Box sx={{ width: 300, flex: '0 0 300px' }}>
          <Card>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1 }}>
                能力状态
              </Typography>
              {statusQuery.isLoading && <CircularProgress size={18} />}
              {status && (
                <Stack spacing={1}>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">
                      是否启用
                    </Typography>
                    <Chip
                      size="small"
                      label={status.enabled ? '已启用' : '未启用'}
                      color={status.enabled ? 'success' : 'default'}
                      variant="outlined"
                      sx={{ height: 18 }}
                    />
                  </Stack>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">
                      向量化实现
                    </Typography>
                    <Typography variant="body2" className="mono">
                      {status.embeddingProvider}
                    </Typography>
                  </Stack>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">
                      向量维度
                    </Typography>
                    <Typography variant="body2">{status.dimension}</Typography>
                  </Stack>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">
                      已索引片段
                    </Typography>
                    <Typography variant="body2">{status.indexedChunks}</Typography>
                  </Stack>
                  <Divider />
                  <Typography variant="caption" color="text.secondary">
                    说明：P0 使用本地哈希向量（dim=256）仅用于验证管线；
                    生产环境应替换为正式 Embedding 服务并开启答案溯源。
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    权限口径：检索 / 预览 / 问答三处共用 AccessFilterBuilder，
                    问答结果只会包含当前用户有权访问的档案。
                  </Typography>
                </Stack>
              )}
            </CardContent>
          </Card>
        </Box>
      </Stack>
    </AppLayout>
  );
}
