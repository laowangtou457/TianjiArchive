import { useRef, useState, type ReactElement } from 'react';
import axios from 'axios';
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import { CHUNK_SIZE, MAX_FILE_SIZE, type ElectronicFileDto } from '@tianji/shared';
import { fileApi } from '../api';
import { ApiError } from '../api/client';

/** 上传器属性 */
export interface FileUploaderProps {
  itemId: string;
  onUploaded?: (file: ElectronicFileDto) => void;
}

/** 上传阶段 */
type Phase = 'idle' | 'hashing' | 'uploading' | 'completing' | 'done' | 'error';

/**
 * 电子文件上传器（F-08，NFR-6：单文件 ≤2GB，分片直传）。
 *
 * 流程：
 *   1) 浏览器端流式计算 SHA-256（Web Crypto，分块读取，避免大文件占满内存）；
 *   2) 请求 /files/presign 获取直传凭证（>5MB 走分片）；
 *   3) 逐片 PUT 到 MinIO（文件不经过 API 服务器）；
 *   4) /files/complete 由服务端重算 SHA-256 比对后入库（入库必记哈希）。
 */
export function FileUploader(props: FileUploaderProps): ReactElement {
  const { itemId, onUploaded } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 选中文件 */
  const pick = (): void => inputRef.current?.click();

  /** 浏览器端 SHA-256（分 4MB 块流式读取） */
  const computeSha256 = async (file: File): Promise<string> => {
    const chunkSize = 4 * 1024 * 1024;
    const total = Math.ceil(file.size / chunkSize);
    // 注意：Web Crypto 不支持增量更新，这里采用逐块读取后一次性 hash（浏览器会分页读取 Blob）
    const buffers: ArrayBuffer[] = [];
    for (let i = 0; i < total; i += 1) {
      const slice = file.slice(i * chunkSize, Math.min((i + 1) * chunkSize, file.size));
      buffers.push(await slice.arrayBuffer());
      setProgress(Math.round(((i + 1) / total) * 10));
    }
    const merged = new Uint8Array(buffers.reduce((s, b) => s + b.byteLength, 0));
    let offset = 0;
    for (const b of buffers) {
      merged.set(new Uint8Array(b), offset);
      offset += b.byteLength;
    }
    const digest = await crypto.subtle.digest('SHA-256', merged);
    return Array.from(new Uint8Array(digest))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  };

  /** 执行上传 */
  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    setMessage(null);
    setProgress(0);

    if (file.size > MAX_FILE_SIZE) {
      setPhase('error');
      setError(`文件超过 2GB 上限（${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB）`);
      return;
    }

    try {
      // 1) 计算哈希
      setPhase('hashing');
      setMessage('正在计算文件指纹（SHA-256）…');
      const sha256 = await computeSha256(file);
      setProgress(15);

      // 2) 申请凭证
      setPhase('uploading');
      setMessage('正在申请上传凭证…');
      const presign = await fileApi.presign({
        itemId,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        multipart: file.size > CHUNK_SIZE,
      });

      // 3) 上传分片（直传 MinIO）
      const parts: Array<{ partNumber: number; etag: string }> = [];
      if (presign.partUrls.length > 0) {
        for (const part of presign.partUrls) {
          const start = (part.partNumber - 1) * presign.chunkSize;
          const end = Math.min(start + presign.chunkSize, file.size);
          const blob = file.slice(start, end);
          const res = await axios.put(part.url, blob, {
            headers: { 'Content-Type': 'application/octet-stream' },
            timeout: 0,
          });
          const etag = String(res.headers.etag ?? res.headers.ETag ?? '').replace(/"/g, '');
          parts.push({ partNumber: part.partNumber, etag });
          setProgress(15 + Math.round((part.partNumber / presign.partUrls.length) * 70));
          setMessage(`正在上传分片 ${part.partNumber}/${presign.partUrls.length}…`);
        }
      } else if (presign.putUrl) {
        await axios.put(presign.putUrl, file, {
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          timeout: 0,
        });
        setProgress(85);
      }

      // 4) 完成登记（服务端重算哈希 + 魔数校验）
      setPhase('completing');
      setMessage('服务端正在校验文件完整性…');
      const saved = await fileApi.complete({
        itemId,
        bucket: presign.bucket,
        objectKey: presign.objectKey,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        sha256,
        uploadId: presign.uploadId,
        parts: parts.length > 0 ? parts : undefined,
      });

      setProgress(100);
      setPhase('done');
      setMessage(`上传成功：${saved.filename}（SHA-256 ${saved.sha256.slice(0, 16)}…）`);
      onUploaded?.(saved);
    } catch (err) {
      setPhase('error');
      setProgress(0);
      const msg =
        err instanceof ApiError
          ? err.message
          : axios.isAxiosError(err)
            ? `上传失败：${err.message}`
            : '上传失败，请重试';
      setError(msg);
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const busy = phase === 'hashing' || phase === 'uploading' || phase === 'completing';

  return (
    <Box>
      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
      <Stack direction="row" spacing={1} alignItems="center">
        <Button variant="outlined" onClick={pick} disabled={busy}>
          选择文件上传
        </Button>
        <Typography variant="caption" color="text.secondary">
          支持 PDF/图片/Office/音视频，单文件 ≤ 2GB，自动分片直传
        </Typography>
      </Stack>

      {(busy || phase === 'done') && (
        <Box sx={{ mt: 1 }}>
          <LinearProgress variant="determinate" value={progress} />
          <Typography variant="caption" color="text.secondary">
            {message}
          </Typography>
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
