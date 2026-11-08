import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_ADJUSTABLE = {
  tone: 'gentle',
  encouragement: 'balanced',
  correctionStyle: 'hint_first',
  speakingRate: 0.65,
} as const;
const TONES = ['gentle', 'lively', 'calm'] as const;
const ENCOURAGEMENT = ['light', 'balanced', 'frequent'] as const;
const CORRECTION = ['model_first', 'hint_first', 'encourage_retry'] as const;
const STYLES = ['patient_guide', 'playful_companion', 'calm_coach', 'conversation_partner'] as const;

type Adjustable = {
  tone: typeof TONES[number];
  encouragement: typeof ENCOURAGEMENT[number];
  correctionStyle: typeof CORRECTION[number];
  speakingRate: number;
};

@Injectable()
export class PersonalityEngineService {
  private readonly logger = new Logger(PersonalityEngineService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ModelRouterImpl) private readonly router: ModelRouterImpl,
    @Inject(AiGatewayService) private readonly gateway: AiGatewayService,
  ) {}

  /** Suggest a bounded profile change from lesson evidence; persist only server-validated values. */
  async adaptAfterLesson(input: {
    learnerId: string;
    lessonSessionId: string;
    evidenceBySkill: Array<{ independentSuccesses: number; unsuccessfulAttempts: number }>;
    memories: Array<{ memoryType: string; content: string }>;
  }): Promise<void> {
    const profile = await this.getOrCreateProfile(input.learnerId);
    const current = readAdjustable(profile.adjustable);
    const skillStates = await this.prisma.learner_skill_states.findMany({
      where: { learnerId: input.learnerId },
      select: { skillNodeId: true, masteryCode: true },
    });
    const failed = input.evidenceBySkill.reduce((sum, row) => sum + row.unsuccessfulAttempts, 0);
    const successes = input.evidenceBySkill.reduce((sum, row) => sum + row.independentSuccesses, 0);
    const memoryHint = input.memories.map((memory) => memory.content).slice(0, 3);
    let suggestion: Partial<Adjustable> = {};

    if (failed >= 3) suggestion = { ...suggestion, encouragement: 'frequent', correctionStyle: 'model_first', speakingRate: Math.max(0.55, current.speakingRate - 0.05) };
    else if (successes >= 3 && failed === 0) suggestion = { ...suggestion, tone: 'lively', speakingRate: Math.min(0.75, current.speakingRate + 0.03) };

    if (memoryHint.length) {
      const decision = await this.router.route({ serviceKind: 'llm', taskRoute: 'llm.personality_adjustment' });
      try {
        const result = await this.gateway.llm({
          promptKey: 'personality_engine.adjustment',
          promptVersion: 'v1',
          system: [
            '根据有限的课程证据和明确教学偏好，为教师提出温和、有限的参数建议。',
            '建议只能使用 tone: gentle|lively|calm, encouragement: light|balanced|frequent, correctionStyle: model_first|hint_first|encourage_retry, speakingRate: 0.55至0.75。',
            '不得改动固定人格、安全原则或教师身份，不诊断儿童，不推断情绪。只输出 JSON 对象。',
          ].join(''),
          messages: [{ role: 'user', content: JSON.stringify({ current, evidenceBySkill: input.evidenceBySkill, teachingPreferences: memoryHint, deterministicSuggestion: suggestion }) }],
          temperature: 0,
          maxTokens: 120,
          timeoutMs: 8000,
        }, decision);
        await this.router.recordUsage({
          id: `usage-personality-adjustment-${input.lessonSessionId}`,
          learnerId: input.learnerId,
          lessonSessionId: input.lessonSessionId,
          serviceKind: 'llm',
          taskRoute: 'llm.personality_adjustment',
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
        suggestion = { ...suggestion, ...parseSuggestion(result.content) };
      } catch (error) {
        this.logger.warn(`人格调整建议回退到规则: ${(error as Error).message}`);
      }
    }

    const next = validateSuggestion(current, suggestion);
    const observedStage = growthStageOf(skillStates, input.evidenceBySkill);
    // 成长阶段只前进不倒退：它反映已验证的语言能力，而不是“完成了几节课”。
    const nextStage = Math.max(profile.stage, observedStage);
    const nextStyle = styleForStage(nextStage, next.tone);
    if (JSON.stringify(current) === JSON.stringify(next) &&
      profile.stage === nextStage &&
      profile.style === nextStyle) return;
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.teacher_profiles.update({
        where: { id: profile.id },
        data: { adjustable: next, style: nextStyle, stage: nextStage, version: { increment: 1 } },
      });
      await tx.persona_history.create({
        data: {
          teacherProfileId: profile.id,
          learnerId: input.learnerId,
          changeContent: JSON.stringify({ before: { adjustable: current, style: profile.style }, after: { adjustable: next, style: nextStyle }, sourceSessionId: input.lessonSessionId }),
          reason: '根据结课结构化学习证据和已确认教学偏好进行受控适配',
          version: updated.version,
        },
      });
    });
  }

  private async getOrCreateProfile(learnerId: string) {
    const existing = await this.prisma.teacher_profiles.findUnique({ where: { learnerId } });
    if (existing) return existing;
    const template = await this.prisma.teacher_profiles.findFirst({ where: { learnerId: null }, orderBy: { createdAt: 'asc' } });
    return this.prisma.teacher_profiles.create({
      data: {
        name: template?.name ?? '英语成长老师',
        coreTraits: template?.coreTraits ?? { childSafety: true, honestAiIdentity: true, noShaming: true, noPressure: true, ageAppropriate: true },
        adjustable: template?.adjustable ?? DEFAULT_ADJUSTABLE,
        style: template?.style ?? 'patient_guide',
        learnerId,
      },
    }).catch(async (error: unknown) => {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      return this.prisma.teacher_profiles.findUniqueOrThrow({ where: { learnerId } });
    });
  }
}

function growthStageOf(
  states: Array<{ skillNodeId: string; masteryCode: number }>,
  evidenceBySkill: Array<{ independentSuccesses: number; unsuccessfulAttempts: number }>,
): number {
  const hasConversationMastery = ['LA.SPEAK.simple_sentences', 'LA.COMM.dialogue']
    .every((skillNodeId) => states.some((state) => state.skillNodeId === skillNodeId && state.masteryCode >= 3));
  if (hasConversationMastery) return 2;
  const hasVerifiedProgress = states.some((state) => state.masteryCode >= 2) ||
    evidenceBySkill.some((item) => item.independentSuccesses > 0);
  return hasVerifiedProgress ? 1 : 0;
}

function styleForStage(stage: number, tone: Adjustable['tone']): string {
  if (stage >= 2) return 'conversation_partner';
  if (stage === 1) return tone === 'calm' ? 'calm_coach' : 'playful_companion';
  return 'patient_guide';
}

function readAdjustable(value: unknown): Adjustable {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return validateSuggestion(DEFAULT_ADJUSTABLE, object);
}

function parseSuggestion(content: string): Partial<Adjustable> {
  try {
    const value = JSON.parse(content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()) as Record<string, unknown>;
    return {
      ...(TONES.includes(value.tone as typeof TONES[number]) ? { tone: value.tone as Adjustable['tone'] } : {}),
      ...(ENCOURAGEMENT.includes(value.encouragement as typeof ENCOURAGEMENT[number]) ? { encouragement: value.encouragement as Adjustable['encouragement'] } : {}),
      ...(CORRECTION.includes(value.correctionStyle as typeof CORRECTION[number]) ? { correctionStyle: value.correctionStyle as Adjustable['correctionStyle'] } : {}),
      ...(typeof value.speakingRate === 'number' ? { speakingRate: value.speakingRate } : {}),
    };
  } catch {
    return {};
  }
}

function validateSuggestion(current: Adjustable, suggestion: Partial<Adjustable>): Adjustable {
  const speakingRate = typeof suggestion.speakingRate === 'number' && Number.isFinite(suggestion.speakingRate)
    ? Math.max(0.55, Math.min(0.75, suggestion.speakingRate))
    : current.speakingRate;
  return {
    tone: TONES.includes(suggestion.tone as Adjustable['tone']) ? suggestion.tone! : current.tone,
    encouragement: ENCOURAGEMENT.includes(suggestion.encouragement as Adjustable['encouragement']) ? suggestion.encouragement! : current.encouragement,
    correctionStyle: CORRECTION.includes(suggestion.correctionStyle as Adjustable['correctionStyle']) ? suggestion.correctionStyle! : current.correctionStyle,
    speakingRate,
  };
}
