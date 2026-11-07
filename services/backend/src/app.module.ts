/**
 * 应用模块装配。
 *
 * 依据 D-016：NestJS 模块化单体，一个项目内的独立领域模块，不是独立部署的服务。
 */
import { Module } from '@nestjs/common';
import { MOCK_PROVIDER_ALIASES, ModelRouterImpl } from '@alg/model-router';
import { ConfigModule } from './config/config.module';
import { PrismaService } from './prisma/prisma.service';
import { AiGatewayService } from './ai-gateway/ai-gateway.service';
import { LearnerModelService } from './learner-model/learner-model.service';
import { PlannerService } from './planner/planner.service';
import { OrchestratorService } from './orchestrator/orchestrator.service';
import { LessonsController, LearnersController } from './lessons/lessons.controller';
import {
  HealthController,
  SpeechController,
  UsageController,
} from './speech/speech.controller';

@Module({
  imports: [ConfigModule],
  controllers: [
    LessonsController,
    LearnersController,
    SpeechController,
    UsageController,
    HealthController,
  ],
  providers: [
    PrismaService,
    AiGatewayService,
    LearnerModelService,
    PlannerService,
    OrchestratorService,
    {
      provide: ModelRouterImpl,
      useFactory: () => {
        // M1 默认 Mock：让 Router 的供应商别名指向实际注册的 Mock 适配器，
        // 避免每次调用都被误判为「降级」。live 模式沿用路由表中的逻辑别名。
        const mode = process.env.AI_GATEWAY_MODE ?? 'mock';
        return new ModelRouterImpl(
          undefined,
          undefined,
          mode === 'mock' ? MOCK_PROVIDER_ALIASES : undefined,
        );
      },
    },
  ],
})
export class AppModule {}
