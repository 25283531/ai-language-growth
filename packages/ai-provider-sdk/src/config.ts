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
  SignedJsonTtsAdapter,
  type SignedTtsOptions,
} from './signed-tts';
import {
  MockAsrAdapter,
  MockLlmAdapter,
  MockPronunciationAdapter,
  MockTtsAdapter,
} from './mock';

/** 网关运行模式。 */
export type GatewayMode = 'mock' | 'live';

/**
 * TTS 协议形态。两种都是公开协议，不含任何厂商名：
 * - openai_audio：POST {baseUrl}/audio/speech，直接返回二进制音频
 * - signed_json_audio：POST 到配置 host，签名请求头 + JSON 响应里的 Base64 音频
 */
export type TtsProtocol = 'openai_audio' | 'signed_json_audio';

export function resolveTtsProtocol(env: NodeJS.ProcessEnv = process.env): TtsProtocol {
  return (env.TTS_PROTOCOL ?? 'openai_audio') === 'signed_json_audio'
    ? 'signed_json_audio'
    : 'openai_audio';
}

/**
 * 安全解析配置注入的额外请求字段。
 *
 * 环境变量经 shell source 注入时，JSON 里的双引号会被 shell 吃掉，
 * 因此优先使用无引号的 `key:value;key:value` 形式；同时兼容 JSON 以便容器环境使用。
 * 非法值直接忽略，不让配置错误拖垮进程。
 */
function parseExtraBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  if (trimmed.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  const result: Record<string, unknown> = {};
  for (const pair of trimmed.split(';')) {
    const index = pair.indexOf(':');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const token = pair.slice(index + 1).trim();
    if (!key || !token) continue;
    if (token === 'true' || token === 'false') result[key] = token === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(token)) result[key] = Number(token);
    else result[key] = token;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function optionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export interface ProviderConfig {
  mode: GatewayMode;
  llm?: HttpServiceOptions;
  tts?: SignedTtsOptions;
  asr?: HttpServiceOptions;
  pronunciation?: HttpServiceOptions;
  /** TTS 协议选择，由配置注入 */
  ttsProtocol: TtsProtocol;
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
 * 通用业务字段保护清单（与供应商无关）：防止配置注入覆盖业务字段。
 *
 * 约束二：必需键、允许取值、额外禁止键、以及策略本身全部来自 .env，
 * 代码里不写任何厂商名 / 模型名 / 音色名 / 厂商专属字段名 / 取值。
 * 额外的禁止键由 LLM_FORBIDDEN_EXTRA_KEYS 以逗号分隔追加，默认清单
 * 永不丢失。LLM_EXTRA_POLICY 是必需项，防止「策略漏配」时校验被静默
 * 跳过、退回空 content 故障路径。
 */
export const LLM_FORBIDDEN_EXTRA_KEYS: readonly string[] = [
  'model', 'messages', 'max_tokens', 'temperature',
  'response_format', 'stream', 'tools',
];

/**
 * 启动期 fail-fast：live 模式下必需配置缺失/非法时拒绝启动。
 *
 * 目的：不让「配置漏填」在运行期表现为静默回落 Mock 或空回复。
 * 教学代码不因换模型而调参，配置正确性由这里统一把关（约束二分层）。
 * mock 模式（含 CI 无密钥环境）直接放行。
 */
export function assertLiveProviderConfig(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.AI_GATEWAY_MODE ?? 'mock') !== 'live') return;
  const live = new Set(resolveLiveServices(env));
  if (live.size === 0) return;

  const require = (key: string): void => {
    if (!env[key]) throw new Error(`live 模式缺少必需配置 ${key}`);
  };
  const requireValidExtra = (keys: string[]): void => {
    const raw = keys.map((key) => env[key]).find(Boolean);
    if (raw && !parseExtraBody(raw)) {
      throw new Error(`live 模式额外请求字段格式非法: ${keys.join(' / ')}`);
    }
  };

  if (live.has('llm')) {
    for (const key of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']) require(key);

    // 策略本身必需：漏配会让下方校验被静默跳过，退回空 content 故障路径。
    const policy = env.LLM_EXTRA_POLICY;
    if (policy !== 'required' && policy !== 'none') {
      throw new Error('live 模式缺少必需配置 LLM_EXTRA_POLICY（只允许 required / none）');
    }

    const extra = parseExtraBody(env.LLM_EXTRA_BODY_KV ?? env.LLM_EXTRA_BODY_JSON);
    if (policy === 'required') {
      // 期望 KV 必需且可解析；漏填或格式非法都拒绝。
      const required = parseExtraBody(env.LLM_REQUIRED_EXTRA_KV);
      if (!required) {
        throw new Error('live 模式缺少必需配置 LLM_REQUIRED_EXTRA_KV，或额外请求字段格式非法');
      }
      if (!extra) {
        throw new Error(
          'live 模式缺少必需配置 LLM_EXTRA_BODY_KV / LLM_EXTRA_BODY_JSON，或额外请求字段格式非法',
        );
      }
      for (const [key, expected] of Object.entries(required)) {
        if (!(key in extra) || String(extra[key]) !== String(expected)) {
          throw new Error(`live 模式 LLM 额外请求字段 ${key} 与 LLM_REQUIRED_EXTRA_KV 不一致`);
        }
      }
    }

    // 两种策略都执行禁止键检查：默认通用业务字段 + .env 追加键，均不可被配置覆盖。
    const forbiddenKeys = [
      ...LLM_FORBIDDEN_EXTRA_KEYS,
      ...(env.LLM_FORBIDDEN_EXTRA_KEYS ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean),
    ];
    if (extra) {
      for (const key of forbiddenKeys) {
        if (key in extra) {
          throw new Error(`live 模式 LLM 额外请求字段禁止使用 ${key}`);
        }
      }
    }

    // token 下限漏填会让 Math.max(120, 0) 静默取业务侧下限，推理预算不足返回空 content。
    const minRaw = env.LLM_MIN_MAX_TOKENS;
    if (minRaw === undefined || minRaw === '' ||
        !Number.isInteger(Number(minRaw)) || Number(minRaw) <= 0) {
      throw new Error('live 模式缺少必需配置 LLM_MIN_MAX_TOKENS（必须为正整数）');
    }
  }

  if (live.has('tts')) {
    if (env.TTS_PROTOCOL && !['openai_audio', 'signed_json_audio'].includes(env.TTS_PROTOCOL)) {
      throw new Error(`live 模式 TTS_PROTOCOL 不受支持: ${env.TTS_PROTOCOL}`);
    }
    const signed = resolveTtsProtocol(env) === 'signed_json_audio';
    if (signed) {
      for (const key of [
        'TTS_SECRET_ID', 'TTS_SECRET_KEY', 'TTS_SERVICE',
        'TTS_ACTION', 'TTS_VERSION', 'TTS_VOICE',
      ]) require(key);
      // 配了双凭据却没切协议，会静默按二进制协议调用并失败
      if (!env.TTS_PROTOCOL) {
        throw new Error('已配置签名双凭据，必须显式设置 TTS_PROTOCOL=signed_json_audio');
      }
      // 编码必须显式声明：裸 PCM 无容器头、浏览器不可播放，
      // 且「未设置」会被静默归一成 mp3，掩盖配置漏填。
      if (!env.TTS_CODEC) {
        throw new Error('live 模式必须显式设置 TTS_CODEC (mp3 或 wav)');
      }
      if (env.TTS_CODEC !== 'mp3' && env.TTS_CODEC !== 'wav') {
        throw new Error(`live 模式 TTS_CODEC 只允许 mp3/wav，禁止 ${env.TTS_CODEC}（裸 PCM 无容器头）`);
      }
      if (!Number.isInteger(Number(env.TTS_VOICE)) || Number(env.TTS_VOICE) <= 0) {
        throw new Error('live 模式 TTS_VOICE 必须为有效音色编号');
      }
      if (env.TTS_MODEL_TYPE && Number(env.TTS_MODEL_TYPE) !== 1) {
        throw new Error('live 模式 TTS_MODEL_TYPE 只允许默认值 1，音色档位由 TTS_VOICE 决定');
      }
    } else if (env.TTS_SECRET_ID || env.TTS_SECRET_KEY) {
      throw new Error('检测到签名双凭据但 TTS_PROTOCOL 不是 signed_json_audio');
    }
    requireValidExtra(['TTS_EXTRA_BODY_KV', 'TTS_EXTRA_BODY_JSON']);
  }

  if (live.has('asr')) {
    for (const key of ['ASR_BASE_URL', 'ASR_API_KEY', 'ASR_MODEL']) require(key);
  }
}

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
  ): SignedTtsOptions | undefined => {
    const prefix = serviceKind.toUpperCase();
    const baseUrl = env[`${prefix}_BASE_URL`];
    if (!baseUrl) return undefined;
    const common = {
      alias,
      serviceKind,
      baseUrl,
      apiKey: env[`${prefix}_API_KEY`],
      modelAlias: env[`${prefix}_MODEL`],
      voice: env[`${prefix}_VOICE`],
      audioDir: resolveAudioDir(env),
      pricing: DEFAULT_PRICING,
      capabilities: {},
      extraBody: parseExtraBody(
        env[`${prefix}_EXTRA_BODY_KV`] ?? env[`${prefix}_EXTRA_BODY_JSON`],
      ),
      minMaxTokens: optionalNumber(env[`${prefix}_MIN_MAX_TOKENS`]),
    } satisfies HttpServiceOptions;
    if (serviceKind !== 'tts') return common;

    // 签名型音频协议的额外参数全部来自配置；换供应商/换音色档位不改代码。
    return {
      ...common,
      secretId: env.TTS_SECRET_ID,
      secretKey: env.TTS_SECRET_KEY,
      service: env.TTS_SERVICE,
      action: env.TTS_ACTION,
      version: env.TTS_VERSION,
      region: env.TTS_REGION,
      // 裸 PCM 无容器头，浏览器无法播放，协议层不开放该选项
      codec: env.TTS_CODEC === 'wav' ? 'wav' : 'mp3',
      sampleRate: optionalNumber(env.TTS_SAMPLE_RATE),
      primaryLanguage: optionalNumber(env.TTS_PRIMARY_LANGUAGE),
      volume: optionalNumber(env.TTS_VOLUME),
      modelType: optionalNumber(env.TTS_MODEL_TYPE),
      extraBody: parseExtraBody(env.TTS_EXTRA_BODY_KV ?? env.TTS_EXTRA_BODY_JSON),
      audioField: env.TTS_AUDIO_FIELD,
    } satisfies SignedTtsOptions;
  };

  return {
    mode,
    llm: build('llm', LIVE_PROVIDER_ALIASES.llm),
    tts: build('tts', LIVE_PROVIDER_ALIASES.tts),
    asr: build('asr', LIVE_PROVIDER_ALIASES.asr),
    pronunciation: build('pronunciation', LIVE_PROVIDER_ALIASES.pronunciation),
    ttsProtocol: resolveTtsProtocol(env),
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
    registry.register(
      'tts',
      config.ttsProtocol === 'signed_json_audio'
        ? new SignedJsonTtsAdapter(config.tts)
        : new HttpTtsAdapter(config.tts),
    );
  }
  if (live.has('asr') && config.asr?.baseUrl) {
    registry.register('asr', new HttpAsrAdapter(config.asr));
  }

  return registry;
}
