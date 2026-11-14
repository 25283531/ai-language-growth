/**
 * 语言感知语速回归（2026-11-14 用户要求）：
 * 慢速教学只针对英语——英语单词 / 例句 / 短文放慢，中文讲解保持自然语速。
 *
 * 覆盖：
 *  - 中英混排按语言边界切段，纯中文 / 纯英文仍是一段（不返回原“按长度切分”）；
 *  - 标点跟随前一段，短片段并入相邻段，避免逐字合成的断句感；
 *  - 腾讯云 Speed 用档位（0.6/0.8/1.0/1.2/1.5），不是倍率；
 *  - 讯飞 speed 用 0—100，中文固定 50。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  iflytekSpeedForSegment,
  iflytekSpeedForTeacherSpeed,
  splitByLanguage,
  tencentSpeedForSegment,
  tencentSpeedForTeacherSpeed,
} from '@alg/ai-provider-sdk';

describe('splitByLanguage', () => {
  it('纯英文只有一段，且判定为 en', () => {
    const segments = splitByLanguage('Listen and say: apple.');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].language, 'en');
  });

  it('纯中文只有一段，且判定为 zh', () => {
    const segments = splitByLanguage('看，这是苹果。跟我读。');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].language, 'zh');
  });

  it('中英混排按语言边界切段，标点不缺字', () => {
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

describe('腾讯云档位与讯飞速度值', () => {
  it('英语段按老师语速取最近档位，中文段固定自然语速', () => {
    assert.equal(tencentSpeedForTeacherSpeed(0.44), -2);
    assert.equal(tencentSpeedForTeacherSpeed(0.65), -2);
    assert.equal(tencentSpeedForTeacherSpeed(0.8), -1);
    assert.equal(tencentSpeedForTeacherSpeed(1.0), 0);
    assert.equal(tencentSpeedForTeacherSpeed(1.2), 1);
    assert.equal(tencentSpeedForSegment({ text: 'apple', language: 'en' }, 0.44), -2);
    assert.equal(tencentSpeedForSegment({ text: '苹果', language: 'zh' }, 0.44), 0);
  });

  it('讯飞：中文固定 50，英文按老师语速换算到 0—100', () => {
    assert.equal(iflytekSpeedForSegment({ text: '苹果', language: 'zh' }, 0.44), 50);
    assert.equal(iflytekSpeedForTeacherSpeed(1.0), 43);
    assert.equal(iflytekSpeedForSegment({ text: 'apple', language: 'en' }, 1.0), 43);
    // 越慢的倍率得到越小的 speed 值
    assert.ok(iflytekSpeedForTeacherSpeed(0.44) < iflytekSpeedForTeacherSpeed(1.0));
  });
});
