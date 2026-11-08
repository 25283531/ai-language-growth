/**
 * AI Gateway —— 统一调用层。
 *
 * 依据：D-012「Gateway 负责统一鉴权、请求转换、实际调用、超时、重试和成本计量；
 *      只执行调用，不选模型」；D-013「语音三路独立路由」；
 *      D-014「TTS 音色与语速抽象」；D-015「降级链」。
 *
 * 铁律：
 *  1. Gateway 只按 Router 给出的决策执行调用，绝不自己选模型。
 *  2. 重复播放同一段语音不重新消耗 TTS —— 走本地缓存（D-014 / 验收硬指标一）。
 *  3. 所有降级都必须如实上报，不得静默掩盖。
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AdapterRegistry,
  HttpAsrAdapter,
  HttpLlmAdapter,
  HttpTtsAdapter,
  loadProviderConfig,
  resolveProviderAliases,
  registerAdapters,
  type HttpServiceOptions,
  type AsrAdapter,
  type LlmAdapter,
  type PronunciationAdapter,
  type TtsAdapter,
  IflytekIseAdapter,
  TencentSoeAdapter,
  AzurePronunciationAdapter,
  SpeechacePronunciationAdapter,
  ChivoxPronunciationAdapter,
  IflytekTtsAdapter,
  IflytekAsrAdapter,
} from '@alg/ai-provider-sdk';
import type {
  AiGateway,
  AsrRequest,
  AsrResponse,
  LlmRequest,
  LlmResponse,
  PronunciationRequest,
  PronunciationResponse,
  RoutingDecision,
  TtsRequest,
  TtsResponse,
} from '@alg/shared-contracts';
import { MOCK_PROVIDER_ALIASES, ModelRouterImpl } from '@alg/model-router';
import { ProviderConfigService, type RuntimeProviderConfig } from '../providers/provider-config.service';

/** 一次调用的结果与降级信息。 */
export interface GatewayCallResult<T> {
  result: T;
  /** 是否发生了降级 */
  degraded: boolean;
  /** 降级原因 */
  reasons: string[];
  /** 实际使用的级别 */
  effectiveLevel: RoutingDecision['level'];
  /** 实际使用的供应商标识 */
  providerAlias: string;
  latencyMs: number;
}

@Injectable()
export class AiGatewayService implements AiGateway, OnModuleInit {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly registry: AdapterRegistry;
  /** TTS 音频缓存：语音内容 + 参数 → 音频引用。 */
  private readonly ttsCache = new Map<string, { audioRef: string; characters: number }>();

  constructor(
    @Inject(ModelRouterImpl) private readonly modelRouter: ModelRouterImpl,
    @Inject(ProviderConfigService) private readonly providerConfigs: ProviderConfigService,
  ) {
    this.registry = registerAdapters(new AdapterRegistry(), loadProviderConfig());
    this.logger.log(
      `AI Gateway 就绪，llm=${this.registry.list('llm').join(',')} tts=${this.registry
        .list('tts')
        .join(',')} asr=${this.registry.list('asr').join(',')} pronunciation=${this.registry
        .list('pronunciation')
        .join(',')}`,
    );
  }

  async onModuleInit(): Promise<void> {
    for (const config of await this.providerConfigs.listEnabledRuntimeConfigs()) {
      await this.applyRuntimeProvider(config);
    }
  }

  /** Apply an operator-selected provider immediately after a configuration save. */
  async refreshRuntimeProvider(serviceKind: 'llm' | 'tts' | 'asr' | 'pronunciation'): Promise<void> {
    const config = await this.providerConfigs.getEnabledRuntimeConfig(serviceKind);
    if (config) {
      await this.applyRuntimeProvider(config);
      return;
    }
    this.modelRouter.setProviderAlias(serviceKind, resolveProviderAliases()[serviceKind]);
  }

  private async applyRuntimeProvider(config: RuntimeProviderConfig): Promise<void> {
    const alias = `configured_${config.serviceKind}`;
    const options: HttpServiceOptions = {
      alias,
      serviceKind: config.serviceKind,
      providerPresetId: config.providerPresetId,
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      apiKey: config.credentials.apiKey,
      credentials: config.credentials,
      options: config.options,
      modelAlias: config.modelAlias,
      pricing: { checkedAt: new Date().toISOString().slice(0, 10) },
      ...(typeof config.options.voice === 'string' ? { voice: config.options.voice } : {}),
      ...(config.options.extraBody && typeof config.options.extraBody === 'object'
        ? { extraBody: config.options.extraBody as Record<string, unknown> }
        : {}),
      ...(typeof config.options.minMaxTokens === 'number'
        ? { minMaxTokens: config.options.minMaxTokens }
        : {}),
    };

    switch (config.serviceKind) {
      case 'llm':
        this.registry.register('llm', new HttpLlmAdapter(options));
        break;
      case 'tts':
        this.registry.register('tts', config.providerPresetId === 'iflytek-spark'
          ? new IflytekTtsAdapter({ ...options, baseUrl: config.baseUrl, credentials: config.credentials })
          : new HttpTtsAdapter(options));
        break;
      case 'asr':
        this.registry.register('asr', config.providerPresetId === 'iflytek-spark'
          ? new IflytekAsrAdapter({ ...options, baseUrl: config.baseUrl, credentials: config.credentials })
          : new HttpAsrAdapter(options));
        break;
      case 'pronunciation':
        if (config.providerPresetId === 'iflytek-spark') {
          this.registry.register('pronunciation', new IflytekIseAdapter({ alias, providerPresetId: config.providerPresetId, baseUrl: config.baseUrl, modelAlias: config.modelAlias, credentials: config.credentials, options: config.options }));
        } else if (config.providerPresetId === 'tencent-soe') {
          this.registry.register('pronunciation', new TencentSoeAdapter({ alias, providerPresetId: config.providerPresetId, baseUrl: config.baseUrl, modelAlias: config.modelAlias, credentials: config.credentials, options: config.options }));
        } else if (config.providerPresetId === 'azure-speech') {
          this.registry.register('pronunciation', new AzurePronunciationAdapter({ alias, providerPresetId: config.providerPresetId, baseUrl: config.baseUrl, modelAlias: config.modelAlias, credentials: config.credentials, options: config.options }));
        } else if (config.providerPresetId === 'speechace') {
          this.registry.register('pronunciation', new SpeechacePronunciationAdapter({ alias, providerPresetId: config.providerPresetId, baseUrl: config.baseUrl, modelAlias: config.modelAlias, credentials: config.credentials, options: config.options }));
        } else if (config.providerPresetId === 'chivox') {
          this.registry.register('pronunciation', new ChivoxPronunciationAdapter({ alias, providerPresetId: config.providerPresetId, baseUrl: config.baseUrl, modelAlias: config.modelAlias, credentials: config.credentials, options: config.options }));
        } else {
          throw new Error(`平台 ${config.providerPresetId} 暂无音素评测适配器`);
        }
        break;
    }
    const benchmarkPassed = await this.providerConfigs.hasPassingBenchmark(
      config.serviceKind,
      config.modelAlias,
    );
    if (benchmarkPassed) {
      this.modelRouter.setProviderAlias(config.serviceKind, alias, config.modelAlias);
      this.logger.log(`运行时模型连接已更新：${config.serviceKind} → ${alias}（儿童专项 Benchmark 通过）`);
    } else {
      this.modelRouter.setProviderAlias(config.serviceKind, MOCK_PROVIDER_ALIASES[config.serviceKind]);
      this.logger.warn(`模型 ${config.serviceKind}/${config.modelAlias} 尚无通过的儿童专项 Benchmark，暂使用本地 Mock`);
    }
  }

  // ——————————————————— LLM ———————————————————

  async llm(request: LlmRequest, decision: RoutingDecision): Promise<LlmResponse> {
    const outcome = await this.callWithFallback<LlmResponse>(
      'llm',
      decision,
      async (adapter) => (adapter as LlmAdapter).invoke(request),
      'mock_llm',
    );
    return outcome.result;
  }

  // ——————————————————— TTS ———————————————————

  async tts(request: TtsRequest, decision: RoutingDecision): Promise<TtsResponse> {
    return (await this.ttsWithResult(request, decision)).result;
  }

  /**
   * 与 tts 相同，但额外返回真实调用链上的降级信息。
   *
   * 编排器据此填写 degradation —— 降级必须如实上报，不得静默掩盖（D-015）。
   * 只看 Router 的 fellBack 是不够的：Gateway 可能因适配器未注册而发生
   * 实际切换，而 Router 对此一无所知。
   */
  async ttsWithResult(
    request: TtsRequest,
    decision: RoutingDecision,
  ): Promise<GatewayCallResult<TtsResponse>> {
    // —— 缓存命中：反复播放不重新消耗 TTS ——
    const cacheKey = this.ttsCacheKey(request);
    const cached = this.ttsCache.get(cacheKey);
    if (cached) {
      return {
        result: {
          audioRef: cached.audioRef,
          characters: 0, // 缓存命中不计入字符量
          latencyMs: 0,
          providerAlias: decision.providerAlias,
          modelAlias: decision.modelAlias,
          cached: true,
        },
        degraded: false,
        reasons: [],
        effectiveLevel: decision.level,
        providerAlias: decision.providerAlias,
        latencyMs: 0,
      };
    }

    const outcome = await this.callWithFallback<TtsResponse>(
      'tts',
      decision,
      async (adapter) => (adapter as TtsAdapter).invoke(request),
      'mock_tts',
    );

    // 只要拿到可用音频就缓存：降级到兜底适配器同样是有效音频，
    // 若因 degraded 而不缓存，Mock 模式下重复播放会永远重新计费。
    if (outcome.result.audioRef && !outcome.result.cached) {
      this.ttsCache.set(cacheKey, {
        audioRef: outcome.result.audioRef,
        characters: outcome.result.characters,
      });
    }
    return outcome;
  }

  /**
   * TTS 缓存键。
   * 只包含决定音频内容的参数：文本、抽象语速、音色、发音模式、停顿。
   * 不含供应商或模型标识 —— 换模型不应让缓存失效导致重复计费。
   */
  private ttsCacheKey(request: TtsRequest): string {
    return [
      request.text,
      request.voice.teacherSpeed,
      request.voice.voiceStyle,
      request.voice.pronunciationMode,
      request.voice.pauseAfterSentenceMs,
      request.voiceIdentity,
    ].join('|');
  }

  // ——————————————————— ASR ———————————————————

  /**
   * ASR 双层策略（D-013）：
   * 先用免费识别做初步转写，质量检测（空结果、明显异常、无法确认）后，
   * 仅把需要二次识别的内容送高质量识别。
   *
   * M1 的双层由 Gateway 内部完成：先调主适配器，命中 suspect 才调 fallback。
   */
  async asr(request: AsrRequest, decision: RoutingDecision): Promise<AsrResponse> {
    const first = await this.callWithFallback<AsrResponse>(
      'asr',
      decision,
      async (adapter) => (adapter as AsrAdapter).invoke(request),
      'mock_asr',
    );

    if (!first.result.suspect || request.highQuality) {
      return first.result;
    }

    // suspect：升级到高质量识别
    const upgraded = await this.callWithFallback<AsrResponse>(
      'asr',
      { ...decision, level: 'L2', fellBack: true, strategy: 'asr_high_quality_second_pass' },
      async (adapter) => (adapter as AsrAdapter).invoke({ ...request, highQuality: true }),
      'mock_asr',
    );

    if (upgraded.result.transcript) {
      return upgraded.result;
    }
    return first.result;
  }

  // ——————————————————— 发音评估 ———————————————————

  /**
   * 发音评估。与 ASR 严格分离（D-013）：
   * ASR 回答「说了什么」，发音评估回答「说得对不对」。
   * 识别正确不证明发音正确，两者混用会污染发音能力证据。
   */
  async pronunciation(
    request: PronunciationRequest,
    decision: RoutingDecision,
  ): Promise<PronunciationResponse> {
    const outcome = await this.callWithFallback<PronunciationResponse>(
      'pronunciation',
      decision,
      async (adapter) => (adapter as PronunciationAdapter).invoke(request),
      'mock_pronunciation',
    );
    return outcome.result;
  }

  // ——————————————————— 降级链 ———————————————————

  /**
   * 按降级链执行调用。
   *
   * 降级链固定四步（D-015）：
   *   免费模型优先 → 限流时切付费低价 → 预算上限时保障关键教学交互
   *   → 外部服务全不可用时保留固定课程和缓存音频，保证课程不中断
   *
   * 最后一步由调用方（编排器）根据 degradation 结果决定是否走离线兜底。
   */
  private async callWithFallback<T>(
    serviceKind: 'llm' | 'tts' | 'asr' | 'pronunciation',
    decision: RoutingDecision,
    invoke: (adapter: unknown) => Promise<T>,
    lastResortAlias: string,
  ): Promise<GatewayCallResult<T>> {
    const started = Date.now();
    const reasons: string[] = [];

    // 第一候选：Router 指定的模型
    const primary = this.registry.get(serviceKind, decision.providerAlias);
    if (primary) {
      try {
        const result = await invoke(primary);
        return {
          result,
          degraded: decision.fellBack,
          reasons: decision.fellBack ? [`fallback_to_${decision.providerAlias}`] : [],
          effectiveLevel: decision.level,
          providerAlias: decision.providerAlias,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        reasons.push(`primary_failed:${(error as Error).message}`);
        this.logger.warn(`${serviceKind} 主模型 ${decision.providerAlias} 调用失败: ${(error as Error).message}`);
      }
    } else {
      reasons.push(`adapter_not_found:${decision.providerAlias}`);
    }

    // 第二候选：兜底适配器（Mock / 缓存），保证课程不中断
    const fallback = this.registry.get(serviceKind, lastResortAlias);
    if (fallback) {
      try {
        const result = await invoke(fallback);
        return {
          result,
          degraded: true,
          reasons: [...reasons, `fallback_to_${lastResortAlias}`],
          effectiveLevel: 'L0',
          providerAlias: lastResortAlias,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        reasons.push(`fallback_failed:${(error as Error).message}`);
      }
    }

    // 全部不可用：抛出，由编排器决定离线兜底
    throw new Error(`${serviceKind} 全部供应商标识不可用: ${reasons.join('; ')}`);
  }

  /** 缓存统计，供成本与用量接口展示。 */
  ttsCacheStats(): { entries: number; hitCharactersSaved: number } {
    let saved = 0;
    for (const v of this.ttsCache.values()) {
      saved += v.characters;
    }
    return { entries: this.ttsCache.size, hitCharactersSaved: saved };
  }
}
