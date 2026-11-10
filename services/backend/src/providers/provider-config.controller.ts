import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { SERVICE_KINDS, type ProviderServiceKind, type ServiceKind } from '@alg/shared-contracts';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { ProviderConfigService, type ProviderConfigInput } from './provider-config.service';
import { AdminAuthService } from '../auth/admin-auth.service';

@Controller('api/v1/admin/model-providers')
export class ProviderConfigController {
  constructor(
    private readonly configs: ProviderConfigService,
    private readonly gateway: AiGatewayService,
    private readonly adminAuth: AdminAuthService,
  ) {}

  private authorize(cookie?: string) {
    this.adminAuth.resolveRequest({ headers: { cookie } });
  }

  @Get('catalog')
  catalog() {
    return this.configs.listCatalog();
  }

  @Get('configs')
  async list(@Headers('cookie') cookie?: string) {
    this.authorize(cookie);
    return this.configs.listPublicConfigs();
  }

  // 删除前查询该配置是否被任务路由设为首选/备用，供管理端做防误删判断。
  // 该接口只读、走同一套 HttpOnly 会话鉴权，且不回读任何密钥。
  @Get('configs/:id/references')
  async routingReferences(
    @Headers('cookie') cookie: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    this.authorize(cookie);
    return this.configs.listRoutingReferences(id);
  }

  // 保持原有 DELETE 契约不变：不额外加参数校验，仍由 service 判定配置是否存在。
  // 可选 ?force=true 用于显式越过「该服务将无启用配置」的运行时护栏。
  @Delete('configs/:id')
  async remove(
    @Headers('cookie') cookie: string | undefined,
    @Param('id') id: string,
    @Query('force') force?: string,
  ) {
    this.authorize(cookie);
    const removed = await this.configs.deleteConfig(id, force === 'true');
    await this.gateway.refreshRuntimeProvider(removed.serviceKind as ServiceKind);
    return removed;
  }

  @Put('configs')
  async save(
    @Headers('cookie') cookie: string | undefined,
    @Body() body: ProviderConfigInput,
  ) {
    this.authorize(cookie);
    const saved = await this.configs.save(body);
    if (SERVICE_KINDS.includes(saved.serviceKind as ServiceKind)) {
      await this.gateway.refreshRuntimeProvider(saved.serviceKind as ServiceKind);
    }
    return saved;
  }

  @Get('benchmarks')
  async benchmarks(
    @Headers('cookie') cookie: string | undefined,
    @Query('serviceKind') serviceKind: ServiceKind,
    @Query('configId') configId?: string,
  ) {
    this.authorize(cookie);
    return this.configs.listBenchmarks(serviceKind, configId);
  }

  @Get('runtime-scores')
  async runtimeScores(
    @Headers('cookie') cookie: string | undefined,
    @Query('serviceKind') serviceKind: ServiceKind,
  ) {
    this.authorize(cookie);
    if (!SERVICE_KINDS.includes(serviceKind)) return [];
    return this.configs.listRuntimeScores(serviceKind);
  }

  @Post('benchmarks')
  async recordBenchmark(@Headers('cookie') cookie: string | undefined, @Body() body: unknown) {
    this.authorize(cookie);
    const benchmark = await this.configs.recordBenchmark(body);
    await this.gateway.refreshRuntimeProvider(benchmark.serviceKind);
    return benchmark;
  }

  @Get('prices')
  async prices(
    @Headers('cookie') cookie: string | undefined,
    @Query('serviceKind') serviceKind: ProviderServiceKind,
    @Query('configId') configId?: string,
  ) {
    this.authorize(cookie);
    return this.configs.listPrices(serviceKind, configId);
  }

  @Put('prices')
  async savePrices(@Headers('cookie') cookie: string | undefined, @Body() body: unknown) {
    this.authorize(cookie);
    return this.configs.savePrices(body);
  }
}
