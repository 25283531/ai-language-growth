/**
 * 语言感知的语速策略（与供应商无关的部分）。
 *
 * 产品要求（2026-11-14）：慢速教学**只针对英语**——英语单词、例句、短文需要放慢；
 * 中文讲解保持自然语速。一次合成请求只能带一个速率，因此按书写系统切段后，
 * 由各适配器把每段换算成自己的速率参数，再把音频按顺序拼接。
 *
 * 本文件只做切段与语言判定，不含任何厂商参数，保证模型/供应商可替换。
 */

/**
 * 纯英文三档的「渲染语速」：档位标签不变，但合成时用更慢的值。
 *
 * 实测（2026-11-17，Matcha）：0.8 档对短词几乎无声学差异（hello ×1.07、apple ×1.03、
 * dog ×1.04，`Sorry!` 甚至反向），孩子点「慢速」和「正常」听不出区别。
 * 因此把 0.8 档实际渲染成 0.7（实测区间 ×1.2 上下），用档位差换听感差；
 * 「很慢」0.65 本来就有 ×1.25—1.46，保持不变。
 *
 * 注意：成本档位（speedTier）仍按客户端传来的 0.8 判定，所以缓存键、预生成索引不受影响。
 */
export const ENGLISH_TIER_RENDER_SPEED: Readonly<Record<number, number>> = {
  1: 1,
  0.8: 0.7,
  0.65: 0.65,
};

/** 把档位语速换成实际渲染语速；非档位值（如 0.9）原样透传。 */
export function renderSpeedForTier(teacherSpeed: number): number {
  const value = Number.isFinite(teacherSpeed) && teacherSpeed > 0 ? teacherSpeed : 1;
  for (const [tier, render] of Object.entries(ENGLISH_TIER_RENDER_SPEED)) {
    if (Math.abs(value - Number(tier)) < 1e-6) return render;
  }
  return value;
}

export type SpeechLanguage = 'zh' | 'en';

/**
 * 中英混排句子的固定语速。
 *
 * 产品口径（2026-11-17）：混排句子不是让孩子跟读的内容（跟读项是纯英文单词/例句），
 * 所以不需要跟着「正常/慢速/很慢」三档变，统一用一个略慢的自然语速即可；
 * 只有纯英文才需要按档变速。
 */
export const MIXED_SENTENCE_SPEED = 0.8;

/** 本次合成实际采用的语速以及原因，便于日志与预生成工具复用同一套判定。 */
export interface EffectiveSpeechSpeed {
  /** 相对倍率，1 为自然语速 */
  speed: number;
  /** tier=纯英文按档变速，mixed=混排固定语速，natural=纯中文自然语速 */
  mode: 'tier' | 'mixed' | 'natural';
}

/**
 * 决定一次合成该用多快。
 *
 * - 纯英文（只有拉丁字母，没有汉字）：用调用方给的档位，三档差异只在这里生效；
 * - 中英混排：固定 {@link MIXED_SENTENCE_SPEED}，不跟档位；
 * - 纯中文（讲解、提示）：自然语速 1.0，不因为孩子选了「很慢」就把讲解拖慢。
 */
export function resolveEffectiveTeacherSpeed(
  text: string,
  teacherSpeed: number,
): EffectiveSpeechSpeed {
  const body = (text ?? '').trim();
  if (!body) return { speed: 1, mode: 'natural' };
  const hasCjk = CJK.test(body);
  const hasLatin = LATIN.test(body);
  if (hasLatin && !hasCjk) {
    return { speed: renderSpeedForTier(teacherSpeed), mode: 'tier' };
  }
  if (hasCjk && hasLatin) return { speed: MIXED_SENTENCE_SPEED, mode: 'mixed' };
  return { speed: 1, mode: 'natural' };
}

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
 * - 过短的片段（去掉空白后 < 3 个字符）并入相邻段，避免逐字合成的生硬断句。
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
