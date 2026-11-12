import type {
  AbilitiesResponse,
  DegradedTurnBody,
  HealthResponse,
  LessonFinishResponse,
  LessonStartResponse,
  ResponseForm,
  SynthesizeResponse,
  TeacherVoiceParams,
  TurnRequestBody,
  TurnResponse,
  UsageSummary,
  EvidenceRow,
  GrowthArchiveResponse,
} from './types';
import { authRequest } from './auth-api';
import { LESSON_START_ENABLED } from './runtime-config';

/** 后端已 enableCors，Web 直连；可用 NEXT_PUBLIC_API_BASE 覆盖。 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '/api/v1';

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
  } catch (error) {
    throw new Error(`网络请求失败（${API_BASE}）：${(error as Error).message}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）`);
  }

  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new Error(`${message}（HTTP ${res.status}）`);
  }
  return body as T;
}

/** 生成唯一幂等键；非安全上下文下给出兜底，保证演示可用。 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

/**
 * 稳定序列化：递归对对象 key 排序后再序列化。
 *
 * 后端幂等命中的是已落库的 JSON（existing.output），反序列化后字段顺序可能与
 * 首次响应不同；用稳定序列化比较，避免把「语义相同的同一结果」误判为不一致。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** 区分正常 TurnResponse 与后端返回的降级错误体（同为 HTTP 200）。 */
export function isTurnResponse(value: unknown): value is TurnResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.directive === 'object' &&
    v.directive !== null &&
    typeof v.assessment === 'object' &&
    typeof v.routing === 'object'
  );
}

export function buildTurnRequestBody(
  learnerId: string,
  idempotencyKey: string,
  form: ResponseForm,
): TurnRequestBody {
  const nullable = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    learnerId,
    idempotencyKey,
    clientTimestamp: new Date().toISOString(),
    response: {
      text: nullable(form.text),
      audioRef: nullable(form.audioRef),
      audioDurationMs: null,
      selectedImageId: nullable(form.selectedImageId),
      requestedSlower: form.requestedSlower,
      requestedRepeat: form.requestedRepeat,
      freeUtterance: nullable(form.freeUtterance),
    },
  };
}

export const getHealth = (): Promise<HealthResponse> => apiRequest<HealthResponse>('/health');

export function startLesson(learnerId: string, topicId: string): Promise<LessonStartResponse> {
  if (!LESSON_START_ENABLED) {
    return Promise.reject(new Error('生产评估模式已关闭 Web 开课入口；正式课堂请在 Android 客户端进行。'));
  }
  return apiRequest<LessonStartResponse>('/lessons/start', {
    method: 'POST',
    body: JSON.stringify({ learnerId, topicId }),
  });
}

export function sendTurn(
  sessionId: string,
  body: TurnRequestBody,
): Promise<TurnResponse | DegradedTurnBody> {
  return apiRequest<TurnResponse | DegradedTurnBody>(`/lessons/${encodeURIComponent(sessionId)}/turn`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function finishLesson(
  sessionId: string,
  learnerId: string,
): Promise<LessonFinishResponse> {
  return apiRequest<LessonFinishResponse>(
    `/lessons/${encodeURIComponent(sessionId)}/finish`,
    { method: 'POST', body: JSON.stringify({ learnerId }) },
  );
}

export function synthesize(
  text: string,
  voice: TeacherVoiceParams,
): Promise<SynthesizeResponse> {
  return apiRequest<SynthesizeResponse>('/speech/synthesize', {
    method: 'POST',
    body: JSON.stringify({
      text,
      teacherSpeed: voice.teacherSpeed,
      voiceStyle: voice.voiceStyle,
      pauseAfterSentenceMs: voice.pauseAfterSentenceMs,
      pronunciationMode: voice.pronunciationMode,
    }),
  });
}

/**
 * 学习者档案类只读接口必须带会话。
 *
 * `/api/v1/learners/:id/*` 需要登录态（后端 `LearnersController` 会校验归属，
 * 匿名一律 401/403）。因此这三个接口走 `authRequest`（自动附加
 * localStorage 里的 Bearer），而不是裸 `apiRequest`。
 * 返回类型与调用签名保持不变，调用方无需改动。
 */
export const getAbilities = (learnerId: string): Promise<AbilitiesResponse> =>
  authRequest<AbilitiesResponse>(`/learners/${encodeURIComponent(learnerId)}/abilities`);

export const getEvidence = (learnerId: string): Promise<EvidenceRow[]> =>
  authRequest<EvidenceRow[]>(`/learners/${encodeURIComponent(learnerId)}/evidence`);

export const getGrowthArchive = (learnerId: string): Promise<GrowthArchiveResponse> =>
  authRequest<GrowthArchiveResponse>(`/learners/${encodeURIComponent(learnerId)}/growth`);

export function getUsage(sessionId?: string | null): Promise<UsageSummary> {
  const query = sessionId ? `?lessonSessionId=${encodeURIComponent(sessionId)}` : '';
  return apiRequest<UsageSummary>(`/usage/summary${query}`);
}
