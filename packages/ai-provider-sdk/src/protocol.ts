/**
 * Provider 适配器协议。
 *
 * 依据：D-012「Router 与 Gateway 分离」、D-013「语音三路独立路由」、
 *      D-014「TTS 音色与语速抽象」、约束二「所有模型都可以替换」。
 *
 * 铁律：
 *  1. 本文件及整个 packages/ 与 services/ 的业务代码中，不得出现任何服务商
 *     或模型名称。适配器只按协议能力注册，业务只依赖协议。
 *  2. LLM / TTS / ASR / 发音评估四类服务各自独立注册、独立降级。
 *  3. ASR 与发音评估严格分离：ASR 回答「说了什么」，发音评估回答「说得对不对」。
 */
import type {
  AsrRequest,
  AsrResponse,
  LlmRequest,
  LlmResponse,
  PronunciationRequest,
  PronunciationResponse,
  ServiceKind,
  TtsRequest,
  TtsResponse,
} from '@alg/shared-contracts';

/** 适配器能力声明。用于 Benchmark 前的准入检查与路由资格判定。 */
export interface ProviderCapabilities {
  /** 支持的结构化输出 */
  supportsStructuredOutput: boolean;
  /** 支持流式 */
  supportsStreaming: boolean;
  /** 支持的语速下限与上限（抽象参数） */
  teacherSpeedRange?: { min: number; max: number };
  /** 是否支持音素级发音评估 */
  supportsPhonemeAssessment?: boolean;
  /** 是否支持音节级发音评估 */
  supportsSyllableAssessment?: boolean;
}

/** 单个服务类型的适配器。 */
export interface ProviderAdapter<TReq, TRes> {
  /** 协议标识（配置别名，非真实厂商名） */
  readonly alias: string;
  /** 服务类型 */
  readonly serviceKind: ServiceKind;
  /** 能力声明 */
  readonly capabilities: ProviderCapabilities;
  /** 成本单价（元），用于成本账本 */
  readonly pricing: ProviderPricing;
  /** 执行调用 */
  invoke(request: TReq): Promise<TRes>;
}

/**
 * 成本单价表。价格必须标注核对日期，过期信息只能作历史记录。
 * 对应 DECISIONS.md「价格、免费额度、模型名单等易变信息必须标注核对日期」。
 */
export interface ProviderPricing {
  /** 核对日期（YYYY-MM-DD） */
  checkedAt: string;
  /** 输入价格（元 / 千 token） */
  inputPerKiloToken?: number;
  /** 输出价格（元 / 千 token） */
  outputPerKiloToken?: number;
  /** TTS 价格（元 / 千字节） */
  perKiloByte?: number;
  /** ASR 价格（元 / 秒） */
  perSecond?: number;
  /** 每次发音评估价格（元 / 次） */
  perCall?: number;
}

export type LlmAdapter = ProviderAdapter<LlmRequest, LlmResponse>;
export type TtsAdapter = ProviderAdapter<TtsRequest, TtsResponse>;
export type AsrAdapter = ProviderAdapter<AsrRequest, AsrResponse>;
export type PronunciationAdapter = ProviderAdapter<PronunciationRequest, PronunciationResponse>;

/**
 * 适配器注册表。按服务类型分别注册，实现四路独立路由与独立故障切换（D-013）。
 */
export class AdapterRegistry {
  private readonly map = new Map<ServiceKind, Map<string, ProviderAdapter<never, never>>>();

  register<TReq, TRes>(
    serviceKind: ServiceKind,
    adapter: ProviderAdapter<TReq, TRes>,
  ): void {
    if (!this.map.has(serviceKind)) {
      this.map.set(serviceKind, new Map());
    }
    this.map.get(serviceKind)!.set(adapter.alias, adapter as never);
  }

  get<TReq, TRes>(serviceKind: ServiceKind, alias: string): ProviderAdapter<TReq, TRes> | undefined {
    return this.map.get(serviceKind)?.get(alias) as
      | ProviderAdapter<TReq, TRes>
      | undefined;
  }

  list(serviceKind: ServiceKind): string[] {
    return [...(this.map.get(serviceKind)?.keys() ?? [])];
  }
}

/**
 * 适配器工厂。
 * 真实供应商通过配置注入（baseUrl / modelAlias / apiKey / pricing），
 * 代码中不出现供应商名称 —— 满足约束二。
 */
export interface AdapterFactoryOptions {
  alias: string;
  serviceKind: ServiceKind;
  baseUrl?: string;
  apiKey?: string;
  modelAlias?: string;
  pricing: ProviderPricing;
  capabilities?: Partial<ProviderCapabilities>;
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  supportsStructuredOutput: false,
  supportsStreaming: false,
};

/**
 * 通用 HTTP 适配器：按 OpenAI 兼容的 chat-completions 协议发起调用。
 * 这是协议实现，不是厂商实现 —— 具体指向哪个服务由 baseUrl 配置决定。
 */
export class HttpLlmAdapter implements LlmAdapter {
  readonly alias: string;
  readonly serviceKind: ServiceKind = 'llm';
  readonly capabilities: ProviderCapabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly options: AdapterFactoryOptions) {
    this.alias = options.alias;
    this.pricing = options.pricing;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  async invoke(request: LlmRequest): Promise<LlmResponse> {
    const baseUrl = this.options.baseUrl;
    if (!baseUrl) {
      throw new Error(`adapter ${this.alias} 缺少 baseUrl 配置`);
    }
    const started = Date.now();
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.modelAlias,
        messages: [{ role: 'system', content: request.system }, ...request.messages],
        temperature: request.temperature ?? 0.6,
        max_tokens: request.maxTokens ?? 800,
        ...(request.responseSchema ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 15000),
    });

    if (!res.ok) {
      throw new Error(`adapter ${this.alias} 调用失败: HTTP ${res.status}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = json.choices?.[0]?.message?.content ?? '';
    return {
      content,
      schemaValid: request.responseSchema ? isJsonParsable(content) : true,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: this.options.modelAlias ?? 'unknown',
    };
  }
}

function isJsonParsable(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
