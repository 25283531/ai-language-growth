import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';

export const MEMBERSHIP_TIERS = ['guest', 'free', 'member', 'advanced'] as const;
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIMPLE_PASSWORDS = new Set([
  '12345678',
  '00000000',
  '11111111',
  '22222222',
  '87654321',
  'password',
  'password1',
  'abcdefgh',
  'qwertyui',
]);

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function assertPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8) {
    throw new ConflictException('密码至少需要 8 位');
  }
  const normalized = value.toLowerCase();
  if (
    SIMPLE_PASSWORDS.has(normalized) ||
    /^(.)\1+$/.test(value) ||
    /^(?:0123456789|123456789|9876543210|876543210)$/.test(value) ||
    /^(?:abcdefgh|bcdefghi|qwertyui)$/i.test(value)
  ) {
    throw new ConflictException('密码过于简单，请换一个密码');
  }
  return value;
}

export function assertEmail(value: unknown): string {
  const email = normalizeEmail(value);
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new ConflictException('请输入有效的邮箱地址');
  }
  return email;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  membershipTier: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    membershipTier: user.membershipTier,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
  };
}

@Injectable()
export class AuthService {
  private readonly sessionDays = 30;

  constructor(private readonly prisma: PrismaService) {}

  async register(input: { email: unknown; password: unknown; displayName?: unknown }) {
    const email = assertEmail(input.email);
    const password = assertPassword(input.password);
    const displayName =
      typeof input.displayName === 'string' && input.displayName.trim()
        ? input.displayName.trim().slice(0, 80)
        : (email.split('@')[0] ?? '家长').slice(0, 80);
    const existing = await this.prisma.users.findUnique({ where: { email } });
    if (existing) throw new ConflictException('该邮箱已注册，请直接登录');

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.users.create({
        data: {
          email,
          passwordHash,
          displayName,
          membershipTier: 'free',
        },
      });
      await tx.learner_profiles.create({
        data: {
          userId: created.id,
          guardianId: created.id,
          displayName,
          membershipTier: 'free',
        },
      });
      await tx.membership_events.create({
        data: {
          userId: created.id,
          fromTier: 'guest',
          toTier: 'free',
          source: 'registration',
          note: '注册账户默认开通免费会员',
        },
      });
      return created;
    });

    const session = await this.createSession(user.id);
    return { user: publicUser(user), ...session };
  }

  async login(input: { email: unknown; password: unknown }) {
    const email = assertEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    const user = await this.prisma.users.findUnique({ where: { email } });
    if (!user || user.disabledAt || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('邮箱或密码不正确');
    }
    const session = await this.createSession(user.id);
    return { user: publicUser(user), ...session };
  }

  async createSession(userId: string) {
    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.sessionDays * 24 * 60 * 60 * 1000);
    await this.prisma.auth_sessions.create({
      data: { userId, tokenHash: hashToken(rawToken), expiresAt },
    });
    return { accessToken: rawToken, expiresAt };
  }

  async resolveSession(rawToken: string | undefined) {
    if (!rawToken) throw new UnauthorizedException('请先登录');
    const session = await this.prisma.auth_sessions.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.disabledAt) {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    await this.prisma.auth_sessions.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });
    return session.user;
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.prisma.auth_sessions.updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async requestPasswordReset(emailInput: unknown): Promise<{ token?: string; userId?: string }> {
    const email = normalizeEmail(emailInput);
    const user = await this.prisma.users.findUnique({ where: { email } });
    if (!user || user.disabledAt) return {};
    const rawToken = randomBytes(32).toString('base64url');
    await this.prisma.$transaction([
      this.prisma.password_reset_tokens.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.password_reset_tokens.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      }),
    ]);
    return { token: rawToken, userId: user.id };
  }

  async getEmailForUser(userId: string): Promise<string | null> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return user?.email ?? null;
  }

  async resetPassword(rawToken: unknown, newPassword: unknown): Promise<void> {
    if (typeof rawToken !== 'string' || rawToken.length < 20) {
      throw new UnauthorizedException('重置链接无效或已过期');
    }
    const password = assertPassword(newPassword);
    const reset = await this.prisma.password_reset_tokens.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (!reset || reset.usedAt || reset.expiresAt <= new Date()) {
      throw new UnauthorizedException('重置链接无效或已过期');
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await this.prisma.$transaction(async (tx) => {
      await tx.users.update({
        where: { id: reset.userId },
        data: { passwordHash, passwordChangedAt: new Date() },
      });
      await tx.password_reset_tokens.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      });
      await tx.auth_sessions.updateMany({
        where: { userId: reset.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  async me(rawToken: string | undefined) {
    return publicUser(await this.resolveSession(rawToken));
  }

  async assertLearnerOwnership(rawToken: string | undefined, learnerId: string): Promise<string> {
    const user = await this.resolveSession(rawToken);
    const learner = await this.prisma.learner_profiles.findUnique({
      where: { id: learnerId },
      select: { userId: true, guardianId: true },
    });
    if (!learner || learner.userId !== user.id || learner.guardianId !== user.id) {
      throw new ForbiddenException('无权访问该学习者档案');
    }
    return user.id;
  }

  async assertReservationOwnership(rawToken: string | undefined, reservationId: string): Promise<void> {
    const reservation = await this.prisma.speech_quota_reservations.findUnique({
      where: { id: reservationId },
      select: { learnerId: true },
    });
    if (!reservation) throw new UnauthorizedException('额度租约无效');
    await this.assertLearnerOwnership(rawToken, reservation.learnerId);
  }
}

export function extractBearerToken(authorization: string | undefined, cookieHeader?: string): string | undefined {
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const cookie = cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('alg_session='));
  return cookie?.slice('alg_session='.length);
}
