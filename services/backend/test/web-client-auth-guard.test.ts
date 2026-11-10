/**
 * 家长 Web 端鉴权静态守卫。
 *
 * 背景：`/api/v1/learners/:id/abilities|evidence|growth` 已要求会话（后端
 * `LearnersController` 校验 learner 归属，匿名 401）。家长 Web 端的
 * `apiRequest` 不带 `Authorization`，若继续用它直调这三个接口，
 * 能力档案 / 证据时间线 / 成长档案会全部 401。
 *
 * 运行：npx tsx --test services/backend/test/web-client-auth-guard.test.ts
 * 依赖：仅 node:test / node:fs / node:assert；零网络、零数据库。
 *
 * ── 边界声明 ─────────────────────────────────────────────────────────────
 * 本文件全部断言都是「源码文本启发式」：只能证明源码中这三个接口改用了
 * `authRequest`、且 `authRequest` 确实会附加 Bearer。
 * 它 **不能证明**：浏览器里登录态存在时这三个面板真的拿到了数据、token 过期后的
 * 401 流程如何展示。行为验证仍归入【需联调】。
 * ────────────────────────────────────────────────────────────────────────
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

// test/ → backend/ → services/ → 仓库根
const ROOT = resolve(import.meta.dirname, '../../..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const api = read('apps/web/app/api.ts');
const authApi = read('apps/web/app/auth-api.ts');

/** 三个必须带会话的学习者接口。 */
const LEARNER_FETCHERS = ['getAbilities', 'getEvidence', 'getGrowthArchive'] as const;

describe('家长 Web 端：learners 接口必须带会话', () => {
  it('1. 源码中不存在用裸 apiRequest 直调 /learners/ 的语句', () => {
    // 典型写法：apiRequest<AbilitiesResponse>(`/learners/${id}/abilities`)
    const offenders = [...api.matchAll(/apiRequest\s*(?:<[^>]*>)?\s*\(\s*`[^`]*\/learners\//g)];
    assert.equal(
      offenders.length,
      0,
      `apps/web/app/api.ts 仍有裸 apiRequest 直调 learners 路由：${offenders.map((m) => m[0]).join(' , ')}`,
    );
  });

  it('2. 三个 learners 取数函数都改用 authRequest，且仍指向同一路由', () => {
    for (const name of LEARNER_FETCHERS) {
      const at = api.indexOf(`export const ${name}`);
      assert.ok(at >= 0, `apps/web/app/api.ts 找不到 ${name}`);
      const block = api.slice(at, at + 400);
      assert.match(block, /authRequest\s*</, `${name} 未使用 authRequest（会 401）`);
      assert.match(block, /\/learners\//, `${name} 不再是 learners 路由，守卫失效需复核`);
    }
  });

  it('3. authRequest 确实从 localStorage 读 token 并附加 Bearer', () => {
    assert.match(authApi, /localStorage\.getItem\(\s*'alg_access_token'\s*\)/, 'authRequest 不再从 localStorage 读 token');
    assert.match(authApi, /headers\.set\(\s*'Authorization'\s*,\s*`Bearer \$\{accessToken\}`\s*\)/, 'authRequest 不再附加 Bearer');
    assert.match(authApi, /credentials:\s*'include'/, 'authRequest 缺少 credentials: include');
  });

  it('4. 未把封装整体删掉（apiRequest 仍存在，避免「守卫靠删代码通过」）', () => {
    assert.match(api, /export async function apiRequest<T>/, 'apiRequest 被删除，需复核其他接口是否也改走 authRequest');
    // 只数「模板字符串直调」形式：`/learners/...`（注释里的路由说明不算调用）
    const learnersCalls = [...api.matchAll(/`\/learners\//g)].length;
    assert.equal(learnersCalls, LEARNER_FETCHERS.length, 'learners 调用数量变化，需同步复核本守卫');
  });
});
