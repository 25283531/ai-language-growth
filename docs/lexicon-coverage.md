# 词库扩容覆盖报告（P3-06）

> 生成时间：2026-11-25T16:06:59.622Z
> 数据源：ECDICT（MIT）5,000 词族；教材/课标目标词使用 ECDICT 公开标签作为代理。

## 1. 口径

- **基线（3,000）**：`isCore=true` 的核心词族，P3-05 已上线。
- **扩容（5,000）**：核心 3,000 + 扩展 2,000，全部进入 `lexicon.json` 并可导入 `lexicon_entries`。
- **命中**：目标词命中词族 `word` 或 `variants` 即算覆盖；同一目标词去重后只计一次。
- **教材词边界**：本报告不包含出版社教材原文。`zk/gk` 是可公开复现的课标词代理；授权教材单元的实际覆盖仍按册/单元计算。
- **已知噪声**：ECDICT 将少量月份/地名按小写词条收录（如 august、pacific），仍按原标签计入；扩容前后使用同一分母，不影响对比结论。
- **2026-11-25 修订**：修复 `computer`/`internet` 技术释义误删，并将 12 个英式拼写与 2 个不规则复数别名挂入现有词族；3,000 基线也因这些命中而上升。另将 65 个教材优先词插入扩展层（第一批 30 个、第二批 35 个），替换扩展层尾部同样数量的低频词，并保护已有的 `zk`/`gk` 标签词族；3,000 核心层逐词不变。

## 2. 规模

| 项目 | 3,000 核心 | 5,000 全量 |
|---|---:|---:|
| 词族数 | 3000 | 5000 |
| 扩展层词族 | — | 2000 |
| 有例句词族 | 2961 | 2961 |
| 有中文释义 | 3000 | 5000 |
| 有音标 | 2991 | 4966 |
| 有词性 | 3000 | 5000 |
| 有领域标签 | 984 | 1435 |
| `childSafe=false` | 39 | 55 |

## 3. 教材/课标优先词覆盖对比

| 目标词表 | 目标词数 | 3,000 覆盖 | 5,000 覆盖 | 新增 | 提升 | 5,000 缺口 |
|---|---:|---:|---:|---:|---:|---:|
| 课标/教材优先词（ECDICT zk） | 1514 | 1285（84.9%） | 1477（97.6%） | 192 | +12.7pp | 37 |
| 课标/阅读扩展词（ECDICT gk） | 3478 | 2221（63.9%） | 2907（83.6%） | 686 | +19.7pp | 571 |
| 课标/教材优先词（zk ∪ gk） | 3519 | 2246（63.8%） | 2939（83.5%） | 693 | +19.7pp | 580 |
| 首批教材高频词（TEXTBOOK_PRIORITY_WORDS） | 166 | 166（100.0%） | 166（100.0%） | 0 | +0.0pp | 0 |
| 大学英语四级（cet4，参考） | 3709 | 1940（52.3%） | 2888（77.9%） | 948 | +25.6pp | 821 |
| 大学英语六级（cet6，参考） | 5237 | 1868（35.7%） | 3196（61.0%） | 1328 | +25.4pp | 2041 |

## 4. 5,000 缺口摘要

`zk` 缺口是全量词库对义务教育阶段教材优先词的剩余空白；`gk` 缺口只代表阅读扩展空间，不是儿童阶段目标。

### 课标/教材优先词（ECDICT zk）（37 个）

august, bill, cent, chant, clone, coke, dollar, dvd, eighty, email, gymnasium, hotdog, humorous, inch, kilo, kilogram, kilometre, madam, madame, mile, nineteen, ninety, oneself, pacific, pardon, pence, penny, percent, pity, seventeen, seventy, tenth, ton, twelfth, vcd, weekday, x-ray

### 课标/阅读扩展词（ECDICT gk）（571 个）

abnormal, abolish, abrupt, abundant, accustomed, acquaintance, acre, addicted, admirable, adolescence, adore, aeroplane, airmail, airspace, algebra, allergic, allocate, allowance, alphabet, altitude, aluminium, ambiguous, ample, amuse, amusement, anecdote, annoy, antarctic, anyhow, appendix, apron, arbitrary, arch, are, arithmetic, armchair, astonish, astronomy, athletics, attentively, august, autonomous, awesome, backache, bacon, bacterium, badminton, baggage, bakery, ballet, ballpoint, bandage, barbecue, barber, barbershop, basin, bathrobe, bathtub, bay, beancurd, bedclothes, beddings, beehive, bill, bingo, biochemistry, birdcage, birthplace, blouse, bookcase, bookmark, bookshelf, bookshop, bookstore, botanical, botany, boycott, bravery, breathless, bridegroom

> 仅展示前 80 个；完整缺口见 `packages/vocabulary/data/lexicon-coverage.json`。

## 5. 教材单元词注入

- `services/backend/scripts/import-lexicon.ts` 在导入全局词库后扫描 `textbook_units.metadata` 与 `curriculum_drafts.wordList`；
- 已命中的词挂到现有词族，未命中的词以 `source=textbook`、`childSafe=false` 保守入库，待补齐释义/审核后放行；
- 静态 JSON 中 `textbookUnitIds` 非空的词族数为 0；出版社单元要求授权后录入，不能由 ECDICT 标签替代。
- 管理端按册汇总：`GET /api/v1/admin/curriculum/textbook/units/:unitId/lexicon-coverage`。

## 6. 当前质量状态

- 5,000 全量：音标 4966/5000（99.3%），中文 5000/5000，词性 5000/5000。
- 扩展层：音标 1975/2000，中文 2000/2000，词性 2000/2000。
- 例句仍按 P3-05/任务书 9.3 只要求核心词：核心 2961/3000；扩展层不批量生成低置信模板句，避免把不自然句子写进儿童课程。
