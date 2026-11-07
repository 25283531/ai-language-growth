/**
 * Provider 配置装载。
 *
 * 全部通过环境变量注入，代码中不出现供应商或模型名称（约束二）。
 * 真实服务接入只需填 .env，不需要改动业务代码。
 */
import type { ServiceKind } from '@alg/shared-contracts';
import {
  HttpLlmAdapter,
  type AdapterRegistry,
  type ProviderPricing,
} from './protocol';
import {
  HttpAsrAdapter,
  HttpTtsAdapter,
  resolveAudioDir,
  type HttpServiceOptions,
} from './http';
import {
  MockAsrAdapter,
  MockLlmAdapter,
  MockPronunciationAdapter,
  MockTtsAdapter,
} from './mock';

/** 网关运行模式。 */
export type GatewayMode = 'mock' | 'live';

export interface ProviderConfig {
  mode: GatewayMode;
  llm?: HttpServiceOptions;
  tts?: HttpServiceOptions;
  asr?: HttpServiceOptions;
  pronunciation?: HttpServiceOptions;
  /** 实际启用真实调用的服务种类 */
  liveServices: ServiceKind[];
}

/**
 * live 模式下 Router 应指向的适配器别名（配置别名，不含厂商名）。
 * 发音评估没有免费且提供音素级评分的对口服务，固定走 Mock，
 * 绝不拿 ASR 转写结果冒充发音评分（D-013 / 约束三）。
 */
export const LIVE_PROVIDER_ALIASES: Record<ServiceKind, string> = {
  llm: 'live_llm',
  tts: 'live_tts',
  asr: 'live_asr',
  pronunciation: 'mock_pronunciation',
};

/** 兜底别名，与 Gateway 的 lastResortAlias 一致。 */
export const FALLBACK_PROVIDER_ALIASES: Record<ServiceKind, string> = {
  llm: 'mock_llm',
  tts: 'mock_tts',
  asr: 'mock_asr',
  pronunciation: 'mock_pronunciation',
};

/** M1 有真实 HTTP 适配器的三类服务。 */
const LIVE_CAPABLE: readonly ServiceKind[] = ['llm', 'asr', 'tts'];
const DEFAULT_LIVE_SERVICES = 'llm,asr,tts';

const DEFAULT_PRICING: ProviderPricing = {
  checkedAt: '2026-11-07',
};

/**
 * 计算哪些服务真正走真实调用。
 *
 * 三个条件同时满足：AI_GATEWAY_MODE=live、在 AI_GATEWAY_LIVE_SERVICES 白名单内、
 * 且对应 *_BASE_URL 已配置。任一不满足就自动回落 Mock，
 * 避免出现「Router 指向一个不存在的适配器 → 静默降级」（M1 联调修过的坑）。
 *
 * AI_GATEWAY_LIVE_SERVICES 是可一键关闭的开关，例如去掉 tts 即可零 TTS 调用。
 */
export function resolveLiveServices(env: NodeJS.ProcessEnv = process.env): ServiceKind[] {
  if ((env.AI_GATEWAY_MODE ?? 'mock') !== 'live') return [];
  const requested = (env.AI_GATEWAY_LIVE_SERVICES ?? DEFAULT_LIVE_SERVICES)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return LIVE_CAPABLE.filter(
    (kind) => requested.includes(kind) && Boolean(env[`${kind.toUpperCase()}_BASE_URL`]),
  );
}

/** Router 的供应商别名与 Gateway 注册表必须来自同一份判断，不能各算各的。 */
export function resolveProviderAliases(
  env: NodeJS.ProcessEnv = process.env,
): Record<ServiceKind, string> {
  const live = new Set(resolveLiveServices(env));
  const pick = (kind: ServiceKind): string =>
    live.has(kind) ? LIVE_PROVIDER_ALIASES[kind] : FALLBACK_PROVIDER_ALIASES[kind];
  return { llm: pick('llm'), tts: pick('tts'), asr: pick('asr'), pronunciation: pick('pronunciation') };
}

/** 从环境变量读取配置。缺失真实凭据时自动回落到 mock。 */
export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const mode = (env.AI_GATEWAY_MODE ?? 'mock') as GatewayMode;

  const build = (
    serviceKind: ServiceKind,
    alias: string,
  ): HttpServiceOptions | undefined => {
    const prefix = serviceKind.toUpperCase();
    const baseUrl = env[`${prefix}_BASE_URL`];
    if (!baseUrl) return undefined;
    return {
      alias,
      serviceKind,
      baseUrl,
      apiKey: env[`${prefix}_API_KEY`],
      modelAlias: env[`${prefix}_MODEL`],
      voice: env[`${prefix}_VOICE`],
      audioDir: resolveAudioDir(env),
      pricing: DEFAULT_PRICING,
      capabilities: {},
    };
  };

  return {
    mode,
    llm: build('llm', LIVE_PROVIDER_ALIASES.llm),
    tts: build('tts', LIVE_PROVIDER_ALIASES.tts),
    asr: build('asr', LIVE_PROVIDER_ALIASES.asr),
    pronunciation: build('pronunciation', LIVE_PROVIDER_ALIASES.pronunciation),
    liveServices: resolveLiveServices(env),
  };
}

/**
 * 把配置装配进注册表。
 *
 * 四个 Mock 适配器始终注册，作为最终降级兜底（D-015：外部服务全不可用时课程不中断）。
 * 真实适配器按 liveServices 单独注册，四类服务互不影响。
 */
export function registerAdapters(
  registry: AdapterRegistry,
  config: ProviderConfig = loadProviderConfig(),
): AdapterRegistry {
  registry.register('llm', new MockLlmAdapter());
  registry.register('tts', new MockTtsAdapter());
  registry.register('asr', new MockAsrAdapter());
  registry.register('pronunciation', new MockPronunciationAdapter());

  const live = new Set(config.liveServices);
  if (live.has('llm') && config.llm?.baseUrl) {
    registry.register('llm', new HttpLlmAdapter(config.llm));
  }
  if (live.has('tts') && config.tts?.baseUrl) {
    registry.register('tts', new HttpTtsAdapter(config.tts));
  }
  if (live.has('asr') && config.asr?.baseUrl) {
    registry.register('asr', new HttpAsrAdapter(config.asr));
  }

  return registry;
}
