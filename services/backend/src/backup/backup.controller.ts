import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Put, Req, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import { BackupService } from './backup.service';

@Controller('api/v1/admin/backups')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get('settings')
  async settings() {
    return this.backups.getSettings();
  }

  @Put('settings')
  async save(@Body() body: unknown) {
    return this.backups.saveSettings(body);
  }

  @Get('local')
  local() {
    return this.backups.listLocal();
  }

  @Post('create')
  async create() {
    return this.backups.createBackup();
  }

  @Get('local/:name')
  download(@Param('name') name: string) {
    return new StreamableFile(this.backups.openLocal(name), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${name}"`,
    });
  }

  @Post('restore')
  async restore(
    @Headers('x-restore-confirm') confirm: string | undefined,
    @Req() request: Request,
  ) {
    if (confirm !== 'RESTORE') throw new BadRequestException('还原操作需要确认');
    if (!Buffer.isBuffer(request.body)) throw new BadRequestException('请上传项目备份 ZIP 文件');
    return this.backups.restoreBackup(request.body.toString('base64'));
  }
}
