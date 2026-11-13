import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ePub, { type Book, type Rendition } from 'epubjs';
import type { ElectronicFileDto, PreviewResponse } from '@tianji/shared';
import { fileApi } from '../api';
import { ApiError } from '../api/client';

/** 预览器属性 */
export interface FilePreviewProps {
  file: ElectronicFileDto | null;
  open: boolean;
  onClose: () => void;
  /** 是否允许下载（受系统参数与权限控制，默认隐藏） */
  allowDownload?: boolean;
}

/**
 * 在线预览（F-08）。
 *
 * 预览策略：
 *   - PDF：iframe 内嵌（浏览器原生渲染）；
 *   - 图片/音频/视频：原生标签，视频支持 Range 拖动；
 *   - Office：服务端已转 PDF（previewKey），按 PDF 渲染；
 *   - EPUB：epub.js 内置翻页阅读器（原件 presign URL 直读，书籍式排版）；
 *   - TEXT / MOBI/AZW3 降级文本：书籍排版阅读视图（fetch 失败自动降级 iframe）。
 *
 * 强制留痕：调用 /files/:id/preview 时后端记录 PREVIEW 审计（不可关闭）。
 */
export function FilePreview(props: FilePreviewProps): ReactElement {
  const { file, open, onClose, allowDownload = false } = props;
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fontScale, setFontScale] = useState(1);

  useEffect(() => {
    if (!open || !file) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fileApi
      .preview(file.id)
      .then((res) => {
        if (!cancelled) setPreview(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : '无法加载预览');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, file]);

  /** 下载原件 */
  const download = async (): Promise<void> => {
    if (!file) return;
    try {
      const res = await fileApi.download(file.id);
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '下载失败');
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" noWrap>
            {file?.filename ?? '预览'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {file?.mime} · {(Number(file?.size ?? 0) / 1024).toFixed(1)} KB
            {preview?.kind === 'EBOOK' && ' · 图书阅读器'}
            {preview?.kind === 'TEXT' && ' · 阅读视图'}
          </Typography>
        </Box>
        {(preview?.kind === 'TEXT' || preview?.kind === 'EBOOK') && (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Tooltip title="缩小字号">
              <Button size="small" onClick={() => setFontScale((s) => Math.max(0.7, +(s - 0.1).toFixed(2)))}>
                A-
              </Button>
            </Tooltip>
            <Tooltip title="放大字号">
              <Button size="small" onClick={() => setFontScale((s) => Math.min(2, +(s + 0.1).toFixed(2)))}>
                A+
              </Button>
            </Tooltip>
          </Stack>
        )}
        {allowDownload && (
          <Button size="small" onClick={() => void download()}>
            下载原件
          </Button>
        )}
        <Tooltip title="关闭">
          <IconButton size="small" onClick={onClose} sx={{ position: 'absolute', right: 10, top: 10 }}>
            ✕
          </IconButton>
        </Tooltip>
      </DialogTitle>

      <DialogContent dividers sx={{ minHeight: 420, bgcolor: '#f7fafc', p: 0 }}>
        {loading && (
          <Stack alignItems="center" justifyContent="center" sx={{ height: 400 }}>
            <CircularProgress size={28} />
            <Typography variant="body2" sx={{ mt: 2 }}>
              正在准备预览…
            </Typography>
          </Stack>
        )}

        {error && (
          <Box sx={{ p: 2 }}>
            <Alert severity="warning">{error}</Alert>
          </Box>
        )}

        {!loading && !error && preview && (
          <Box sx={{ position: 'relative' }}>
            {preview.watermarked && preview.kind !== 'TEXT' && preview.kind !== 'EBOOK' && (
              <Alert severity="info" sx={{ m: 1 }}>
                本预览已按要求叠加水印，请勿外传
              </Alert>
            )}
            {preview.watermarked && (preview.kind === 'TEXT' || preview.kind === 'EBOOK') && (
              <Alert severity="info" sx={{ m: 1 }}>
                {preview.watermarkTemplate || '本预览已按要求叠加水印'}，请勿外传
              </Alert>
            )}

            {preview.kind === 'PDF' && (
              <iframe
                title="PDF 预览"
                src={preview.url}
                style={{ width: '100%', height: '72vh', border: 'none', backgroundColor: '#fff' }}
              />
            )}

            {preview.kind === 'IMAGE' && (
              <Box sx={{ textAlign: 'center', p: 2 }}>
                <img
                  src={preview.url}
                  alt={preview.filename}
                  style={{ maxWidth: '100%', maxHeight: '72vh' }}
                />
              </Box>
            )}

            {preview.kind === 'AUDIO' && (
              <Box sx={{ p: 3 }}>
                <audio controls src={preview.url} style={{ width: '100%' }}>
                  您的浏览器不支持音频播放
                </audio>
              </Box>
            )}

            {preview.kind === 'VIDEO' && (
              <Box sx={{ p: 2 }}>
                <video
                  controls
                  src={preview.url}
                  style={{ width: '100%', maxHeight: '72vh', backgroundColor: '#000' }}
                >
                  您的浏览器不支持视频播放
                </video>
              </Box>
            )}

            {preview.kind === 'EBOOK' && <EpubReader url={preview.url} fontScale={fontScale} />}

            {preview.kind === 'TEXT' && (
              <TextReader url={preview.url} fontScale={fontScale} title={preview.filename} />
            )}

            {preview.kind === 'NONE' && (
              <Box sx={{ p: 2 }}>
                <Alert severity="info">该格式暂不支持在线预览，可申请下载原件。</Alert>
              </Box>
            )}
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// EPUB 阅读器（epub.js）—— 图书式翻页排版
// ============================================================================

function EpubReader(props: { url: string; fontScale: number }): ReactElement {
  const { url, fontScale } = props;
  const holderRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const holder = holderRef.current;
    if (!holder) return;
    setState('loading');
    let book: Book | null = null;
    try {
      book = ePub(url);
      bookRef.current = book;
      const rendition = book.renderTo(holder, {
        width: '100%',
        height: '68vh',
        spread: 'none',
        flow: 'paginated',
      });
      renditionRef.current = rendition;
      rendition.themes.default({
        body: { 'font-size': `${Math.round(16 * fontScale)}px`, 'line-height': '1.8', padding: '0 8px' },
        p: { 'text-indent': '2em', margin: '0 0 .6em' },
      });
      rendition.display().then(() => {
        if (!cancelled) setState('ready');
      }).catch((err: unknown) => {
        if (cancelled) return;
        setState('error');
        setErrMsg(err instanceof Error ? err.message : 'EPUB 加载失败（可能是跨域限制）');
      });
      rendition.on('relocated', (loc: { start?: { percentage?: number } }) => {
        const pct = loc?.start?.percentage;
        if (typeof pct === 'number') setProgress(Math.round(pct * 100));
      });
    } catch (err) {
      setState('error');
      setErrMsg(err instanceof Error ? err.message : 'EPUB 初始化失败');
    }
    return () => {
      cancelled = true;
      try {
        renditionRef.current?.destroy();
      } catch { /* ignore */ }
      try {
        void bookRef.current?.destroy();
      } catch { /* ignore */ }
      renditionRef.current = null;
      bookRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // 字号热调节
  useEffect(() => {
    if (state !== 'ready') return;
    renditionRef.current?.themes.fontSize(`${Math.round(16 * fontScale)}px`);
  }, [fontScale, state]);

  const prev = (): void => {
    void renditionRef.current?.prev();
  };
  const next = (): void => {
    void renditionRef.current?.next();
  };

  return (
    <Box sx={{ position: 'relative', backgroundColor: '#fbf7f0' }}>
      {state === 'loading' && (
        <Stack alignItems="center" justifyContent="center" sx={{ height: 380 }}>
          <CircularProgress size={26} />
          <Typography variant="body2" sx={{ mt: 2 }}>
            正在打开图书…
          </Typography>
        </Stack>
      )}
      {state === 'error' && (
        <Box sx={{ p: 2 }}>
          <Alert severity="warning">图书加载失败：{errMsg}。可申请下载原件阅读。</Alert>
        </Box>
      )}
      <div ref={holderRef} style={{ height: '68vh', display: state === 'ready' ? 'block' : 'none' }} />
      {state === 'ready' && (
        <>
          <Box
            onClick={prev}
            title="上一页"
            sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '15%', cursor: 'pointer' }}
          />
          <Box
            onClick={next}
            title="下一页"
            sx={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '15%', cursor: 'pointer' }}
          />
          <Stack
            direction="row"
            justifyContent="center"
            alignItems="center"
            spacing={2}
            sx={{ py: 1, borderTop: '1px solid #e2e8f0', backgroundColor: '#fff' }}
          >
            <Button size="small" onClick={prev}>‹ 上一页</Button>
            <Typography variant="caption" color="text.secondary">{progress}%</Typography>
            <Button size="small" onClick={next}>下一页 ›</Button>
          </Stack>
        </>
      )}
    </Box>
  );
}

// ============================================================================
// 文本阅读视图 —— 书籍排版（衬线、行距、页宽、字号可调）
// ============================================================================

function TextReader(props: { url: string; fontScale: number; title: string }): ReactElement {
  const { url, fontScale, title } = props;
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFailed(false);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch(() => {
        // CORS 或网络失败：降级为 iframe（浏览器原生 text 展示）
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (failed) {
    return (
      <iframe
        title={title}
        src={url}
        style={{ width: '100%', height: '72vh', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}
      />
    );
  }
  if (text === null) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: 380 }}>
        <CircularProgress size={26} />
      </Stack>
    );
  }
  const paragraphs = text.split(/\r?\n\s*\r?\n|\r?\n/).filter((p) => p.trim().length > 0);
  return (
    <Box
      sx={{
        height: '72vh',
        overflowY: 'auto',
        backgroundColor: '#fbf7f0',
        px: { xs: 2, md: 6 },
        py: 3,
      }}
    >
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        {paragraphs.map((p, i) => (
          <Typography
            key={i}
            component="p"
            sx={{
              fontSize: `${Math.round(15 * fontScale)}px`,
              lineHeight: 1.9,
              textIndent: '2em',
              fontFamily: '"Noto Serif SC", "Source Han Serif SC", serif',
              color: '#2d2a24',
              mb: 1.2,
            }}
          >
            {p.trim()}
          </Typography>
        ))}
        {paragraphs.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', pt: 4 }}>
            （无正文内容）
          </Typography>
        )}
      </Box>
    </Box>
  );
}
