/**
 * 后端入口。
 *
 * 约束一：教学逻辑全部在后端，客户端只渲染。
 * 本进程是唯一决定「孩子下一步学什么」的地方。
 */
import 'reflect-metadata';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { json, raw } from 'express';
import type { NextFunction, Response } from 'express';
import type { Request } from 'express';
import { AppModule } from './app.module';
import { assertLiveProviderConfig } from '@alg/ai-provider-sdk';
import { loadConfig } from './config/config.module';
import { AdminAuthService } from './auth/admin-auth.service';

async function bootstrap(): Promise<void> {
  // live 模式下配置漏填必须立刻失败，不能等到运行期静默回落 Mock
  assertLiveProviderConfig();
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, {
    logger: config.nodeEnv === 'development' ? ['log', 'warn', 'error'] : ['warn', 'error'],
  });

  app.enableShutdownHooks();
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Idempotency-Key',
      'X-Learner-Id',
      'X-Speech-Quota-Reservation',
    ],
  });

  // 儿童录音以一次性 audioBase64 随课堂回合提交；提高 JSON 上限但服务端不落盘。
  app.use(json({ limit: '8mb' }));
  app.use('/api/v1/admin/backups/restore', raw({ type: 'application/octet-stream', limit: '512mb' }));
  const adminAuth = app.get(AdminAuthService);
  app.use('/api/v1/admin', (request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'POST' && request.path === '/curriculum/internal/model') {
      const expected = process.env.CURRICULUM_GENERATOR_TOKEN ?? '';
      const provided = String(request.headers['x-curriculum-token'] ?? '');
      const expectedBytes = Buffer.from(expected);
      const providedBytes = Buffer.from(provided);
      if (
        expectedBytes.length > 0
        && expectedBytes.length === providedBytes.length
        && timingSafeEqual(expectedBytes, providedBytes)
      ) {
        next();
        return;
      }
      response.status(401).json({ message: '课程生成服务凭据无效' });
      return;
    }
    if (adminAuth.isAuthPath(request.path)) {
      next();
      return;
    }
    try {
      adminAuth.resolveRequest(request);
      next();
    } catch (error) {
      const status = error instanceof UnauthorizedException ? 401 : 503;
      response.status(status).json({ message: error instanceof Error ? error.message : '管理后台未授权' });
    }
  });

  await app.listen(config.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`AI Language Growth 后端已启动：http://0.0.0.0:${config.port}/api/v1`);
  logger.log(`AI Gateway 模式：${config.aiGatewayMode}`);
  logger.log('M1 阈值全部为未校准原型值，不得对外表述为「已掌握」');
}

void bootstrap();
