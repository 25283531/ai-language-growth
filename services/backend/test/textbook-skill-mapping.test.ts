/**
 * P0-2 回归测试：教材单元 → 能力节点映射。
 *
 * 关注点：
 *  1. 映射不再是空数组（第 3 节「教材同步」的核心承诺）；
 *  2. 输出必须是能力图谱里真实存在的节点编码；
 *  3. 双轨都覆盖，不允许只映射语言习得轨；
 *  4. 确定性：同输入同输出，且不修改入参；
 *  5. 脏数据（null / 非数组 / 未知编码）读取时被安全过滤。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { M1_SKILL_NODES } from '@alg/skill-graph';
import {
  DEFAULT_SKILL_NODE_IDS,
  mapTextbookUnitToSkillNodeIds,
  parseSkillNodeIds,
} from '../src/curriculum/textbook-skill-mapping.ts';

const KNOWN = new Set(M1_SKILL_NODES.map((node) => node.id));

describe('教材单元 → 能力节点映射', () => {
  it('问候类单元映射到听力与口语节点，且不是空数组', () => {
    const ids = mapTextbookUnitToSkillNodeIds({
      unitCode: 'Unit 1',
      unitTitle: 'Unit 1 Hello!',
      textbookTitle: '英语（PEP）',
      grade: '三年级上册',
    });
    assert.ok(ids.length > 0);
    assert.ok(ids.includes('LA.LISTEN.greeting_core'));
    assert.ok(ids.includes('LA.SPEAK.imitation'));
  });

  it('字母/拼读类单元映射到学校英语轨', () => {
    const letters = mapTextbookUnitToSkillNodeIds({ unitTitle: 'Unit 2 Letters and alphabet' });
    assert.deepEqual(letters, ['SE.SCHOOL.letters']);

    const phonics = mapTextbookUnitToSkillNodeIds({ unitTitle: 'Unit 4 自然拼读 Phonics' });
    assert.ok(phonics.includes('SE.SCHOOL.phonics'));
  });

  it('映射表同时覆盖两条轨，不允许只映射语言习得轨', () => {
    const laUnits = ['Unit 1 Hello!', 'Unit 7 Dialogue 情景对话', 'Unit 8 Grammar 语法'];
    const seUnits = ['Unit 2 Letters 字母', 'Unit 6 Story 阅读', 'Unit 9 拼写 Spelling'];
    const laProduced = laUnits.flatMap((unitTitle) => mapTextbookUnitToSkillNodeIds({ unitTitle }));
    const seProduced = seUnits.flatMap((unitTitle) => mapTextbookUnitToSkillNodeIds({ unitTitle }));
    assert.ok(laProduced.some((id) => id.startsWith('LA.')));
    assert.ok(seProduced.some((id) => id.startsWith('SE.')));
  });

  it('阅读/故事类单元映射到阅读理解与单词识读', () => {
    const ids = mapTextbookUnitToSkillNodeIds({ unitTitle: 'Unit 6 A short story 小故事' });
    assert.ok(ids.includes('SE.SCHOOL.reading'));
    assert.ok(ids.includes('SE.SCHOOL.word_reading'));
  });

  it('话题词类单元（颜色/数字/动物）映射到词汇与单词表达', () => {
    for (const title of ['Unit 3 Colours 颜色', 'Unit 5 Numbers', 'Unit 7 Animals 动物']) {
      const ids = mapTextbookUnitToSkillNodeIds({ unitTitle: title });
      assert.ok(ids.includes('LA.VOCAB.receptive'), `${title} 应映射到接受性词汇`);
    }
  });

  it('所有产出都是能力图谱里真实存在的节点，且不重复，数量受限', () => {
    const titles = [
      'Unit 1 Hello!',
      'Unit 2 Letters and sounds 字母与发音',
      'Unit 3 Colours 颜色',
      'Unit 4 自然拼读 Phonics',
      'Unit 5 Numbers and spelling 拼写',
      'Unit 6 Story 阅读 and writing 书写',
      'Unit 7 Dialogue 情景对话',
      'Unit 8 Grammar 语法与句型',
      'Unit 9 发音 Pronunciation',
      'Unit 10 完全无关的标题',
    ];
    for (const title of titles) {
      const ids = mapTextbookUnitToSkillNodeIds({ unitTitle: title });
      assert.ok(ids.length > 0, `${title} 不允许产出空映射`);
      assert.ok(ids.length <= 4, `${title} 的映射数量应受限`);
      assert.equal(new Set(ids).size, ids.length, `${title} 的映射不允许重复`);
      for (const id of ids) assert.ok(KNOWN.has(id), `${title} 产出了图谱中不存在的节点 ${id}`);
    }
  });

  it('无关键词命中时回落到起点可选、不会被硬前置阻塞的默认节点', () => {
    const ids = mapTextbookUnitToSkillNodeIds({ unitTitle: 'Unit 10 Review' });
    assert.deepEqual(ids, [...DEFAULT_SKILL_NODE_IDS]);
    assert.ok(KNOWN.has(DEFAULT_SKILL_NODE_IDS[0]!));
  });

  it('确定性：同输入连续 50 次结果一致，且不修改入参', () => {
    const input = { unitCode: 'Unit 3', unitTitle: 'Unit 3 Look at me!', grade: '三年级上册' };
    const snapshot = JSON.stringify(input);
    const first = mapTextbookUnitToSkillNodeIds(input);
    for (let i = 0; i < 50; i += 1) {
      assert.deepEqual(mapTextbookUnitToSkillNodeIds(input), first);
    }
    assert.equal(JSON.stringify(input), snapshot);
  });

  it('英文关键词按词边界匹配，不被更长单词误命中', () => {
    // "which" / "this" 里含 "hi"，不能因此被判定为问候单元
    const ids = mapTextbookUnitToSkillNodeIds({ unitTitle: 'Unit 9 Which one is this' });
    assert.ok(!ids.includes('LA.LISTEN.greeting_core'));
  });
});

describe('textbook_mappings.skillNodeIds 读取', () => {
  it('从 Json 列安全读出节点列表，过滤非字符串与未知编码', () => {
    assert.deepEqual(
      parseSkillNodeIds(['LA.VOCAB.receptive', 'NOT.A.NODE', 42, '', 'LA.VOCAB.receptive', 'SE.SCHOOL.letters']),
      ['LA.VOCAB.receptive', 'SE.SCHOOL.letters'],
    );
  });

  it('null / 非数组 / 空数组一律返回空列表，不抛错', () => {
    for (const value of [null, undefined, {}, 'LA.VOCAB.receptive', 0, []]) {
      assert.deepEqual(parseSkillNodeIds(value), []);
    }
  });
});
