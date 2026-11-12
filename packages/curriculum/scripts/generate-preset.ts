import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCefrPreset } from '../src/cefr';

/**
 * 生成服务端预置 CEFR 纯 JSON。
 *
 * 运行：npm run generate:preset --workspace @alg/curriculum
 * 产物：data/cefr-curriculum.json。只含教学内容与媒体需求，不含图片/音频。
 */
const data = buildCefrPreset();
const directory = join(process.cwd(), 'data');
mkdirSync(directory, { recursive: true });
const path = join(directory, 'cefr-curriculum.json');
writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
const lessons = data.levels.reduce((sum, level) => sum + level.units.reduce((unitSum, unit) => unitSum + unit.lessons.length, 0), 0);
console.log(`wrote ${path}: levels=${data.levels.length} units=${data.levels.reduce((sum, level) => sum + level.units.length, 0)} lessons=${lessons}`);
