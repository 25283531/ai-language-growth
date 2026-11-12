/**
 * 管理端 + Android 静态守卫（QA 独立验证，非实现者自检）。
 *
 * 目的：把本轮「管理端 CRUD / 自动加载 / 换平台凭据提示」与「Android 功能零回归」
 * 的源码级约束固化成可重复执行的断言，防止后续改动悄悄回退。
 *
 * 运行：npx tsx --test services/backend/test/admin-console-static-guard.test.ts
 * 依赖：仅 node:test / node:fs / node:assert；零网络、零数据库、零 Redis、零外部 API。
 *
 * ── 边界声明（重要，避免把「静态守卫通过」误读成「行为已验证」）─────────────
 * 本文件全部断言都是「源码文本启发式」：只能证明源码中写了某段结构（安全降级、
 * 统一封装、mount 加载、状态同步、重试入口、平台切换守卫、锚点集合未变）。
 * 它 **不能证明**：
 *   - React 运行时状态确实被清空 / 自动加载真的在浏览器里成功返回数据；
 *   - 换平台后 UI 实际不误导用户、服务端凭据真的未残留；
 *   - PUT / DELETE 的真实 HTTP 语义、401 过期流程、在课会话不被打断；
 *   - Android 视觉 / 触控 / 对比度 / 真机可用性（本机无 Android SDK / gradle / java）。
 * 上述行为验证一律归入【需联调】/【需真机】/【需 CI 云端】的 Deferred 清单。
 * 若实现被抽到独立 hook / 新文件而令定位窗口失效，应如实报出并交回实现者，
 * 只允许调整「定位窗口」，不得放宽下列判定标准。
 * ────────────────────────────────────────────────────────────────────────
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

// test/ → backend/ → services/ → 仓库根
const ROOT = resolve(import.meta.dirname, '../../..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const providers = read('apps/admin-web/app/providers-page.tsx');
const settings = read('apps/admin-web/app/settings/page.tsx');
const learning = read('apps/admin-web/app/learning/page.tsx');
const costs = read('apps/admin-web/app/costs/page.tsx');
const adminAuth = read('apps/admin-web/app/admin-auth.tsx');

const ANDROID_DIR = join(ROOT, 'apps/android/app/src/main/java/com/alg/languagegrowth');
const androidSources = readdirSync(ANDROID_DIR)
  .filter((file) => file.endsWith('.kt'))
  .map((file) => readFileSync(join(ANDROID_DIR, file), 'utf8'))
  .join('\n');

/**
 * 基线 d282095 的 Android 功能锚点集合（从 HEAD 对象提取，不随工作区改动漂移）。
 * 课堂回合与教师语音是后续新增的正式功能，故路径集合按「基线不可丢 +
 * 新功能必须齐」校验，而不是要求集合大小永远不变。
 */
const BASELINE_PATH_LITERALS = [
  '"/api/v1"',
  '"/auth/captcha"',
  '"/auth/email-verification"',
  '"/auth/login"',
  '"/auth/register"',
  '"/auth/verify-email"',
  '"/lessons/start"',
  '"/user/account"',
  '"/user/dashboard"',
  '"/user/password"',
  '"/user/profile"',
  '"/user/textbook"',
];
/** 正式课堂 + 教师语音链路新增的必需端点，一项都不能少。 */
const CLASSROOM_PATH_LITERALS = [
  '"/api/v1/media/audio/"',
  // 儿童录音改为随回合内联提交，上传端点已停用（410），不再要求客户端保留该路径。
  '"/speech/cache/lookup"',
  '"/speech/quota/release"',
  '"/speech/quota/reserve"',
  '"/speech/quota/settle"',
  '"/speech/synthesize"',
];
const BASELINE_PREF_KEYS = [
  'getSharedPreferences("account"',
  'getSharedPreferences("appearance"',
  'putBoolean("childTheme"',
  'putBoolean("official"',
  'putString("custom"',
  'putString("email"',
  'putString("token"',
];
const BASELINE_SCREEN_BRANCHES = [
  'screen == "legal_privacy"',
  'screen == "legal_terms"',
  'screen == "tabs"',
];

const collect = (source: string, pattern: RegExp): string[] =>
  [...new Set(source.match(pattern) ?? [])].sort();

describe('管理端模型接入页：静态守卫', () => {
  it('1. 不再直接调用 crypto.randomUUID(；UUID 生成必须有安全降级', () => {
    // 非安全上下文（http://<IP>:3001）下 crypto.randomUUID 未定义，裸调用会抛 TypeError，
    // 正是「新增模型配置按钮点了没反应」的根因。
    assert.ok(
      !/\bcrypto\.randomUUID\s*\(/.test(providers),
      'providers-page.tsx 仍存在裸 crypto.randomUUID( 调用',
    );
    if (/randomUUID/.test(providers)) {
      assert.match(
        providers,
        /randomUUID\?\./,
        'randomUUID 仍出现但缺少可选链安全取值',
      );
      const draftFn = providers.slice(
        Math.max(0, providers.indexOf('newDraftKey') - 200),
        providers.indexOf('newDraftKey') + 500,
      );
      assert.match(draftFn, /\?\?/, 'UUID 取不到值时缺少 fallback 表达式');
    }
  });

  it('2. providers-page 无裸 fetch(，统一封装带 credentials 与 no-store', () => {
    assert.ok(!/\bfetch\s*\(/.test(providers), 'providers-page.tsx 仍有裸 fetch( 调用');
    assert.match(providers, /adminFetch/, 'providers-page.tsx 未引用统一请求封装 adminFetch');
    assert.match(adminAuth, /credentials:\s*'include'/, 'adminFetch 缺少 credentials: include');
    assert.match(adminAuth, /cache:\s*'no-store'/, 'adminFetch 缺少 cache: no-store');
  });

  it('3. providers / settings / learning 三页均在 mount 时自动加载', () => {
    // 基线 settings 与 learning 的 useEffect 计数为 0：自动加载是本轮新增能力。
    const pages: Array<[string, string]> = [
      ['providers-page', providers],
      ['settings', settings],
      ['learning', learning],
    ];
    for (const [name, source] of pages) {
      assert.match(source, /useEffect\s*\(/, `${name} 缺少 useEffect`);
      assert.match(source, /\}\s*,\s*\[\s*\]\s*\)/, `${name} 缺少 mount-only effect（依赖数组 []）`);
      assert.match(
        source,
        /void\s+(loadConfigs|load|loadLearningSettings)\s*\(\s*\)/,
        `${name} 的 mount effect 未触发加载函数`,
      );
    }
  });

  it('4. PUT / DELETE 成功后状态一致，且 activeConfigIds 不悬空', () => {
    const putPositions = [...providers.matchAll(/method:\s*'PUT'/g)].map((match) => match.index ?? 0);
    const deletePositions = [...providers.matchAll(/method:\s*'DELETE'/g)].map((match) => match.index ?? 0);
    assert.ok(putPositions.length > 0, '未找到 PUT /model-providers/configs 请求');
    assert.ok(deletePositions.length > 0, '未找到 DELETE /model-providers/configs 请求');

    // 页面存在多个 PUT（单价 / 配置 / 停用），要求至少一个是配置保存且同步了状态。
    assert.ok(
      putPositions.some((at) => {
        const window = providers.slice(at, at + 1800);
        return /setConfigs\(|setServerConfigs\(/.test(window) && /setActiveConfigIds\(/.test(window);
      }),
      '配置 PUT 成功后未同步 configs / serverConfigs 与 activeConfigIds',
    );
    assert.ok(
      deletePositions.some((at) => {
        const window = providers.slice(at, at + 1800);
        return /setConfigs\(|setServerConfigs\(/.test(window) && /setActiveConfigIds\(/.test(window);
      }),
      '配置 DELETE 成功后未更新 activeConfigIds（会指向已删除项）',
    );
  });

  it('5. 加载失败有可见错误态与重试入口，会话过期后有自动重试', () => {
    assert.match(providers, /configLoadError/, '缺少配置加载失败状态');
    assert.match(providers, /重试读取配置/, '缺少配置读取重试入口');
    assert.match(providers, /onClick=\{\(\)\s*=>\s*void\s+loadConfigs\(\)\}/, '重试按钮未绑定 loadConfigs');
    assert.match(providers, /catalogError/, '缺少目录加载失败状态');
    assert.match(providers, /重试读取目录/, '缺少目录读取重试入口');
    assert.match(providers, /visibilitychange|focus/, '会话过期后缺少重新聚焦自动重试');
  });
});

describe('Android：功能锚点零回归（静态）', () => {
  it('6. 同包 Kotlin 合并后的锚点集合与基线 d282095 相等', () => {
    // 允许视觉重构把代码拆到同包新 .kt；但功能锚点集合一项都不能少、也不能多。
    assert.deepEqual(
      collect(androidSources, /"\/[a-zA-Z0-9_/-]+"/g),
      [...BASELINE_PATH_LITERALS, ...CLASSROOM_PATH_LITERALS].sort(),
      'API 路径集合必须等于「基线 + 课堂/教师语音端点」，不得丢失或静默新增',
    );
    assert.match(
      androidSources,
      /class TeacherSpeechController/,
      '正式客户端必须存在教师语音播放控制器',
    );
    assert.match(
      androidSources,
      /fun play\([\s\S]{0,6000}?cache\/lookup/,
      '播放前必须先查询服务端 TTS 缓存',
    );
    assert.match(
      androidSources,
      /fun play\([\s\S]{0,12000}?cachedParts/,
      '重播必须复用本地已下载音频',
    );
    assert.deepEqual(
      collect(androidSources, /getSharedPreferences\("[^"]+"|put(String|Boolean)\("[^"]+"/g),
      [...BASELINE_PREF_KEYS].sort(),
      'SharedPreferences 键集合与基线不一致',
    );
    assert.deepEqual(
      collect(androidSources, /screen == "[a-z_]+"/g),
      [...BASELINE_SCREEN_BRANCHES].sort(),
      'screen 分支集合与基线不一致',
    );

    const tabsLine = androidSources.split('\n').find((line) => line.includes('val tabs ='));
    assert.ok(tabsLine, '未找到 tabs 定义');
    for (const key of ['home', 'learn', 'achievements', 'me']) {
      assert.ok(tabsLine.includes(`"${key}"`), `tabs 缺少基线项 ${key}`);
    }
    assert.match(
      androidSources,
      /OFFICIAL_API\s*=\s*"https:\/\/152\.136\.230\.132:3000\/api\/v1"/,
      'OFFICIAL_API 常量被改动',
    );
    assert.match(
      androidSources,
      /require\(value\.startsWith\("https:\/\/"\)\)/,
      'HTTPS 强制校验被移除',
    );
  });
});

describe('R2 必修：换平台后不得继续渲染「已有凭据」误导提示', () => {
  // 边界：以下为源码文本启发式。它只证明「平台切换分支里写了 credentialConfigured
  // 的清除语句」以及「误导文案位于平台切换状态守卫的条件分支内」；不证明 React
  // 运行时状态确实清空、不证明实际 UI 不误导、不证明服务端凭据未残留。
  // 行为验证仍需【需联调】补测：换平台 → 保存 → 回读凭据状态 → 启用应被 400 拦截。
  it('7a. 切换 providerPresetId 的分支显式清除 / 重算 credentialConfigured', () => {
    const assignments = [...providers.matchAll(/providerPresetId\s*:\s*([a-zA-Z_$][\w$]*)\s*,/g)];
    assert.ok(assignments.length > 0, '未找到任何把新值写入 providerPresetId 的平台切换分支');
    for (const match of assignments) {
      const at = match.index ?? 0;
      const window = providers.slice(Math.max(0, at - 600), at + 900);
      assert.ok(
        /credentialConfigured\s*:\s*false/.test(window) ||
          /credentialConfigured\s*:\s*Boolean\(/.test(window) ||
          /delete\s+[\w.]*credentialConfigured/.test(window) ||
          /credentialConfigured\s*=/.test(window),
        '平台切换分支未显式清除 / 重算 credentialConfigured（仅清空 credentials 输入不算）',
      );
    }
    // 换平台标记必须被置位，否则「更换平台需重新填写密钥」的保护分支不会生效。
    assert.match(providers, /setProviderSwitched\(/, '缺少平台切换状态');
    assert.match(providers, /\[active\]:\s*true/, '换平台时未把平台切换标记置为 true');
  });

  it('7b. 「已有凭据；留空保留已保存值」不得无条件渲染给新平台', () => {
    const misleading = '已有凭据；留空保留已保存值';
    const lines = providers.split('\n').filter((line) => line.includes(misleading));
    // 文案整体移除是更彻底的实现，视为通过。
    for (const line of lines) {
      const guard = /providerSwitched|platformChanged|presetChanged|sameProvider|credentialsConfiguredForCurrentPreset|dirty/;
      assert.ok(guard.test(line), '误导文案所在行缺少平台切换状态守卫（不得裸渲染）');
      const guardAt = line.search(guard);
      const textAt = line.indexOf(misleading);
      assert.ok(guardAt >= 0 && guardAt < textAt, '平台切换守卫必须位于误导文案之前');
      const guardedBranch = line.slice(guardAt, textAt);
      assert.ok(
        !/已有凭据/.test(guardedBranch),
        '平台切换守卫的真分支仍然渲染「已有凭据」提示（换平台时会误导用户）',
      );
    }
  });
});

describe('管理端成本与缓存页：只读静态守卫', () => {
  it('8. 只读取 /tts-cache，不发送写请求，并展示命中率与合成量', () => {
    assert.match(costs, /adminFetch<TtsCacheResponse>\('\/tts-cache'\)/, '成本页未通过 adminFetch 读取 /tts-cache');
    assert.match(costs, /hitRate/, '成本页未展示命中率');
    assert.match(costs, /charactersSynthesized/, '成本页未展示实际合成字符');
    assert.match(costs, /misses/, '成本页未展示未命中次数');
    assert.ok(!/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/.test(costs), '成本页不应发送写请求');
    assert.match(costs, /void\s+load\(\)/, '成本页挂载后未自动读取指标');
  });

  it('9. 成本页接入账本聚合，支持日期与 learner/topic 过滤，展示未计价而不与进程缓存相加', () => {
    assert.match(
      costs,
      /adminFetch<UsageCostResponse>\(buildUsagePath\(appliedFilters\)\)/,
      '成本页未通过 adminFetch 读取 /usage/cost',
    );
    assert.match(costs, /\/usage\/cost/, '成本页缺少 /usage/cost 路径');
    for (const field of ['from', 'to', 'learnerId', 'topicId']) {
      assert.match(costs, new RegExp(`\\b${field}\\b`), `成本页缺少 ${field} 过滤字段`);
    }
    assert.match(costs, /开始日期/, '成本页缺少开始日期输入');
    assert.match(costs, /结束日期/, '成本页缺少结束日期输入');
    for (const field of ['unpricedCalls', 'estimatedCostCny', 'byLearner', 'byTopic', 'byDay']) {
      assert.match(costs, new RegExp(field), `成本页未展示账本字段 ${field}`);
    }
    assert.match(costs, /账本用量/, '成本页缺少账本用量区');
    assert.match(costs, /进程 TTS 缓存/, '成本页缺少进程缓存区');
    assert.match(costs, /不相加|不与/, '成本页未说明账本与进程指标分开、不可相加');
    assert.ok(!/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/.test(costs), '成本页不应发送写请求');
  });
});
