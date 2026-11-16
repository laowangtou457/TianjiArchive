import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { SECURITY_LEVEL_LABELS, type WikiPageDto, type WikiPageTreeNode } from '@tianji/shared';
import { wikiPageApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

/**
 * 知识 Wiki（可编辑页面库）。
 *
 * 三栏：空间列表 → 页面树 → 页面视图/编辑 + 版本 + Wiki 问答。
 * Markdown 用轻量自渲染（标题/列表/粗体/代码/引用），不引第三方库 ——
 * 页面正文以中文段落为主，复杂排版需求交由档案正文预览承担。
 */
export function WikiHomePage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [question, setQuestion] = useState('');
  const [askResult, setAskResult] = useState<Awaited<ReturnType<typeof wikiPageApi.ask>> | null>(null);

  const spacesQuery = useQuery({ queryKey: ['wiki-spaces'], queryFn: wikiPageApi.listSpaces });
  const treeQuery = useQuery({
    queryKey: ['wiki-tree', spaceId],
    queryFn: () => wikiPageApi.pageTree(spaceId!),
    enabled: Boolean(spaceId),
  });
  const pageQuery = useQuery({
    queryKey: ['wiki-page', pageId],
    queryFn: () => wikiPageApi.getPage(pageId!),
    enabled: Boolean(pageId),
  });
  const versionsQuery = useQuery({
    queryKey: ['wiki-versions', pageId],
    queryFn: () => wikiPageApi.versions(pageId!),
    enabled: Boolean(pageId) && showVersions,
  });
  const indexStatusQuery = useQuery({ queryKey: ['wiki-index'], queryFn: wikiPageApi.indexStatus });

  const errText = (err: unknown): string => (err instanceof ApiError ? err.message : '操作失败');

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['wiki-spaces'] });
    void qc.invalidateQueries({ queryKey: ['wiki-tree', spaceId] });
    void qc.invalidateQueries({ queryKey: ['wiki-page', pageId] });
    void qc.invalidateQueries({ queryKey: ['wiki-versions', pageId] });
    void qc.invalidateQueries({ queryKey: ['wiki-index'] });
  };

  const askMutation = useMutation({
    mutationFn: (q: string) => wikiPageApi.ask(q, spaceId ?? undefined),
    onSuccess: (r) => setAskResult(r),
    onError: (err) => enqueueSnackbar(errText(err), { variant: 'error' }),
  });
  const reindexMutation = useMutation({
    mutationFn: wikiPageApi.reindex,
    onSuccess: (r) => {
      enqueueSnackbar(`Wiki 向量重建：${r.pages} 页 / ${r.chunks} 块`, { variant: 'success' });
      invalidate();
    },
    onError: (err) => enqueueSnackbar(errText(err), { variant: 'error' }),
  });
  const deletePageMutation = useMutation({
    mutationFn: wikiPageApi.deletePage,
    onSuccess: (r) => {
      enqueueSnackbar(`已删除 ${r.deleted} 个页面（含子页）`, { variant: 'success' });
      setPageId(null);
      setEditing(false);
      invalidate();
    },
    onError: (err) => enqueueSnackbar(errText(err), { variant: 'error' }),
  });
  const restoreMutation = useMutation({
    mutationFn: (v: { id: string; versionNo: number }) =>
      wikiPageApi.restoreVersion(v.id, v.versionNo),
    onSuccess: () => {
      enqueueSnackbar('已回滚到所选版本', { variant: 'success' });
      setShowVersions(false);
      invalidate();
    },
    onError: (err) => enqueueSnackbar(errText(err), { variant: 'error' }),
  });

  const spaces = spacesQuery.data ?? [];
  const page = pageQuery.data ?? null;

  return (
    <AppLayout title="知识 Wiki" subtitle="编研知识页面库 · 空间/页面树/版本回滚 · 内容可向量问答">
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        {/* 左栏：空间 */}
        <Card variant="outlined" sx={{ width: 210, flex: '0 0 210px' }}>
          <Stack sx={{ p: 1.25 }} spacing={0.75}>
            <Typography variant="subtitle2">空间</Typography>
            {spacesQuery.isLoading && <CircularProgress size={18} />}
            {spaces.map((s) => (
              <Box
                key={s.id}
                sx={{
                  px: 1, py: 0.75, borderRadius: 1, cursor: 'pointer',
                  bgcolor: s.id === spaceId ? 'action.selected' : 'transparent',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
                onClick={() => {
                  setSpaceId(s.id);
                  setPageId(null);
                  setEditing(false);
                  setAskResult(null);
                }}
              >
                <Stack direction="row" alignItems="center" spacing={0.75}>
                  <Typography variant="body2" sx={{ flex: 1 }} noWrap>
                    {s.name}
                  </Typography>
                  <Chip
                    size="small"
                    label={SECURITY_LEVEL_LABELS[s.securityLevel]}
                    color={s.securityLevel === 'SECRET' ? 'error' : s.securityLevel === 'INTERNAL' ? 'warning' : 'success'}
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {s.pageCount} 页
                </Typography>
              </Box>
            ))}
            <PermGate domain="WIKI" op="WRITE">
              <NewSpaceButton onDone={invalidate} />
            </PermGate>
          </Stack>
        </Card>

        {/* 中栏：页面树 */}
        <Card variant="outlined" sx={{ width: 260, flex: '0 0 260px' }}>
          <Stack sx={{ p: 1.25 }} spacing={0.5}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="subtitle2" sx={{ flex: 1 }}>
                页面
              </Typography>
              {spaceId && (
                <PermGate domain="WIKI" op="WRITE">
                  <Button
                    size="small"
                    onClick={async () => {
                      const title = window.prompt('新页面标题：');
                      if (!title) return;
                      try {
                        const p = await wikiPageApi.createPage({ spaceId: spaceId!, title });
                        invalidate();
                        setPageId(p.id);
                        setEditing(true);
                      } catch (err) {
                        enqueueSnackbar(errText(err), { variant: 'error' });
                      }
                    }}
                  >
                    新建
                  </Button>
                </PermGate>
              )}
            </Stack>
            {!spaceId && (
              <Typography variant="caption" color="text.secondary">
                先在左侧选择一个空间
              </Typography>
            )}
            {treeQuery.isLoading && <CircularProgress size={18} />}
            {(treeQuery.data ?? []).map((n) => (
              <TreeNodeView
                key={n.id}
                node={n}
                activeId={pageId}
                depth={0}
                onOpen={(id) => {
                  setPageId(id);
                  setEditing(false);
                  setAskResult(null);
                }}
                onAddChild={async (parent) => {
                  const title = window.prompt('子页面标题：');
                  if (!title) return;
                  try {
                    const p = await wikiPageApi.createPage({ spaceId: spaceId!, parentId: parent, title });
                    invalidate();
                    setPageId(p.id);
                    setEditing(true);
                  } catch (err) {
                    enqueueSnackbar(errText(err), { variant: 'error' });
                  }
                }}
              />
            ))}
            {spaceId && !treeQuery.isLoading && (treeQuery.data ?? []).length === 0 && (
              <Typography variant="caption" color="text.secondary">
                空空间，点「新建」开始
              </Typography>
            )}
          </Stack>
        </Card>

        {/* 右栏：页面视图 / 编辑 / 问答 */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack spacing={1.5}>
            {!page && (
              <Card variant="outlined" sx={{ p: 3 }}>
                <Typography variant="body2" color="text.secondary">
                  {spaceId
                    ? '从中间的页面树选择一个页面，或新建。'
                    : '「知识 Wiki」是人写的编研知识库：空间 → 页面树 → Markdown 正文，保存即留版本，内容可向量问答。'}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
                  {indexStatusQuery.data && (
                    <Chip
                      size="small"
                      label={`向量：${indexStatusQuery.data.chunkCount} 块 / 已嵌入 ${indexStatusQuery.data.embeddedCount}`}
                    />
                  )}
                  <PermGate domain="WIKI" op="WRITE">
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={reindexMutation.isPending}
                      onClick={() => reindexMutation.mutate()}
                    >
                      {reindexMutation.isPending ? '重建中…' : '重建 Wiki 向量'}
                    </Button>
                  </PermGate>
                </Stack>
              </Card>
            )}

            {page && editing && (
              <PageEditor
                page={page}
                spaceId={spaceId ?? page.spaceId}
                onDone={() => {
                  setEditing(false);
                  invalidate();
                }}
                onCancel={() => setEditing(false)}
              />
            )}

            {page && !editing && (
              <Card variant="outlined" sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="h6" sx={{ flex: 1, minWidth: 200 }}>
                    {page.title}
                  </Typography>
                  <Chip size="small" label={`v${page.versionNo}`} />
                  <PermGate domain="WIKI" op="WRITE">
                    <Button size="small" onClick={() => setEditing(true)}>
                      编辑
                    </Button>
                    <Button size="small" color="error" onClick={() => {
                      if (window.confirm(`删除「${page.title}」及其全部子页面？`)) {
                        deletePageMutation.mutate(page.id);
                      }
                    }}>
                      删除
                    </Button>
                  </PermGate>
                  <Button size="small" onClick={() => setShowVersions((v) => !v)}>
                    {showVersions ? '收起历史' : '历史版本'}
                  </Button>
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {page.spaceName}｜更新于 {new Date(page.updatedAt).toLocaleString()}
                </Typography>
                <Divider sx={{ my: 1.5 }} />

                <Collapse in={showVersions}>
                  {versionsQuery.isLoading && <CircularProgress size={18} />}
                  <Stack spacing={0.5} sx={{ mb: 2 }}>
                    {(versionsQuery.data ?? []).map((v) => (
                      <Stack key={v.id} direction="row" spacing={1} alignItems="center">
                        <Chip size="small" label={`v${v.versionNo}`} />
                        <Typography variant="caption" sx={{ flex: 1 }} noWrap>
                          {v.title}｜{new Date(v.createdAt).toLocaleString()}
                        </Typography>
                        <PermGate domain="WIKI" op="WRITE">
                          <Button
                            size="small"
                            onClick={() => restoreMutation.mutate({ id: page.id, versionNo: v.versionNo })}
                          >
                            回滚到此版
                          </Button>
                        </PermGate>
                      </Stack>
                    ))}
                  </Stack>
                </Collapse>

                <MarkdownLite md={page.contentMd} />

                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2">问一下本空间 Wiki</Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                  <TextField
                    fullWidth
                    size="small"
                    placeholder="基于本空间的 Wiki 页面回答，带 [n] 引用"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing && question.trim()) {
                        askMutation.mutate(question.trim());
                      }
                    }}
                  />
                  <Button
                    variant="contained"
                    disabled={askMutation.isPending || !question.trim()}
                    onClick={() => askMutation.mutate(question.trim())}
                  >
                    提问
                  </Button>
                </Stack>
                {askMutation.isPending && (
                  <Box sx={{ mt: 1.5 }}>
                    <LinearProgress />
                  </Box>
                )}
                {askResult && (
                  <Box sx={{ mt: 2 }}>
                    {askResult.degraded && (
                      <Alert severity="warning" sx={{ mb: 1 }}>
                        {askResult.note ?? '模型不可用，以下为检索摘录'}
                      </Alert>
                    )}
                    <Card variant="outlined" sx={{ p: 2, bgcolor: 'action.hover' }}>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>
                        {askResult.answer}
                      </Typography>
                    </Card>
                    <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                      {askResult.citations.map((c) => (
                        <Chip
                          key={c.pageId}
                          size="small"
                          variant="outlined"
                          clickable
                          label={`[${c.index}] ${c.pageTitle}`}
                          onClick={() => {
                            setPageId(c.pageId);
                            setAskResult(null);
                          }}
                        />
                      ))}
                      <Chip size="small" label={`${Math.round(askResult.tookMs / 100) / 10}s`} />
                      {askResult.model && <Chip size="small" label={askResult.model} />}
                    </Stack>
                  </Box>
                )}
              </Card>
            )}
          </Stack>
        </Box>
      </Stack>
    </AppLayout>
  );
}

// ---------------------------------------------------------------- 页面树节点

function TreeNodeView(options: {
  node: WikiPageTreeNode;
  activeId: string | null;
  depth: number;
  onOpen: (id: string) => void;
  onAddChild: (parentId: string) => Promise<void>;
}): ReactElement {
  const { node, activeId, depth, onOpen, onAddChild } = options;
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <Stack
        direction="row"
        alignItems="center"
        sx={{
          pl: depth * 1.5, px: 1, py: 0.4, borderRadius: 1, cursor: 'pointer',
          bgcolor: node.id === activeId ? 'action.selected' : 'transparent',
          '&:hover': { bgcolor: 'action.hover' },
        }}
        onClick={() => onOpen(node.id)}
      >
        {hasChildren ? (
          <Box
            component="span"
            sx={{ width: 16, textAlign: 'center', cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            {open ? '▾' : '▸'}
          </Box>
        ) : (
          <Box component="span" sx={{ width: 16 }} />
        )}
        <Typography variant="body2" sx={{ flex: 1 }} noWrap>
          {node.title}
        </Typography>
      </Stack>
      {open &&
        node.children.map((c) => (
          <TreeNodeView
            key={c.id}
            node={c}
            activeId={activeId}
            depth={depth + 1}
            onOpen={onOpen}
            onAddChild={onAddChild}
          />
        ))}
    </>
  );
}

// ---------------------------------------------------------------- 新建空间

function NewSpaceButton(options: { onDone: () => void }): ReactElement {
  const { onDone } = options;
  const { enqueueSnackbar } = useSnackbar();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [level, setLevel] = useState('INTERNAL');
  const create = useMutation({
    mutationFn: () => wikiPageApi.createSpace({ name, securityLevel: level }),
    onSuccess: () => {
      enqueueSnackbar('空间已创建', { variant: 'success' });
      setOpen(false);
      setName('');
      onDone();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '创建失败', { variant: 'error' }),
  });
  return (
    <>
      <Button size="small" onClick={() => setOpen((v) => !v)}>
        {open ? '收起' : '新建空间'}
      </Button>
      <Collapse in={open}>
        <Stack spacing={0.75} sx={{ mt: 0.5 }}>
          <TextField
            size="small"
            label="空间名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField select size="small" label="密级" value={level} onChange={(e) => setLevel(e.target.value)}>
            {['PUBLIC', 'INTERNAL', 'SECRET'].map((l) => (
              <MenuItem key={l} value={l}>
                {SECURITY_LEVEL_LABELS[l as keyof typeof SECURITY_LEVEL_LABELS]}
              </MenuItem>
            ))}
          </TextField>
          <Button variant="contained" size="small" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            创建
          </Button>
        </Stack>
      </Collapse>
    </>
  );
}

// ---------------------------------------------------------------- 页面编辑器

function PageEditor(options: { page: WikiPageDto; spaceId: string; onDone: () => void; onCancel: () => void }): ReactElement {
  const { page, onDone, onCancel } = options;
  const { enqueueSnackbar } = useSnackbar();
  const [title, setTitle] = useState(page.title);
  const [content, setContent] = useState(page.contentMd);
  const save = useMutation({
    mutationFn: () => wikiPageApi.updatePage(page.id, { title, contentMd: content }),
    onSuccess: () => {
      enqueueSnackbar('已保存（版本 +1，向量已更新）', { variant: 'success' });
      onDone();
    },
    onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.message : '保存失败', { variant: 'error' }),
  });
  return (
    <Card variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <TextField size="small" label="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextField
          label="正文（Markdown）"
          multiline
          minRows={14}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          helperText="支持 # 标题、列表、**粗体**、`代码`、> 引用；保存后自动切片入向量库"
        />
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button onClick={onCancel}>取消</Button>
          <Button variant="contained" disabled={save.isPending || !title.trim()} onClick={() => save.mutate()}>
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------- 轻量 Markdown

/**
 * 极简 Markdown 渲染：标题/列表/引用/粗体/行内代码/分隔线/段落。
 * 有意不引库：Wiki 正文以中文段落为主，转义优先（防注入），
 * 复杂表格与图片等需求出现时再评估引入 react-markdown。
 */
function MarkdownLite(options: { md: string }): ReactElement {
  const { md } = options;
  const blocks = useMemo(() => {
    const lines = (md ?? '').split('\n');
    const out: Array<{ type: 'h1' | 'h2' | 'h3' | 'li' | 'quote' | 'hr' | 'p' | 'code'; text: string }> = [];
    let inCode = false;
    for (const raw of lines) {
      if (raw.trim().startsWith('```')) {
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        out.push({ type: 'code', text: raw });
        continue;
      }
      const line = raw.trimEnd();
      if (/^###\s/.test(line)) out.push({ type: 'h3', text: line.slice(4) });
      else if (/^##\s/.test(line)) out.push({ type: 'h2', text: line.slice(3) });
      else if (/^#\s/.test(line)) out.push({ type: 'h1', text: line.slice(2) });
      else if (/^[-*]\s/.test(line)) out.push({ type: 'li', text: line.slice(2) });
      else if (/^>\s?/.test(line)) out.push({ type: 'quote', text: line.replace(/^>\s?/, '') });
      else if (/^---+$/.test(line)) out.push({ type: 'hr', text: '' });
      else if (line.trim().length > 0) out.push({ type: 'p', text: line });
    }
    return out;
  }, [md]);

  const inline = (text: string): ReactElement[] => {
    // 先转义，再按 **bold** / `code` 切分（防注入：全部走 {text} 渲染，不用 dangerouslySetInnerHTML）
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts: ReactElement[] = [];
    const regex = /\*\*([^*]+)\*\*|`([^`]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = regex.exec(esc)) !== null) {
      if (m.index > last) parts.push(<span key={key++}>{esc.slice(last, m.index)}</span>);
      if (m[1] !== undefined) {
        parts.push(
          <Box key={key++} component="strong" sx={{ fontWeight: 700 }}>
            {m[1]}
          </Box>,
        );
      } else {
        parts.push(
          <Box key={key++} component="code" sx={{ px: 0.5, bgcolor: 'action.hover', fontFamily: 'monospace', fontSize: '0.9em' }}>
            {m[2]}
          </Box>,
        );
      }
      last = m.index + m[0].length;
    }
    if (last < esc.length) parts.push(<span key={key++}>{esc.slice(last)}</span>);
    return parts;
  };

  return (
    <Box sx={{ '& ul': { m: 0, pl: 3 } }}>
      {blocks.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          （正文为空）
        </Typography>
      )}
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'h1':
            return <Typography key={i} variant="h5" sx={{ mt: 2, mb: 1 }}>{inline(b.text)}</Typography>;
          case 'h2':
            return <Typography key={i} variant="h6" sx={{ mt: 2, mb: 1 }}>{inline(b.text)}</Typography>;
          case 'h3':
            return <Typography key={i} variant="subtitle1" sx={{ mt: 1.5, mb: 0.5 }}>{inline(b.text)}</Typography>;
          case 'li':
            return (
              <Stack key={i} direction="row" spacing={1} sx={{ pl: 2 }}>
                <Typography variant="body2" color="text.secondary">•</Typography>
                <Typography variant="body2" sx={{ lineHeight: 1.9 }}>{inline(b.text)}</Typography>
              </Stack>
            );
          case 'quote':
            return (
              <Box key={i} sx={{ borderLeft: 3, borderColor: 'divider', pl: 1.5, py: 0.5, my: 0.5 }}>
                <Typography variant="body2" color="text.secondary">{inline(b.text)}</Typography>
              </Box>
            );
          case 'code':
            return (
              <Box key={i} component="pre" sx={{ m: 0, px: 1.5, py: 1, bgcolor: 'action.hover', overflowX: 'auto', fontSize: '0.85rem', fontFamily: 'monospace' }}>
                {b.text}
              </Box>
            );
          case 'hr':
            return <Divider key={i} sx={{ my: 1.5 }} />;
          default:
            return (
              <Typography key={i} variant="body2" sx={{ lineHeight: 1.95, mb: 1 }}>
                {inline(b.text)}
              </Typography>
            );
        }
      })}
    </Box>
  );
}
