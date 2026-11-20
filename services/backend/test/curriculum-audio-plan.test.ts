import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assembleCurriculumPassage,
  buildCurriculumAudioPlan,
  selectFocusWords,
} from '../src/curriculum/curriculum-audio-plan.ts';

const content = {
  passage: {
    title: 'My Family',
    paragraphs: [{
      sentences: [
        {
          id: 'Unit-3-s01',
          en: 'This is my father.',
          zh: '这是我的爸爸。',
          keyWords: ['father'],
          grammarIds: [],
          schoolModules: [],
        },
        {
          id: 'Unit-3-s02',
          en: 'My father is kind.',
          zh: '我的爸爸很和善。',
          keyWords: ['father', 'kind'],
          grammarIds: [],
          schoolModules: [],
        },
      ],
    }],
  },
  vocabulary: [
    {
      word: 'father',
      phonetic: '/ˈfɑːðər/',
      meaningZh: '爸爸',
      syllables: ['fa', 'ther'],
      difficultPhonemes: ['/ð/'],
      phrases: [],
      exampleSentences: [],
    },
    {
      word: 'family',
      phonetic: '/ˈfæməli/',
      meaningZh: '家庭',
      syllables: ['fam', 'i', 'ly'],
      difficultPhonemes: [],
      phrases: [],
      exampleSentences: [],
    },
  ],
  activities: [
    { targetWords: ['father'], taskType: 'word_mimicry', scenario: 'story_scene', skillNodeIds: ['LA.VOCAB.family'] },
    { targetWords: ['family'], taskType: 'listening_comprehension', scenario: 'story_scene', skillNodeIds: ['LA.LISTEN.family'] },
  ],
} as never;

describe('curriculum audio plan', () => {
  it('每句规划正常 1.0 与慢速 0.65 两条音频', () => {
    const plan = buildCurriculumAudioPlan(content);
    assert.equal(plan.sentenceClips.length, 4);
    const first = plan.sentenceClips.filter((clip) => clip.clipKey === 'sentence:Unit-3-s01');
    assert.deepEqual(first.map((clip) => [clip.speedTier, clip.speed]), [['normal', 1], ['slow', 0.65]]);
    assert.ok(first.every((clip) => clip.text === 'This is my father.'));
  });

  it('重点词只合成整词慢速与自然语速，不再拆分音节', () => {
    const plan = buildCurriculumAudioPlan(content);
    assert.ok(plan.focusWords.length >= 2 && plan.focusWords.length <= 4);
    const father = plan.focusWords.find((word) => word.word === 'father');
    assert.ok(father);
    assert.deepEqual(father.clips.map((clip) => clip.kind), ['word', 'natural']);
    assert.deepEqual(father.clips.map((clip) => clip.position), [0, 1]);
    assert.equal(father.clips[0]?.text, 'father');
    assert.equal(father.clips[0]?.speed, 0.65);
    assert.equal(father.clips.at(-1)?.speed, 1);
    assert.match(father.reason, /课文出现 2 次/);
    assert.match(father.reason, /困难音素/);
  });

  it('音节与音素只作为文字提示，不生成朗读片段', () => {
    const plan = buildCurriculumAudioPlan(content, { knownPhonemes: new Set(['f', 'ɑː']) });
    const father = plan.focusWords.find((word) => word.word === 'father');
    assert.ok(father);
    assert.equal(father.clips.some((clip) => clip.kind === 'phoneme'), false);
    assert.equal(plan.wordClips.some((clip) => ['syllable', 'phoneme', 'blend'].includes(clip.kind)), false);
    assert.equal(plan.skipped.length, 0);
  });

  it('选择重点词时不编造音标/释义，且最多 4 个', () => {
    const selected = selectFocusWords(content);
    assert.ok(selected.length <= 4);
    assert.ok(selected.every((word) => word.word.trim().length > 0));
    assert.equal(selected.find((word) => word.word === 'father')?.phonetic, '/ˈfɑːðər/');
  });

  it('把 ready 片段装配回课文与重点词，并标记 audioReady', () => {
    const plan = buildCurriculumAudioPlan(content);
    const clips = [...plan.sentenceClips, ...plan.wordClips].map((clip) => ({
      clipKey: clip.clipKey,
      kind: clip.kind,
      partIndex: clip.partIndex,
      position: clip.position,
      speedTier: clip.speedTier,
      speed: clip.speed,
      text: clip.text,
      audioRef: `/api/v1/media/audio/${clip.kind}.mp3`,
      durationMs: 1000,
      status: 'ready',
    }));
    const passage = assembleCurriculumPassage({
      unitId: 'unit-1',
      topicId: 'topic-textbook-1',
      contentVersion: 'v1',
      content,
      clips,
    });
    assert.equal(passage.audioReady, true);
    const first = passage.paragraphs[0]!.sentences[0]!;
    assert.equal(first.audio?.normalKey, 'sentence:Unit-3-s01:normal');
    assert.equal(first.audio?.slowKey, 'sentence:Unit-3-s01:slow');
    assert.equal(first.audio?.normalRef, '/api/v1/media/audio/sentence.mp3');
    assert.equal(first.audio?.slowRef, '/api/v1/media/audio/sentence.mp3');
    const father = passage.focusWords.find((word) => word.word === 'father');
    assert.ok(father);
    assert.equal(father.clips[0]?.status, 'ready');
    assert.equal(father.clips[0]?.audioRef, '/api/v1/media/audio/word.mp3');
    assert.equal(father.clips[0]?.key, 'word:father:word:0:slow');
  });

  it('缺少 ready 片段时保留稳定键但不伪造 audioRef', () => {
    const passage = assembleCurriculumPassage({
      unitId: 'unit-1',
      topicId: 'topic-textbook-1',
      contentVersion: 'v1',
      content,
      clips: [],
    });
    assert.equal(passage.audioReady, false);
    const first = passage.paragraphs[0]!.sentences[0]!;
    assert.equal(first.audio?.normalRef, undefined);
    assert.equal(first.audio?.slowRef, undefined);
    assert.ok(passage.focusWords.every((word) => word.clips.every((clip) => clip.audioRef === null)));
  });
});
