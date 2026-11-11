/**
 * 合成音频的只读访问入口。
 *
 * TTS 适配器把真实音频落盘后返回 /api/v1/media/audio/<指纹>.<扩展名>，
 * Web / Android 用同一个 audioRef 播放。文件名是内容指纹，白名单校验防目录穿越。
 * 扩展名与 Content-Type 由协议适配器产出的编码决定，平台侧不假设一定是 MP3。
 */
import { Controller, Get, HttpException, Param, Post, Req, StreamableFile } from '@nestjs/common';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUDIO_EXTENSIONS,
  audioMimeType,
  resolveAudioDir,
  resolveUploadDir,
} from '@alg/ai-provider-sdk';
import type { Request } from 'express';
import { SpeechQuotaService } from '../usage/speech-quota.service';
import { AuthService, extractBearerToken } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';

const FILE_PATTERN = new RegExp(
  `^[a-f0-9]{24}\\.(${AUDIO_EXTENSIONS.join('|')})$`,
  'i',
);
const IMAGE_PATTERN = /^[a-f0-9-]{36}$/i;
const IMAGE_DIR = process.env.AI_MEDIA_CACHE_DIR || join(process.cwd(), '.cache', 'media');

@Controller('api/v1/media/audio')
export class MediaController {
  constructor(
    private readonly quota: SpeechQuotaService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 儿童录音不落盘。
   *
   * 手机端录音只保留在设备本地；需要 ASR/发音评估时，把音频作为
   * `audioBase64` 放进 `/lessons/{id}/turn` 的本次请求，服务端只在内存/临时
   * 请求生命周期内转发给供应商，不写 media_assets、不写 uploads 目录。
   * 旧上传入口保留为明确的 410，避免客户端继续把录音传到服务端。
   */
  @Post('uploads')
  async upload(): Promise<never> {
    throw new HttpException({
      message: '服务端不再接收儿童录音文件；请改用 /lessons/{id}/turn 的 audioBase64 一次性转发。',
      code: 'AUDIO_UPLOAD_DISABLED',
    }, 410);
  }

  @Get(':file')
  async audio(@Param('file') file: string, @Req() request: Request): Promise<StreamableFile> {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new HttpException('音频不存在', 404);
    }
    const reservationId = String(request.headers['x-speech-quota-reservation'] ?? '').trim();
    const learnerId = String(request.headers['x-learner-id'] ?? '').trim();
    if (!reservationId || !learnerId) {
      throw new HttpException('音频下载缺少额度租约或学习者标识', 400);
    }
    await this.auth.assertLearnerOwnership(
      extractBearerToken(request.headers.authorization, request.headers.cookie),
      learnerId,
    );
    // 先看本人私有录音目录：命中即本人资产，不必回查数据库。
    const ownUpload = join(resolveUploadDir(learnerId), file);
    const publicPath = join(resolveAudioDir(), file);
    let fullPath: string;
    if (existsSync(ownUpload)) {
      fullPath = ownUpload;
    } else if (existsSync(publicPath)) {
      // 公共 TTS 音频：按资产作用域与归属校验，禁止拿本人租约读别人的私人音频。
      await this.assertAudioAssetAccess(file, learnerId);
      fullPath = publicPath;
    } else {
      throw new HttpException('音频不存在', 404);
    }
    await this.quota.assertReservation({
      reservationId,
      learnerId,
      serviceKind: 'tts',
    });
    return new StreamableFile(createReadStream(fullPath), {
      type: audioMimeType(match[1]!.toLowerCase()),
    });
  }

  /**
   * 公共目录音频的资产归属校验。
   *
   * media_assets 中登记的资产按 scope 分三类：
   *  - PUBLIC_CURRICULUM / PRONUNCIATION 或旧数据（无 scope）：任何已通过学习者
   *    归属校验的调用方都可读，这是「同一课程跨用户复用」的前提；
   *  - PRIVATE_DYNAMIC / PRIVATE_UPLOAD：只有 ownerLearnerId 本人可读；
   *  - 已过 expiresAt 的私人资产：无论谁请求都按不存在处理。
   * 无登记的旧音频保持既有行为（租约 + 学习者归属），不因缺少元数据而误拒。
   */
  private async assertAudioAssetAccess(file: string, learnerId: string): Promise<void> {
    const checksum = file.split('.')[0];
    const assets = await this.prisma.media_assets.findMany({
      where: { kind: 'audio', checksum },
      select: { scope: true, ownerLearnerId: true, expiresAt: true },
    });
    if (!assets.length) return;
    const now = Date.now();
    const active = assets.filter((asset) => !asset.expiresAt || asset.expiresAt.getTime() > now);
    if (!active.length) throw new HttpException('音频不存在', 404);
    const ownedByCaller = active.some((asset) => asset.ownerLearnerId === learnerId);
    const shared = active.some((asset) => !asset.ownerLearnerId
      && (asset.scope === null || asset.scope === 'PUBLIC_CURRICULUM' || asset.scope === 'PRONUNCIATION'));
    if (!ownedByCaller && !shared) throw new HttpException('音频不存在', 404);
  }

  @Get('images/:file')
  async image(@Param('file') file: string): Promise<StreamableFile> {
    if (!IMAGE_PATTERN.test(file)) throw new HttpException('图片不存在', 404);
    const asset = await this.prisma.media_assets.findUnique({ where: { id: file } });
    if (!asset || asset.kind !== 'image' || asset.cacheStatus !== 'cached' || !asset.checksum || !asset.cacheExtension) {
      throw new HttpException('图片尚未缓存', 404);
    }
    const fullPath = join(IMAGE_DIR, `${asset.checksum}.${asset.cacheExtension}`);
    if (!existsSync(fullPath)) throw new HttpException('图片尚未缓存', 404);
    const mime = asset.cacheExtension === 'jpg' || asset.cacheExtension === 'jpeg'
      ? 'image/jpeg'
      : `image/${asset.cacheExtension}`;
    return new StreamableFile(createReadStream(fullPath), { type: mime });
  }
}
