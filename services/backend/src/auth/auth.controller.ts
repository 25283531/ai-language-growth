import { Body, Controller, Get, Headers, HttpException, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService, extractBearerToken } from './auth.service';
import { EmailService } from './email.service';
import { ProviderConfigService } from '../providers/provider-config.service';

const registerSchema = z.object({
  email: z.string(),
  password: z.string(),
  displayName: z.string().max(80).optional(),
});
const loginSchema = z.object({ email: z.string(), password: z.string() });
const forgotSchema = z.object({ email: z.string() });
const resetSchema = z.object({ token: z.string(), newPassword: z.string() });

function setSessionCookie(response: Response, token: string, expiresAt: Date, secure: boolean) {
  response.setHeader(
    'Set-Cookie',
    `alg_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax;${secure ? ' Secure;' : ''} Expires=${expiresAt.toUTCString()}`,
  );
}

function clearSessionCookie(response: Response) {
  response.setHeader('Set-Cookie', 'alg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly email: EmailService,
  ) {}

  @Post('register')
  async register(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) throw new HttpException({ message: '注册信息不完整', detail: parsed.error.flatten() }, 400);
    const result = await this.auth.register(parsed.data);
    setSessionCookie(response, result.accessToken, result.expiresAt, process.env.NODE_ENV === 'production');
    return result;
  }

  @Post('login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new HttpException({ message: '登录信息不完整' }, 400);
    const result = await this.auth.login(parsed.data);
    setSessionCookie(response, result.accessToken, result.expiresAt, process.env.NODE_ENV === 'production');
    return result;
  }

  @Get('me')
  async me(@Headers('authorization') authorization?: string, @Headers('cookie') cookie?: string) {
    return { user: await this.auth.me(extractBearerToken(authorization, cookie)) };
  }

  @Post('logout')
  async logout(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(extractBearerToken(authorization, cookie));
    clearSessionCookie(response);
    return { ok: true };
  }

  @Post('forgot-password')
  async forgotPassword(@Body() body: unknown) {
    const parsed = forgotSchema.safeParse(body);
    if (!parsed.success) throw new HttpException({ message: '请输入邮箱地址' }, 400);
    const result = await this.auth.requestPasswordReset(parsed.data.email);
    if (result.token && result.userId) {
      const email = await this.auth.getEmailForUser(result.userId);
      if (email) await this.email.sendPasswordReset({ to: email, token: result.token });
    }
    return { message: '如果该邮箱已注册，密码重置邮件将在几分钟内发送。' };
  }

  @Post('reset-password')
  async resetPassword(@Body() body: unknown) {
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) throw new HttpException({ message: '重置参数不完整' }, 400);
    await this.auth.resetPassword(parsed.data.token, parsed.data.newPassword);
    return { message: '密码已重置，请使用新密码登录。' };
  }
}

@Controller('api/v1/admin/email')
export class EmailAdminController {
  constructor(
    private readonly email: EmailService,
    private readonly adminConfig: ProviderConfigService,
  ) {}

  @Get('status')
  status(@Headers('x-admin-token') token: string | undefined) {
    this.adminConfig.assertAdminToken(token);
    return { configured: this.email.isConfigured() };
  }
}
