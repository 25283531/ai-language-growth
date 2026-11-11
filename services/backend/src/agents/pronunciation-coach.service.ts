import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { RoutingDecision } from '@alg/shared-contracts';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';

const correctionSchema = z.object({
  focus: z.string().min(1).max(40),
  correction: z.string().min(1).max(100),
  encouragement: z.string().min(1).max(40),
});

export interface PronunciationCoaching {
  displayText: string;
  focus: string;
  correction: string;
  encouragement: string;
}

/**
 * 发音纠正教练。
 *
 * 发音评分只回答“哪里不对”；本服务把结构化 errorUnits 交给低成本文本模型，
 * 生成一句孩子听得懂、可以直接送 TTS 的纠正引导。模型失败时回退到确定性文案，
 * 绝不因为 LLM 不可用而中断课堂。评分与掌握状态仍由规则引擎决定。
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
    lessonSessionId: string;
    targetText: string;
    score: number | null;
    errorUnits: Array<{ unit: string; kind: string; detail: string | null }>;
  }): Promise<PronunciationCoaching> {
    const fallback = deterministicCorrection(input.targetText, input.errorUnits);
    if (!input.errorUnits.length) return fallback;

    const decision: RoutingDecision = await this.router.route({
      serviceKind: 'llm',
      taskRoute: 'llm.teaching_explanation',
      escalationSignals: [],
    });
    try {
      const result = await this.gateway.llm({
        promptKey: 'pronunciation_coach.correction',
        promptVersion: 'v1',
        system: [
          '你是 6-9 岁儿童的英语发音陪练。只根据给定的目标词和音素/音节错误，给出一句温和、具体、可模仿的纠正。',
          '不要诊断、不要责备、不要说“你已经掌握”；不要扩展新知识；不要输出 Markdown。',
          '只输出 JSON：{"focus":"要练的音","correction":"一句不超过 60 个汉字的纠正引导","encouragement":"一句不超过 20 个汉字的鼓励"}。',
        ].join(''),
        messages: [{
          role: 'user',
          content: JSON.stringify({
            targetText: input.targetText,
            score: input.score,
            errors: input.errorUnits.slice(0, 4),
          }),
        }],
        temperature: 0.1,
        maxTokens: 160,
        timeoutMs: 8000,
      }, decision);
      await this.router.recordUsage({
        id: `usage-pron-coach-${input.lessonSessionId}-${Date.now()}`,
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
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
      const parsed = correctionSchema.safeParse(JSON.parse(content));
      if (!parsed.success) return fallback;
      return {
        ...parsed.data,
        displayText: `${parsed.data.correction} ${parsed.data.encouragement}`.trim(),
      };
    } catch (error) {
      this.logger.warn(`发音纠正模型回退到规则文案: ${(error as Error).message}`);
      return fallback;
    }
  }
}

function deterministicCorrection(
  targetText: string,
  errorUnits: Array<{ unit: string; kind: string }>,
): PronunciationCoaching {
  const focus = errorUnits[0]?.unit || targetText;
  return {
    focus,
    correction: `再试一次：${targetText}。先慢一点，把 ${focus} 说清楚。`,
    encouragement: '你已经很接近了。',
    displayText: `再试一次：${targetText}。先慢一点，把 ${focus} 说清楚。你已经很接近了。`,
  };
}
