import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const STALE_DOWNLOAD_MS = 10 * 60 * 1000;
const IMAGE_DIR = process.env.AI_MEDIA_CACHE_DIR || join(process.cwd(), '.cache', 'media');

@Injectable()
export class ImageCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImageCacheService.name);
  private timer?: NodeJS.Timeout;
  private working = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    void this.cacheNext().catch((error) => {
      this.logger.warn(`课程图片后台缓存失败：${(error as Error).message}`);
    });
    this.timer = setInterval(() => void this.cacheNext().catch((error) => {
      this.logger.warn(`课程图片后台缓存失败：${(error as Error).message}`);
    }), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async cacheNext(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      const asset = await this.prisma.media_assets.findFirst({
        where: {
          kind: 'image',
          sourceUrl: { not: null },
          OR: [
            { cacheStatus: 'pending' },
            {
              cacheStatus: 'failed',
              OR: [
                { cacheAttemptedAt: null },
                { cacheAttemptedAt: { lte: new Date(Date.now() - RETRY_COOLDOWN_MS) } },
              ],
            },
            { cacheStatus: 'downloading', cacheAttemptedAt: { lte: new Date(Date.now() - STALE_DOWNLOAD_MS) } },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!asset?.sourceUrl) return;
      await this.prisma.media_assets.update({
        where: { id: asset.id },
        data: { cacheStatus: 'downloading', cacheAttemptedAt: new Date() },
      });
      try {
        const { bytes, extension } = await this.download(asset.sourceUrl);
        const checksum = createHash('sha256').update(bytes).digest('hex');
        await mkdir(IMAGE_DIR, { recursive: true });
        await writeFile(join(IMAGE_DIR, `${checksum}.${extension}`), bytes, { flag: 'wx' }).catch(() => undefined);
        await this.prisma.media_assets.update({
          where: { id: asset.id },
          data: {
            ref: `/api/v1/media/audio/images/${asset.id}`,
            checksum,
            cacheExtension: extension,
            cacheStatus: 'cached',
            cacheError: null,
          },
        });
      } catch (error) {
        await this.prisma.media_assets.update({
          where: { id: asset.id },
          data: { cacheStatus: 'failed', cacheError: String((error as Error).message).slice(0, 500) },
        });
      }
    } finally {
      this.working = false;
    }
  }

  private async download(sourceUrl: string): Promise<{ bytes: Buffer; extension: string }> {
    const url = new URL(sourceUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('图片来源地址无效');
    }
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host === '127.0.0.1' || host === '::1' ||
      (isIP(host) === 4 && (host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.startsWith('169.254.')))
    ) {
      throw new Error('不允许从本地或内网地址下载课程图片');
    }
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status >= 300 && response.status < 400) throw new Error('图片地址重定向被拒绝');
    if (!response.ok) throw new Error(`图片下载失败 (${response.status})`);
    const contentType = String(response.headers.get('content-type') ?? '').split(';')[0]?.toLowerCase() ?? '';
    const extension = contentType === 'image/jpeg' ? 'jpg'
      : contentType === 'image/png' ? 'png'
        : contentType === 'image/webp' ? 'webp'
          : contentType === 'image/gif' ? 'gif' : '';
    if (!extension) throw new Error('图片格式仅支持 JPEG、PNG、WebP 和 GIF');
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_IMAGE_BYTES) throw new Error('课程图片超过 10 MB');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('课程图片超过 10 MB');
    return { bytes, extension };
  }
}
