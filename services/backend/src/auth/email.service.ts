import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderConfigService } from '../providers/provider-config.service';
import { z } from 'zod';

const smtpSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().min(1).max(255),
  from: z.string().trim().min(3).max(255),
  replyTo: z.string().trim().max(255).optional().default(''),
  resetUrl: z.string().url().max(2048),
  password: z.string().max(4096).optional(),
});

type SmtpSettings = z.infer<typeof smtpSchema>;
type PublicSmtpSettings = Omit<SmtpSettings, 'password'> & { passwordConfigured: boolean };

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly secrets: ProviderConfigService,
  ) {}

  async getSettings(): Promise<PublicSmtpSettings | null> {
    const row = await this.prisma.app_settings.findUnique({ where: { key: 'smtp' } });
    if (!row) {
      if (!this.config.mail.host) return null;
      return {
        host: this.config.mail.host,
        port: this.config.mail.port,
        secure: this.config.mail.secure,
        user: this.config.mail.user ?? '',
        from: this.config.mail.from ?? '',
        replyTo: this.config.mail.replyTo ?? '',
        resetUrl: this.config.mail.resetUrl,
        passwordConfigured: Boolean(this.config.mail.password),
      };
    }
    const value = smtpSchema.omit({ password: true }).parse(row.value);
    return { ...value, passwordConfigured: Boolean(row.secretCiphertext) };
  }

  async isConfigured(): Promise<boolean> {
    const settings = await this.loadSettings();
    return Boolean(settings?.host && settings.user && settings.password && settings.from);
  }

  async saveSettings(input: unknown): Promise<PublicSmtpSettings | null> {
    const parsed = smtpSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const value = parsed.data;
    const existing = await this.prisma.app_settings.findUnique({ where: { key: 'smtp' } });
    const existingSecret = existing?.secretCiphertext
      ? this.secrets.decryptSecretRecord(existing.secretCiphertext).password
      : undefined;
    const password = value.password?.trim() || existingSecret;
    if (!password) throw new BadRequestException('请填写 SMTP 密码');
    const secretCiphertext = this.secrets.encryptSecretRecord({ password });
    await this.prisma.app_settings.upsert({
      where: { key: 'smtp' },
      create: {
        key: 'smtp',
        value: { host: value.host, port: value.port, secure: value.secure, user: value.user, from: value.from, replyTo: value.replyTo, resetUrl: value.resetUrl },
        secretCiphertext,
      },
      update: {
        value: { host: value.host, port: value.port, secure: value.secure, user: value.user, from: value.from, replyTo: value.replyTo, resetUrl: value.resetUrl },
        secretCiphertext,
      },
    });
    return this.getSettings();
  }

  async testSettings(): Promise<{ ok: true }> {
    const settings = await this.loadSettings();
    if (!settings?.host || !settings.user || !settings.password || !settings.from) {
      throw new ServiceUnavailableException('SMTP 尚未配置完整');
    }
    const transporter = nodemailer.createTransport({
      host: settings.host, port: settings.port, secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
    });
    await transporter.verify();
    return { ok: true };
  }

  async sendPasswordReset(input: { to: string; token: string }): Promise<void> {
    const settings = await this.loadSettings();
    const url = `${settings?.resetUrl ?? this.config.mail.resetUrl}?token=${encodeURIComponent(input.token)}`;
    if (!settings?.host || !settings.user || !settings.password || !settings.from) {
      if (this.config.mail.disabled || this.config.nodeEnv !== 'production') {
        this.logger.warn(`邮件未配置，开发模式密码重置链接：${url}`);
        return;
      }
      throw new ServiceUnavailableException('服务端尚未配置邮箱发送功能');
    }
    const transporter = nodemailer.createTransport({
      host: settings.host, port: settings.port, secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
    });
    await transporter.sendMail({
      from: settings.from,
      replyTo: settings.replyTo || undefined,
      to: input.to,
      subject: 'AI Language Growth 密码重置',
      text: `请在 30 分钟内打开以下链接重置密码：${url}`,
      html: `<p>请在 30 分钟内完成密码重置。</p><p><a href="${url}">重置密码</a></p>`,
    });
  }

  private async loadSettings(): Promise<(SmtpSettings & { password?: string }) | null> {
    const row = await this.prisma.app_settings.findUnique({ where: { key: 'smtp' } });
    if (!row) {
      return this.config.mail.host
        ? {
          host: this.config.mail.host, port: this.config.mail.port, secure: this.config.mail.secure,
          user: this.config.mail.user ?? '', from: this.config.mail.from ?? '',
          replyTo: this.config.mail.replyTo ?? '', resetUrl: this.config.mail.resetUrl,
          password: this.config.mail.password,
        }
        : null;
    }
    const value = smtpSchema.omit({ password: true }).parse(row.value);
    const password = row.secretCiphertext
      ? this.secrets.decryptSecretRecord(row.secretCiphertext).password
      : undefined;
    return { ...value, password };
  }
}
