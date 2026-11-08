/**
 * 语音与用量接口。
 *
 * POST /api/v1/speech/synthesize   合成语音（支持重复播放缓存命中）
 * POST /api/v1/speech/recognize     语音识别（ASR，不等于发音评估）
 * POST /api/v1/speech/evaluate      发音评估（与 ASR 严格分离）
 * GET  /api/v1/usage/summary        成本与用量汇总
 * GET  /api/v1/health               健康检查
 */
import { Body, Controller, Get, HttpException, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ModelRouterImpl } from '@alg/model-router';
import { resolveLiveServices, resolveTtsProtocol } from '@alg/ai-provider-sdk';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';

const synthesizeSchema = z.object({
  text: z.string().min(1).max(500),
  teacherSpeed: z.number().min(0.25).max(4).default(0.65),
  voiceStyle: z.enum(['gentle', 'warm', 'encouraging']).default('gentle'),
  pauseAfterSentenceMs: z.number().int().min(0).max(5000).default(1000),
  pronunciationMode: z
    .enum(['natural', 'slow_clear', 'syllable_by_syllable'])
    .default('slow_clear'),
});

const recognizeSchema = z.object({
  audioRef: z.string().min(1),
  highQuality: z.boolean().default(false),
});

const evaluateSchema = z.object({
  audioRef: z.string().min(1),
  targetText: z.string().min(1),
  granularity: z.enum(['word', 'syllable', 'phoneme']).default('phoneme'),
});

@Controller('api/v1/speech')
export class SpeechController {
  constructor(
    @Inject(AiGatewayService) private readonly gateway: AiGatewayService,
    @Inject(ModelRouterImpl) private readonly router: ModelRouterImpl,
  ) {}

  @Post('synthesize')
  async synthesize(@Body() body: unknown) {
    const parsed = synthesizeSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '参数不合法', detail: parsed.error.flatten() }, 400);
    }
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
      },
      decision,
    );
    return result;
  }

  @Post('recognize')
  async recognize(@Body() body: unknown) {
    const parsed = recognizeSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '参数不合法', detail: parsed.error.flatten() }, 400);
    }
    const decision = await this.router.route({
      serviceKind: 'asr',
      taskRoute: 'asr.free_speech',
    });
    return this.gateway.asr(
      { audioRef: parsed.data.audioRef, highQuality: parsed.data.highQuality },
      decision,
    );
  }

  @Post('evaluate')
  async evaluate(@Body() body: unknown) {
    const parsed = evaluateSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '参数不合法', detail: parsed.error.flatten() }, 400);
    }
    const decision = await this.router.route({
      serviceKind: 'pronunciation',
      taskRoute: 'pronunciation.phoneme',
    });
    return this.gateway.pronunciation(
      {
        audioRef: parsed.data.audioRef,
        targetText: parsed.data.targetText,
        granularity: parsed.data.granularity,
      },
      decision,
    );
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
