/**
 * 教材词注入的纯函数。
 *
 * 数据库扫描逻辑留在 import-lexicon.ts；这里只负责从教材 metadata 中提取
 * 词形并做规范化。单独拆出后可以单测“教材词无条件进入词库”的入口规则。
 */

/** 教材 metadata 中可能出现的词表字段。 */
const WORD_KEYS = ['words', 'wordList', 'vocabulary', 'keyWords'] as const;

/**
 * 提取 metadata 中的教材词。
 *
 * 支持字符串数组、对象数组（取 word/text）、逗号/换行分隔的字符串，以及
 * 已生成内容的 `metadata.content.vocabulary` / `content.keyWords`。
 * 返回值保留原始形态，由 normalizeTextbookWord 统一清洗。
 */
export function extractMetadataWords(metadata: unknown): unknown[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const record = metadata as Record<string, unknown>;
  const output: unknown[] = [];

  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      output.push(...value.map((item) => (
        typeof item === 'string'
          ? item
          : item && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>).word ?? (item as Record<string, unknown>).text
            : undefined
      )));
      return;
    }
    if (typeof value === 'string') {
      output.push(...value.split(/\r?\n|[,，;；]/));
    }
  };

  for (const key of WORD_KEYS) collect(record[key]);
  const content = record.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const contentRecord = content as Record<string, unknown>;
    collect(contentRecord.vocabulary);
    collect(contentRecord.keyWords);
  }
  return output;
}

/**
 * 规范化教材词：
 * - 小写、去空白；
 * - 去掉 `1.` / `1)` 这类序号；
 * - 只接受字母开头、可含连字符/撇号/空格的单词或短语；
 * - 超过 100 字符的脏数据直接丢弃。
 */
export function normalizeTextbookWord(value: unknown): string {
  if (typeof value !== 'string') return '';
  const word = value
    .trim()
    .replace(/^\d+[.)、]\s*/, '')
    .toLowerCase();
  if (!word || word.length > 100) return '';
  if (!/^[a-z][a-z' -]*$/.test(word)) return '';
  return word.replace(/\s+/g, ' ').trim();
}
