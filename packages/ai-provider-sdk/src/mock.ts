/**
 * Mock Provider 适配器。
 *
 * M1 阶段默认实现：不产生外部调用与费用，但完整走通
 * 「教 → 听 → 评估 → 调整 → 记录」五动作闭环与成本账本（D-018）。
 *
 * Mock 的行为不是「随便返回」：
 *  - LLM 返回结构化 JSON，符合契约要求的 schema，便于校验 schema 合规性信号；
 *  - 发音评估按目标词的真实音节结构产出分单元得分，便于验证
 *    「只练出错的部分」的教学逻辑（D-010）；
 *  - ASR 对空输入返回空结果并标记 suspect，用于验证双层识别策略（D-013）。
 */
import type {
  AsrRequest,
  AsrResponse,
  LlmRequest,
  LlmResponse,
  PronunciationRequest,
  PronunciationResponse,
  TtsRequest,
  TtsResponse,
} from '@alg/shared-contracts';
import type {
  AsrAdapter,
  LlmAdapter,
  PronunciationAdapter,
  ProviderCapabilities,
  ProviderPricing,
  TtsAdapter,
} from './protocol';

/** 词 → 音节切分表。用于 Mock 发音评估产出分单元结果。 */
const SYLLABLES: Record<string, string[]> = {
  hello: ['he', 'llo'],
  bye: ['bye'],
  'thank you': ['thank', 'you'],
  sorry: ['sor', 'ry'],
  goodbye: ['good', 'bye'],
  'good morning': ['good', 'mor', 'ning'],
  apple: ['ap', 'ple'],
  banana: ['ba', 'na', 'na'],
  ball: ['ball'],
  book: ['book'],
  cup: ['cup'],
  cat: ['cat'],
  dog: ['dog'],
  red: ['red'],
  blue: ['blue'],
  green: ['green'],
  like: ['like'],
  this: ['this'],
  'i am': ['i', 'am'],
  'my name is': ['my', 'name', 'is'],
  name: ['name'],
  my: ['my'],
  am: ['am'],
  is: ['is'],
  boy: ['boy'],
  girl: ['girl'],
  nine: ['nine'],
  friend: ['friend'],
  nice: ['nice'],
  meet: ['meet'],
  i: ['i'],
  please: ['please'],
  yes: ['yes'],
  no: ['no'],
  hi: ['hi'],
};

/** 音节切分。未知词按音素数兜底。 */
export function splitSyllables(word: string): string[] {
  const key = word.toLowerCase().trim();
  if (SYLLABLES[key]) return SYLLABLES[key];
  return [key];
}

/** Mock 定价。全部为 0，表示不产生真实成本，但仍写入用量账本。 */
export const MOCK_PRICING: ProviderPricing = {
  checkedAt: '2026-11-07',
};

/** Mock LLM 适配器。 */
export class MockLlmAdapter implements LlmAdapter {
  readonly alias = 'mock_llm';
  readonly serviceKind = 'llm' as const;
  readonly capabilities: ProviderCapabilities = {
    supportsStructuredOutput: true,
    supportsStreaming: false,
  };
  readonly pricing: ProviderPricing = MOCK_PRICING;

  /**
   * Mock 的确定性策略：
   *  - 若请求带 responseSchema，返回符合该 schema 形态的 JSON；
   *  - 否则返回一段温和的鼓励式教学语句。
   * 不使用随机数，保证测试可重复。
   */
  async invoke(request: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    let content: string;
    if (request.responseSchema) {
      content = JSON.stringify(buildMockStructuredOutput(request.responseSchema, lastUser));
    } else {
      content = buildMockTeacherUtterance(lastUser);
    }

    const inputTokens = estimateTokens(request.system) + estimateTokens(lastUser);
    const outputTokens = estimateTokens(content);

    return {
      content,
      schemaValid: request.responseSchema ? isJsonParsable(content) : true,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: 'mock',
    };
  }
}

/**
 * 按 schema 的属性名构造一个合理的 mock 结构化输出。
 * 只覆盖 M1 实际用到的字段，未覆盖字段给空值。
 */
function buildMockStructuredOutput(schema: unknown, context: string): Record<string, unknown> {
  const props = extractSchemaProperties(schema);
  const out: Record<string, unknown> = {};

  for (const [key, spec] of Object.entries(props)) {
    out[key] = mockValueFor(spec, key, context);
  }
  return out;
}

function mockValueFor(spec: JsonSchemaSpec, key: string, context: string): unknown {
  switch (spec.type) {
    case 'string':
      if (/encourag|affirm|reply|utterance|teacher/i.test(key)) {
        return `Very good! ${context.slice(0, 40)}`.trim();
      }
      if (/reason|explanation/i.test(key)) return 'mock 判定：基于当前证据的保守结论';
      if (/method|variant/i.test(key)) return 'method_slower_syllable';
      return `mock_${key}`;
    case 'number':
      return 80;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

interface JsonSchemaSpec {
  type?: string;
  properties?: Record<string, JsonSchemaSpec>;
}

function extractSchemaProperties(schema: unknown): Record<string, JsonSchemaSpec> {
  if (schema && typeof schema === 'object') {
    const s = schema as JsonSchemaSpec;
    if (s.properties) return s.properties;
  }
  return {};
}

function buildMockTeacherUtterance(context: string): string {
  const trimmed = context.trim();
  if (!trimmed) return 'Let us try together. Listen first, then you try.';
  return `You did it! Let us say it together: ${trimmed.slice(0, 60)}`;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function isJsonParsable(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mock TTS 适配器。
 * 不生成真实音频，返回可复现的伪引用；缓存命中逻辑由 Gateway 负责，
 * Mock 同样返回 cached 标记以验证「反复播放不重新消耗 TTS」。
 */
export class MockTtsAdapter implements TtsAdapter {
  readonly alias = 'mock_tts';
  readonly serviceKind = 'tts' as const;
  readonly capabilities: ProviderCapabilities = {
    supportsStructuredOutput: false,
    supportsStreaming: false,
    teacherSpeedRange: { min: 0.25, max: 4 },
  };
  readonly pricing: ProviderPricing = MOCK_PRICING;

  async invoke(request: TtsRequest): Promise<TtsResponse> {
    const started = Date.now();
    // 音频引用由文本、语速与音色决定，保证同一参数命中缓存
    const ref = `mock://tts/${encodeURIComponent(request.text)}/${request.voice.teacherSpeed}/${request.voice.voiceStyle}`;
    return {
      audioRef: ref,
      // Mock 也按码点计字符数，保证与真实供应商的计费口径一致
      characters: [...request.text].length,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: 'mock',
      cached: false,
    };
  }
}

/** Mock ASR 适配器。空输入返回空结果并标记 suspect（D-013 双层策略）。 */
export class MockAsrAdapter implements AsrAdapter {
  readonly alias = 'mock_asr';
  readonly serviceKind = 'asr' as const;
  readonly capabilities: ProviderCapabilities = {
    supportsStructuredOutput: false,
    supportsStreaming: false,
  };
  readonly pricing: ProviderPricing = MOCK_PRICING;

  async invoke(request: AsrRequest): Promise<AsrResponse> {
    const started = Date.now();
    // Mock 不做真实识别：无音频引用时返回空结果并标记 suspect
    if (!request.audioRef) {
      return {
        transcript: '',
        confidence: 0,
        seconds: 0,
        latencyMs: Date.now() - started,
        providerAlias: this.alias,
        modelAlias: 'mock',
        suspect: true,
      };
    }
    const durationSeconds = 1.5;
    return {
      transcript: 'mock transcript',
      confidence: 0.9,
      seconds: durationSeconds,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: 'mock',
      suspect: false,
    };
  }
}

/**
 * Mock 发音评估适配器。
 * 产出音节级结果：全部正确或第一个音节偏低（可由调用方控制），
 * 用于验证「定位到具体出错的音，只练出错的部分」的教学逻辑（D-010）。
 */
export class MockPronunciationAdapter implements PronunciationAdapter {
  readonly alias = 'mock_pronunciation';
  readonly serviceKind = 'pronunciation' as const;
  readonly capabilities: ProviderCapabilities = {
    supportsStructuredOutput: false,
    supportsStreaming: false,
    supportsPhonemeAssessment: true,
    supportsSyllableAssessment: true,
  };
  readonly pricing: ProviderPricing = MOCK_PRICING;

  /**
   * 模拟规则：
   *  - 没有音频 → 全部得分 0，标记不通过；
   *  - 有音频 → 音节逐个给出分，最后一个音节固定偏低（模拟儿童常见尾音不稳），
   *    这样「定向练习出错音节」的分支必然被覆盖到。
   */
  async invoke(request: PronunciationRequest): Promise<PronunciationResponse> {
    const started = Date.now();
    const syllables = splitSyllables(request.targetText);

    if (!request.audioRef) {
      return {
        score: 0,
        passed: false,
        units: syllables.map((s) => ({
          text: s,
          kind: 'syllable' as const,
          score: 0,
          correct: false,
          detail: 'no audio provided',
        })),
        latencyMs: Date.now() - started,
        providerAlias: this.alias,
        modelAlias: 'mock',
      };
    }

    const units = syllables.map((s, idx) => {
      const isLast = idx === syllables.length - 1;
      const score = isLast ? 62 : 92;
      return {
        text: s,
        kind: 'syllable' as const,
        score,
        correct: score >= 80,
        detail: isLast ? '尾音不稳定' : null,
      };
    });

    const total = Math.round(units.reduce((sum, u) => sum + u.score, 0) / units.length);
    return {
      score: total,
      passed: total >= 85,
      units,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: 'mock',
    };
  }
}
