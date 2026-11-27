import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { levelForContent, minimumLevelForGrade } from '../src/curriculum/textbook-unit-publisher.service';

describe('教材单元 CEFR 校准', () => {
  it('六年级以 A2 为最低等级，AI 更低 stageHint 不能拉低', () => {
    assert.equal(minimumLevelForGrade('六年级上册'), 'A2');
    assert.equal(levelForContent({ stageHint: 0 } as never, '六年级上册'), 'A2');
    assert.equal(levelForContent({ stageHint: 1 } as never, '六年级上册'), 'A2');
    assert.equal(levelForContent({ stageHint: 2 } as never, '六年级上册'), 'A2');
  });

  it('AI 等级高于年级下限时保留更高等级', () => {
    assert.equal(levelForContent({ stageHint: 3 } as never, '六年级上册'), 'B1');
  });

  it('缺少 stageHint 时按年级兜底，未知年级保持 A1', () => {
    assert.equal(levelForContent({} as never, '六年级上册'), 'A2');
    assert.equal(levelForContent({} as never, '三年级上册'), 'A1');
    assert.equal(levelForContent({} as never, undefined), 'A1');
  });
});
