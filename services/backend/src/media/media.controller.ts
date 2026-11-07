/**
 * 合成音频的只读访问入口。
 *
 * TTS 适配器把真实音频落盘后返回 /api/v1/media/audio/<hash>.mp3，
 * Web / Android 用同一个 audioRef 播放。文件名是内容指纹，白名单校验防目录穿越。
 */
import { Controller, Get, HttpException, Param, StreamableFile } from '@nestjs/common';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAudioDir } from '@alg/ai-provider-sdk';

@Controller('api/v1/media/audio')
export class MediaController {
  @Get(':file')
  audio(@Param('file') file: string): StreamableFile {
    if (!/^[a-f0-9]{24}\.mp3$/i.test(file)) {
      throw new HttpException('音频不存在', 404);
    }
    const fullPath = join(resolveAudioDir(), file);
    if (!existsSync(fullPath)) {
      throw new HttpException('音频不存在', 404);
    }
    return new StreamableFile(createReadStream(fullPath), { type: 'audio/mpeg' });
  }
}
