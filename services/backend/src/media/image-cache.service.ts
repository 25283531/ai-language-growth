import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { QueueRuntimeService } from '../queue/queue-runtime.service';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const STALE_DOWNLOAD_MS = 10 * 60 * 1000;
const IMAGE_DIR = process.env.AI_MEDIA_CACHE_DIR || join(process.cwd(), '.cache', 'media');

export async function persistCachedImage(bytes: Buffer, extension: string, directory = IMAGE_DIR): Promise<string> {
  const checksum = createHash('sha256').update(bytes).digest('hex');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${checksum}.${extension}`);
  await writeFile(path, bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error('既有图片缓存内容校验失败');
  });
  return checksum;
}

@Injectable()
export class ImageCacheService implements OnModuleInit {
  private working = false;
  private readonly imageDirectory = IMAGE_DIR;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueRuntimeService,
  ) {}

  onModuleInit(): void {
    this.queue.startImageCache(async (job) => {
      await this.cacheNext(job.data.assetId, async (assetId) => {
        await job.updateData({ assetId });
      });
    });
  }

  async cacheNext(retryAssetId?: string, rememberAsset?: (assetId: string) => Promise<void>): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      const asset = retryAssetId
        ? await this.prisma.media_assets.findFirst({ where: { id: retryAssetId, kind: 'image', cacheStatus: { not: 'cached' } } })
        : await this.prisma.media_assets.findFirst({
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
      // Persist only the ID so BullMQ retries revisit the same asset despite DB cooldown.
      await rememberAsset?.(asset.id);
      await this.prisma.media_assets.update({
        where: { id: asset.id },
        data: { cacheStatus: 'downloading', cacheAttemptedAt: new Date() },
      });
      try {
        const { bytes, extension } = await this.download(asset.sourceUrl);
        const checksum = await persistCachedImage(bytes, extension, this.imageDirectory);
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
      } catch {
        await this.prisma.media_assets.update({
          where: { id: asset.id },
          data: { cacheStatus: 'failed', cacheError: '课程图片缓存失败，等待后台重试' },
        });
        // Do not persist source URLs or upstream errors into Redis/logs.
        throw new Error('课程图片缓存失败');
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
