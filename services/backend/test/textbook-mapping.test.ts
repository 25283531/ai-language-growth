import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inferSchoolModules,
  inferTextbookUnitMapping,
  resolveTextbookUnitMapping,
} from '../src/curriculum/textbook-mapping.ts';

describe('教材单元映射', () => {
  it('没有存储映射时按单元信息推断能力节点与学校模块', () => {
    const mapping = inferTextbookUnitMapping({
      unitCode: 'Unit 2',
      title: 'Letters and phonics 字母与拼读',
      grade: '三年级上册',
    });
    assert.ok(mapping.skillNodeIds.includes('SE.SCHOOL.letters'));
    assert.ok(mapping.skillNodeIds.includes('SE.SCHOOL.phonics'));
    assert.deepEqual(mapping.schoolModules, ['A', 'B']);
    assert.equal(mapping.source, 'inferred');
    assert.equal(mapping.origin, 'inferred');
    assert.equal(mapping.version, 0);
  });

  it('话题单元不会为了覆盖学校轨而硬塞 A-E 模块', () => {
    const mapping = inferTextbookUnitMapping({
      unitCode: 'Unit 3',
      title: 'My Family',
      grade: '三年级上册',
    });
    assert.ok(mapping.skillNodeIds.includes('LA.VOCAB.receptive'));
    assert.deepEqual(mapping.schoolModules, []);
  });

  it('显式映射优先，并过滤未知能力节点与非法模块', () => {
    const mapping = resolveTextbookUnitMapping({
      skillNodeIds: ['LA.VOCAB.receptive', 'NOT.A.NODE', 'SE.SCHOOL.spelling'],
      domains: ['family', 'family', 42],
      schoolModules: ['D', 'Z', 'a'],
      stageHint: 3,
      source: 'ai',
      version: 7,
    }, {
      unitCode: 'Unit 3',
      title: 'My Family',
    });
    assert.deepEqual(mapping.skillNodeIds, ['LA.VOCAB.receptive', 'SE.SCHOOL.spelling']);
    assert.deepEqual(mapping.domains, ['family']);
    assert.deepEqual(mapping.schoolModules, ['A', 'D']);
    assert.equal(mapping.stageHint, 3);
    assert.equal(mapping.source, 'ai');
    assert.equal(mapping.origin, 'stored');
    assert.equal(mapping.version, 7);
  });

  it('存储映射缺少模块时用能力节点与单元信息补齐', () => {
    const mapping = resolveTextbookUnitMapping({
      skillNodeIds: ['SE.SCHOOL.reading'],
      domains: [],
      schoolModules: [],
      stageHint: null,
      source: 'editorial',
      version: 1,
    }, {
      unitCode: 'Unit 6',
      title: 'A short story 小故事',
    });
    assert.deepEqual(mapping.schoolModules, ['C']);
    assert.equal(mapping.stageHint, null);
  });

  it('单元元数据里的学校模块可作为推断输入', () => {
    assert.deepEqual(inferSchoolModules({
      unitCode: 'Unit 1',
      title: 'Hello',
      metadataModules: ['B', 'C', 'C'],
    }, []), ['B', 'C']);
  });
});
