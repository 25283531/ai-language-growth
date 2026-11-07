/**
 * 应用模块装配。
 *
 * 依据 D-016：NestJS 模块化单体，一个项目内的独立领域模块，不是独立部署的服务。
 */
import { Module } from '@nestjs/common';
import { ModelRouterImpl } from '@alg/model-router';
import { resolveProviderAliases } from '@alg/ai-provider-sdk';
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
import { MediaController } from './media/media.controller';

@Module({
  imports: [ConfigModule],
  controllers: [
    LessonsController,
    LearnersController,
    SpeechController,
    UsageController,
    HealthController,
    MediaController,
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
        // Router 的供应商别名必须与 Gateway 实际注册的适配器来自同一份判断：
        // 未配置 BASE_URL 或被 AI_GATEWAY_LIVE_SERVICES 关闭的服务自动指向 Mock，
        // 避免出现「别名存在但适配器不存在」的静默降级。
        return new ModelRouterImpl(undefined, undefined, resolveProviderAliases());
      },
    },
  ],
})
export class AppModule {}
