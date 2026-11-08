/**
 * 后端入口。
 *
 * 约束一：教学逻辑全部在后端，客户端只渲染。
 * 本进程是唯一决定「孩子下一步学什么」的地方。
 */
import 'reflect-metadata';
import { Logger, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, raw } from 'express';
import type { NextFunction, Response } from 'express';
import type { Request } from 'express';
import { AppModule } from './app.module';
import { assertLiveProviderConfig } from '@alg/ai-provider-sdk';
import { loadConfig } from './config/config.module';
import { SpeechQuotaService } from './usage/speech-quota.service';
import { AuthService, extractBearerToken } from './auth/auth.service';

async function bootstrap(): Promise<void> {
  // live 模式下配置漏填必须立刻失败，不能等到运行期静默回落 Mock
  assertLiveProviderConfig();
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, {
    logger: config.nodeEnv === 'development' ? ['log', 'warn', 'error'] : ['warn', 'error'],
  });

  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Idempotency-Key',
      'X-Admin-Token',
      'X-Learner-Id',
      'X-Speech-Quota-Reservation',
    ],
  });

  // JSON body 体积上限：M1 语音以引用方式传递，不内联大 base64
  app.use(json({ limit: '2mb' }));
  app.use('/api/v1/admin/backups/restore', raw({ type: 'application/octet-stream', limit: '512mb' }));
  const speechQuota = app.get(SpeechQuotaService);
  const auth = app.get(AuthService);
  app.use('/api/v1/media/audio/uploads', async (request: Request, response: Response, next: NextFunction) => {
    const reservationId = String(request.headers['x-speech-quota-reservation'] ?? '').trim();
    const learnerId = String(request.headers['x-learner-id'] ?? '').trim();
    if (!reservationId || !learnerId) {
      response.status(400).json({ message: '音频请求缺少额度租约或学习者标识' });
      return;
    }
    try {
      await auth.assertLearnerOwnership(
        extractBearerToken(request.headers.authorization, request.headers.cookie),
        learnerId,
      );
      await speechQuota.assertReservation({ reservationId, learnerId, serviceKind: 'asr' });
      next();
    } catch (error) {
      const status = error instanceof UnauthorizedException
        ? 401
        : error instanceof ForbiddenException
          ? 403
          : 429;
      response.status(status).json({ message: '语音额度租约无效或已超额，已阻止音频上传' });
    }
  });
  // Android 原型将录音字节直接 POST 到该路径；只对上传路由启用原始字节解析。
  app.use('/api/v1/media/audio/uploads', raw({
    type: ['audio/*', 'application/octet-stream'],
    limit: '10mb',
  }));

  await app.listen(config.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`AI Language Growth 后端已启动：http://0.0.0.0:${config.port}/api/v1`);
  logger.log(`AI Gateway 模式：${config.aiGatewayMode}`);
  logger.log('M1 阈值全部为未校准原型值，不得对外表述为「已掌握」');
}

void bootstrap();
