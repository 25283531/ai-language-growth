import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractMetadataWords, normalizeTextbookWord } from '../src/curriculum/textbook-word-injection';

describe('P3-06 教材词注入入口', () => {
  it('提取 metadata 的顶层词表、字符串词表和已生成内容词表', () => {
    const words = extractMetadataWords({
      words: ['apple', 'banana'],
      wordList: 'cat, dog\nbird',
      vocabulary: [{ word: 'giraffe' }, { text: 'ice cream' }],
      content: { vocabulary: [{ word: 'panda' }], keyWords: ['red'] },
    });
    assert.deepEqual(words, [
      'apple', 'banana',
      'cat', ' dog', 'bird',
      'giraffe', 'ice cream',
      'panda', 'red',
    ]);
  });

  it('规范化小写、去序号、压空格，并拒绝非词形数据', () => {
    assert.equal(normalizeTextbookWord(' 1. Apple '), 'apple');
    assert.equal(normalizeTextbookWord('ice   cream'), 'ice cream');
    assert.equal(normalizeTextbookWord("don't"), "don't");
    assert.equal(normalizeTextbookWord('3) well-known'), 'well-known');
    assert.equal(normalizeTextbookWord('中文'), '');
    assert.equal(normalizeTextbookWord('123'), '');
    assert.equal(normalizeTextbookWord(''), '');
  });

  it('保留原始顺序，由 normalize 统一清洗', () => {
    const words = extractMetadataWords({ words: ['Apple', 'apple', 'banana'] })
      .map(normalizeTextbookWord)
      .filter(Boolean);
    assert.deepEqual(words, ['apple', 'apple', 'banana']);
  });
});
