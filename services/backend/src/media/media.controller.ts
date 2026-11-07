/**
 * 合成音频的只读访问入口。
 *
 * TTS 适配器把真实音频落盘后返回 /api/v1/media/audio/<指纹>.<扩展名>，
 * Web / Android 用同一个 audioRef 播放。文件名是内容指纹，白名单校验防目录穿越。
 * 扩展名与 Content-Type 由协议适配器产出的编码决定，平台侧不假设一定是 MP3。
 */
import { Controller, Get, HttpException, Param, StreamableFile } from '@nestjs/common';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_EXTENSIONS, audioMimeType, resolveAudioDir } from '@alg/ai-provider-sdk';

const FILE_PATTERN = new RegExp(
  `^[a-f0-9]{24}\\.(${AUDIO_EXTENSIONS.join('|')})$`,
  'i',
);

@Controller('api/v1/media/audio')
export class MediaController {
  @Get(':file')
  audio(@Param('file') file: string): StreamableFile {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new HttpException('音频不存在', 404);
    }
    const fullPath = join(resolveAudioDir(), file);
    if (!existsSync(fullPath)) {
      throw new HttpException('音频不存在', 404);
    }
    return new StreamableFile(createReadStream(fullPath), {
      type: audioMimeType(match[1]!.toLowerCase()),
    });
  }
}
