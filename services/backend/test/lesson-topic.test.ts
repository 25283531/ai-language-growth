import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectLessonTopic } from '../src/orchestrator/lesson-topic.ts';

const fallback = 'topic-greetings';

describe('开课主题选择顺序', () => {
  it('客户端显式传入优先级最高', () => {
    assert.equal(selectLessonTopic({
      requested: 'topic-textbook-u07',
      profile: 'topic-manual',
      textbook: 'topic-textbook-u07',
      previous: 'topic-objects-around',
      fallback,
    }), 'topic-textbook-u07');
  });

  it('档案一次性指定优先于教材兜底', () => {
    assert.equal(selectLessonTopic({
      requested: null,
      profile: 'topic-manual',
      textbook: 'topic-textbook-u07',
      previous: 'topic-objects-around',
      fallback,
    }), 'topic-manual');
  });

  it('旧客户端不带 topicId 时按教材映射开单元课', () => {
    assert.equal(selectLessonTopic({
      requested: null,
      profile: null,
      textbook: 'topic-textbook-u07',
      previous: 'topic-objects-around',
      fallback,
    }), 'topic-textbook-u07');
  });

  it('没有教材映射时维持上一节课主题', () => {
    assert.equal(selectLessonTopic({
      requested: undefined,
      profile: undefined,
      textbook: null,
      previous: 'topic-objects-around',
      fallback,
    }), 'topic-objects-around');
  });

  it('全空时落到兜底主题，空串与 null 字面量都视为未提供', () => {
    assert.equal(selectLessonTopic({
      requested: '   ',
      profile: '',
      textbook: 'null',
      previous: null,
      fallback,
    }), fallback);
  });

  it('解析出的主题两端空白会被裁掉', () => {
    assert.equal(selectLessonTopic({
      textbook: '  topic-textbook-u07  ',
      fallback,
    }), 'topic-textbook-u07');
  });
});
