/**
 * 配置模块。
 *
 * 所有外部依赖通过环境变量注入，代码中不出现服务商或模型名称（约束二）。
 */
import { Global, Module } from '@nestjs/common';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  workingMemoryTtlSeconds: number;
  mem0: {
    baseUrl?: string;
    apiKey?: string;
    addPath: string;
    searchPath: string;
    updatePath: string;
    deletePath: string;
    timeoutMs: number;
  };
  queueRedisUrl: string;
  queueAllowSharedRedis: boolean;
  aiGatewayMode: 'mock' | 'live';
  llm: { apiKey?: string; baseUrl?: string; model?: string };
  tts: { apiKey?: string; baseUrl?: string; model?: string };
  asr: { apiKey?: string; baseUrl?: string; model?: string };
  pronunciation: { apiKey?: string; baseUrl?: string; model?: string };
  embedding: { apiKey?: string; baseUrl?: string; model?: string };
  mail: {
    host?: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from?: string;
    replyTo?: string;
    resetUrl: string;
    disabled: boolean;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const pick = (prefix: string) => ({
    apiKey: env[`${prefix}_API_KEY`] || undefined,
    baseUrl: env[`${prefix}_BASE_URL`] || undefined,
    model: env[`${prefix}_MODEL`] || undefined,
  });
  const positiveNumber = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value ?? fallback);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 3100),
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? '',
    workingMemoryTtlSeconds: positiveNumber(env.WORKING_MEMORY_TTL_SECONDS, 21600),
    mem0: {
      baseUrl: env.MEM0_BASE_URL || undefined,
      apiKey: env.MEM0_API_KEY || undefined,
      addPath: env.MEM0_ADD_PATH || '/v1/memories/',
      searchPath: env.MEM0_SEARCH_PATH || '/v1/memories/search/',
      updatePath: env.MEM0_UPDATE_PATH || '/v1/memories/{id}/',
      deletePath: env.MEM0_DELETE_PATH || '/v1/memories/{id}/',
      timeoutMs: Math.max(500, Math.min(15000, positiveNumber(env.MEM0_TIMEOUT_MS, 5000))),
    },
    queueRedisUrl: env.QUEUE_REDIS_URL ?? '',
    queueAllowSharedRedis: (env.QUEUE_ALLOW_SHARED_REDIS ?? '').toLowerCase() === 'true',
    aiGatewayMode: (env.AI_GATEWAY_MODE ?? 'mock') as 'mock' | 'live',
    llm: pick('LLM'),
    tts: pick('TTS'),
    asr: pick('ASR'),
    pronunciation: pick('PRONUNCIATION'),
    embedding: pick('EMBEDDING'),
    mail: {
      host: env.MAIL_HOST || undefined,
      port: Number(env.MAIL_PORT ?? 587),
      secure: env.MAIL_SECURE === 'true',
      user: env.MAIL_USER || undefined,
      password: env.MAIL_PASSWORD || undefined,
      from: env.MAIL_FROM || undefined,
      replyTo: env.MAIL_REPLY_TO || undefined,
      resetUrl: env.PASSWORD_RESET_URL || 'http://localhost:3000/reset-password',
      disabled: env.MAIL_DISABLED === 'true',
    },
  };
}

export const APP_CONFIG = 'APP_CONFIG';

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
