/**
 * 语音与用量接口。
 *
 * POST /api/v1/speech/synthesize   合成语音（支持重复播放缓存命中）
 * POST /api/v1/speech/recognize     语音识别（ASR，不等于发音评估）
 * POST /api/v1/speech/evaluate      发音评估（与 ASR 严格分离）
 * GET  /api/v1/usage/summary        成本与用量汇总
 * GET  /api/v1/health               健康检查
 */
import { Body, Controller, Get, HttpException, Inject, Post, Query, Req } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { ModelRouterImpl } from '@alg/model-router';
import type { UsageRecord } from '@alg/shared-contracts';
import { resolveLiveServices, resolveTtsProtocol } from '@alg/ai-provider-sdk';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { SpeechQuotaService } from '../usage/speech-quota.service';
import { AuthService, extractBearerToken } from '../auth/auth.service';

/**
 * 直连 synthesize / cache/lookup 的可选课程作用域。
 * 仅接受内容身份；作用域一律由服务端 fail-closed 到 PRIVATE_DYNAMIC，
 * owner 一律取请求方 X-Learner-Id，绝不信任客户端声明的 scope / learnerId。
 */
const speechScopeSchema = z.object({
  topicId: z.string().optional(),
  contentId: z.string().optional(),
  contentVersion: z.string().optional(),
  lessonSessionId: z.string().optional(),
}).optional();

const synthesizeSchema = z.object({
  text: z.string().min(1).max(500),
  teacherSpeed: z.number().min(0.25).max(4).default(0.65),
  voiceStyle: z.enum(['gentle', 'warm', 'encouraging']).default('gentle'),
  pauseAfterSentenceMs: z.number().int().min(0).max(5000).default(1000),
  pronunciationMode: z
    .enum(['natural', 'slow_clear', 'syllable_by_syllable'])
    .default('slow_clear'),
  /** 可选课程作用域；缺省或不带时按无会话上下文 fail-closed 处理。 */
  scope: speechScopeSchema,
});

const recognizeSchema = z.object({
  audioRef: z.string().min(1),
  highQuality: z.boolean().default(false),
  /** 可选课堂会话；提供时校验归属，用于按课程归集 ASR 成本。 */
  lessonSessionId: z.string().min(1).max(100).optional(),
});

const evaluateSchema = z.object({
  audioRef: z.string().min(1),
  targetText: z.string().min(1),
  granularity: z.enum(['word', 'syllable', 'phoneme']).default('phoneme'),
  /** 可选课堂会话；提供时校验归属，用于按课程归集发音成本。 */
  lessonSessionId: z.string().min(1).max(100).optional(),
});

@Controller('api/v1/speech')
export class SpeechController {
  constructor(
    @Inject(AiGatewayService) private readonly gateway: AiGatewayService,
    @Inject(ModelRouterImpl) private readonly router: ModelRouterImpl,
    @Inject(SpeechQuotaService) private readonly quota: SpeechQuotaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Post('synthesize')
  async synthesize(@Body() body: unknown, @Req() request: Request) {
    const parsed = synthesizeSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '参数不合法', detail: parsed.error.flatten() }, 400);
    }
    // 无会话上下文时不查任何课堂会话，绝不因「派生不出 courseScope」而 400：
    // 一律 fail-closed 到 PRIVATE_DYNAMIC，用请求方 learnerId 作 owner。
    await this.assertClientReservation(request, 'tts');
    const learnerId = String(request.headers['x-learner-id'] ?? '').trim();
    // 重播请求会原样带回开课时下发的 scope；带 lessonSessionId 时必须校验归属，
    // 既用于缓存键，也用于把重播 TTS 归到对应课程主题。
    const lessonSessionId = await this.optionalLessonSessionId(
      request,
      learnerId,
      parsed.data.scope?.lessonSessionId,
    );
    const decision = await this.router.route({
      serviceKind: 'tts',
      taskRoute: 'tts.dynamic_teaching',
    });
    const result = await this.gateway.tts(
      {
        text: parsed.data.text,
        voice: {
          teacherSpeed: parsed.data.teacherSpeed,
          voiceStyle: parsed.data.voiceStyle,
          pauseAfterSentenceMs: parsed.data.pauseAfterSentenceMs,
          pronunciationMode: parsed.data.pronunciationMode,
        },
        voiceIdentity: 'teacher_default',
        cacheScope: this.privateCacheScope(parsed.data.text, learnerId, parsed.data.scope),
      },
      decision,
    );
    // 每次成功请求都留一行：缓存命中写 0 字符，保持「调用次数 = 账本行数」，
    // 但绝不把缓存命中重复算成合成字符或费用。
    await this.recordSpeechUsage({
      learnerId,
      lessonSessionId,
      serviceKind: 'tts',
      taskRoute: 'tts.dynamic_teaching',
      level: result.providerAlias.startsWith('mock_') ? 'L0' : decision.level,
      providerAlias: result.providerAlias,
      modelAlias: result.modelAlias,
      ttsCharacters: result.characters,
      latencyMs: result.latencyMs,
    });
    return result;
  }

  /**
   * 播放前只读探测服务端 TTS 缓存。
   *
   * 固定单词 / 短句 / 文章由编排器分段合成后落在服务端缓存；客户端在
   * 调用 synthesize 之前先查这里，命中即可直接下载音频，不产生任何
   * 供应商 TTS 请求。音频下载仍需要本人额度租约与学习者标识。
   */
  @Post('cache/lookup')
  async lookupCache(@Body() body: unknown, @Req() request: Request) {
    const parsed = synthesizeSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '参数不合法', detail: parsed.error.flatten() }, 400);
    }
    const learnerId = String(request.headers['x-learner-id'] ?? '').trim();
    if (!learnerId) throw new HttpException('缓存查询缺少学习者标识', 400);
    await this.auth.assertLearnerOwnership(
      extractBearerToken(request.headers.authorization, request.headers.cookie),
      learnerId,
    );
    const speech = await this.gateway.peekTtsCache({
      text: parsed.data.text,
      voice: {
        teacherSpeed: parsed.data.teacherSpeed,
        voiceStyle: parsed.data.voiceStyle,
        pauseAfterSentenceMs: parsed.data.pauseAfterSentenceMs,
        pronunciationMode: parsed.data.pronunciationMode,
      },
      voiceIdentity: 'teacher_default',
      // 与 synthesize 用同一套派生规则，保证命中同一键；owner 取本人 X-Learner-Id，
      // 网关按 owner 过滤，跨 learner 的 PRIVATE 资产一律不命中。
      cacheScope: this.privateCacheScope(parsed.data.text, learnerId, parsed.data.scope),
    });
    return { cached: Boolean(speech), speech };
  }

  @Post('recognize')
  async recognize(@Body() body: unknown, @Req() request: Request) {
    const parsed = recognizeSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '参数不合法', detail: parsed.error.flatten() }, 400);
    }
    const learnerId = await this.assertClientReservation(request, 'asr');
    const lessonSessionId = await this.optionalLessonSessionId(
      request,
      learnerId,
      parsed.data.lessonSessionId,
    );
    const decision = await this.router.route({
      serviceKind: 'asr',
      taskRoute: 'asr.free_speech',
    });
    const trace = await this.gateway.asrWithTrace(
      { audioRef: parsed.data.audioRef, highQuality: parsed.data.highQuality },
      decision,
    );
    // 直连接口按真实 pass 入账；suspect 二次识别会有两条，不与编排器路径重复。
    for (const pass of trace.passes) {
      await this.recordSpeechUsage({
        learnerId,
        lessonSessionId,
        serviceKind: 'asr',
        taskRoute: 'asr.free_speech',
        level: pass.result.providerAlias.startsWith('mock_') ? 'L0' : pass.effectiveLevel,
        providerAlias: pass.result.providerAlias,
        modelAlias: pass.result.modelAlias,
        asrSeconds: pass.result.seconds,
        latencyMs: pass.result.latencyMs,
      });
    }
    return trace.result;
  }

  @Post('evaluate')
  async evaluate(@Body() body: unknown, @Req() request: Request) {
    const parsed = evaluateSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '参数不合法', detail: parsed.error.flatten() }, 400);
    }
    const learnerId = await this.assertClientReservation(request, 'pronunciation');
    const lessonSessionId = await this.optionalLessonSessionId(
      request,
      learnerId,
      parsed.data.lessonSessionId,
    );
    const decision = await this.router.route({
      serviceKind: 'pronunciation',
      taskRoute: 'pronunciation.phoneme',
    });
    const result = await this.gateway.pronunciation(
      {
        audioRef: parsed.data.audioRef,
        targetText: parsed.data.targetText,
        granularity: parsed.data.granularity,
      },
      decision,
    );
    await this.recordSpeechUsage({
      learnerId,
      lessonSessionId,
      serviceKind: 'pronunciation',
      taskRoute: 'pronunciation.phoneme',
      level: result.providerAlias.startsWith('mock_') ? 'L0' : decision.level,
      providerAlias: result.providerAlias,
      modelAlias: result.modelAlias,
      pronunciationCalls: 1,
      latencyMs: result.latencyMs,
    });
    return result;
  }

  private async optionalLessonSessionId(
    request: Request,
    learnerId: string,
    lessonSessionId: string | undefined,
  ): Promise<string | null> {
    if (!lessonSessionId) return null;
    await this.auth.assertLessonSessionOwnership(
      extractBearerToken(request.headers.authorization, request.headers.cookie),
      learnerId,
      lessonSessionId,
    );
    return lessonSessionId;
  }

  /** 只在直连接口写账；编排器通过 gateway 调用后自行写账，二者不共用这条路径。 */
  private async recordSpeechUsage(input: {
    learnerId: string;
    lessonSessionId: string | null;
    serviceKind: 'asr' | 'tts' | 'pronunciation';
    taskRoute: string;
    level: UsageRecord['level'];
    providerAlias: string;
    modelAlias: string;
    ttsCharacters?: number;
    asrSeconds?: number;
    pronunciationCalls?: number;
    latencyMs: number;
  }): Promise<void> {
    await this.router.recordUsage({
      id: `usage-${input.serviceKind}-${randomUUID()}`,
      learnerId: input.learnerId,
      lessonSessionId: input.lessonSessionId,
      serviceKind: input.serviceKind,
      taskRoute: input.taskRoute,
      level: input.level,
      providerAlias: input.providerAlias,
      modelAlias: input.modelAlias,
      inputTokens: 0,
      outputTokens: 0,
      ttsCharacters: input.ttsCharacters ?? 0,
      asrSeconds: input.asrSeconds ?? 0,
      pronunciationCalls: input.pronunciationCalls ?? 0,
      estimatedCostCny: 0,
      latencyMs: input.latencyMs,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * 直连语音请求的缓存作用域：无会话上下文时 fail-closed 到 PRIVATE_DYNAMIC，
   * owner 用请求方 learnerId；contentVersion 缺省时以文本哈希兜底，保证
   * 不同文本不会误命中同一份音频，相同文本 + 同一 learner 必定命中同一键。
   */
  private privateCacheScope(
    text: string,
    learnerId: string,
    scope?: { topicId?: string; contentId?: string; contentVersion?: string; lessonSessionId?: string },
  ) {
    return {
      scope: 'PRIVATE_DYNAMIC' as const,
      topicId: scope?.topicId ?? '',
      contentId: scope?.contentId ?? '',
      contentVersion: scope?.contentVersion ?? createHash('sha256').update(text).digest('hex'),
      learnerId,
      ...(scope?.lessonSessionId ? { lessonSessionId: scope.lessonSessionId } : {}),
    };
  }

  private async assertClientReservation(
    request: Request,
    serviceKind: 'asr' | 'tts' | 'pronunciation',
  ): Promise<string> {
    const reservationId = String(request.headers['x-speech-quota-reservation'] ?? '').trim();
    const learnerId = String(request.headers['x-learner-id'] ?? '').trim();
    if (!reservationId || !learnerId) {
      throw new HttpException('语音请求缺少额度租约或学习者标识', 400);
    }
    await this.auth.assertLearnerOwnership(
      extractBearerToken(request.headers.authorization, request.headers.cookie),
      learnerId,
    );
    await this.quota.assertReservation({ reservationId, learnerId, serviceKind });
    return learnerId;
  }
}

@Controller('api/v1/speech/quota')
export class SpeechQuotaController {
  constructor(
    @Inject(SpeechQuotaService) private readonly quota: SpeechQuotaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get('status')
  async status(
    @Query('learnerId') learnerId: string | undefined,
    @Req() request: Request,
  ) {
    if (!learnerId) throw new HttpException('缺少 learnerId', 400);
    await this.auth.assertLearnerOwnership(
      extractBearerToken(request.headers.authorization, request.headers.cookie),
      learnerId,
    );
    return this.quota.status(learnerId);
  }

  @Post('reserve')
  async reserve(@Body() body: unknown, @Req() request: Request) {
    const parsed = z
      .object({
        learnerId: z.string().min(1),
        serviceKind: z.enum(['asr', 'tts', 'pronunciation']),
        seconds: z.number().positive().max(120),
        idempotencyKey: z.string().min(8),
        ttlSeconds: z.number().int().min(30).max(600).optional(),
      })
      .safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '额度预留参数不合法', detail: parsed.error.flatten() }, 400);
    }
    await this.auth.assertLearnerOwnership(
      extractBearerToken(request.headers.authorization, request.headers.cookie),
      parsed.data.learnerId,
    );
    return this.quota.reserve({
      learnerId: parsed.data.learnerId,
      serviceKind: parsed.data.serviceKind,
      units: parsed.data.seconds,
      idempotencyKey: parsed.data.idempotencyKey,
      ttlSeconds: parsed.data.ttlSeconds,
    });
  }

  @Post('settle')
  async settle(@Body() body: unknown, @Req() request: Request) {
    const parsed = z
      .object({ reservationId: z.string().uuid(), seconds: z.number().min(0).max(120) })
      .safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '额度结算参数不合法', detail: parsed.error.flatten() }, 400);
    }
    await this.auth.assertReservationOwnership(
      extractBearerToken(request.headers.authorization, request.headers.cookie),
      parsed.data.reservationId,
    );
    return this.quota.settle(parsed.data.reservationId, parsed.data.seconds);
  }

  @Post('release')
  async release(@Body() body: unknown, @Req() request: Request) {
    const parsed = z.object({ reservationId: z.string().uuid() }).safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '额度释放参数不合法', detail: parsed.error.flatten() }, 400);
    }
    await this.auth.assertReservationOwnership(
      extractBearerToken(request.headers.authorization, request.headers.cookie),
      parsed.data.reservationId,
    );
    return this.quota.release(parsed.data.reservationId);
  }
}

@Controller('api/v1/usage')
export class UsageController {
  constructor(@Inject(ModelRouterImpl) private readonly router: ModelRouterImpl) {}

  @Get('summary')
  async summary(@Query('learnerId') learnerId?: string, @Query('lessonSessionId') lessonSessionId?: string) {
    const summary = await this.router.usageSummary({
      ...(learnerId ? { learnerId } : {}),
      ...(lessonSessionId ? { lessonSessionId } : {}),
    });
    return {
      ...summary,
      // 有效教学成本 = 总成本 / 有效学习目标数（不是免费调用比例）
      note: '有效教学成本 = 总 API 成本 ÷ 实际完成的有效学习目标数',
      // 当前路由还未关联到可计价的模型记录。costCny=0 表示「未计价」，绝不是「免费」。
      pricingStatus: 'unpriced',
      pricingNote:
        'M1 未接入供应商价格表，costCny 恒为 0 表示未计价而非零成本；' +
        '账户资源包属于已付费的预付额度，不是免费调用，且按音色档位/模型分别抵扣；' +
        '真实费用与资源包余量以供应商控制台账单为准。',
    };
  }
}

/** 只回显 host，不回显任何路径中的敏感段，更不回显凭据。 */
function hostOnly(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

/** 只取配置里额外请求字段的键名，不回显值。 */
function extraKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  if (trimmed.startsWith('{')) {
    try {
      return Object.keys(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      return [];
    }
  }
  return trimmed
    .split(';')
    .map((pair) => pair.split(':')[0]?.trim())
    .filter((key): key is string => Boolean(key));
}

@Controller('api/v1')
export class HealthController {
  @Get('health')
  health() {
    return {
      status: 'ok',
      gatewayMode: process.env.AI_GATEWAY_MODE ?? 'mock',
      // ⚠️ M1 阈值全部未校准
      calibrationStatus: 'uncalibrated',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 脱敏的运行配置审计。
   *
   * 用途：验证「真的走 live、真的用了配置里的供应商与模型」，防止
   * 配置了却静默回落 Mock 造成假绿。**绝不回显 SecretId / SecretKey / API Key 明文**，
   * 也不回显完整 URL，只给出 host 与是否已配置的布尔标记。
   *
   * 暴露面控制：该端点会回显模型名、动作与厂商域名，属于管理端信息，
   * 不应对儿童端/公网开放。M1 原型阶段仅在非 production 环境提供；
   * 上线前必须替换为管理端 Guard，不能只靠 NODE_ENV 门槛（D-023 / 任务书第 7 章）。
   */
  @Get('config/audit')
  configAudit() {
    if (process.env.NODE_ENV === 'production') {
      throw new HttpException('端点不可用', 404);
    }
    const env = process.env;
    return {
      gatewayMode: env.AI_GATEWAY_MODE ?? 'mock',
      liveServices: resolveLiveServices(env),
      ttsProtocol: resolveTtsProtocol(env),
      providers: {
        llm: {
          host: hostOnly(env.LLM_BASE_URL),
          modelAlias: env.LLM_MODEL ?? null,
          credentialConfigured: Boolean(env.LLM_API_KEY),
          minMaxTokens: env.LLM_MIN_MAX_TOKENS ?? null,
          extraBodyKeys: extraKeys(env.LLM_EXTRA_BODY_KV ?? env.LLM_EXTRA_BODY_JSON),
          extraPolicy: env.LLM_EXTRA_POLICY ?? null,
        },
        tts: {
          host: hostOnly(env.TTS_BASE_URL),
          modelAlias: env.TTS_MODEL ?? null,
          codec: env.TTS_CODEC ?? null,
          action: env.TTS_ACTION ?? null,
          voiceConfigured: Boolean(env.TTS_VOICE),
          // 签名型协议用「ID + Key」两件套，区别于 Bearer 单键
          credentialKind: env.TTS_SECRET_ID && env.TTS_SECRET_KEY
            ? 'signed-pair'
            : env.TTS_API_KEY
              ? 'bearer'
              : 'none',
          extraBodyKeys: extraKeys(env.TTS_EXTRA_BODY_KV ?? env.TTS_EXTRA_BODY_JSON),
        },
        asr: {
          host: hostOnly(env.ASR_BASE_URL),
          modelAlias: env.ASR_MODEL ?? null,
          credentialConfigured: Boolean(env.ASR_API_KEY),
        },
        pronunciation: {
          configured: Boolean(env.PRONUNCIATION_BASE_URL),
        },
      },
    };
  }
}
