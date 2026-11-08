import { Body, Controller, Get, Headers, Put } from '@nestjs/common';
import { RoutingConfigService } from './routing-config.service';
import { ProviderConfigService } from '../providers/provider-config.service';

@Controller('api/v1/admin/model-routing')
export class RoutingConfigController {
  constructor(
    private readonly routing: RoutingConfigService,
    private readonly auth: ProviderConfigService,
  ) {}

  @Get()
  async get(@Headers('x-admin-token') token?: string) {
    this.auth.assertAdminToken(token);
    return this.routing.getSnapshot();
  }

  @Put()
  async save(@Headers('x-admin-token') token: string | undefined, @Body() body: unknown) {
    this.auth.assertAdminToken(token);
    return this.routing.save(body);
  }
}
