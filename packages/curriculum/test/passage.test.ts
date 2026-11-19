import assert from 'node:assert/strict';
import test from 'node:test';
import { splitLongSentence, splitPassage, splitSentences } from '../src/passage';

test('按中英文句末标点切句，并保留引号与组合标点', () => {
  assert.deepEqual(
    splitSentences('She said, "Hello." Then she left!'),
    ['She said, "Hello."', 'Then she left!'],
  );
  assert.deepEqual(
    splitSentences('Wait... What? Really?!'),
    ['Wait...', 'What?', 'Really?!'],
  );
  assert.deepEqual(
    splitSentences('你好。今天天气很好！你叫什么？'),
    ['你好。', '今天天气很好！', '你叫什么？'],
  );
});

test('不误切常见缩写、小数、时间和编号', () => {
  assert.deepEqual(
    splitSentences('Mr. Smith is here. He is 3.14 meters tall. It is 10:30. Unit 3 starts.'),
    [
      'Mr. Smith is here.',
      'He is 3.14 meters tall.',
      'It is 10:30.',
      'Unit 3 starts.',
    ],
  );
  assert.deepEqual(
    splitSentences('Use e.g. this one, i.e. the red one, etc. Then stop.'),
    ['Use e.g. this one, i.e. the red one, etc.', 'Then stop.'],
  );
  assert.deepEqual(
    splitSentences('I live in the U.S. She lives in the U.K.'),
    ['I live in the U.S.', 'She lives in the U.K.'],
  );
});

test('整篇切分保留段落，并生成稳定句子 id', () => {
  const result = splitPassage(
    'Hello. Nice to meet you.\n\nThis is my family. I love them.',
    'u03',
  );
  assert.equal(result.length, 2);
  assert.deepEqual(result[0]!.map((sentence) => sentence.id), ['u03-s01', 'u03-s02']);
  assert.deepEqual(result[1]!.map((sentence) => sentence.id), ['u03-s03', 'u03-s04']);
  assert.deepEqual(result[0]!.map((sentence) => sentence.en), ['Hello.', 'Nice to meet you.']);
});

test('超长句在从句边界切分，所有句子不超过上限并标记 splitFrom', () => {
  const source = `${'This is a very long sentence, '.repeat(30)}and this is the end.`;
  const result = splitPassage(source, 'u03', { maxLength: 120 });
  const sentences = result[0]!;
  assert.ok(sentences.length > 1);
  assert.ok(sentences.every((sentence) => Array.from(sentence.en).length <= 120));
  assert.equal(sentences[0]!.splitFrom, undefined);
  assert.ok(sentences.slice(1).every((sentence) => sentence.splitFrom === sentences[0]!.id));
  assert.ok(sentences.every((sentence, index) => sentence.id === `u03-s${String(index + 1).padStart(2, '0')}`));
});

test('没有从句边界时按字符硬切，不丢字符', () => {
  const source = 'a'.repeat(1200);
  const chunks = splitLongSentence(source, 500);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [500, 500, 200]);
  assert.equal(chunks.join(''), source);
});

test('编辑时复用未改动句子 id，新增句取最大序号 + 1', () => {
  const original = splitPassage('A. B. C.', 'u03');
  const existing = original[0]!;
  const inserted = splitPassage('A. New. B. C.', 'u03', { existing });
  assert.deepEqual(inserted[0]!.map((sentence) => sentence.id), ['u03-s01', 'u03-s04', 'u03-s02', 'u03-s03']);
  assert.deepEqual(inserted[0]!.map((sentence) => sentence.en), ['A.', 'New.', 'B.', 'C.']);

  const changed = splitPassage('Changed. B. C.', 'u03', { existing });
  assert.deepEqual(changed[0]!.map((sentence) => sentence.id), ['u03-s04', 'u03-s02', 'u03-s03']);
});

test('空段落和空白输入不产生句子', () => {
  assert.deepEqual(splitSentences('   \n  '), []);
  assert.deepEqual(splitPassage('  \n\n  ', 'u03'), []);
});
