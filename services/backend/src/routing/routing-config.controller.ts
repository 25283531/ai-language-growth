import { Body, Controller, Get, Put } from '@nestjs/common';
import { RoutingConfigService } from './routing-config.service';

@Controller('api/v1/admin/model-routing')
export class RoutingConfigController {
  constructor(private readonly routing: RoutingConfigService) {}

  @Get()
  async get() {
    return this.routing.getSnapshot();
  }

  @Put()
  async save(@Body() body: unknown) {
    return this.routing.save(body);
  }
}
