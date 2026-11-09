import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const COOKIE_NAME = 'alg_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

@Injectable()
export class AdminAuthService {
  private config(): { username: string; password: string; secret: string } {
    const username = process.env.ADMIN_USERNAME?.trim();
    const password = process.env.ADMIN_PASSWORD;
    if (!username || !password) {
      throw new ServiceUnavailableException(
        '管理后台未配置：请设置 ADMIN_USERNAME 和 ADMIN_PASSWORD',
      );
    }
    const secret = process.env.ADMIN_SESSION_SECRET?.trim() || `${username}:${password}`;
    return { username, password, secret };
  }

  login(usernameInput: unknown, passwordInput: unknown): { expiresAt: string; username: string } {
    const { username, password, secret } = this.config();
    if (
      typeof usernameInput !== 'string' ||
      typeof passwordInput !== 'string' ||
      usernameInput !== username ||
      !this.safeEqual(passwordInput, password)
    ) {
      throw new UnauthorizedException('管理员账号或密码不正确');
    }
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const payload = base64url(JSON.stringify({ sub: username, exp: expiresAt }));
    return {
      username,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  createSession(username: string): { token: string; expiresAt: string } {
    const { secret } = this.config();
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const payload = base64url(JSON.stringify({ sub: username, exp: expiresAt }));
    return {
      token: `${payload}.${this.sign(payload, secret)}`,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  resolveRequest(request: Pick<Request, 'headers'>): string {
    const token =
      cookieValue(request.headers.cookie, COOKIE_NAME) ||
      this.bearer(request.headers.authorization);
    if (!token) throw new UnauthorizedException('请先登录管理后台');
    const [payload, signature] = token.split('.');
    if (!payload || !signature) throw new UnauthorizedException('管理登录已失效');
    const { username, secret } = this.config();
    const expected = this.sign(payload, secret);
    if (!this.safeEqual(signature, expected)) {
      throw new UnauthorizedException('管理登录已失效');
    }
    try {
      const body = JSON.parse(decodeBase64url(payload)) as { sub?: string; exp?: number };
      if (body.sub !== username || !body.exp || body.exp <= Math.floor(Date.now() / 1000)) {
        throw new Error('expired');
      }
      return username;
    } catch {
      throw new UnauthorizedException('管理登录已失效');
    }
  }

  cookie(token: string, expiresAt: string): string {
    const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax;${secure} Expires=${new Date(expiresAt).toUTCString()}`;
  }

  clearCookie(): string {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  isAuthPath(path: string): boolean {
    return ['/auth/login', '/auth/me', '/auth/logout'].includes(path);
  }

  private sign(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  private safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private bearer(value: string | undefined): string | undefined {
    return value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  }
}
