import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLexiconCoverageReport, formatCoverageDelta, formatCoverageRate } from '../src/coverage';

describe('P3-06 词库覆盖报告', () => {
  it('区分 3,000 核心层与 5,000 全量层，并统计扩展层新增覆盖', () => {
    const entries = [
      { word: 'cat', variants: ['cats'], isCore: true },
      { word: 'dog', variants: ['dogs'], isCore: false },
      { word: 'run', variants: ['ran', 'running'], isCore: false },
    ];
    const report = buildLexiconCoverageReport(entries, [{
      id: 'sample',
      label: '样本词表',
      words: ['cat', 'cats', 'dog', 'run', 'unicorn', 'cat'],
    }]);

    assert.equal(report.baselineFamilies, 1);
    assert.equal(report.expandedFamilies, 3);
    assert.deepEqual(report.targets[0]!.before, {
      total: 5,
      covered: 2,
      rate: 0.4,
      gaps: ['dog', 'run', 'unicorn'],
    });
    assert.deepEqual(report.targets[0]!.after, {
      total: 5,
      covered: 4,
      rate: 0.8,
      gaps: ['unicorn'],
    });
    assert.equal(report.targets[0]!.added, 2);
    assert.equal(report.targets[0]!.improvement, 0.4);
  });

  it('目标词为空或全部未命中时返回稳定的 0 覆盖率', () => {
    const entries = [{ word: 'cat', variants: [], isCore: true }];
    const empty = buildLexiconCoverageReport(entries, [{ id: 'empty', label: '空表', words: [] }]);
    assert.deepEqual(empty.targets[0]!.before, { total: 0, covered: 0, rate: 0, gaps: [] });
    assert.deepEqual(empty.targets[0]!.after, { total: 0, covered: 0, rate: 0, gaps: [] });

    const missing = buildLexiconCoverageReport(entries, [{
      id: 'missing', label: '未命中', words: ['dog'],
    }]);
    assert.equal(missing.targets[0]!.after.rate, 0);
    assert.deepEqual(missing.targets[0]!.after.gaps, ['dog']);
  });

  it('百分比格式固定一位小数，避免报告出现浮点噪声', () => {
    assert.equal(formatCoverageRate(0.922), '92.2%');
    assert.equal(formatCoverageDelta(0.084), '+8.4pp');
    assert.equal(formatCoverageDelta(0), '+0.0pp');
  });
});
