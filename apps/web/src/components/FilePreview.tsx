import { useEffect, useState, type ReactElement } from 'react';
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
 *   - PDF：iframe 内嵌（浏览器原生渲染，避免额外 pdfjs 体积）；
 *   - 图片/音频/视频：原生标签，视频支持 Range 拖动；
 *   - Office：服务端已转 PDF（previewKey），按 PDF 渲染；
 *   - TEXT：服务端生成 txt 预览对象。
 *
 * 强制留痕：调用 /files/:id/preview 时后端记录 PREVIEW 审计（不可关闭）。
 */
export function FilePreview(props: FilePreviewProps): ReactElement {
  const { file, open, onClose, allowDownload = false } = props;
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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
            {file?.mime} · {(Number(file?.size ?? 0) / 1024).toFixed(1)} KB · SHA-256{' '}
            {file?.sha256?.slice(0, 20)}…
          </Typography>
        </Box>
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

      <DialogContent dividers sx={{ minHeight: 420, bgcolor: '#f7fafc' }}>
        {loading && (
          <Stack alignItems="center" justifyContent="center" sx={{ height: 400 }}>
            <CircularProgress size={28} />
            <Typography variant="body2" sx={{ mt: 2 }}>
              正在准备预览…
            </Typography>
          </Stack>
        )}

        {error && <Alert severity="warning">{error}</Alert>}

        {!loading && !error && preview && (
          <Box>
            {preview.watermarked && (
              <Alert severity="info" sx={{ mb: 1 }}>
                本预览已按要求叠加水印，请勿外传
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
              <Box sx={{ textAlign: 'center' }}>
                <img
                  src={preview.url}
                  alt={preview.filename}
                  style={{ maxWidth: '100%', maxHeight: '72vh' }}
                />
              </Box>
            )}

            {preview.kind === 'AUDIO' && (
              <audio controls src={preview.url} style={{ width: '100%' }}>
                您的浏览器不支持音频播放
              </audio>
            )}

            {preview.kind === 'VIDEO' && (
              <video
                controls
                src={preview.url}
                style={{ width: '100%', maxHeight: '72vh', backgroundColor: '#000' }}
              >
                您的浏览器不支持视频播放
              </video>
            )}

            {preview.kind === 'TEXT' && (
              <iframe
                title="文本预览"
                src={preview.url}
                style={{ width: '100%', height: '72vh', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}
              />
            )}

            {preview.kind === 'NONE' && (
              <Alert severity="info">该格式暂不支持在线预览，可申请下载原件。</Alert>
            )}
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
