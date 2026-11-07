/**
 * Provider 配置装载。
 *
 * 全部通过环境变量注入，代码中不出现供应商或模型名称（约束二）。
 * 真实供应商接入只需填 .env，不需要改动业务代码。
 */
import {
  HttpLlmAdapter,
  type AdapterFactoryOptions,
  type AdapterRegistry,
  type LlmAdapter,
  type ProviderCapabilities,
  type ProviderPricing,
} from './protocol';
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
  llm?: AdapterFactoryOptions;
  tts?: AdapterFactoryOptions;
  asr?: AdapterFactoryOptions;
  pronunciation?: AdapterFactoryOptions;
}

const DEFAULT_PRICING: ProviderPricing = {
  checkedAt: '2026-11-07',
};

/** 从环境变量读取配置。缺失真实凭据时自动回落到 mock。 */
export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const mode = (env.AI_GATEWAY_MODE ?? 'mock') as GatewayMode;

  const build = (
    serviceKind: 'llm' | 'tts' | 'asr' | 'pronunciation',
    alias: string,
  ): AdapterFactoryOptions | undefined => {
    const baseUrl = env[`${serviceKind.toUpperCase()}_BASE_URL`];
    const apiKey = env[`${serviceKind.toUpperCase()}_API_KEY`];
    const modelAlias = env[`${serviceKind.toUpperCase()}_MODEL`];
    if (!baseUrl) return undefined;
    return {
      alias,
      serviceKind,
      baseUrl,
      apiKey,
      modelAlias,
      pricing: DEFAULT_PRICING,
      capabilities: {} as Partial<ProviderCapabilities>,
    };
  };

  return {
    mode,
    llm: build('llm', 'primary_llm'),
    tts: build('tts', 'primary_tts'),
    asr: build('asr', 'primary_asr'),
    pronunciation: build('pronunciation', 'primary_pronunciation'),
  };
}

/**
 * 把配置装配进注册表。
 * mock 模式：注册四个 Mock 适配器。
 * live 模式：注册真实适配器，同时保留 mock 作为最终降级兜底，
 * 保证「外部服务全部不可用时课程不中断」（D-015 降级链）。
 */
export function registerAdapters(
  registry: AdapterRegistry,
  config: ProviderConfig = loadProviderConfig(),
): AdapterRegistry {
  registry.register('llm', new MockLlmAdapter());

  if (config.mode === 'live' && config.llm?.baseUrl) {
    registry.register('llm', new HttpLlmAdapter(config.llm));
  }

  registry.register('tts', new MockTtsAdapter());

  registry.register('asr', new MockAsrAdapter());

  registry.register('pronunciation', new MockPronunciationAdapter());

  return registry;
}
