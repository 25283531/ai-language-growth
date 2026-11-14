/**
 * 语言感知的语速策略（与供应商无关的部分）。
 *
 * 产品要求（2026-11-14）：慢速教学**只针对英语**——英语单词、例句、短文需要放慢；
 * 中文讲解保持自然语速。一次合成请求只能带一个速率，因此按书写系统切段后，
 * 由各适配器把每段换算成自己的速率参数，再把音频按顺序拼接。
 *
 * 本文件只做切段与语言判定，不含任何厂商参数，保证模型/供应商可替换。
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
