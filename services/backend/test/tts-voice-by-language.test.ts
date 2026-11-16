import assert from 'node:assert/strict';
import { test } from 'node:test';

import { iflytekVoiceForSegment } from '@alg/ai-provider-sdk';
import {
  parseTtsCacheBypassLangs,
  textBypassesTtsCache,
} from '../src/ai-gateway/ai-gateway.service.js';

/**
 * 按语种分音色 + 英文语音在线合成。
 *
 * 背景：中文发音人 xiaoyan 读英文几乎不认 speed（实测 hello 全档 0.76→0.68s），
 * 英文发音人 vimary 同一句 1.37→0.54s。所以英文段换音色，且英文不走缓存，
 * 免得继续下发旧的中文音色英文音频。
 */

test('英文段用英文发音人，中文段保留原音色', () => {
  assert.equal(iflytekVoiceForSegment({ text: 'hello', language: 'en' }, 'xiaoyan', 'vimary'), 'vimary');
  assert.equal(iflytekVoiceForSegment({ text: '苹果', language: 'zh' }, 'xiaoyan', 'vimary'), 'xiaoyan');
  // 混排里中英各自取各自的音色
  assert.equal(iflytekVoiceForSegment({ text: '苹果', language: 'zh' }, 'xiaoyan', 'vimary'), 'xiaoyan');
  assert.equal(iflytekVoiceForSegment({ text: 'apple', language: 'en' }, 'xiaoyan', 'vimary'), 'vimary');
});

test('未配置英文发音人时退回中文音色，不报错', () => {
  assert.equal(iflytekVoiceForSegment({ text: 'hello', language: 'en' }, 'xiaoyan', ''), 'xiaoyan');
  assert.equal(iflytekVoiceForSegment({ text: 'hello', language: 'en' }, 'xiaoyan', '   '), 'xiaoyan');
});

test('按语种旁路开关：默认关闭，配置 en 后英文文本不读缓存', () => {
  const off = parseTtsCacheBypassLangs(undefined);
  assert.equal(off.size, 0);
  // 默认关闭：英文照样允许读缓存（保证缓存契约用例不变）
  assert.equal(textBypassesTtsCache('hello', off), false);
  assert.equal(textBypassesTtsCache('苹果', off), false);

  const en = parseTtsCacheBypassLangs(' en , zh ');
  assert.deepEqual([...en].sort(), ['en', 'zh']);
  assert.equal(textBypassesTtsCache('hello', en), true);
  assert.equal(textBypassesTtsCache('苹果 apple', en), true);
  // 纯中文文本仍可读缓存，中文讲解不会被逼着重复合成
  assert.equal(textBypassesTtsCache('苹果是常见水果', en), false);
  assert.equal(textBypassesTtsCache('', en), false);
});
