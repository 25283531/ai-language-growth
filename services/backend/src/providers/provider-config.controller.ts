import { Body, Controller, Get, Headers, Put } from '@nestjs/common';
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
    await this.gateway.refreshRuntimeProvider(saved.serviceKind);
    return saved;
  }
}
