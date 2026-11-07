/**
 * HTTP API 契约。
 *
 * 依据：V1.1 任务书第 7 章「核心教学 API（节选）」。
 * 路径前缀统一为 /api/v1。
 */
import { z } from 'zod';
import {
  lessonFinishRequestSchema,
  lessonFinishResponseSchema,
  lessonStartRequestSchema,
  lessonStartResponseSchema,
  turnRequestSchema,
  turnResponseSchema,
} from './teaching';
import { learnerProfileSchema } from './evidence';

export const API_PREFIX = '/api/v1';

export const turnRouteSchema = {
  method: 'POST',
  path: `${API_PREFIX}/lessons/{id}/turn`,
  request: turnRequestSchema,
  response: turnResponseSchema,
  description: '全局核心接口：孩子每次回答都经它完成教学编排',
} as const;

export const lessonStartRouteSchema = {
  method: 'POST',
  path: `${API_PREFIX}/lessons/start`,
  request: lessonStartRequestSchema,
  response: lessonStartResponseSchema,
} as const;

export const lessonFinishRouteSchema = {
  method: 'POST',
  path: `${API_PREFIX}/lessons/{id}/finish`,
  request: lessonFinishRequestSchema,
  response: lessonFinishResponseSchema,
} as const;

export const learnerRoutesSchema = {
  list: { method: 'GET', path: `${API_PREFIX}/learners` },
  profile: { method: 'GET', path: `${API_PREFIX}/learners/{id}/profile` },
  abilities: { method: 'GET', path: `${API_PREFIX}/learners/{id}/abilities` },
  createProfile: {
    method: 'POST',
    path: `${API_PREFIX}/learners`,
    body: learnerProfileSchema.omit({ id: true, createdAt: true }),
  },
} as const;

export const speechRoutesSchema = {
  synthesize: { method: 'POST', path: `${API_PREFIX}/speech/synthesize` },
  recognize: { method: 'POST', path: `${API_PREFIX}/speech/recognize` },
  evaluate: { method: 'POST', path: `${API_PREFIX}/speech/evaluate` },
} as const;

export const evidenceRoutesSchema = {
  list: { method: 'GET', path: `${API_PREFIX}/assessment/evidence` },
} as const;

export const usageRoutesSchema = {
  summary: { method: 'GET', path: `${API_PREFIX}/usage/summary` },
} as const;

export const healthRoutesSchema = {
  health: { method: 'GET', path: `${API_PREFIX}/health` },
} as const;

export type ApiRouteSummary = {
  method: string;
  path: string;
  description?: string;
};
