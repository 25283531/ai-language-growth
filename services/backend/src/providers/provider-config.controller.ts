import { Body, Controller, Get, Headers, Post, Put, Query } from '@nestjs/common';
import { SERVICE_KINDS, type ProviderServiceKind, type ServiceKind } from '@alg/shared-contracts';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { ProviderConfigService, type ProviderConfigInput } from './provider-config.service';

@Controller('api/v1/admin/model-providers')
export class ProviderConfigController {
  constructor(
    private readonly configs: ProviderConfigService,
    private readonly gateway: AiGatewayService,
  ) {}

  @Get('catalog')
  catalog() {
    return this.configs.listCatalog();
  }

  @Get('configs')
  async list(@Headers('x-admin-token') token?: string) {
    this.configs.assertAdminToken(token);
    return this.configs.listPublicConfigs();
  }

  @Put('configs')
  async save(
    @Headers('x-admin-token') token: string | undefined,
    @Body() body: ProviderConfigInput,
  ) {
    this.configs.assertAdminToken(token);
    const saved = await this.configs.save(body);
    if (SERVICE_KINDS.includes(saved.serviceKind as ServiceKind)) {
      await this.gateway.refreshRuntimeProvider(saved.serviceKind as ServiceKind);
    }
    return saved;
  }

  @Get('benchmarks')
  async benchmarks(
    @Headers('x-admin-token') token: string | undefined,
    @Query('serviceKind') serviceKind: ServiceKind,
  ) {
    this.configs.assertAdminToken(token);
    return this.configs.listBenchmarks(serviceKind);
  }

  @Post('benchmarks')
  async recordBenchmark(@Headers('x-admin-token') token: string | undefined, @Body() body: unknown) {
    this.configs.assertAdminToken(token);
    const benchmark = await this.configs.recordBenchmark(body);
    await this.gateway.refreshRuntimeProvider(benchmark.serviceKind);
    return benchmark;
  }

  @Get('prices')
  async prices(
    @Headers('x-admin-token') token: string | undefined,
    @Query('serviceKind') serviceKind: ProviderServiceKind,
  ) {
    this.configs.assertAdminToken(token);
    return this.configs.listPrices(serviceKind);
  }

  @Put('prices')
  async savePrices(@Headers('x-admin-token') token: string | undefined, @Body() body: unknown) {
    this.configs.assertAdminToken(token);
    return this.configs.savePrices(body);
  }
}
