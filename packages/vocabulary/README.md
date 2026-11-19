# @alg/vocabulary

ECDICT 词族词库的构建与数据包。

## 数据来源与许可

- 源数据：仓库根目录 `ecdict.csv`（ECDICT，MIT License）。
- 生成物：`data/lexicon.json`，仅保留词族代表词、屈折形式、音标、中文释义、词频/考试标签和 ECDICT 搭配/例句。
- 不包含教材原文、图片或受限词库内容；教材单元词由后端导入脚本标记到 `textbookUnitIds`。

## 构建

从仓库根目录运行：

```bash
npm run lexicon:build
```

当前构建结果：扫描 770,611 行，候选 56,992 词族，保留 5,000 族；核心 3,000 族，核心音标覆盖 2,992/3,000，核心中文释义覆盖 3,000/3,000。

## 词族规则

- 以 ECDICT `exchange` 字段的屈折形式归并词族；忽略 `0` / `1` 这类元数据键，避免把派生词过度合并。
- 每个词族保留一个代表词（优先高频、带音标/释义的词），其余形式写入 `variants` 供反向查询。
- `isCore` 标记前 3,000 个高频词族；`isFunctionWord` 单独标记功能词。

## 测试

```bash
npm run test --workspace @alg/vocabulary
```
