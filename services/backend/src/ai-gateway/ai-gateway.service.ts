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
import { access, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
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
  TtsCacheScope,
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

/** ASR 一次逻辑调用中实际发生的 pass 轨迹（suspect 时可能包含第二次高质量识别）。 */
export interface AsrTrace {
  result: AsrResponse;
  passes: GatewayCallResult<AsrResponse>[];
}

/** 缓存键版本。升位即让旧格式索引整体逻辑失效，无需物理删除。 */
const TTS_KEY_VERSION = 'tts-v4-natural-voice';
/** PRIVATE_DYNAMIC 资产的短 TTL（毫秒），到期后索引与音频都视为 miss。 */
const PRIVATE_TTS_TTL_MS = 24 * 60 * 60 * 1000;

type TtsCacheScopeName = NonNullable<TtsCacheScope['scope']>;

/** 归一化后的完整缓存作用域（字段已补齐、scope 已解析）。 */
interface ResolvedTtsCacheScope {
  scope: TtsCacheScopeName;
  topicId: string;
  contentId: string;
  contentVersion: string;
  learnerId?: string;
  lessonSessionId?: string;
  providerModelFamily?: string;
}

/**
 * 归一化后的 TTS 请求：voice / voiceIdentity / cacheScope 的默认值都已补齐。
 * 与 TtsRequest 求交保证它仍可原样传给供应商适配器。
 */
type NormalizedTtsRequest = TtsRequest & {
  voice: {
    teacherSpeed: number;
    voiceStyle: string;
    pauseAfterSentenceMs: number;
    pronunciationMode: string;
  };
  voiceIdentity: string;
  cacheScope: ResolvedTtsCacheScope;
};

/** 写入缓存索引 / media_assets 的归属与版本身份。 */
interface TtsScopeIdentity {
  keyVersion: string;
  scope: TtsCacheScopeName;
  topicId: string;
  contentId: string;
  contentVersion: string;
  ownerLearnerId: string | null;
  expiresAt: string | null;
  audioSha256: string | null;
  textHash: string;
}

/** 内存缓存条目；与磁盘索引字段保持一致以便相互回填。 */
interface TtsCacheEntry extends TtsScopeIdentity {
  audioRef: string;
  characters: number;
  text: string;
  teacherSpeed: number;
  voiceIdentity: string;
  outcome: GatewayCallResult<TtsResponse>;
}

/**
 * 语速量化 —— 课程级跨用户复用的前置条件（主理人拍板）。
 *
 * teacherSpeed 由 learner.speakingRate × 6 个 method 因子算出，是连续值；
 * 若直接进缓存键，两个学习者几乎不可能落在同一数值上，「同一课程、不同用户
 * 复用」就永远命中不了。按 0.05 步长归一化到有限档位并 clamp 到 [0.25, 1.0]
 * （0.47→0.45、0.62→0.60、0.65→0.65），同一量化档位的请求即可共享同一份
 * 已合成的音频。细粒度的个性化差异不再触发重新合成（那会破坏复用），只在需要
 * 时由客户端 playbackRate 微调；量化值同时用于 TTS 请求、缓存键与对外返回的
 * speech.teacherSpeed，保证三者一致。
 */
export function quantizeTeacherSpeed(raw: number): number {
  if (!Number.isFinite(raw)) return 0.65;
  const clamped = Math.min(1.0, Math.max(0.25, raw));
  return Number((Math.round(clamped / 0.05) * 0.05).toFixed(2));
}

@Injectable()
export class AiGatewayService implements AiGateway, OnModuleInit {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly registry: AdapterRegistry;
  /** TTS 音频缓存：结构化课程级缓存键 → 音频引用与归属身份。 */
  private readonly ttsCache = new Map<string, TtsCacheEntry>();
  /** Coalesce simultaneous requests for the same utterance within this process. */
  private readonly ttsInFlight = new Map<string, Promise<GatewayCallResult<TtsResponse>>>();
  private readonly providerTimeouts = new Map<string, number>();
  /** TTS 成本可观测指标；只在进程内累计，重启归零。 */
  private ttsRequests = 0;
  private ttsCacheHits = 0;
  private ttsCacheMisses = 0;
  private ttsCoalesced = 0;
  private ttsCharactersSynthesized = 0;
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
    const eligible: RuntimeProviderConfig[] = [];
    if ((process.env.AI_GATEWAY_MODE ?? 'mock') === 'live') {
      for (const config of configs) {
        if (await this.providerConfigs.hasPassingBenchmark(config.serviceKind, config.modelAlias, config.id)) {
          eligible.push(config);
        } else {
          this.logger.warn(`生产模式已跳过未通过 Benchmark 的模型：${config.serviceKind}/${config.id}`);
        }
      }
    } else {
      eligible.push(...configs);
    }
    const enabled: RuntimeProviderConfig[] = [];
    if (eligible.length) {
      for (const config of eligible) {
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
    const normalizedRequest = this.normalizeTtsRequest(request);
    const cacheKey = this.ttsCacheKey(normalizedRequest);
    this.ttsRequests += 1;
    const pending = this.ttsInFlight.get(cacheKey);
    if (pending) {
      this.ttsCoalesced += 1;
      return this.cachedTtsOutcome(await pending);
    }
    const work = this.resolveTts(normalizedRequest, decision, cacheKey);
    this.ttsInFlight.set(cacheKey, work);
    try { return await work; }
    finally { this.ttsInFlight.delete(cacheKey); }
  }

  private cachedTtsOutcome(outcome: GatewayCallResult<TtsResponse>): GatewayCallResult<TtsResponse> {
    return { ...outcome, reasons: [...outcome.reasons], latencyMs: 0,
      result: { ...outcome.result, cached: true, characters: 0, latencyMs: 0 } };
  }

  private async resolveTts(
    normalizedRequest: NormalizedTtsRequest,
    decision: RoutingDecision,
    cacheKey: string,
  ): Promise<GatewayCallResult<TtsResponse>> {
    // —— 缓存命中：反复播放不重新消耗 TTS ——
    const cached = await this.findTtsCache(cacheKey, normalizedRequest);
    if (cached) {
      this.ttsCacheHits += 1;
      return this.cachedTtsOutcome(cached.outcome);
    }
    this.ttsCacheMisses += 1;

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
    if (!outcome.result.cached) this.ttsCharactersSynthesized += outcome.result.characters || 0;

    // 只要拿到可用音频就缓存：降级到兜底适配器同样是有效音频，
    // 若因 degraded 而不缓存，Mock 模式下重复播放会永远重新计费。
    // 不可播放的 mock:// 引用只在内存复用，不会写入持久索引。
    if (outcome.result.audioRef && !outcome.result.cached) {
      const audioSha256 = await this.audioSha256(outcome.result.audioRef);
      const identity = this.ttsScopeIdentity(normalizedRequest, audioSha256);
      this.ttsCache.set(cacheKey, {
        audioRef: outcome.result.audioRef,
        characters: outcome.result.characters,
        text: normalizedRequest.text,
        teacherSpeed: normalizedRequest.voice.teacherSpeed,
        voiceIdentity: normalizedRequest.voiceIdentity,
        keyVersion: identity.keyVersion,
        scope: identity.scope,
        topicId: identity.topicId,
        contentId: identity.contentId,
        contentVersion: identity.contentVersion,
        ownerLearnerId: identity.ownerLearnerId,
        expiresAt: identity.expiresAt,
        audioSha256: identity.audioSha256,
        textHash: identity.textHash,
        outcome: { ...outcome, result: { ...outcome.result } },
      });
      if (this.ttsCache.size > 1000) this.ttsCache.delete(this.ttsCache.keys().next().value!);
      await this.storePersistentTtsCache(cacheKey, normalizedRequest, outcome, identity).catch((error) =>
        this.logger.warn(`TTS 持久化缓存索引写入失败：${(error as Error).message}`),
      );
    }
    return outcome;
  }

  /**
   * 只读缓存探测：供「播放前先检查服务端缓存资源」使用。
   * 绝不触发供应商 TTS；命中时返回与 synthesize 相同的音频描述。
   *
   * PRIVATE_DYNAMIC 资产按 owner 过滤：请求必须带请求方 learnerId，且只能命中
   * 归属于该 learner 的资产（键中已含 learnerId，这里再显式校验归属，双保险）。
   */
  async peekTtsCache(request: TtsRequest): Promise<TtsResponse | null> {
    const normalized = this.normalizeTtsRequest(request);
    const hit = await this.findTtsCache(this.ttsCacheKey(normalized), normalized);
    if (!hit) return null;
    // 显式 owner 过滤：PRIVATE 资产只能命中归属同一 learner 的请求（无 owner 时同为 null）。
    // PRIVATE 键本身已含 learnerId，这里是第二道防线。
    if (hit.scope === 'PRIVATE_DYNAMIC'
      && (hit.ownerLearnerId ?? null) !== (normalized.cacheScope.learnerId ?? null)) {
      return null;
    }
    return { ...hit.outcome.result, cached: true, characters: 0, latencyMs: 0 };
  }

  private normalizeTtsRequest(request: TtsRequest): NormalizedTtsRequest {
    const s = request.cacheScope;
    return {
      ...request,
      voice: {
        // 量化语速：有限档位才能让不同学习者命中同一课程级缓存（见 quantizeTeacherSpeed）。
        teacherSpeed: quantizeTeacherSpeed(request.voice.teacherSpeed ?? 0.65),
        voiceStyle: request.voice.voiceStyle ?? 'gentle',
        pauseAfterSentenceMs: request.voice.pauseAfterSentenceMs ?? 1000,
        pronunciationMode: request.voice.pronunciationMode ?? 'slow_clear',
      },
      voiceIdentity: request.voiceIdentity ?? 'teacher_default',
      cacheScope: {
        scope: s?.scope ?? 'PRIVATE_DYNAMIC',
        topicId: s?.topicId ?? '',
        contentId: s?.contentId ?? '',
        contentVersion: s?.contentVersion ?? '',
        ...(s?.learnerId ? { learnerId: s.learnerId } : {}),
        ...(s?.lessonSessionId ? { lessonSessionId: s.lessonSessionId } : {}),
        ...(s?.providerModelFamily ? { providerModelFamily: s.providerModelFamily } : {}),
      },
    } as NormalizedTtsRequest;
  }

  private async findTtsCache(cacheKey: string, request: NormalizedTtsRequest) {
    let cached = this.ttsCache.get(cacheKey);
    if (cached) {
      // 身份/归属校验：keyVersion、scope、topicId、contentVersion、owner、textHash
      // 任一不匹配都视为 miss，不允许旧形状或跨 learner 的 PRIVATE 资产命中。
      if (!this.ttsIdentityMatches(cached, request) || (cached.expiresAt !== null && Date.parse(cached.expiresAt) <= Date.now())) {
        cached = undefined;
      }
    }
    if (cached) {
      // 本地媒体引用必须指向仍存在的文件；mock/provider-hosted 引用无需本地文件。
      if (cached.audioRef.startsWith('/api/v1/media/audio/')) {
        const audioFile = cached.audioRef.split('/').pop();
        try {
          if (!audioFile || audioFile.includes('..')) throw new Error('invalid audio reference');
          await access(join(resolveAudioDir(), audioFile));
          if (cached.audioSha256 && cached.audioSha256 !== await this.audioSha256(cached.audioRef)) {
            throw new Error('audio bytes changed');
          }
        } catch {
          this.ttsCache.delete(cacheKey);
          cached = undefined;
        }
      }
    }
    cached ??= await this.loadPersistentTtsCache(cacheKey, request);
    return cached;
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
   * 课程级 TTS 缓存键（结构化 + sha256，供索引用）。
   *
   * 键 = (keyVersion, scope, topicId, contentId, contentVersion, voiceParamsHash,
   *       voiceProfileVersion, modelFamily, textHash)：
   *  - voiceParamsHash 只取影响声学的参数（量化后的 teacherSpeed / voiceStyle /
   *    pronunciationMode），绝不含 pauseAfterSentenceMs —— 它不写入任何请求体、
   *    不改变声学结果，拼进键只会制造重复计费与 audioRef 漂移。
   *  - textHash 保证「文本一定进键」：PUBLIC 分支 contentVersion 是发布内容哈希，
   *    已隐含文本；PRIVATE 分支文本是动态的，必须显式加文本指纹，否则同一课堂
   *    不同回合（相同 contentVersion + learnerId + 音色档位）会互相串音。
   *  - scope 默认 fail-closed 到 PRIVATE_DYNAMIC。
   *  - PUBLIC_CURRICULUM / PRONUNCIATION 绝不带 learnerId / lessonSessionId，
   *    否则会破坏「同一课程、不同用户、不同时间」复用；PRIVATE_DYNAMIC 必带二者。
   *  - 键中绝不含 userId、timestamp、idempotencyKey。
   */
  private ttsCacheKey(request: NormalizedTtsRequest): string {
    const s = request.cacheScope;
    const voiceParamsHash = createHash('sha256').update(JSON.stringify([
      request.voice.teacherSpeed,
      request.voice.voiceStyle,
      request.voice.pronunciationMode,
    ])).digest('hex');
    const keyMaterial = {
      keyVersion: TTS_KEY_VERSION,
      scope: s.scope,
      topicId: s.topicId,
      contentId: s.contentId,
      contentVersion: s.contentVersion,
      voiceParamsHash,
      voiceProfileVersion: process.env.TTS_VOICE_PROFILE_VERSION ?? '1',
      modelFamily: s.providerModelFamily ?? '',
      textHash: createHash('sha256').update(request.text).digest('hex'),
      ...(s.scope === 'PRIVATE_DYNAMIC'
        ? { learnerId: s.learnerId ?? '', lessonSessionId: s.lessonSessionId ?? '' }
        : {}),
    };
    return createHash('sha256').update(JSON.stringify(keyMaterial)).digest('hex');
  }

  /** 音频文件字节的 sha256；provider-hosted / mock 引用没有本地字节，返回 null。 */
  private async audioSha256(audioRef: string): Promise<string | null> {
    const match = /^\/api\/v1\/media\/audio\/([a-f0-9]{24}\.(?:mp3|wav|m4a))$/i.exec(audioRef);
    if (!match) return null;
    try {
      const bytes = await readFile(join(resolveAudioDir(), match[1]!));
      return createHash('sha256').update(bytes).digest('hex');
    } catch {
      return null;
    }
  }

  /** 写入索引 / media_assets 的归属身份（PUBLIC 无 owner 无 TTL；PRIVATE 短 TTL）。 */
  private ttsScopeIdentity(request: NormalizedTtsRequest, audioSha256: string | null): TtsScopeIdentity {
    const s = request.cacheScope;
    const isPrivate = s.scope === 'PRIVATE_DYNAMIC';
    return {
      keyVersion: TTS_KEY_VERSION,
      scope: s.scope,
      topicId: s.topicId,
      contentId: s.contentId,
      contentVersion: s.contentVersion,
      ownerLearnerId: isPrivate ? (s.learnerId ?? null) : null,
      expiresAt: isPrivate ? new Date(Date.now() + PRIVATE_TTS_TTL_MS).toISOString() : null,
      audioSha256,
      textHash: createHash('sha256').update(request.text).digest('hex'),
    };
  }

  /** 缓存条目的身份/归属/有效期校验；旧格式索引（无 keyVersion）一律不匹配。 */
  private ttsIdentityMatches(entry: Partial<TtsScopeIdentity>, request: NormalizedTtsRequest): boolean {
    const expected = this.ttsScopeIdentity(request, null);
    return entry.keyVersion === expected.keyVersion
      && entry.scope === expected.scope
      && entry.topicId === expected.topicId
      && entry.contentId === expected.contentId
      && entry.contentVersion === expected.contentVersion
      && (entry.ownerLearnerId ?? null) === expected.ownerLearnerId
      && entry.textHash === expected.textHash
      && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now());
  }

  private async loadPersistentTtsCache(
    cacheKey: string,
    request: NormalizedTtsRequest,
  ): Promise<TtsCacheEntry | undefined> {
    const file = this.ttsCacheIndexPath(cacheKey);
    try {
      const teacherSpeed = request.voice.teacherSpeed;
      const voiceIdentity = request.voiceIdentity;
      const entry = JSON.parse(await readFile(file, 'utf8')) as Partial<TtsScopeIdentity> & {
        audioRef?: unknown;
        characters?: unknown;
        teacherSpeed?: unknown;
        voiceIdentity?: unknown;
        outcome?: GatewayCallResult<TtsResponse>;
      };
      // 旧格式索引或 keyVersion/scope/topicId/contentVersion/owner/textHash 不匹配 → miss。
      if (!this.ttsIdentityMatches(entry, request)) return undefined;
      if (typeof entry.audioRef !== 'string' || !/^\/api\/v1\/media\/audio\/[a-f0-9]{24}\.(mp3|wav|m4a)$/i.test(entry.audioRef)) return undefined;
      if (Number(entry.teacherSpeed) !== teacherSpeed || entry.voiceIdentity !== voiceIdentity) return undefined;
      if (!entry.outcome?.result || entry.outcome.result.audioRef !== entry.audioRef || typeof entry.outcome.result.providerAlias !== 'string' || entry.outcome.result.providerAlias.startsWith('mock')) return undefined;
      const audioFile = entry.audioRef.split('/').pop();
      if (!audioFile || audioFile.includes('..')) return undefined;
      await access(join(resolveAudioDir(), audioFile));
      // 音频字节 sha256 校验：文件被替换 / 截断 / 乱码时拒绝对外下发。
      if (entry.audioSha256 && entry.audioSha256 !== await this.audioSha256(entry.audioRef)) return undefined;
      const cached: TtsCacheEntry = {
        audioRef: entry.audioRef,
        characters: typeof entry.characters === 'number' ? entry.characters : 0,
        text: request.text,
        teacherSpeed,
        voiceIdentity,
        keyVersion: TTS_KEY_VERSION,
        scope: entry.scope!,
        topicId: entry.topicId!,
        contentId: entry.contentId!,
        contentVersion: entry.contentVersion!,
        ownerLearnerId: entry.ownerLearnerId ?? null,
        expiresAt: entry.expiresAt ?? null,
        audioSha256: entry.audioSha256 ?? null,
        textHash: entry.textHash!,
        outcome: entry.outcome,
      };
      this.ttsCache.set(cacheKey, cached);
      if (this.ttsCache.size > 1000) this.ttsCache.delete(this.ttsCache.keys().next().value!);
      return cached;
    } catch {
      return undefined;
    }
  }

  private async storePersistentTtsCache(
    cacheKey: string,
    request: NormalizedTtsRequest,
    outcome: GatewayCallResult<TtsResponse>,
    identity: TtsScopeIdentity,
  ): Promise<void> {
    const result = outcome.result;
    if (!/^\/api\/v1\/media\/audio\/[a-f0-9]{24}\.(mp3|wav|m4a)$/i.test(result.audioRef)) return;
    const directory = resolveAudioDir();
    await access(join(directory, result.audioRef.split('/').pop()!));
    await mkdir(directory, { recursive: true });
    const target = this.ttsCacheIndexPath(cacheKey);
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      // 只读索引：绝不保存明文教学内容（仅文本摘要），并写入身份/归属/有效期/音频字节摘要。
      await writeFile(temporary, JSON.stringify({
        ...identity,
        audioRef: result.audioRef, characters: result.characters,
        teacherSpeed: request.voice.teacherSpeed, voiceIdentity: request.voiceIdentity,
        outcome,
      }), 'utf8');
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => undefined); }
    const audioFile = result.audioRef.split('/').pop();
    if (audioFile && !audioFile.includes('..')) {
      const extension = audioFile.split('.').pop() || null;
      const checksum = audioFile.split('.')[0] || null;
      // scope / ownerLearnerId / expiresAt 由并行 worker 加到 media_assets。
      // 用变量承接 data 可绕开 Prisma 生成类型对新增列的 excess-property 检查，
      // 同时保留运行时写入；列尚未迁移时由 .catch 兜底，不影响缓存命中。
      const ownership = {
        scope: identity.scope,
        ownerLearnerId: identity.ownerLearnerId,
        expiresAt: identity.expiresAt ? new Date(identity.expiresAt) : null,
      };
      const createData = {
        id: `tts-${checksum}`,
        kind: 'audio',
        ref: result.audioRef,
        voiceIdentity: request.voiceIdentity,
        teacherSpeed: request.voice.teacherSpeed,
        checksum,
        cacheExtension: extension,
        cacheStatus: 'cached',
        sourceProvider: result.providerAlias,
        ...ownership,
      };
      const updateData = {
        ref: result.audioRef,
        voiceIdentity: request.voiceIdentity,
        teacherSpeed: request.voice.teacherSpeed,
        checksum,
        cacheExtension: extension,
        cacheStatus: 'cached',
        sourceProvider: result.providerAlias,
        ...ownership,
      };
      await this.prisma.media_assets.upsert({
        where: { id: `tts-${checksum}` },
        create: createData,
        update: updateData,
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
    return (await this.asrWithTrace(request, decision)).result;
  }

  /**
   * 与 asr 相同，但额外返回实际发生的 pass，供直连接口按真实调用次数入账。
   *
   * suspect 触发第二次高质量识别时，两次 pass 都真实消耗了供应商额度，
   * 不能只按最终结果记一条。编排器仍使用 asr()，保持原有单条逻辑入账路径。
   */
  async asrWithTrace(request: AsrRequest, decision: RoutingDecision): Promise<AsrTrace> {
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
      return { result: first.result, passes: [first] };
    }
    // Router 判定 L0（预算熔断）时不得为了「二次高质量识别」把请求升级到付费供应商。
    if (decision.level === 'L0') {
      return { result: first.result, passes: [first] };
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

    const passes = [first, upgraded];
    return {
      result: upgraded.result.transcript ? upgraded.result : first.result,
      passes,
    };
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
      // 与 ASR/TTS 一致：Router 判 L0 时仍可用零成本 Mock 发音评估，
      // 不能因缺少兜底别名把本地 mock 链路打成 500。
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
   *
   * 预算熔断（Router 返回 level = 'L0'）时本函数只允许执行零成本路径：
   * 本地规则 / 缓存 / Mock 兜底适配器。绝对不允许回落任何付费供应商。
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

    // ————— Router 已经判定 L0：本次调用必须零成本 —————
    // L0 只会在「预算熔断」或「全部供应商失败」时出现。此时唯一正确的执行方式
    // 是本地规则 + 缓存 + 免费兜底适配器。此前 Gateway 会用自己的
    // configured_* / mainLlmCandidates 覆盖这个决定，等于把预算熔断绕过去了
    // （违反铁律一：Gateway 只按 Router 的决策执行，不自己选模型）。
    const localOnly = decision.level === 'L0';
    if (localOnly) {
      reasons.push(`local_only_${decision.strategy}`);
      this.logger.warn(
        `${serviceKind} 按 Router 的 L0 决策执行本地兜底（${decision.strategy}），不调用任何付费供应商`,
      );
    }

    const candidates = localOnly
      ? []
      : candidateOverride !== undefined
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

    // 第二候选：兜底适配器（Mock / 缓存），保证课程不中断。
    // L0 时即使调用方没给 lastResortAlias，也只用 Mock（免费），
    // 不允许回落到任何付费适配器。
    const fallbackAlias = lastResortAlias ?? (localOnly ? MOCK_PROVIDER_ALIASES[serviceKind] : undefined);
    const fallback = fallbackAlias ? this.registry.get(serviceKind, fallbackAlias) : undefined;
    if (fallback) {
      try {
        const result = await invoke(fallback);
        return {
          result,
          degraded: true,
          reasons: [...reasons, `fallback_to_${fallbackAlias}`],
          effectiveLevel: 'L0',
          providerAlias: fallbackAlias!,
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

  /** 缓存统计，供管理端与成本看板展示；命中率包含 single-flight 合并请求。 */
  ttsCacheStats(): {
    entries: number;
    hitCharactersSaved: number;
    requests: number;
    cacheHits: number;
    coalesced: number;
    misses: number;
    hitRate: number;
    charactersSynthesized: number;
  } {
    let saved = 0;
    for (const v of this.ttsCache.values()) {
      saved += v.characters;
    }
    const avoided = this.ttsCacheHits + this.ttsCoalesced;
    return {
      entries: this.ttsCache.size,
      hitCharactersSaved: saved,
      requests: this.ttsRequests,
      cacheHits: this.ttsCacheHits,
      coalesced: this.ttsCoalesced,
      misses: this.ttsCacheMisses,
      hitRate: this.ttsRequests ? Number((avoided / this.ttsRequests).toFixed(4)) : 0,
      charactersSynthesized: this.ttsCharactersSynthesized,
    };
  }
}
