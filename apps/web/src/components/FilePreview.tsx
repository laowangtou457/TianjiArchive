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
  Chip,
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
  /**
   * 定位文本（可选）：打开后自动跳转到正文中包含该内容的页/段，
   * 用于「智能问答 → 打开原件」直达引用出处。PDF/图片等无文本层格式忽略。
   */
  locateText?: string | null;
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
  const { file, open, onClose, allowDownload = false, locateText = null } = props;
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
            {/* 阅读器（EPUB/TEXT）不显示水印提示条：模板占位符（{username}{datetime}）
                无实际渲染价值，访问留痕已由后端 PREVIEW 审计强制记录 */}

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

            {preview.kind === 'EBOOK' && (
              <EpubReader url={preview.url} fontScale={fontScale} locateText={locateText} />
            )}

            {preview.kind === 'TEXT' && (
              <TextReader
                url={preview.url}
                fontScale={fontScale}
                title={preview.filename}
                locateText={locateText}
              />
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
// 文本定位（智能问答「打开原件」直达引用出处）
// ============================================================================

/** 归一化：去空白；stripPunct 时再去掉全部标点（抽取文本与原书标点可能有差异） */
function normForLocate(s: string, stripPunct: boolean): string {
  const t = s.replace(/\s+/g, '');
  return stripPunct ? t.replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, '') : t;
}

/**
 * 由待定位文本构造搜索锚点。
 *
 * ⚠️ 不能直接拿「内容前缀」当锚点：档案全文抽取的切片头部常拼着 Gutenberg
 * 英文元数据（"Language: Chinese…"），这些字在原书 EPUB 里根本不存在，
 * 拿它搜索必然全书落空。因此锚点按可靠性排序：
 *   1. 章节标题锚（第X回/章/卷… + 题名，最长 50 字）—— 最强定位信号；
 *   2. 首个 ≥10 连续汉字段 —— 跳过开头拉丁字母/标点的元数据；
 *   3. 原文前缀兜底（内容本身干净时仍可用）。
 */
function locateNeedles(text: string): string[] {
  const out: string[] = [];
  const compact = text.replace(/\s+/g, '');
  const heading = compact.match(
    /第[0-9〇零一二三四五六七八九十百千两]+[回章节節卷篇][^。！？!?]{2,50}/,
  );
  if (heading && heading[0].length >= 8) {
    // 16 字短锚：正文里「第一回 XXX」独立成行（比 50 字长锚更可能逐字命中标题元素）
    out.push(heading[0].slice(0, 16));
    if (heading[0].length > 16) out.push(heading[0]);
  }
  const hanRun = compact.match(/[\u4e00-\u9fff]{10,}/);
  if (hanRun) out.push(hanRun[0].slice(0, 60));
  for (const n of [60, 36, 20, 12]) {
    if (compact.length >= n) out.push(compact.slice(0, n));
  }
  if (compact.length > 0 && compact.length < 12) out.push(compact);
  return [...new Set(out)].filter((s) => s.length >= 8);
}

/**
 * 在 EPUB 各章节正文中搜索定位文本，命中后跳转到该处并叠加高亮。
 *
 * 匹配策略：同章内多个元素都包含锚点时（如目录页 vs 正文标题）取**文本最短**
 * 的元素——正文里「第一回 XXX」独立成行，最短即最准。封面/目录等非正文章节
 * （linear=false）跳过。全书搜不到时保持原位置。
 */
async function locateInBook(
  book: Book,
  rendition: Rendition,
  locateText: string,
): Promise<boolean> {
  const needles = locateNeedles(locateText);
  if (needles.length === 0) return false;
  // 高亮样式注入 iframe（override 追加进默认主题，不覆盖字号/缩进设置）
  try {
    rendition.themes.override('.tj-locate', 'background-color: rgba(255, 200, 0, 0.4)');
  } catch {
    /* 忽略主题注入失败 */
  }
  await book.loaded.spine;
  const items = (book.spine as unknown as { spineItems?: Array<Record<string, unknown>> })
    .spineItems ?? [];
  // 先在段落级元素找（精确），再退回容器级 div（整章容器匹配也能跳对章）
  const selectorPasses = ['p, li, blockquote, td, h1, h2, h3, h4, h5, h6', 'div, section'];
  for (const spineItem of items) {
    if (spineItem.linear === false) continue; // 封面/目录等非正文章节
    const item = spineItem as unknown as {
      load: (req?: unknown) => Promise<unknown>;
      unload: () => Promise<void> | void;
      cfiFromElement: (el: Element) => string;
    };
    try {
      const doc = (await item.load(book.load)) as unknown as Document;
      try {
        let best: { el: HTMLElement; tLen: number } | null = null;
        for (const selector of selectorPasses) {
          const elements = Array.from(doc.querySelectorAll(selector));
          for (const el of elements) {
            const raw = el.textContent ?? '';
            if (raw.trim().length === 0) continue;
            const t = normForLocate(raw, false);
            if (!needles.some((n) => t.includes(n))) continue;
            if (!best || t.length < best.tLen) {
              best = { el: el as HTMLElement, tLen: t.length };
            }
          }
        }
        if (best) {
          const cfi = item.cfiFromElement(best.el);
          if (cfi) {
            await item.unload();
            await rendition.display(cfi);
            try {
              rendition.annotations.highlight(cfi, {}, () => undefined, 'tj-locate');
            } catch {
              /* 高亮失败不影响跳转 */
            }
            return true;
          }
        }
      } finally {
        try {
          item.unload();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 单章加载失败继续下一章 */
    }
  }
  return false;
}

// ============================================================================
// EPUB 阅读器（epub.js）—— 图书式翻页排版
// ============================================================================

function EpubReader(props: { url: string; fontScale: number; locateText?: string | null }): ReactElement {
  const { url, fontScale, locateText } = props;
  const holderRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const locatedRef = useRef(false);
  /** 当前页起始 CFI（relocated 时记录，字号重排后回显用） */
  const lastCfiRef = useRef<string | null>(null);
  /** spine 总章数（locations 未生成时的进度估算用） */
  const spineTotalRef = useRef(0);
  /** 分页位置表是否已生成（生成后 percentage 才有精确值） */
  const locationsReadyRef = useRef(false);
  /** 字号重排串行化：连续点 A-/A+ 时逐个回显，避免并发 display 打架 */
  const remapRef = useRef<Promise<unknown>>(Promise.resolve());
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [progress, setProgress] = useState(0);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const holder = holderRef.current;
    if (!holder) return;
    setState('loading');
    locatedRef.current = false;
    setLocating(false);
    setProgress(0);
    lastCfiRef.current = null;
    spineTotalRef.current = 0;
    locationsReadyRef.current = false;
    remapRef.current = Promise.resolve();
    let book: Book | null = null;
    try {
      book = ePub(url);
      bookRef.current = book;
      const bk = book;
      void book.loaded.spine.then((spine) => {
        const items = (spine as unknown as { spineItems?: unknown[] }).spineItems;
        spineTotalRef.current = Array.isArray(items) ? items.length : 0;
      });
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
      rendition.on(
        'relocated',
        (loc: {
          start?: {
            index?: number;
            cfi?: string;
            percentage?: number;
            displayed?: { page?: number; total?: number };
          };
        }) => {
          const start = loc?.start;
          if (!start) return;
          if (typeof start.cfi === 'string') lastCfiRef.current = start.cfi;
          // 进度三级策略：① locations 生成后按 CFI 精确换算（页级精度）；
          // ② start.percentage（部分版本有值）；③ 章节序号+页内比例估算兜底。
          // ⚠️ 不调 locations.generate 时 percentage 恒为 0（epub.js 已知行为）。
          let pct: number | null = null;
          if (locationsReadyRef.current && typeof start.cfi === 'string') {
            const v = (
              bk.locations as unknown as { percentageFromCFI?: (c: string) => number | undefined }
            ).percentageFromCFI?.(start.cfi);
            if (typeof v === 'number' && v >= 0) pct = v;
          }
          if (pct === null && typeof start.percentage === 'number' && start.percentage > 0) {
            pct = start.percentage;
          }
          if (pct === null && spineTotalRef.current > 0 && typeof start.index === 'number') {
            const d = start.displayed;
            const pageFrac = d && d.total ? Math.min(1, ((d.page ?? 1) - 1) / d.total) : 1;
            pct = Math.min(1, (start.index + pageFrac) / spineTotalRef.current);
          }
          if (pct !== null) setProgress(Math.round(Math.min(1, Math.max(0, pct)) * 100));
        },
      );
      // 后台生成分页位置表（约 1KB/锚点）：完成后进度条精确到页，
      // 并立刻按当前位置刷新一次百分比
      void bk.ready
        .then(() => bk.locations.generate(1024))
        .then(() => {
          if (cancelled) return;
          locationsReadyRef.current = true;
          const cur = (
            rendition as unknown as {
              currentLocation?: () => { start?: { cfi?: string } };
            }
          ).currentLocation?.();
          const cfi = cur?.start?.cfi ?? lastCfiRef.current;
          if (typeof cfi === 'string') {
            const v = (
              bk.locations as unknown as { percentageFromCFI?: (c: string) => number | undefined }
            ).percentageFromCFI?.(cfi);
            if (typeof v === 'number' && v >= 0) {
              setProgress(Math.round(Math.min(1, Math.max(0, v)) * 100));
            }
          }
        })
        .catch(() => undefined);
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

  // 字号热调节：改字号会触发整章重排，epub.js 内部页码映射会过期，
  // 之后翻页就按旧映射跨页 → 实测小字号下从版权页回翻直接跳过两卷。
  // 修法：字号变更后显式 display(当前CFI) 重排并重映射（串行化防连点打架）。
  useEffect(() => {
    if (state !== 'ready') return;
    const rendition = renditionRef.current;
    if (!rendition) return;
    rendition.themes.fontSize(`${Math.round(16 * fontScale)}px`);
    const cfi = lastCfiRef.current;
    if (!cfi) return;
    remapRef.current = remapRef.current
      .then(() => rendition.display(cfi))
      .catch(() => undefined);
  }, [fontScale, state]);

  // 定位搜索内容：渲染就绪后在书内搜索并跳转（只执行一次，换文件由主 effect 复位）
  useEffect(() => {
    if (state !== 'ready' || !locateText || locatedRef.current) return;
    const rendition = renditionRef.current;
    const book = bookRef.current;
    if (!rendition || !book) return;
    locatedRef.current = true;
    setLocating(true);
    void locateInBook(book, rendition, locateText)
      .catch(() => undefined)
      .finally(() => setLocating(false));
  }, [state, locateText]);

  const prev = (): void => {
    void renditionRef.current?.prev();
  };
  const next = (): void => {
    void renditionRef.current?.next();
  };

  return (
    <Box sx={{ position: 'relative', backgroundColor: '#fbf7f0' }}>
      {state === 'loading' && (
        <Stack
          alignItems="center"
          justifyContent="center"
          sx={{ position: 'absolute', inset: 0, height: '68vh', backgroundColor: '#fbf7f0', zIndex: 1 }}
        >
          <CircularProgress size={26} />
          <Typography variant="body2" sx={{ mt: 2 }}>
            正在打开图书…
          </Typography>
        </Stack>
      )}
      {state === 'ready' && locating && (
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2,
          }}
        >
          <Chip size="small" color="primary" label="正在定位引用内容…" />
        </Box>
      )}
      {state === 'error' && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            height: '68vh',
            backgroundColor: '#fbf7f0',
            zIndex: 1,
            p: 2,
          }}
        >
          <Alert severity="warning">图书加载失败：{errMsg}。可申请下载原件阅读。</Alert>
        </Box>
      )}
      <div
        ref={holderRef}
        style={{
          height: '68vh',
          // ⚠️ 不能用 display:none：epub.js 在隐藏容器上 renderTo 量到 0 尺寸，
          // 首屏会渲染成整页空白（翻一页才恢复）。用 visibility + 覆盖层替代。
          visibility: state === 'error' ? 'hidden' : 'visible',
        }}
      />
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

function TextReader(props: {
  url: string;
  fontScale: number;
  title: string;
  locateText?: string | null;
}): ReactElement {
  const { url, fontScale, title, locateText } = props;
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** 命中定位文本的段落下标（null = 未定位） */
  const [locateIdx, setLocateIdx] = useState<number | null>(null);
  const matchedRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFailed(false);
    setLocateIdx(null);
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

  // 定位：找到第一个包含目标文本的段落，滚动到屏幕中央并高亮
  useEffect(() => {
    if (text === null || !locateText) return;
    const paras = text
      .split(/\r?\n\s*\r?\n|\r?\n/)
      .filter((p) => p.trim().length > 0);
    const needles = locateNeedles(locateText);
    const idx = paras.findIndex((p) =>
      needles.some((n) => n.length >= 8 && normForLocate(p, false).includes(n)),
    );
    const looseIdx =
      idx >= 0
        ? idx
        : paras.findIndex((p) =>
            needles.some((n) => n.length >= 8 && normForLocate(p, true).includes(n)),
          );
    setLocateIdx(looseIdx >= 0 ? looseIdx : null);
  }, [text, locateText]);

  useEffect(() => {
    if (locateIdx !== null) {
      matchedRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [locateIdx]);

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
        {paragraphs.map((p, i) => {
          const located = i === locateIdx;
          return (
            <Typography
              key={i}
              component="p"
              ref={located ? matchedRef : undefined}
              sx={{
                fontSize: `${Math.round(15 * fontScale)}px`,
                lineHeight: 1.9,
                textIndent: '2em',
                fontFamily: '"Noto Serif SC", "Source Han Serif SC", serif',
                color: '#2d2a24',
                mb: 1.2,
                ...(located && {
                  backgroundColor: 'rgba(255, 200, 0, 0.4)',
                  borderRadius: 1,
                  textIndent: 0,
                  px: 1,
                  py: 0.5,
                }),
              }}
            >
              {p.trim()}
            </Typography>
          );
        })}
        {paragraphs.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', pt: 4 }}>
            （无正文内容）
          </Typography>
        )}
      </Box>
    </Box>
  );
}
