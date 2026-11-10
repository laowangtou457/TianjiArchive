import { useState, type ReactElement, type ReactNode } from 'react';
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
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router-dom';
import { type KbCitation } from '@tianji/shared';
import { kbApi } from '../api';
import { ApiError } from '../api/client';
import { AppLayout } from '../components/AppLayout';
import { ArchiveNo, SecurityChip } from '../components/ArchiveNo';

/**
 * 片段检索页（F-22 A 档：检索增强）。
 *
 * 能力边界（界面上必须如实写出来，不允许含糊）：
 *   - 本页只做**片段检索**：把问题匹配到档案正文片段，返回档号 + 原文 + 密级；
 *   - **不生成任何答案**。后端 `answer` 恒为空、`mode='retrieval'`；
 *   - 未命中时明确显示「无依据」，绝不编造 —— 这是本项目对"不臆造"的硬约束。
 *
 * 权限口径：检索结果只可能包含当前用户有权访问的档案（后端密级 + 数据范围过滤，
 * 且对命中片段回 PG 二次校验），前端不做也不应做越权兜底。
 */
export function KbPage(): ReactElement {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();

  const [question, setQuestion] = useState<string>('');
  const [citations, setCitations] = useState<KbCitation[] | null>(null);
  const [grounded, setGrounded] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['kb-status'],
    queryFn: () => kbApi.status(),
  });

  const askMutation = useMutation({
    mutationFn: async () => {
      if (question.trim().length < 2) throw new Error('请输入至少 2 个字的检索内容');
      return kbApi.query(question.trim(), 8);
    },
    onSuccess: (r) => {
      setCitations(r.citations as KbCitation[]);
      setGrounded(r.grounded);
      setError(null);
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : '检索失败';
      setCitations(null);
      setGrounded(false);
      setError(msg);
    },
  });

  const reindexMutation = useMutation({
    mutationFn: () => kbApi.reindex([]),
    onSuccess: (r) => {
      const msg =
        r.items > 0
          ? `已建立片段索引：${r.items} 个条目 / ${r.indexed} 个片段${r.failed > 0 ? `（失败 ${r.failed}）` : ''}`
          : '没有需要建立索引的条目（索引已是最新）';
      enqueueSnackbar(msg, { variant: r.failed > 0 ? 'warning' : 'info' });
      void qc.invalidateQueries({ queryKey: ['kb-status'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : '索引重建失败');
    },
  });

  const status = statusQuery.data;
  const searching = askMutation.isPending;
  const noResult = citations !== null && citations.length === 0;
  const emptyIndex = status !== undefined && status.indexedChunks === 0;

  return (
    <AppLayout
      title="片段检索"
      subtitle="返回档案正文中的依据片段（档号 + 原文），不生成答案 —— 结论请以原文为准"
      actions={
        <Button
          size="small"
          onClick={() => reindexMutation.mutate()}
          disabled={reindexMutation.isPending}
        >
          {reindexMutation.isPending ? '建立索引中…' : '建立/更新片段索引'}
        </Button>
      }
    >
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Card sx={{ flex: 1, minWidth: 0 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>
              检索依据片段
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                fullWidth
                size="small"
                multiline
                minRows={2}
                placeholder="例如：2023 年办公室关于档案数字化的通知"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) askMutation.mutate();
                }}
              />
              <Button
                variant="contained"
                onClick={() => askMutation.mutate()}
                disabled={searching}
                sx={{ minWidth: 90 }}
              >
                {searching ? <CircularProgress size={16} color="inherit" /> : '检索'}
              </Button>
            </Stack>
            <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
              提示：Ctrl/⌘ + Enter 直接检索。本页只找"哪段原文提到了"，不做问答生成。
            </Typography>

            <Divider sx={{ my: 2 }} />

            {error && (
              <Alert severity="info" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            {emptyIndex && citations === null && (
              <Alert severity="warning" sx={{ mb: 1.5 }}>
                当前尚无片段索引（已索引片段 0）。请先点击右上角「建立/更新片段索引」，
                或等待后台自愈扫描完成后再检索。
              </Alert>
            )}

            {noResult && (
              <Alert severity="info" sx={{ mb: 1.5 }}>
                <strong>无依据</strong>：未在当前可访问的档案正文中检索到相关片段。
                这不代表档案不存在 —— 可能尚未抽取正文，或该内容超出你的访问范围。
                系统不会因此生成推测性答案。
              </Alert>
            )}

            {citations !== null && citations.length > 0 && (
              <>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                  <Typography variant="subtitle2">
                    命中 {citations.length} 段依据
                  </Typography>
                  <Chip
                    size="small"
                    label={grounded ? '有依据（片段检索）' : '无依据'}
                    color={grounded ? 'success' : 'warning'}
                    variant="outlined"
                    sx={{ height: 18 }}
                  />
                </Stack>
                {citations.map((c, idx) => (
                  <Box
                    key={`${c.itemId}-${idx}`}
                    sx={{ p: 1.25, mb: 1, bgcolor: '#f7fafc', borderRadius: 1 }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                      <Typography variant="caption" color="text.secondary">
                        依据 {idx + 1}
                      </Typography>
                      <ArchiveNo value={c.danghao} copyable />
                      <SecurityChip level={c.securityLevel} />
                      <Link
                        component="button"
                        variant="caption"
                        onClick={() => navigate(`/archive/items/${c.itemId}`)}
                      >
                        查看条目
                      </Link>
                    </Stack>
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                      {renderHighlight(c.snippet)}
                    </Typography>
                  </Box>
                ))}
                <Typography variant="caption" color="text.disabled">
                  以上为原文片段，未做改写。引用时请以条目原文为准。
                </Typography>
              </>
            )}

            {citations === null && !error && !emptyIndex && (
              <Box sx={{ py: 6, textAlign: 'center' }}>
                <Typography color="text.secondary">输入关键词或一句话描述，检索档案正文依据</Typography>
                <Typography variant="caption" color="text.disabled">
                  当前为片段检索（词法召回）。语义检索需接入本地向量模型，属后续能力。
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
                  <Row label="检索可用">
                    <Chip
                      size="small"
                      label={status.searchReady ? '可用' : '索引未就绪'}
                      color={status.searchReady ? 'success' : 'default'}
                      variant="outlined"
                      sx={{ height: 18 }}
                    />
                  </Row>
                  <Row label="检索方式">
                    <Typography variant="body2">
                      {status.mode === 'lexical' ? '词法（BM25 + IK）' : '向量相似度'}
                    </Typography>
                  </Row>
                  <Row label="已索引片段">
                    <Typography variant="body2">{status.indexedChunks}</Typography>
                  </Row>
                  <Row label="向量化实现">
                    <Typography variant="body2" className="mono" sx={{ fontSize: 12 }}>
                      {status.embeddingProvider}
                    </Typography>
                  </Row>
                  <Row label="语义检索">
                    <Typography variant="body2" color={status.productionReady ? 'success.main' : 'text.secondary'}>
                      {status.productionReady ? '已启用' : '未启用'}
                    </Typography>
                  </Row>
                  <Divider />
                  <Typography variant="caption" color="text.secondary">
                    检索前按密级与数据范围过滤，命中片段再回库二次校验 ——
                    越权片段不会出现在结果中。
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    本页不生成答案：没有依据时只提示「无依据」，不猜测、不编造。
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

/** 状态行（左标签右值） */
function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

/**
 * 渲染 ES 高亮片段。
 *
 * ES 只插入 `<em class="hl">` 标记，但**不保证转义正文里的 HTML**，因此不能直接
 * `dangerouslySetInnerHTML`。这里按标记切分后逐段作为文本节点渲染，命中部分用
 * `<mark>` 表达——既不丢高亮，也不引入注入面。
 */
function renderHighlight(snippet: string): ReactNode[] {
  const parts = snippet.split(/(<em class="hl">|<\/em>)/g);
  const nodes: ReactNode[] = [];
  let hit = false;
  parts.forEach((part, i) => {
    if (part === '<em class="hl">') {
      hit = true;
      return;
    }
    if (part === '</em>') {
      hit = false;
      return;
    }
    if (part.length === 0) return;
    nodes.push(
      hit ? (
        <Box
          component="mark"
          key={i}
          sx={{ bgcolor: '#fff3bf', color: 'inherit', px: 0.25, borderRadius: 0.5 }}
        >
          {part}
        </Box>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
  });
  return nodes;
}
