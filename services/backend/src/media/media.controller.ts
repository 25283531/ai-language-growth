/**
 * 合成音频的只读访问入口。
 *
 * TTS 适配器把真实音频落盘后返回 /api/v1/media/audio/<指纹>.<扩展名>，
 * Web / Android 用同一个 audioRef 播放。文件名是内容指纹，白名单校验防目录穿越。
 * 扩展名与 Content-Type 由协议适配器产出的编码决定，平台侧不假设一定是 MP3。
 */
import { Controller, Get, HttpException, Param, Post, Req, StreamableFile } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_EXTENSIONS, audioMimeType, resolveAudioDir } from '@alg/ai-provider-sdk';
import type { Request } from 'express';
import { SpeechQuotaService } from '../usage/speech-quota.service';

const FILE_PATTERN = new RegExp(
  `^[a-f0-9]{24}\\.(${AUDIO_EXTENSIONS.join('|')})$`,
  'i',
);

@Controller('api/v1/media/audio')
export class MediaController {
  constructor(private readonly quota: SpeechQuotaService) {}

  /**
   * 原型音频上传：客户端直接提交录音字节，服务端只保存内容指纹文件并返回
   * 可被 ASR/发音评测适配器读取的 audioRef。正式版本仍需接入短期对象存储、
   * 监护人授权和自动过期清理。
   */
  @Post('uploads')
  async upload(@Req() request: Request) {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new HttpException('请求体必须是音频字节', 400);
    }
    if (body.length > 10 * 1024 * 1024) {
      throw new HttpException('音频文件不能超过 10 MB', 413);
    }

    const mime = (String(request.headers['content-type'] ?? '').split(';', 1)[0] ?? '').toLowerCase();
    const extension =
      mime === 'audio/mp4' || mime === 'audio/x-m4a'
        ? 'm4a'
        : mime === 'audio/wav' || mime === 'audio/x-wav'
          ? 'wav'
          : mime === 'audio/mpeg' || mime === 'audio/mp3'
            ? 'mp3'
            : null;
    if (!extension) {
      throw new HttpException('仅支持 audio/mp4、audio/wav 或 audio/mpeg', 415);
    }

    // 端侧采集必须先拿到服务端短期额度租约。没有租约就拒绝，
    // 从服务端入口阻断绕过客户端计时器的音频上传。
    const reservationId = String(request.headers['x-speech-quota-reservation'] ?? '').trim();
    const learnerId = String(request.headers['x-learner-id'] ?? '').trim();
    if (!reservationId || !learnerId) {
      throw new HttpException('音频请求缺少额度租约或学习者标识', 400);
    }
    await this.quota.assertReservation({
      reservationId,
      learnerId,
      serviceKind: 'asr',
    });

    const digest = createHash('sha256').update(body).digest('hex').slice(0, 24);
    const fileName = `${digest}.${extension}`;
    const directory = resolveAudioDir();
    mkdirSync(directory, { recursive: true });
    const fullPath = join(directory, fileName);
    if (!existsSync(fullPath)) writeFileSync(fullPath, body, { flag: 'wx' });

    return {
      audioRef: `/api/v1/media/audio/${fileName}`,
      bytes: body.length,
      contentType: audioMimeType(extension),
      retention: 'prototype-cache',
    };
  }

  @Get(':file')
  async audio(@Param('file') file: string, @Req() request: Request): Promise<StreamableFile> {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new HttpException('音频不存在', 404);
    }
    const fullPath = join(resolveAudioDir(), file);
    if (!existsSync(fullPath)) {
      throw new HttpException('音频不存在', 404);
    }
    const reservationId = String(request.headers['x-speech-quota-reservation'] ?? '').trim();
    const learnerId = String(request.headers['x-learner-id'] ?? '').trim();
    if (!reservationId || !learnerId) {
      throw new HttpException('音频下载缺少额度租约或学习者标识', 400);
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
}
