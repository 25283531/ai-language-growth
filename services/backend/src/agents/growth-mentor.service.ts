import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';

const reportSchema = z.object({
  strengths: z.array(z.string().trim().min(1).max(120)).max(3),
  practiceFocus: z.array(z.string().trim().min(1).max(120)).max(3),
  caregiverGuidance: z.array(z.string().trim().min(1).max(160)).max(3),
}).strict();

export type GrowthMentorReport = z.infer<typeof reportSchema>;

@Injectable()
export class GrowthMentorService {
  private readonly logger = new Logger(GrowthMentorService.name);

  constructor(
    @Inject(ModelRouterImpl) private readonly router: ModelRouterImpl,
    @Inject(AiGatewayService) private readonly gateway: AiGatewayService,
  ) {}

  async createLessonReport(input: {
    learnerId: string;
    lessonSessionId: string;
    topicId: string;
    turns: number;
    evidenceBySkill: Array<{
      skillNodeId: string;
      skillName: string;
      evidenceCount: number;
      independentSuccesses: number;
      unsuccessfulAttempts: number;
      commonErrorUnits: Array<{ unit: string; count: number }>;
    }>;
    upcomingReviews: Array<{ skillNodeId: string; intervalDays: number }>;
  }): Promise<GrowthMentorReport> {
    const fallback = deterministicReport(input.evidenceBySkill);
    if (!input.evidenceBySkill.length) return fallback;

    const decision = await this.router.route({ serviceKind: 'llm', taskRoute: 'llm.growth_report' });
    try {
      const result = await this.gateway.llm({
        promptKey: 'growth_mentor.lesson_report',
        promptVersion: 'v1',
        system: [
          '你是儿童英语成长导师，为监护人解释本次学习表现。',
          '只依据输入的结构化任务证据，不推断证据未覆盖的能力。',
          '不能宣布孩子已经掌握或退步；区分本次练习表现与长期能力。',
          '建议具体、温和、可执行，不责备、不比较、不诊断心理或学习障碍。',
          '仅输出 JSON，字段为 strengths、practiceFocus、caregiverGuidance，三者均为字符串数组，每组最多 3 项。',
        ].join(''),
        messages: [{ role: 'user', content: JSON.stringify(input) }],
        temperature: 0.2,
        maxTokens: 280,
        timeoutMs: 10000,
      }, decision);
      await this.router.recordUsage({
        id: `usage-growth-report-${input.lessonSessionId}`,
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
        serviceKind: 'llm',
        taskRoute: 'llm.growth_report',
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
      const parsed = reportSchema.safeParse(JSON.parse(content));
      return parsed.success ? parsed.data : fallback;
    } catch (error) {
      this.logger.warn(`成长导师报告回退到规则摘要: ${(error as Error).message}`);
      return fallback;
    }
  }
}

function deterministicReport(
  evidence: Array<{
    skillNodeId: string;
    skillName: string;
    independentSuccesses: number;
    unsuccessfulAttempts: number;
    commonErrorUnits: Array<{ unit: string; count: number }>;
  }>,
): GrowthMentorReport {
  const strengths = evidence
    .filter((item) => item.independentSuccesses > 0)
    .slice(0, 3)
    .map((item) => `${item.skillName || item.skillNodeId}：本次有 ${item.independentSuccesses} 次独立完成记录`);
  const focus = [...evidence]
    .sort((a, b) => b.unsuccessfulAttempts - a.unsuccessfulAttempts)
    .filter((item) => item.unsuccessfulAttempts > 0)
    .slice(0, 3)
    .map((item) => `${item.skillName || item.skillNodeId}：建议安排轻松的再次练习`);
  return {
    strengths,
    practiceFocus: focus,
    caregiverGuidance: ['鼓励孩子分享喜欢的练习部分，按兴趣安排下一次练习。'],
  };
}
