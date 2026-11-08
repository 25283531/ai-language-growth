/**
 * 后端入口。
 *
 * 约束一：教学逻辑全部在后端，客户端只渲染。
 * 本进程是唯一决定「孩子下一步学什么」的地方。
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, raw } from 'express';
import { AppModule } from './app.module';
import { assertLiveProviderConfig } from '@alg/ai-provider-sdk';
import { loadConfig } from './config/config.module';

async function bootstrap(): Promise<void> {
  // live 模式下配置漏填必须立刻失败，不能等到运行期静默回落 Mock
  assertLiveProviderConfig();
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, {
    logger: config.nodeEnv === 'development' ? ['log', 'warn', 'error'] : ['warn', 'error'],
  });

  app.enableCors({
    origin: true,
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
