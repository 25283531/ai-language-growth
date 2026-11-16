/**
 * TTS 缓存运维只读入口。
 *
 * 只暴露进程内命中率与最近一次清理统计，不返回音频路径、文本或供应商凭据。
 * 清理由 TtsCacheMaintenanceService 定时执行，本接口不提供手动删除按钮。
 */
import { Controller, Get, Headers, Optional } from '@nestjs/common';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { AdminAuthService } from '../auth/admin-auth.service';
import { PregenerationIndexService } from './pregeneration-index.service';
import { TtsCacheMaintenanceService } from './tts-cache-maintenance.service';

@Controller('api/v1/admin/tts-cache')
export class TtsCacheAdminController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly gateway: AiGatewayService,
    private readonly maintenance: TtsCacheMaintenanceService,
    /** 预生成索引可能尚未接线；未注入时按关闭处理，不影响既有缓存统计。 */
    @Optional() private readonly pregeneration?: PregenerationIndexService,
  ) {}

  @Get()
  status(@Headers('cookie') cookie?: string) {
    this.adminAuth.resolveRequest({ headers: { cookie } });
    return {
      cache: this.gateway.ttsCacheStats(),
      maintenance: this.maintenance.status(),
      pregeneration: this.pregeneration?.snapshot() ?? null,
    };
  }

  /**
   * 预生成索引只读统计：模式、引擎版本、命中/本可命中/未命中/不合格计数与缓存规模。
   * shadow 阶段看 shadowHits / (shadowHits + misses + ineligible) 判断命中率。
   */
  @Get('pregeneration')
  pregenerationStats(@Headers('cookie') cookie?: string) {
    this.adminAuth.resolveRequest({ headers: { cookie } });
    return {
      gateway: { pregenHits: this.gateway.ttsCacheStats().pregenHits },
      index: this.pregeneration?.snapshot() ?? null,
    };
  }
}
