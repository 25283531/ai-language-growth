# @alg/vocabulary

ECDICT 词族词库的构建与数据包。

## 数据来源与许可

- 源数据：仓库根目录 `ecdict.csv`（ECDICT，MIT License）。
- 生成物：`data/lexicon.json`，保留词族代表词、屈折形式、音标、中文释义、词频/考试标签、领域、儿童安全标记和例句。
- 不包含教材原文、图片或受限词库内容；教材单元词由后端导入脚本标记到 `textbookUnitIds`。
- 领域标签来自 `lexicon.ts` 的英文主题词表，未命中时用中文释义兜底；抽象高频词允许 `domains=[]`。
- `childSafe=false` 表示不进入儿童课程；明显成人/辱骂词仍在构建阶段直接排除，其余风险词保留供管理端复核。
- 例句是确定性生成内容，不是 ECDICT 原文；当前覆盖全部 `childSafe=true` 的核心词（2,961/3,000），39 个 `childSafe=false` 的核心风险词保持 `examples=[]`。扩展层 2,000 词按任务书 9.3 不强制例句，未批量写入低置信模板句。

## 构建

从仓库根目录运行：

```bash
npm run build:lexicon --workspace @alg/vocabulary
```

当前构建结果：扫描 770,611 行，候选 56,993 词族，保留 5,000 族（3,000 核心 + 2,000 扩展）；全量音标 4,966/5,000，中文释义 5,000/5,000，词性 5,000/5,000；核心音标覆盖 2,991/3,000，核心领域标签 984/3,000（`zk` 词 48.1%、`gk` 词 37.2%），核心 `childSafe=false` 39 个，核心例句 2,961/3,000。扩展层音标 1,975/2,000，释义/词性 2,000/2,000，领域 451/2,000，`childSafe=false` 16 个；扩展例句为 0，避免批量模板句污染儿童课程。

扩展层还维护 65 个教材优先词：第一批 30 个（`blackboard`、`schoolbag`、`crayon` 等），第二批 35 个（P0 34 个 + `clap`，见 `EXTENSION_PRIORITY_WORDS_BATCH_2`）。构建时优先保留这些词（即使 ECDICT 无 `frq`/`bnc`，如 `schoolbag`），并从扩展层尾部移除同等数量的低排名词；带 `zk`/`gk` 标签的既有扩展词不参与替换，总词族仍为 5,000，3,000 核心层逐词不变。

例句生成由 `src/examples.ts` 完成：功能词、词性/首义异常词和高风险抽象词走人工覆盖，其余词按词性+中文释义+领域使用受控模板；同时修正 `can=装罐`、`plane=平面`、`ruler=统治者`、`draw=拉/拖`、`medical=医生` 等会误导儿童的高频首义。`build-lexicon.ts` 在写领域/安全标记前应用这些修正，并重算领域与安全状态。技术释义不再因出现“计算机”整行被丢弃；`computer`、`internet` 等词可正常取到中文释义。英式拼写与不规则复数通过 `SAFE_FORM_ALIASES` 挂到已入选词族，不新增词族。

可选环境变量：

```bash
# 默认 3000（全部安全核心词）；设为 0 关闭例句生成
$env:LEXICON_EXAMPLE_LIMIT = '3000'
npm run build:lexicon --workspace @alg/vocabulary
```

## 词族规则

- 以 ECDICT `exchange` 字段的屈折形式归并词族；忽略 `0` / `1` 这类元数据键，避免把派生词过度合并。
- 每个词族保留一个代表词（优先高频、带音标/释义的词），其余形式写入 `variants` 供反向查询。
- `isCore` 标记前 3,000 个高频词族；`isFunctionWord` 单独标记功能词。
- 领域匹配先查英文词表，再查中文释义；抽象词/功能词允许没有领域，不强行分配。
- `assessChildSafety()` 按词形、派生形式和中文义项判定；多义词只要有一个儿童可用义项就保留，避免次要义项误杀。
- `buildChildSafeExample()` 只输出短句、儿童安全、中文无英文污染；数字词使用中文数字，名词按人物/地点/食物/动物/具体物/抽象词分层，避免把 `This is a...` 或量词模板硬套到不可数、抽象名词上。
- 全量核心校验覆盖：目标词出现、中文含汉字且无拉丁字母、句末标点、`childSafe=true`、每个核心词至多 1 条例句、全部安全核心词均非空、风险词为空。

## 覆盖报告

从仓库根目录生成 3,000 → 5,000 的覆盖率对比（结果同时写入 `data/lexicon-coverage.json` 与 `docs/lexicon-coverage.md`）：

```bash
npm run lexicon:coverage
```

报告使用 ECDICT 公开 `zk` / `gk` / `cet4` / `cet6` 标签和 `TEXTBOOK_PRIORITY_WORDS` 作为可复现的教材/课标优先词代理；不包含出版社教材原文。授权教材单元的实际覆盖率仍由 `LexiconService.textbookUnitCoverage` 按册/单元计算。

## 测试

```bash
npm run test --workspace @alg/vocabulary
```
