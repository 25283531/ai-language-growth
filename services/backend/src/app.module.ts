/**
 * 应用模块装配。
 *
 * 依据 D-016：NestJS 模块化单体，一个项目内的独立领域模块，不是独立部署的服务。
 */
import { Module } from '@nestjs/common';
import { ModelRouterImpl } from '@alg/model-router';
import { resolveProviderAliases } from '@alg/ai-provider-sdk';
import { ConfigModule } from './config/config.module';
import { QueueModule } from './queue/queue.module';
import { PrismaService } from './prisma/prisma.service';
import { AiGatewayService } from './ai-gateway/ai-gateway.service';
import { LearnerModelService } from './learner-model/learner-model.service';
import { PlannerService } from './planner/planner.service';
import { OrchestratorService } from './orchestrator/orchestrator.service';
import { LessonsController, LearnersController } from './lessons/lessons.controller';
import {
  HealthController,
  SpeechController,
  SpeechQuotaController,
  UsageController,
} from './speech/speech.controller';
import { TtsCacheAdminController } from './speech/tts-cache-admin.controller';
import { TtsCacheMaintenanceService } from './speech/tts-cache-maintenance.service';
import { MediaController } from './media/media.controller';
import { ImageCacheService } from './media/image-cache.service';
import { ProviderConfigController } from './providers/provider-config.controller';
import { ProviderConfigService } from './providers/provider-config.service';
import { PrismaUsageLedger } from './usage/prisma-usage-ledger';
import { UsageCostService } from './usage/usage-cost.service';
import { UsageAdminController } from './usage/usage-admin.controller';
import { UsageBudgetService } from './usage/usage-budget.service';
import { UsageBudgetAdminController } from './usage/usage-budget-admin.controller';
import { MemoryAdminController } from './memory/memory-admin.controller';
import { SpeechQuotaService } from './usage/speech-quota.service';
import { RoutingConfigController } from './routing/routing-config.controller';
import { RoutingConfigService } from './routing/routing-config.service';
import { MembershipAdminController } from './membership/membership-admin.controller';
import { CurriculumAdminController } from './curriculum/curriculum-admin.controller';
import { CurriculumGeneratorService } from './curriculum/curriculum-generator.service';
import { CurriculumWarmupService } from './curriculum/curriculum-warmup.service';
import { AdminAuthController, AuthController, EmailAdminController } from './auth/auth.controller';
import { UserController } from './auth/user.controller';
import { AuthService } from './auth/auth.service';
import { AdminAuthService } from './auth/admin-auth.service';
import { EmailService } from './auth/email.service';
import { MembershipController, MembershipUsersAdminController } from './membership/membership.controller';
import { BackupController } from './backup/backup.controller';
import { BackupService } from './backup/backup.service';
import { GrowthMentorService } from './agents/growth-mentor.service';
import { MemoryManagerService } from './agents/memory-manager.service';
import { PersonalityEngineService } from './agents/personality-engine.service';
import { PronunciationCoachService } from './agents/pronunciation-coach.service';

@Module({
  imports: [ConfigModule, QueueModule],
  controllers: [
    LessonsController,
    LearnersController,
    SpeechController,
    SpeechQuotaController,
    UsageController,
    TtsCacheAdminController,
    UsageAdminController,
    UsageBudgetAdminController,
    HealthController,
    MediaController,
    ProviderConfigController,
    MemoryAdminController,
    RoutingConfigController,
    MembershipAdminController,
    CurriculumAdminController,
    AuthController,
    AdminAuthController,
    EmailAdminController,
    MembershipController,
    MembershipUsersAdminController,
    BackupController,
    UserController,
  ],
  providers: [
    PrismaService,
    ProviderConfigService,
    ImageCacheService,
    CurriculumGeneratorService,
    CurriculumWarmupService,
    AiGatewayService,
    LearnerModelService,
    PlannerService,
    OrchestratorService,
    SpeechQuotaService,
    TtsCacheMaintenanceService,
    UsageCostService,
    UsageBudgetService,
    RoutingConfigService,
    AuthService,
    AdminAuthService,
    EmailService,
    BackupService,
    GrowthMentorService,
    MemoryManagerService,
    PersonalityEngineService,
    PronunciationCoachService,
    {
      provide: ModelRouterImpl,
      useFactory: (prisma: PrismaService) => {
        // Router 的供应商别名必须与 Gateway 实际注册的适配器来自同一份判断：
        // 未配置 BASE_URL 或被 AI_GATEWAY_LIVE_SERVICES 关闭的服务自动指向 Mock，
        // 避免出现「别名存在但适配器不存在」的静默降级。
        return new ModelRouterImpl(undefined, new PrismaUsageLedger(prisma), resolveProviderAliases());
      },
      inject: [PrismaService],
    },
  ],
})
export class AppModule {}
