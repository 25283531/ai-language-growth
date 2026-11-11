import assert from 'node:assert/strict';
import test from 'node:test';
import { cefrCurriculumPackageSchema } from '@alg/shared-contracts';
import {
  buildCefrCurriculum,
  buildCefrPreset,
  normalizeCefrLevel,
  normalizeWordList,
} from '../src/cefr';

test('预置 CEFR 课程包含 7 个等级、完整单元与活动', () => {
  const preset = buildCefrPreset();
  assert.equal(preset.levels.length, 7);
  assert.deepEqual(preset.levels.map((level) => level.code), ['pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  assert.equal(preset.levels.reduce((sum, level) => sum + level.units.length, 0), 35);
  assert.ok(preset.levels.every((level) => level.units.every((unit) => unit.vocabulary.length === 5)));
  assert.ok(preset.levels.every((level) => level.units.every((unit) => unit.lessons.length === 17)));
  assert.equal(cefrCurriculumPackageSchema.safeParse(preset).success, true);
});

test('教材词表可生成完整课程，未知词也不会缺活动', () => {
  const result = buildCefrCurriculum({
    title: '三年级上册 Unit 3',
    level: 'A1',
    words: 'apple\nbanana\nmysteryword',
    packageId: 'test-package',
    generatedAt: '2026-11-12T00:00:00.000Z',
    unitSize: 3,
  });
  const unit = result.levels[0]!.units[0]!;
  assert.equal(unit.vocabulary.length, 3);
  assert.equal(unit.lessons.length, 11);
  assert.ok(unit.vocabulary.every((item) => item.exampleSentences.length === 1));
  assert.ok(unit.lessons.every((lesson) => lesson.assessment.acceptedTexts.length > 0));
  assert.equal(cefrCurriculumPackageSchema.safeParse(result).success, true);
});

test('词表清洗去重、去编号，并支持中文等级别名', () => {
  assert.deepEqual(normalizeWordList('1. apple\n2) banana\napple\n\norange'), ['apple', 'banana', 'orange']);
  assert.equal(normalizeCefrLevel('pre_a1'), 'pre-A1');
  assert.equal(normalizeCefrLevel('A'), 'A1');
  assert.equal(normalizeCefrLevel('C2'), 'C2');
});

test('所有预置活动满足单次 TTS 上限', () => {
  for (const level of buildCefrPreset().levels) {
    for (const unit of level.units) {
      for (const lesson of unit.lessons) {
        const codePoints = Array.from(lesson.media.speechText);
        const cjk = codePoints.filter((char) => /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char)).length;
        assert.ok(codePoints.length <= 500, `${lesson.id} 字符超限`);
        assert.ok(cjk <= 150, `${lesson.id} 汉字超限`);
      }
    }
  }
});
