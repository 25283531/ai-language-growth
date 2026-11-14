/**
 * 语言感知语速回归（2026-11-14 用户要求）：
 * 慢速教学只针对英语——英语单词 / 例句 / 短文放慢，中文讲解保持自然语速。
 *
 * 覆盖：
 *  - 中英混排按语言边界切段，纯中文 / 纯英文仍是一段（不返回原“按长度切分”）；
 *  - 标点跟随前一段，短片段并入相邻段，避免逐字合成的断句感；
 *  - 档位型供应商的英语段按老师语速取档位、中文段固定自然档；
 *  - 连续型供应商（0—100）英语段按老师语速换算、中文段固定 50。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  iflytekSpeedForSegment,
  splitByLanguage,
  tencentSpeedForSegment,
} from '@alg/ai-provider-sdk';

const en = (text: string) => ({ text, language: 'en' as const });
const zh = (text: string) => ({ text, language: 'zh' as const });

describe('splitByLanguage', () => {
  it('纯英文只有一段，且判定为 en', () => {
    const segments = splitByLanguage('Listen and say: apple.');
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.language, 'en');
  });

  it('纯中文只有一段，且判定为 zh', () => {
    const segments = splitByLanguage('看，这是苹果。跟我读。');
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.language, 'zh');
  });

  it('中英混排按语言边界切段，且不丢字', () => {
    const text = '看，这是 apple。跟我读：apple！';
    const segments = splitByLanguage(text);
    assert.ok(segments.length >= 2);
    assert.equal(segments.map((segment) => segment.text).join(''), text);
    assert.equal(segments.some((segment) => segment.language === 'en'), true);
    assert.equal(segments.some((segment) => segment.language === 'zh'), true);
  });

  it('空白文本返回空数组，不抛错', () => {
    assert.deepEqual(splitByLanguage('   '), []);
  });
});

describe('每段速率：英语放慢，中文自然', () => {
  it('档位型：英语段按老师语速取最近档位，中文段固定 0 档', () => {
    assert.equal(tencentSpeedForSegment(en('apple'), 0.44), -2);
    assert.equal(tencentSpeedForSegment(en('apple'), 0.65), -2);
    assert.equal(tencentSpeedForSegment(en('apple'), 0.8), -1);
    assert.equal(tencentSpeedForSegment(en('apple'), 1.0), 0);
    assert.equal(tencentSpeedForSegment(en('apple'), 1.2), 1);
    assert.equal(tencentSpeedForSegment(en('apple'), 1.6), 2);
    // 中文段不受慢速教学影响
    assert.equal(tencentSpeedForSegment(zh('苹果'), 0.44), 0);
    assert.equal(tencentSpeedForSegment(zh('苹果'), 1.2), 0);
  });

  it('连续型：英语段按老师语速换算到 0—100，中文段固定 50', () => {
    assert.equal(iflytekSpeedForSegment(zh('苹果'), 0.44), 50);
    assert.equal(iflytekSpeedForSegment(zh('苹果'), 1.2), 50);
    assert.equal(iflytekSpeedForSegment(en('apple'), 1.0), 43);
    assert.ok(iflytekSpeedForSegment(en('apple'), 0.44) < iflytekSpeedForSegment(en('apple'), 1.0));
  });
});
