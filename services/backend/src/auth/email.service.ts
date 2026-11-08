import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../config/config.module';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.mail.host && this.config.mail.user && this.config.mail.password && this.config.mail.from);
  }

  async sendPasswordReset(input: { to: string; token: string }): Promise<void> {
    const url = `${this.config.mail.resetUrl}?token=${encodeURIComponent(input.token)}`;
    if (!this.isConfigured()) {
      if (this.config.mail.disabled || this.config.nodeEnv !== 'production') {
        this.logger.warn(`邮件未配置，开发模式密码重置链接：${url}`);
        return;
      }
      throw new ServiceUnavailableException('服务端尚未配置邮箱发送功能');
    }
    const transporter = nodemailer.createTransport({
      host: this.config.mail.host,
      port: this.config.mail.port,
      secure: this.config.mail.secure,
      auth: { user: this.config.mail.user, pass: this.config.mail.password },
    });
    await transporter.sendMail({
      from: this.config.mail.from,
      replyTo: this.config.mail.replyTo || undefined,
      to: input.to,
      subject: 'AI Language Growth 密码重置',
      text: `请在 30 分钟内打开以下链接重置密码：${url}`,
      html: `<p>请在 30 分钟内完成密码重置。</p><p><a href="${url}">重置密码</a></p>`,
    });
  }
}
