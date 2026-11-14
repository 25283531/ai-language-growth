/**
 * 语言感知的语速策略。
 *
 * 产品要求（2026-11-14 用户明确）：慢速教学**只针对英语**——英语单词、例句、
 * 短文需要放慢；中文讲解保持自然语速，不需要放慢。
 *
 * 因此合成前先按书写系统切段，逐段用各自的档位调用供应商，再把音频按顺序拼接。
 * 这两个函数是纯函数，便于单测；适配器只负责把结果映射成厂商参数。
 */

export type SpeechLanguage = 'zh' | 'en';

export interface SpeechSegment {
  text: string;
  language: SpeechLanguage;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;
const LATIN = /[A-Za-z]/;

/** 一个字符属于哪一侧；标点跟着前一个有效字符走，避免把句读切散。 */
function languageOfChar(char: string, previous: SpeechLanguage): SpeechLanguage {
  if (CJK.test(char)) return 'zh';
  if (LATIN.test(char)) return 'en';
  return previous;
}

/**
 * 把一段中英混排文本切成按语言归并的片段。
 *
 * - 纯中文或纯英文只有一段；
 * - 空白与标点跟随前一段，避免出现以标点开头的片段；
 * - 过短的片段（< 3 个字符）并入相邻段，避免逐字合成的生硬断句。
 */
export function splitByLanguage(text: string): SpeechSegment[] {
  const body = (text ?? '').trim();
  if (!body) return [];

  const raw: SpeechSegment[] = [];
  let current = '';
  let currentLanguage: SpeechLanguage = LATIN.test(body.charAt(0)) ? 'en' : 'zh';
  for (const char of body) {
    const language = languageOfChar(char, currentLanguage);
    if (current && language !== currentLanguage) {
      raw.push({ text: current, language: currentLanguage });
      current = '';
    }
    currentLanguage = language;
    current += char;
  }
  if (current) raw.push({ text: current, language: currentLanguage });

  // 合并过短片段：读起来更像一句话，也少一次供应商调用。
  const merged: SpeechSegment[] = [];
  for (const segment of raw) {
    const previous = merged[merged.length - 1];
    const shortEnough = [...segment.text.replace(/\s+/gu, '')].length < 3;
    if (previous && shortEnough) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged.filter((segment) => segment.text.trim().length > 0);
}

/** 腾讯云 Speed 是档位不是倍率：-2→0.6x、-1→0.8x、0→1.0x、1→1.2x、2→1.5x。 */
const TENCENT_GEARS: ReadonlyArray<readonly [ratio: number, gear: number]> = [
  [0.6, -2],
  [0.8, -1],
  [1.0, 0],
  [1.2, 1],
  [1.5, 2],
];

/** 中文不受慢速教学影响，固定用自然语速。 */
export const NEUTRAL_TENCENT_SPEED = 0;
/** 讯飞 speed 取值 0—100，50 为自然语速。 */
export const NEUTRAL_IFLYTEK_SPEED = 50;

export function tencentSpeedForTeacherSpeed(teacherSpeed: number): number {
  const value = Number.isFinite(teacherSpeed) && teacherSpeed > 0 ? teacherSpeed : 1;
  return TENCENT_GEARS.reduce((best, gear) =>
    Math.abs(gear[0] - value) < Math.abs(best[0] - value) ? gear : best,
  )[1];
}

export function iflytekSpeedForTeacherSpeed(teacherSpeed: number): number {
  const value = Number.isFinite(teacherSpeed) && teacherSpeed > 0 ? teacherSpeed : 1;
  return Math.max(0, Math.min(100, Math.round(((value - 0.25) / 1.75) * 100)));
}

/**
 * 某一段该用的腾讯云档位：英语按老师语速放慢，中文固定自然语速。
 */
export function tencentSpeedForSegment(segment: SpeechSegment, teacherSpeed: number): number {
  return segment.language === 'en' ? tencentSpeedForTeacherSpeed(teacherSpeed) : NEUTRAL_TENCENT_SPEED;
}

/** 某一段该用的讯飞速度值：英语按老师语速放慢，中文固定自然语速。 */
export function iflytekSpeedForSegment(segment: SpeechSegment, teacherSpeed: number): number {
  return segment.language === 'en' ? iflytekSpeedForTeacherSpeed(teacherSpeed) : NEUTRAL_IFLYTEK_SPEED;
}
