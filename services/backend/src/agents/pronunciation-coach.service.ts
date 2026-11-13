import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { RoutingDecision } from '@alg/shared-contracts';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';

const coachingSchema = z.object({
  progress: z.string().min(1).max(60),
  advice: z.string().min(1).max(60),
  encouragement: z.string().min(1).max(40),
});

export interface PronunciationCoaching {
  /** 直接显示并送 TTS 的一句话。 */
  displayText: string;
  /** 和上一次相比的进步。 */
  progress: string;
  /** 需要怎么改。 */
  advice: string;
  /** 鼓励再读一次。 */
  encouragement: string;
  /** 是否来自大模型（false 表示确定性兜底文案）。 */
  fromModel: boolean;
}

/**
 * 发音教练。
 *
 * 评分本身只回答“多少分”；本服务把这一次的分数、音素/音节错误和上一次的成绩
 * 一起交给低成本文本模型，生成三句话：比上次哪里进步了、这一次要怎么改、
 * 邀请孩子再读一遍。模型不可用时回退到确定性文案，绝不中断课堂。
 * 评分、阈值与掌握状态仍由规则引擎决定，这里只负责“说话”。
 */
@Injectable()
export class PronunciationCoachService {
  private readonly logger = new Logger(PronunciationCoachService.name);

  constructor(
    @Inject(AiGatewayService) private readonly gateway: AiGatewayService,
    @Inject(ModelRouterImpl) private readonly router: ModelRouterImpl,
  ) {}

  async createCorrection(input: {
    learnerId: string;
    lessonSessionId: string | null;
    targetText: string;
    score: number | null;
    errorUnits: Array<{ unit: string; kind: string; detail: string | null }>;
    /** 同一目标文本上一次的得分；没有上一次时为 null。 */
    previousScore?: number | null;
    /** 这是第几次尝试（从 1 开始）。 */
    attemptIndex?: number;
  }): Promise<PronunciationCoaching> {
    const fallback = deterministicCoaching(input);
    if (input.score === null || input.score === undefined) return fallback;

    const decision: RoutingDecision = await this.router.route({
      serviceKind: 'llm',
      taskRoute: 'llm.teaching_explanation',
      escalationSignals: [],
    });
    try {
      const result = await this.gateway.llm({
        promptKey: 'pronunciation_coach.comparison',
        promptVersion: 'v2',
        system: [
          '你是 6-9 岁儿童的英语发音陪练。根据目标词、本次得分、上一次得分和错误点，说三句孩子听得懂的话。',
          'progress 必须只依据分数和错误点的事实：分数变高就说进步了几分或哪个音更准了；分数没变就说这次和上次差不多、哪里还差一点；分数变低就只说这次先找感觉，不许编造进步。',
          'advice 只能给一个可以马上照做的动作，例如“把 he 拉长一点再说 llo”。',
          'encouragement 用一句话邀请孩子再读一次，不要说“你已经掌握”。',
          '不要诊断、不要责备、不要输出 Markdown 或括号注释。',
          '只输出 JSON：{"progress":"不超过40个汉字","advice":"不超过40个汉字","encouragement":"不超过20个汉字"}。',
        ].join(''),
        messages: [{
          role: 'user',
          content: JSON.stringify({
            targetText: input.targetText,
            score: input.score,
            previousScore: input.previousScore ?? null,
            attemptIndex: input.attemptIndex ?? 1,
            errors: input.errorUnits.slice(0, 4),
          }),
        }],
        temperature: 0.2,
        maxTokens: 200,
        timeoutMs: 8000,
      }, decision);
      await this.router.recordUsage({
        id: `usage-pron-coach-${input.lessonSessionId ?? 'adhoc'}-${Date.now()}`,
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId ?? null,
        serviceKind: 'llm',
        taskRoute: 'llm.teaching_explanation',
        level: result.providerAlias.startsWith('mock_') ? 'L0' : decision.level,
        providerAlias: result.providerAlias,
        modelAlias: result.modelAlias,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ttsCharacters: 0,
        asrSeconds: 0,
        pronunciationCalls: 0,
        estimatedCostCny: 0,
        latencyMs: result.latencyMs,
        createdAt: new Date().toISOString(),
      });

      const content = result.content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      const parsed = coachingSchema.safeParse(JSON.parse(content));
      if (!parsed.success) return fallback;
      return {
        ...parsed.data,
        displayText: `${parsed.data.progress} ${parsed.data.advice} ${parsed.data.encouragement}`.trim(),
        fromModel: true,
      };
    } catch (error) {
      this.logger.warn(`发音教练模型回退到规则文案: ${(error as Error).message}`);
      return fallback;
    }
  }
}

/**
 * 确定性兜底：只陈述事实（分数比较），不编造进步。
 * LLM 不可用时孩子仍然能听到“比上次怎样、现在怎么改、再读一次”。
 */
export function deterministicCoaching(input: {
  targetText: string;
  score: number | null;
  errorUnits: Array<{ unit: string; kind: string; detail: string | null }>;
  previousScore?: number | null;
}): PronunciationCoaching {
  const score = input.score ?? 0;
  const previous = input.previousScore ?? null;
  const focus = input.errorUnits[0]?.unit || input.targetText;

  let progress: string;
  if (previous === null || previous === undefined) {
    progress = `这次 ${Math.round(score)} 分。`;
  } else if (score > previous + 0.5) {
    progress = `比上次进步了 ${Math.round(score - previous)} 分，${focus} 清楚多了。`;
  } else if (Math.abs(score - previous) <= 0.5) {
    progress = `这次和上次差不多，都是 ${Math.round(score)} 分。`;
  } else {
    progress = `这次 ${Math.round(score)} 分，先别急，慢慢找感觉。`;
  }

  const advice = score >= 70
    ? `再读一遍 ${input.targetText}，把语气说得更自然一点。`
    : `先慢一点，把 ${focus} 说清楚，再连着读 ${input.targetText}。`;

  return {
    progress,
    advice,
    encouragement: '再读一次试试吧。',
    displayText: `${progress} ${advice} 再读一次试试吧。`,
    fromModel: false,
  };
}
