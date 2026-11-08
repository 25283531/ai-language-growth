import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Put, Req, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import { ProviderConfigService } from '../providers/provider-config.service';
import { BackupService } from './backup.service';

@Controller('api/v1/admin/backups')
export class BackupController {
  constructor(
    private readonly backups: BackupService,
    private readonly admin: ProviderConfigService,
  ) {}

  @Get('settings')
  async settings(@Headers('x-admin-token') token?: string) {
    this.admin.assertAdminToken(token);
    return this.backups.getSettings();
  }

  @Put('settings')
  async save(@Headers('x-admin-token') token: string | undefined, @Body() body: unknown) {
    this.admin.assertAdminToken(token);
    return this.backups.saveSettings(body);
  }

  @Get('local')
  local(@Headers('x-admin-token') token?: string) {
    this.admin.assertAdminToken(token);
    return this.backups.listLocal();
  }

  @Post('create')
  async create(@Headers('x-admin-token') token?: string) {
    this.admin.assertAdminToken(token);
    return this.backups.createBackup();
  }

  @Get('local/:name')
  download(@Headers('x-admin-token') token: string | undefined, @Param('name') name: string) {
    this.admin.assertAdminToken(token);
    return new StreamableFile(this.backups.openLocal(name), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${name}"`,
    });
  }

  @Post('restore')
  async restore(
    @Headers('x-admin-token') token: string | undefined,
    @Headers('x-restore-confirm') confirm: string | undefined,
    @Req() request: Request,
  ) {
    this.admin.assertAdminToken(token);
    if (confirm !== 'RESTORE') throw new BadRequestException('还原操作需要确认');
    if (!Buffer.isBuffer(request.body)) throw new BadRequestException('请上传项目备份 ZIP 文件');
    return this.backups.restoreBackup(request.body.toString('base64'));
  }
}
