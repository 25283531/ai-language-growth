/**
 * TTS 缓存运维只读入口。
 *
 * 只暴露进程内命中率与最近一次清理统计，不返回音频路径、文本或供应商凭据。
 * 清理由 TtsCacheMaintenanceService 定时执行，本接口不提供手动删除按钮。
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { AdminAuthService } from '../auth/admin-auth.service';
import { TtsCacheMaintenanceService } from './tts-cache-maintenance.service';

@Controller('api/v1/admin/tts-cache')
export class TtsCacheAdminController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly gateway: AiGatewayService,
    private readonly maintenance: TtsCacheMaintenanceService,
  ) {}

  @Get()
  status(@Headers('cookie') cookie?: string) {
    this.adminAuth.resolveRequest({ headers: { cookie } });
    return {
      cache: this.gateway.ttsCacheStats(),
      maintenance: this.maintenance.status(),
    };
  }
}
