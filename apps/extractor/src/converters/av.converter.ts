import { Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConvertOutput } from '../context';

/**
 * 音视频处理器。
 *
 * - 缩略图：ffmpeg 取第 1 秒帧（视频）；音频用 ffmpeg 生成的波形图；
 * - 文本：P0 不做语音转写（P2 可接 ASR），text 返回空；
 * - 预览：浏览器直接播放原始 mp4/mp3（Range 请求由 Nginx 反代透传）。
 */
export class AudioVideoConverter {
  private readonly logger = new Logger(AudioVideoConverter.name);
  private readonly timeoutMs = Number(process.env.AV_CONVERT_TIMEOUT_MS ?? 120000);

  public async convert(buffer: Buffer, filename: string, mime: string): Promise<ConvertOutput> {
    const isVideo = mime.startsWith('video/');
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tianji-av-'));
    const ext = path.extname(filename) || (isVideo ? '.mp4' : '.mp3');
    const inputPath = path.join(workDir, `${randomUUID()}${ext}`);
    const outPath = path.join(workDir, 'thumb.png');

    try {
      await fs.writeFile(inputPath, buffer);
      const duration = await this.probeDuration(inputPath);
      const ok = await this.runFfmpeg(
        isVideo
          ? ['-ss', '00:00:01', '-i', inputPath, '-frames:v', '1', '-vf', 'scale=480:-1', '-y', outPath]
          : ['-i', inputPath, '-filter_complex', 'showwavespic=s=480x120:colors=#1F4E79', '-frames:v', '1', '-y', outPath],
      );
      let thumb: Buffer | null = null;
      if (ok) {
        thumb = await fs.readFile(outPath).catch(() => null);
      } else {
        this.logger.debug('ffmpeg 缩略图生成失败，降级无缩略图');
      }
      return {
        text: '',
        pdfBuffer: null,
        thumbBuffer: thumb,
        supported: true,
        meta: { mime, durationSeconds: duration, kind: isVideo ? 'video' : 'audio' },
      };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** 执行 ffmpeg，返回是否成功 */
  private runFfmpeg(args: string[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let child;
      try {
        child = spawn(process.env.FFMPEG_BIN ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (err) {
        this.logger.warn(`ffmpeg 不可用：${(err as Error).message}`);
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, this.timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }

  /** 读取时长（ffprobe；失败返回 0） */
  private probeDuration(inputPath: string): Promise<number> {
    return new Promise<number>((resolve) => {
      const chunks: Buffer[] = [];
      let child;
      try {
        child = spawn(
          process.env.FFPROBE_BIN ?? 'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inputPath],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } catch {
        resolve(0);
        return;
      }
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.on('error', () => resolve(0));
      child.on('close', () => {
        const v = Number.parseFloat(Buffer.concat(chunks).toString().trim());
        resolve(Number.isFinite(v) ? Math.round(v) : 0);
      });
    });
  }
}
