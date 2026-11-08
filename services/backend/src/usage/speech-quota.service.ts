import { ConflictException, HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type SpeechQuotaKind = 'asr' | 'tts' | 'pronunciation';

type Bucket = {
  id: string;
  learnerId: string;
  usageDate: Date;
  serviceKind: string;
  limitUnits: number;
  reservedUnits: number;
  consumedUnits: number;
};

const DEFAULT_LIMITS: Record<SpeechQuotaKind, number> = {
  asr: 300,
  tts: 300,
  pronunciation: 300,
};
const UNLIMITED_LIMIT = Number.MAX_SAFE_INTEGER;
type MembershipTier = 'guest' | 'free' | 'member' | 'advanced';

class QuotaExceededException extends HttpException {
  constructor(message = '今日语音额度不足，已阻止本次请求') {
    super(message, 429);
  }
}

function utcDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function validKind(value: string): SpeechQuotaKind {
  if (value === 'asr' || value === 'tts' || value === 'pronunciation') return value;
  throw new ConflictException('不支持的语音额度类型');
}

@Injectable()
export class SpeechQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 断网、进程退出或客户端崩溃时，短期租约不能永久占住当天额度。
   * 用条件更新抢占每条租约，避免并发清理重复扣减 reservedUnits。
   */
  private async reapExpired(): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const expired = await tx.speech_quota_reservations.findMany({
        where: { status: 'reserved', expiresAt: { lte: now } },
        select: { id: true, bucketId: true, requestedUnits: true },
      });
      for (const reservation of expired) {
        const claimed = await tx.speech_quota_reservations.updateMany({
          where: { id: reservation.id, status: 'reserved' },
          data: { status: 'released', settledAt: now },
        });
        if (claimed.count === 1) {
          await tx.speech_quota_buckets.update({
            where: { id: reservation.bucketId },
            data: { reservedUnits: { decrement: reservation.requestedUnits } },
          });
        }
      }
    });
  }

  private async membershipTier(learnerId: string): Promise<MembershipTier> {
    const learner = await this.prisma.learner_profiles.findUnique({
      where: { id: learnerId },
      select: { membershipTier: true },
    });
    const tier = learner?.membershipTier;
    return tier === 'free' || tier === 'member' || tier === 'advanced' ? tier : 'guest';
  }

  private limitFor(kind: SpeechQuotaKind, tier: MembershipTier): number {
    if (tier === 'guest') return 0;
    if (tier === 'advanced') return UNLIMITED_LIMIT;
    const envName = `${tier.toUpperCase()}_${kind.toUpperCase()}_DAILY_QUOTA_SECONDS`;
    const configured = Number(process.env[envName]);
    if (Number.isFinite(configured) && configured >= 0) return configured;
    if (tier === 'free') {
      const legacy = Number(process.env[`${kind.toUpperCase()}_DAILY_QUOTA_SECONDS`]);
      return Number.isFinite(legacy) && legacy >= 0 ? legacy : DEFAULT_LIMITS[kind];
    }
    return DEFAULT_LIMITS[kind] * 6;
  }

  async status(learnerId: string) {
    await this.reapExpired();
    const date = utcDate();
    const tier = await this.membershipTier(learnerId);
    const rows = await this.prisma.speech_quota_buckets.findMany({
      where: { learnerId, usageDate: date },
    });
    const byService = (['asr', 'tts', 'pronunciation'] as SpeechQuotaKind[]).reduce(
      (result, kind) => {
        const row = rows.find((item) => item.serviceKind === kind);
        const limit = this.limitFor(kind, tier);
        const used = row?.consumedUnits ?? 0;
        const reserved = row?.reservedUnits ?? 0;
        result[kind] = {
          limitSeconds: tier === 'advanced' ? null : limit,
          unlimited: tier === 'advanced',
          consumedSeconds: used,
          reservedSeconds: reserved,
          remainingSeconds: tier === 'advanced' ? null : Math.max(0, limit - used - reserved),
        };
        return result;
      },
      {} as Record<string, unknown>,
    );
    return { learnerId, membershipTier: tier, usageDate: date.toISOString().slice(0, 10), byService };
  }

  async reserve(input: {
    learnerId: string;
    serviceKind: string;
    units: number;
    idempotencyKey: string;
    ttlSeconds?: number;
  }) {
    await this.reapExpired();
    const serviceKind = validKind(input.serviceKind);
    const tier = await this.membershipTier(input.learnerId);
    const units = Number(input.units);
    if (!Number.isFinite(units) || units <= 0 || units > 120) {
      throw new ConflictException('预留时长必须在 0 到 120 秒之间');
    }
    const existing = await this.prisma.speech_quota_reservations.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { bucket: true },
    });
    if (existing) {
      if (existing.learnerId !== input.learnerId || existing.serviceKind !== serviceKind) {
        throw new ConflictException('额度请求幂等键已用于其他学习者或服务');
      }
      return this.publicReservation(existing, existing.bucket);
    }

    const date = utcDate();
    const limitUnits = this.limitFor(serviceKind, tier);
    const ttl = Math.max(30, Math.min(600, input.ttlSeconds ?? 180));
    try {
      const reservation = await this.prisma.$transaction(async (tx) => {
        await tx.speech_quota_buckets.upsert({
          where: {
            learnerId_usageDate_serviceKind: { learnerId: input.learnerId, usageDate: date, serviceKind },
          },
          create: {
            learnerId: input.learnerId,
            usageDate: date,
            serviceKind,
            limitUnits,
          },
          update: { limitUnits },
        });
        const updated = await tx.speech_quota_buckets.updateMany({
          where: {
            learnerId: input.learnerId,
            usageDate: date,
            serviceKind,
            limitUnits: { gte: 0 },
          },
          data: { reservedUnits: { increment: units } },
        });
        const bucket = await tx.speech_quota_buckets.findUniqueOrThrow({
          where: {
            learnerId_usageDate_serviceKind: { learnerId: input.learnerId, usageDate: date, serviceKind },
          },
        });
        if (updated.count !== 1 || bucket.consumedUnits + bucket.reservedUnits > bucket.limitUnits) {
          throw new QuotaExceededException();
        }
        return tx.speech_quota_reservations.create({
          data: {
            learnerId: input.learnerId,
            serviceKind,
            requestedUnits: units,
            idempotencyKey: input.idempotencyKey,
            expiresAt: new Date(Date.now() + ttl * 1000),
            bucketId: bucket.id,
          },
          include: { bucket: true },
        });
      }, { isolationLevel: 'Serializable' });
      return this.publicReservation(reservation, reservation.bucket);
    } catch (error) {
      // The optimistic increment above is rolled back with the transaction.
      if (error instanceof QuotaExceededException) throw error;
      throw error;
    }
  }

  async settle(reservationId: string, actualUnits: number) {
    const units = Number(actualUnits);
    if (!Number.isFinite(units) || units < 0) throw new ConflictException('实际用量不合法');
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.speech_quota_reservations.findUnique({
        where: { id: reservationId },
        include: { bucket: true },
      });
      if (!reservation) throw new ConflictException('额度租约不存在');
      if (reservation.status !== 'reserved') return this.publicReservation(reservation, reservation.bucket);
      if (reservation.expiresAt.getTime() <= Date.now()) {
        throw new QuotaExceededException('额度租约已过期，不能结算');
      }
      const consumed = Math.min(units, reservation.requestedUnits);
      await tx.speech_quota_buckets.update({
        where: { id: reservation.bucketId },
        data: {
          reservedUnits: { decrement: reservation.requestedUnits },
          consumedUnits: { increment: consumed },
        },
      });
      const updated = await tx.speech_quota_reservations.update({
        where: { id: reservation.id },
        data: { status: 'settled', consumedUnits: consumed, settledAt: new Date() },
        include: { bucket: true },
      });
      return this.publicReservation(updated, updated.bucket);
    }, { isolationLevel: 'Serializable' });
  }

  async release(reservationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.speech_quota_reservations.findUnique({
        where: { id: reservationId },
        include: { bucket: true },
      });
      if (!reservation) throw new ConflictException('额度租约不存在');
      if (reservation.status !== 'reserved') return this.publicReservation(reservation, reservation.bucket);
      await tx.speech_quota_buckets.update({
        where: { id: reservation.bucketId },
        data: { reservedUnits: { decrement: reservation.requestedUnits } },
      });
      const updated = await tx.speech_quota_reservations.update({
        where: { id: reservation.id },
        data: { status: 'released', settledAt: new Date() },
        include: { bucket: true },
      });
      return this.publicReservation(updated, updated.bucket);
    }, { isolationLevel: 'Serializable' });
  }

  async assertReservation(input: { reservationId: string; learnerId: string; serviceKind: SpeechQuotaKind }) {
    await this.reapExpired();
    const tier = await this.membershipTier(input.learnerId);
    if (tier === 'guest') {
      throw new QuotaExceededException('当前账户不允许使用云端语音；请使用设备自带语音播放');
    }
    const reservation = await this.prisma.speech_quota_reservations.findUnique({
      where: { id: input.reservationId },
    });
    if (
      !reservation ||
      reservation.learnerId !== input.learnerId ||
      reservation.serviceKind !== input.serviceKind ||
      reservation.status !== 'reserved' ||
      reservation.expiresAt.getTime() <= Date.now()
    ) {
      throw new QuotaExceededException('语音额度租约无效或已过期，已阻止本次请求');
    }
    return reservation;
  }

  private publicReservation(
    reservation: { id: string; serviceKind: string; requestedUnits: number; consumedUnits: number; status: string; expiresAt: Date },
    bucket: Bucket,
  ) {
    return {
      reservationId: reservation.id,
      serviceKind: reservation.serviceKind,
      reservedSeconds: reservation.requestedUnits,
      consumedSeconds: reservation.consumedUnits,
      status: reservation.status,
      expiresAt: reservation.expiresAt.toISOString(),
      remainingSeconds: bucket.limitUnits >= UNLIMITED_LIMIT ? null : Math.max(0, bucket.limitUnits - bucket.consumedUnits - bucket.reservedUnits),
    };
  }
}
