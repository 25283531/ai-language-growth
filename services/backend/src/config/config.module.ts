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
  queueRedisUrl: string;
  aiGatewayMode: 'mock' | 'live';
  llm: { apiKey?: string; baseUrl?: string; model?: string };
  tts: { apiKey?: string; baseUrl?: string; model?: string };
  asr: { apiKey?: string; baseUrl?: string; model?: string };
  pronunciation: { apiKey?: string; baseUrl?: string; model?: string };
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

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 3100),
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? '',
    queueRedisUrl: env.QUEUE_REDIS_URL ?? '',
    aiGatewayMode: (env.AI_GATEWAY_MODE ?? 'mock') as 'mock' | 'live',
    llm: pick('LLM'),
    tts: pick('TTS'),
    asr: pick('ASR'),
    pronunciation: pick('PRONUNCIATION'),
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
