/**
 * 预生成语音的文本归一化与档位映射 —— **唯一实现**。
 *
 * 为什么强调唯一：导入端（离线批量）与运行时（查表命中）必须算出同一个 textHash。
 * 两份实现一旦漂移，命中率会静默归零且不报错——这是最难查的一类故障。
 * 因此导入脚本 `tools/tts_pregen/import_clips.mjs` 直接 import 本文件，禁止另写一份。
 *
 * 设计约束（详见 deliverables_tts/预生成音频索引与命中链路设计.md 第 5 节）：
 *  - NFKC 归一（全角转半角、兼容字符归一）；
 *  - 连续空白折叠为单空格，去首尾空白；
 *  - **保留大小写与标点**：二者影响发音与语调，剥离会造成「文本相同但韵律不同」的误命中；
 *  - 查表只认精确语速档（1.0 / 0.8 / 0.65），不使用吸附结果，否则「慢一点」的回合内微调会失效。
 */
import { createHash } from 'node:crypto';

/** 归一化规则版本：规则一旦调整必须升版本，令旧 textHash 自然失配而非错配。 */
export const PREGEN_TEXT_VERSION = 'pregen-text-v1';

export type PregenLang = 'en' | 'zh';
export type PregenSpeedTierId = 'normal' | 'slow' | 'very_slow';

export interface PregenSpeedTier {
  id: PregenSpeedTierId;
  /** 下发到 TTS 请求的 teacherSpeed，与三档重听按钮一一对应。 */
  teacherSpeed: number;
  /** 客户端展示用标签。 */
  label: string;
}

export const PREGEN_SPEED_TIERS: readonly PregenSpeedTier[] = [
  { id: 'normal', teacherSpeed: 1.0, label: '正常' },
  { id: 'slow', teacherSpeed: 0.8, label: '慢速' },
  { id: 'very_slow', teacherSpeed: 0.65, label: '很慢' },
] as const;

/** 归一到「同一句话的稳定形态」。纯函数，无副作用。 */
export function normalizePregenText(input: string): string {
  if (typeof input !== 'string') return '';
  return input.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** 语言判定：CJK 字符占比 ≥ 30% 视为中文，否则英文。纯函数。 */
export function detectPregenLang(text: string): PregenLang {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0 && latin === 0) return 'en';
  return cjk / (cjk + latin) >= 0.3 ? 'zh' : 'en';
}

/** 文本指纹：sha256(normalizePregenText(text))。 */
export function pregenTextHash(text: string): string {
  return createHash('sha256').update(normalizePregenText(text), 'utf8').digest('hex');
}

/**
 * 语速 → 档位。**只认精确值**：0.85 之类落在档位之间的值返回 null，
 * 调用方应回落线上供应商，而不是拿 0.8 的音频冒充 0.85。
 */
export function speedTierForTeacherSpeed(teacherSpeed: number): PregenSpeedTier | null {
  if (!Number.isFinite(teacherSpeed)) return null;
  const hit = PREGEN_SPEED_TIERS.find((tier) => Math.abs(tier.teacherSpeed - teacherSpeed) < 1e-6);
  return hit ? { ...hit } : null;
}

/** 由档位 id 反查档位。 */
export function speedTierById(id: string): PregenSpeedTier | null {
  const hit = PREGEN_SPEED_TIERS.find((tier) => tier.id === id);
  return hit ? { ...hit } : null;
}

/** 导入幂等键：同一内容同档位同引擎版本只应有一条记录。 */
export function pregenClipKey(input: {
  lang: PregenLang;
  normalizedText: string;
  speedTier: PregenSpeedTierId;
  voiceId: string;
  engineVersion: string;
}): string {
  return createHash('sha256')
    .update([PREGEN_TEXT_VERSION, input.lang, input.normalizedText, input.speedTier, input.voiceId, input.engineVersion].join('|'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * 音频文件名：`sha256(音频字节)[:24].mp3`。
 * 必须满足缓存服务的白名单正则 `^[a-f0-9]{24}\.(mp3|wav|m4a)$`，
 * 否则媒体接口拒绝下发、缓存维护会当成孤儿文件清掉。
 */
export function pregenAudioFileName(audioBytes: Buffer | Uint8Array): string {
  return `${createHash('sha256').update(audioBytes).digest('hex').slice(0, 24)}.mp3`;
}
