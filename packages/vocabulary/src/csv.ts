import { createReadStream } from 'node:fs';

/**
 * 流式解析 ECDICT CSV。
 *
 * ECDICT 的 translation/detail 字段含真实换行与引号，不能按行 split。
 * 这里实现 RFC 4180 风格的最小状态机，内存只保留当前行。
 */
export async function* parseCsvRecords(path: string): AsyncGenerator<Record<string, string>> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let headers: string[] | null = null;
  let firstCharacter = true;

  const emitRow = (): Record<string, string> | null => {
    if (!row.length && field === '') return null;
    if (field !== '' || row.length) {
      row.push(field);
    }
    const values = row;
    row = [];
    field = '';
    if (!headers) {
      headers = values.map((value, index) => (
        (index === 0 ? value.replace(/^\uFEFF/, '') : value).trim()
      ));
      return null;
    }
    if (!values.some((value) => value.trim())) return null;
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });
    return record;
  };

  try {
    for await (const chunk of stream) {
      for (let index = 0; index < chunk.length; index += 1) {
        const character = chunk[index]!;
        if (firstCharacter && character === '\uFEFF') {
          firstCharacter = false;
          continue;
        }
        firstCharacter = false;

        if (inQuotes) {
          if (character === '"') {
            if (chunk[index + 1] === '"') {
              field += '"';
              index += 1;
            } else {
              inQuotes = false;
            }
          } else {
            field += character;
          }
          continue;
        }

        if (character === '"') {
          inQuotes = true;
        } else if (character === ',') {
          row.push(field);
          field = '';
        } else if (character === '\n') {
          const record = emitRow();
          if (record) yield record;
        } else if (character === '\r') {
          // 由紧随的 \n 结束行；单独 \r 也作为行尾处理。
          if (chunk[index + 1] !== '\n') {
            const record = emitRow();
            if (record) yield record;
          }
        } else {
          field += character;
        }
      }
    }
    const record = emitRow();
    if (record) yield record;
  } finally {
    stream.destroy();
  }
}
