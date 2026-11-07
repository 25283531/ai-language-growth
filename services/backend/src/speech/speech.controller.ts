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
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';

const synthesizeSchema = z.object({
  text: z.string().min(1),
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
      // M1 只接了调用量，没有接价格表。costCny=0 表示「未计价」，绝不是「免费」。
      pricingStatus: 'unpriced',
      pricingNote:
        'M1 未接入供应商价格表，costCny 恒为 0 表示未计价而非零成本；真实费用以供应商控制台账单为准。',
    };
  }
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
}
