/**
 * 约束二静态守卫：教学业务代码不得出现任何供应商名、模型名或音色名。
 *
 * 平台协议差异只能放在 Provider Adapter / 预置目录，不能进入教学业务逻辑。
 * 本测试在 CI 中拦截「把厂商特性写死进课程、编排和学习者模型」。
 * 关键词用片段拼接构造，避免扫描器自身被计入。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

// test/ → ai-provider-sdk/ → packages/ → 仓库根
const ROOT = resolve(import.meta.dirname, '../../..');

const FORBIDDEN = [
  '智' + '谱',
  '腾' + '讯',
  '硅' + '基',
  'big' + 'model',
  'tencent' + 'cloud',
  'silicon' + 'flow',
  'glm-' + '4',
  'glm-' + '5',
  'Sense' + 'Voice',
  'Cosy' + 'Voice',
  '502' + '001',
  '101' + '016',
];

/** 协议名/算法名不算厂商名（公开规范），只扫描具体厂商与具体模型/音色标识。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist' && entry !== 'test' && entry !== '.next') {
        out.push(...sourceFiles(full));
      }
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function collect(): string[] {
  const targets = [
    resolve(ROOT, 'packages'),
    resolve(ROOT, 'services/backend/src'),
  ];
  return targets.flatMap((dir) => sourceFiles(dir)).filter((file) => {
    const normalized = file.replaceAll('\\', '/');
    // Provider-specific protocol implementations and the operator catalog are
    // the only layers allowed to contain platform identifiers by design.
    return !normalized.includes('/ai-provider-sdk/src/http.ts') &&
      !normalized.includes('/ai-provider-sdk/src/vendor-') &&
      !normalized.includes('/ai-provider-sdk/src/provider-presets') &&
      !normalized.includes('/backend/src/providers/') &&
      !normalized.includes('/backend/src/ai-gateway/');
  });
}

describe('约束二：模型可替换', () => {
  it('通用教学业务源码中不出现厂商名、模型名、音色名', () => {
    const hits: string[] = [];
    for (const file of collect()) {
      const text = readFileSync(file, 'utf8');
      for (const keyword of FORBIDDEN) {
        if (text.includes(keyword)) {
          hits.push(`${file.replace(ROOT, '')} → ${keyword}`);
        }
      }
    }
    assert.deepEqual(hits, [], `业务代码出现供应商标识：\n${hits.join('\n')}`);
  });

  it('供应商相关取值只出现在配置示例与部署编排中', () => {
    const example = readFileSync(resolve(ROOT, 'deploy/docker/.env.example'), 'utf8');
    const compose = readFileSync(resolve(ROOT, 'deploy/docker/docker-compose.yml'), 'utf8');
    // 配置示例必须保留所有可注入项；编排必须透传协议开关与双凭据
    for (const key of ['TTS_PROTOCOL', 'TTS_SECRET_ID', 'TTS_SECRET_KEY', 'LLM_EXTRA_BODY_KV']) {
      assert.ok(example.includes(key), `.env.example 缺少 ${key}`);
      assert.ok(compose.includes(key), `docker-compose.yml 未透传 ${key}`);
    }
  });
});
