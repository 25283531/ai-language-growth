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
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  TencentCloudAsrAdapter,
  TencentCloudTtsAdapter,
  resolveAudioDir,
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
import { PrismaService } from '../prisma/prisma.service';

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
  private readonly ttsCache = new Map<string, {
    audioRef: string;
    characters: number;
    text: string;
    teacherSpeed: number;
    voiceIdentity: string;
  }>();
  private readonly providerTimeouts = new Map<string, number>();
  private pronunciationCandidates: string[] = [];
  private readonly runtimeCandidates: Record<'llm' | 'tts' | 'asr', string[]> = {
    llm: [],
    tts: [],
    asr: [],
  };
  private smallLlmCandidates: string[] = [];
  private mainLlmCandidates: string[] = [];

  constructor(
    @Inject(ModelRouterImpl) private readonly modelRouter: ModelRouterImpl,
    @Inject(ProviderConfigService) private readonly providerConfigs: ProviderConfigService,
    private readonly prisma: PrismaService,
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
    for (const kind of ['llm', 'tts', 'asr', 'pronunciation'] as const) {
      await this.refreshRuntimeProvider(kind);
    }
  }

  /** Apply an operator-selected provider immediately after a configuration save. */
  async refreshRuntimeProvider(serviceKind: 'llm' | 'tts' | 'asr' | 'pronunciation'): Promise<void> {
    for (const alias of this.registry.list(serviceKind).filter((item) => item.startsWith(`configured_${serviceKind}_`))) {
      this.registry.unregister(serviceKind, alias);
      this.providerTimeouts.delete(alias);
    }
    const configs = (await this.providerConfigs.listEnabledRuntimeConfigs()).filter((item) => item.serviceKind === serviceKind);
    const enabled: RuntimeProviderConfig[] = [];
    if (configs.length) {
      for (const config of configs) {
        await this.applyRuntimeProvider(config);
        enabled.push(config);
      }
    }
    const candidates = enabled.map((config) => `configured_${serviceKind}_${config.id}`);
    if (serviceKind === 'pronunciation') this.pronunciationCandidates = candidates;
    else {
      this.runtimeCandidates[serviceKind] = candidates;
      if (serviceKind === 'llm') {
        this.smallLlmCandidates = enabled
          .filter((config) => config.options.role === 'small')
          .map((config) => `configured_llm_${config.id}`);
        this.mainLlmCandidates = enabled
          .filter((config) => config.options.role !== 'small')
          .map((config) => `configured_llm_${config.id}`);
      }
    }
    const primary = serviceKind === 'llm'
      ? enabled.find((config) => config.options.role !== 'small')
      : enabled[0];
    this.modelRouter.setProviderAlias(
      serviceKind,
      primary ? `configured_${serviceKind}_${primary.id}` : MOCK_PROVIDER_ALIASES[serviceKind],
      primary?.modelAlias,
    );
  }

  private async applyRuntimeProvider(config: RuntimeProviderConfig): Promise<void> {
    const alias = `configured_${config.serviceKind}_${config.id}`;
    this.providerTimeouts.set(alias, config.timeoutMs);
    const options: HttpServiceOptions = {
      alias,
      serviceKind: config.serviceKind,
      providerPresetId: config.providerPresetId,
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      apiKey: config.credentials.apiKey,
      credentials: config.credentials,
      options: { ...config.options, timeoutMs: config.timeoutMs },
      modelAlias: config.modelAlias,
      pricing: { checkedAt: new Date().toISOString().slice(0, 10) },
      ...(typeof config.options.voice === 'string' ? { voice: config.options.voice } : {}),
      capabilities: config.providerPresetId === 'ollama'
        ? {}
        : { teacherSpeedRange: { min: 0.25, max: 1.2 } },
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
          : config.providerPresetId === 'tencent-cloud'
            ? new TencentCloudTtsAdapter({ ...options, baseUrl: config.baseUrl, credentials: config.credentials })
            : new HttpTtsAdapter(options));
        break;
      case 'asr':
        this.registry.register('asr', config.providerPresetId === 'iflytek-spark'
          ? new IflytekAsrAdapter({ ...options, baseUrl: config.baseUrl, credentials: config.credentials })
          : config.providerPresetId === 'tencent-cloud'
            ? new TencentCloudAsrAdapter({ ...options, baseUrl: config.baseUrl, credentials: config.credentials })
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
    this.logger.log(`运行时模型连接已加载：${config.serviceKind} → ${alias}`);
  }

  // ——————————————————— LLM ———————————————————

  async llm(request: LlmRequest, decision: RoutingDecision): Promise<LlmResponse> {
    const primaryCandidates = this.mainLlmCandidates.length
      ? this.mainLlmCandidates
      : this.runtimeCandidates.llm.length
        ? this.runtimeCandidates.llm.filter((alias) => !this.smallLlmCandidates.includes(alias))
        : [decision.providerAlias];
    const outcome = await this.callWithFallback<LlmResponse>(
      'llm',
      decision,
      async (adapter) => (adapter as LlmAdapter).invoke(request),
      'mock_llm',
      primaryCandidates,
    );
    return outcome.result;
  }

  /** Lightweight LLM role for memory extraction and content enrichment. */
  async smallLlm(request: LlmRequest, decision: RoutingDecision): Promise<LlmResponse> {
    const outcome = await this.callWithFallback<LlmResponse>(
      'llm',
      decision,
      async (adapter, timeoutMs) => (adapter as LlmAdapter).invoke({
        ...request,
        ...(timeoutMs ? { timeoutMs: Math.min(request.timeoutMs ?? timeoutMs, timeoutMs) } : {}),
      }),
      'mock_llm',
      [...this.smallLlmCandidates, ...this.mainLlmCandidates],
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
    const normalizedRequest = {
      ...request,
      voice: {
        teacherSpeed: request.voice.teacherSpeed ?? 0.65,
        voiceStyle: request.voice.voiceStyle ?? 'gentle',
        pauseAfterSentenceMs: request.voice.pauseAfterSentenceMs ?? 1000,
        pronunciationMode: request.voice.pronunciationMode ?? 'slow_clear',
      },
      voiceIdentity: request.voiceIdentity ?? 'teacher_default',
    } as TtsRequest & { voice: { teacherSpeed: number; voiceStyle: string; pauseAfterSentenceMs: number; pronunciationMode: string }; voiceIdentity: string };
    // —— 缓存命中：反复播放不重新消耗 TTS ——
    const cacheKey = this.ttsCacheKey(normalizedRequest);
    let cached = this.ttsCache.get(cacheKey);
    if (cached) {
      // Only local media references must point to an existing file. Mock and
      // provider-hosted references are valid cache entries without local files.
      if (cached.audioRef.startsWith('/api/v1/media/audio/')) {
        const audioFile = cached.audioRef.split('/').pop();
        try {
          if (!audioFile || audioFile.includes('..')) throw new Error('invalid audio reference');
          await access(join(resolveAudioDir(), audioFile));
        } catch {
          this.ttsCache.delete(cacheKey);
          cached = undefined;
        }
      }
    }
    cached ??= await this.loadPersistentTtsCache(cacheKey, normalizedRequest);
    if (cached) {
      const speed = this.ttsSpeedMetadata(normalizedRequest, decision.providerAlias);
      return {
        result: {
          audioRef: cached.audioRef,
          characters: 0, // 缓存命中不计入字符量
          latencyMs: 0,
          providerAlias: decision.providerAlias,
          modelAlias: decision.modelAlias,
          cached: true,
          ...speed,
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
      async (adapter, timeoutMs) => (adapter as TtsAdapter).invoke({
        ...normalizedRequest,
        ...(timeoutMs ? { timeoutMs: Math.min(normalizedRequest.timeoutMs ?? timeoutMs, timeoutMs) } : {}),
      }),
      'mock_tts',
    );
    Object.assign(outcome.result, this.ttsSpeedMetadata(normalizedRequest, outcome.providerAlias));

    // 只要拿到可用音频就缓存：降级到兜底适配器同样是有效音频，
    // 若因 degraded 而不缓存，Mock 模式下重复播放会永远重新计费。
    if (outcome.result.audioRef && !outcome.result.cached) {
      this.ttsCache.set(cacheKey, {
        audioRef: outcome.result.audioRef,
        characters: outcome.result.characters,
        text: normalizedRequest.text,
        teacherSpeed: normalizedRequest.voice.teacherSpeed,
        voiceIdentity: normalizedRequest.voiceIdentity,
      });
      await this.storePersistentTtsCache(cacheKey, normalizedRequest, outcome.result).catch((error) =>
        this.logger.warn(`TTS 持久化缓存索引写入失败：${(error as Error).message}`),
      );
    }
    return outcome;
  }

  private ttsSpeedMetadata(request: TtsRequest, providerAlias: string): {
    requestedTeacherSpeed: number;
    speedMode: 'native' | 'playback';
    playbackRate: number;
  } {
    const requestedTeacherSpeed = Math.min(4, Math.max(0.25, request.voice.teacherSpeed ?? 0.65));
    const adapter = this.registry.get<TtsRequest, TtsResponse>('tts', providerAlias);
    const supportsNative = Boolean(adapter?.capabilities.teacherSpeedRange);
    return {
      requestedTeacherSpeed,
      speedMode: supportsNative ? 'native' : 'playback',
      playbackRate: supportsNative ? 1 : requestedTeacherSpeed,
    };
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

  private async loadPersistentTtsCache(
    cacheKey: string,
    request: TtsRequest,
  ): Promise<{
    audioRef: string;
    characters: number;
    text: string;
    teacherSpeed: number;
    voiceIdentity: string;
  } | undefined> {
    const file = this.ttsCacheIndexPath(cacheKey);
    try {
      const teacherSpeed = request.voice.teacherSpeed ?? 0.65;
      const voiceIdentity = request.voiceIdentity ?? 'teacher_default';
      const entry = JSON.parse(await readFile(file, 'utf8')) as {
        audioRef?: unknown;
        characters?: unknown;
        text?: unknown;
        teacherSpeed?: unknown;
        voiceIdentity?: unknown;
      };
      if (typeof entry.audioRef !== 'string' || !entry.audioRef.startsWith('/api/v1/media/audio/')) return undefined;
      if (entry.text !== request.text || Number(entry.teacherSpeed) !== teacherSpeed || entry.voiceIdentity !== voiceIdentity) return undefined;
      const audioFile = entry.audioRef.split('/').pop();
      if (!audioFile || audioFile.includes('..')) return undefined;
      await access(join(resolveAudioDir(), audioFile));
      const cached = {
        audioRef: entry.audioRef,
        characters: typeof entry.characters === 'number' ? entry.characters : 0,
        text: request.text,
        teacherSpeed,
        voiceIdentity,
      };
      this.ttsCache.set(cacheKey, cached);
      return cached;
    } catch {
      return undefined;
    }
  }

  private async storePersistentTtsCache(cacheKey: string, request: TtsRequest, result: TtsResponse): Promise<void> {
    const directory = resolveAudioDir();
    await mkdir(directory, { recursive: true });
    await writeFile(this.ttsCacheIndexPath(cacheKey), JSON.stringify({
      audioRef: result.audioRef,
      characters: result.characters,
      text: request.text,
      voice: request.voice,
      teacherSpeed: request.voice.teacherSpeed,
      voiceIdentity: request.voiceIdentity,
      providerAlias: result.providerAlias,
      modelAlias: result.modelAlias,
    }), 'utf8');
    const audioFile = result.audioRef.split('/').pop();
    if (audioFile && !audioFile.includes('..')) {
      const extension = audioFile.split('.').pop() || null;
      const checksum = audioFile.split('.')[0] || null;
      await this.prisma.media_assets.upsert({
        where: { id: `tts-${checksum}` },
        create: {
          id: `tts-${checksum}`,
          kind: 'audio',
          ref: result.audioRef,
          voiceIdentity: request.voiceIdentity,
          teacherSpeed: request.voice.teacherSpeed,
          checksum,
          cacheExtension: extension,
          cacheStatus: 'cached',
          sourceProvider: result.providerAlias,
        },
        update: {
          ref: result.audioRef,
          voiceIdentity: request.voiceIdentity,
          teacherSpeed: request.voice.teacherSpeed,
          checksum,
          cacheExtension: extension,
          cacheStatus: 'cached',
          sourceProvider: result.providerAlias,
        },
      }).catch(() => undefined);
    }
  }

  private ttsCacheIndexPath(cacheKey: string): string {
    const key = createHash('sha256').update(cacheKey).digest('hex');
    return join(resolveAudioDir(), `.tts-${key}.json`);
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
      async (adapter, timeoutMs) => (adapter as AsrAdapter).invoke({
        ...request,
        ...(timeoutMs ? { timeoutMs: Math.min(request.timeoutMs ?? timeoutMs, timeoutMs) } : {}),
      }),
      'mock_asr',
    );

    if (!first.result.suspect || request.highQuality) {
      return first.result;
    }

    // suspect：升级到高质量识别
    const upgraded = await this.callWithFallback<AsrResponse>(
      'asr',
      { ...decision, level: 'L2', fellBack: true, strategy: 'asr_high_quality_second_pass' },
      async (adapter, timeoutMs) => (adapter as AsrAdapter).invoke({
        ...request,
        highQuality: true,
        ...(timeoutMs ? { timeoutMs: Math.min(request.timeoutMs ?? timeoutMs, timeoutMs) } : {}),
      }),
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
      async (adapter, timeoutMs) => (adapter as PronunciationAdapter).invoke({
        ...request,
        ...(timeoutMs ? { timeoutMs: Math.min(request.timeoutMs ?? timeoutMs, timeoutMs) } : {}),
      }),
      undefined,
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
    invoke: (adapter: unknown, timeoutMs?: number) => Promise<T>,
    lastResortAlias?: string,
    candidateOverride?: string[],
  ): Promise<GatewayCallResult<T>> {
    const started = Date.now();
    const reasons: string[] = [];

    const candidates = candidateOverride !== undefined
      ? candidateOverride
      : serviceKind === 'pronunciation'
      ? this.pronunciationCandidates
      : this.runtimeCandidates[serviceKind].length
        ? this.runtimeCandidates[serviceKind]
        : [decision.providerAlias];

    for (const candidateAlias of candidates) {
      const primary = this.registry.get(serviceKind, candidateAlias);
      if (!primary) {
        reasons.push(`adapter_not_found:${candidateAlias}`);
        continue;
      }
      try {
        const result = await this.invokeWithTimeout(invoke, primary, this.providerTimeouts.get(candidateAlias));
        const degraded = decision.fellBack || candidateAlias !== decision.providerAlias;
        return {
          result,
          degraded,
          reasons: degraded ? [...reasons, `fallback_to_${candidateAlias}`] : [],
          effectiveLevel: decision.level,
          providerAlias: candidateAlias,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        reasons.push(`${candidateAlias}_failed:${(error as Error).message}`);
        this.logger.warn(`${serviceKind} 模型 ${candidateAlias} 调用失败: ${(error as Error).message}`);
      }
    }

    // 第二候选：兜底适配器（Mock / 缓存），保证课程不中断
    const fallback = lastResortAlias ? this.registry.get(serviceKind, lastResortAlias) : undefined;
    if (fallback) {
      try {
        const result = await invoke(fallback);
        return {
          result,
          degraded: true,
          reasons: [...reasons, `fallback_to_${lastResortAlias}`],
          effectiveLevel: 'L0',
          providerAlias: lastResortAlias!,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        reasons.push(`fallback_failed:${(error as Error).message}`);
      }
    }

    // 全部不可用：抛出，由编排器决定离线兜底
    throw new Error(`${serviceKind} 全部供应商标识不可用: ${reasons.join('; ')}`);
  }

  private async invokeWithTimeout<T>(
    invoke: (adapter: unknown, timeoutMs?: number) => Promise<T>,
    adapter: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (!timeoutMs) return invoke(adapter);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        invoke(adapter, timeoutMs),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`供应商调用超时（${timeoutMs}ms）`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
