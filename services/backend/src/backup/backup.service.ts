import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import AdmZip from 'adm-zip';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderConfigService } from '../providers/provider-config.service';

const execFileAsync = promisify(execFile);
const BACKUP_DIR = process.env.BACKUP_DIR || join(process.cwd(), '.cache', 'backups');
const backupSettingsKey = 'backup';

export interface BackupSettings {
  enabled: boolean;
  intervalHours: number;
  retention: number;
  target: 'local' | 'webdav';
  webdavUrl: string;
  webdavUser: string;
  webdavPath: string;
  passwordConfigured: boolean;
}

@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: ProviderConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.schedule();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async getSettings(): Promise<BackupSettings> {
    const row = await this.prisma.app_settings.findUnique({ where: { key: backupSettingsKey } });
    const value = row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
      ? row.value as Record<string, unknown>
      : {};
    return {
      enabled: value.enabled === true,
      intervalHours: Number(value.intervalHours ?? 24),
      retention: Number(value.retention ?? 7),
      target: value.target === 'webdav' ? 'webdav' : 'local',
      webdavUrl: String(value.webdavUrl ?? ''),
      webdavUser: String(value.webdavUser ?? ''),
      webdavPath: String(value.webdavPath ?? '/ai-language-growth'),
      passwordConfigured: Boolean(row?.secretCiphertext),
    };
  }

  async saveSettings(input: unknown): Promise<BackupSettings> {
    if (!input || typeof input !== 'object') throw new BadRequestException('备份配置无效');
    const value = input as Record<string, unknown>;
    const current = await this.prisma.app_settings.findUnique({ where: { key: backupSettingsKey } });
    const target = value.target === 'webdav' ? 'webdav' : 'local';
    const webdavUrl = String(value.webdavUrl ?? '').trim();
    if (target === 'webdav' && !/^https?:\/\//i.test(webdavUrl)) {
      throw new BadRequestException('WebDAV 地址必须以 http:// 或 https:// 开头');
    }
    const password = String(value.webdavPassword ?? '').trim()
      || (current?.secretCiphertext ? this.secrets.decryptSecretRecord(current.secretCiphertext).password : '');
    await this.prisma.app_settings.upsert({
      where: { key: backupSettingsKey },
      create: {
        key: backupSettingsKey,
        value: {
          enabled: value.enabled === true,
          intervalHours: Math.min(168, Math.max(1, Number(value.intervalHours ?? 24))),
          retention: Math.min(100, Math.max(1, Number(value.retention ?? 7))),
          target, webdavUrl, webdavUser: String(value.webdavUser ?? '').trim(),
          webdavPath: String(value.webdavPath ?? '/ai-language-growth').trim() || '/ai-language-growth',
        } as Prisma.InputJsonValue,
        secretCiphertext: password ? this.secrets.encryptSecretRecord({ password }) : null,
      },
      update: {
        value: {
          enabled: value.enabled === true,
          intervalHours: Math.min(168, Math.max(1, Number(value.intervalHours ?? 24))),
          retention: Math.min(100, Math.max(1, Number(value.retention ?? 7))),
          target, webdavUrl, webdavUser: String(value.webdavUser ?? '').trim(),
          webdavPath: String(value.webdavPath ?? '/ai-language-growth').trim() || '/ai-language-growth',
        } as Prisma.InputJsonValue,
        secretCiphertext: password ? this.secrets.encryptSecretRecord({ password }) : current?.secretCiphertext ?? null,
      },
    });
    await this.schedule();
    return this.getSettings();
  }

  listLocal(): Array<{ name: string; bytes: number; createdAt: string }> {
    mkdirSync(BACKUP_DIR, { recursive: true });
    return readdirSync(BACKUP_DIR)
      .filter((name) => name.endsWith('.zip'))
      .map((name) => {
        const stats = statSync(join(BACKUP_DIR, name));
        return { name, bytes: stats.size, createdAt: stats.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  openLocal(name: string) {
    if (!/^[a-zA-Z0-9_.-]+\.zip$/.test(name)) throw new BadRequestException('备份文件名无效');
    const file = join(BACKUP_DIR, name);
    if (!statSafe(file)) throw new BadRequestException('备份文件不存在');
    return createReadStream(file);
  }

  async createBackup(): Promise<{ name: string; bytes: number; target: string }> {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `alg-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.zip`;
    const output = join(BACKUP_DIR, name);
    const dump = join(BACKUP_DIR, `database-${randomUUID()}.dump`);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new ServiceUnavailableException('DATABASE_URL 未配置');
    try {
      await execFileAsync('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dump, databaseUrl], {
        maxBuffer: 1024 * 1024,
      });
      const archive = new AdmZip();
      archive.addLocalFile(dump, '', 'database.dump');
      archive.writeZip(output);
    } catch (error) {
      this.logger.error(`数据库备份失败: ${(error as Error).message}`);
      throw new ServiceUnavailableException('数据库备份失败，请确认运行环境包含 pg_dump');
    } finally {
      try { unlinkSync(dump); } catch { /* noop */ }
    }
    const settings = await this.getSettings();
    if (settings.target === 'webdav') await this.uploadWebdav(output, settings);
    await this.prune(settings.retention);
    return { name, bytes: statSync(output).size, target: settings.target };
  }

  async restoreBackup(base64: string): Promise<{ ok: true }> {
    if (typeof base64 !== 'string' || base64.length < 32) throw new BadRequestException('备份文件为空');
    const output = join(BACKUP_DIR, `restore-${randomUUID()}.dump`);
    let dump = '';
    mkdirSync(BACKUP_DIR, { recursive: true });
    try {
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length < 16 || bytes.length > 512 * 1024 * 1024) throw new Error('backup size invalid');
      writeFileSync(output, bytes, { flag: 'wx' });
      const archive = new AdmZip(output);
      const entries = archive.getEntries();
      const database = entries.find((entry) => entry.entryName === 'database.dump');
      if (
        !database
        || database.isDirectory
        || entries.length !== 1
        || entries.some((entry) => entry.header.size > 512 * 1024 * 1024)
      ) {
        throw new Error('backup format invalid');
      }
      dump = join(BACKUP_DIR, `restore-db-${randomUUID()}.dump`);
      writeFileSync(dump, database.getData(), { flag: 'wx' });
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('DATABASE_URL missing');
      await this.createBackup();
      await execFileAsync('pg_restore', [
        '--clean', '--if-exists', '--no-owner', '--no-acl', '--dbname', databaseUrl, dump,
      ], { maxBuffer: 1024 * 1024 });
      return { ok: true };
    } catch (error) {
      throw new BadRequestException(`备份还原失败：${(error as Error).message}`);
    } finally {
      try { unlinkSync(output); } catch { /* noop */ }
      if (dump) {
        try { unlinkSync(dump); } catch { /* noop */ }
      }
    }
  }

  private async uploadWebdav(file: string, settings: BackupSettings): Promise<void> {
    const row = await this.prisma.app_settings.findUnique({ where: { key: backupSettingsKey } });
    const password = row?.secretCiphertext
      ? this.secrets.decryptSecretRecord(row.secretCiphertext).password
      : '';
    const base = settings.webdavUrl.replace(/\/+$/, '');
    const path = settings.webdavPath.replace(/^\/+|\/+$/g, '');
    const url = `${base}/${path}/${file.split(/[\\/]/).pop()}`;
    const auth = Buffer.from(`${settings.webdavUser}:${password}`).toString('base64');
    const response = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/octet-stream' },
      body: readFileSync(file),
    });
    if (!response.ok) throw new ServiceUnavailableException(`WebDAV 上传失败 (${response.status})`);
  }

  private async prune(retention: number): Promise<void> {
    const files = this.listLocal();
    for (const file of files.slice(Math.max(0, retention))) {
      try { unlinkSync(join(BACKUP_DIR, file.name)); } catch { /* noop */ }
    }
  }

  private async schedule(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const settings = await this.getSettings();
    if (!settings.enabled) return;
    this.timer = setInterval(() => void this.createBackup().catch((error) => this.logger.error(error)), settings.intervalHours * 3600 * 1000);
  }
}

function statSafe(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}
