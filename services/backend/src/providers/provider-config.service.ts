import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  PROVIDER_SERVICE_KINDS,
  SERVICE_KINDS,
  type ProviderServiceKind,
  type ServiceKind,
} from '@alg/shared-contracts';
import {
  getProviderPreset,
  listProviderPresets,
  type ProviderPreset,
} from '@alg/ai-provider-sdk';
import { PrismaService } from '../prisma/prisma.service';

const configInput = z.object({
  id: z.string().uuid().optional(),
  serviceKind: z.enum(PROVIDER_SERVICE_KINDS),
  providerPresetId: z.string().min(1).max(80),
  baseUrl: z.string().url().max(2048),
  modelAlias: z.string().trim().min(1).max(160),
  priority: z.number().int().min(1).max(10000).default(100),
  timeoutMs: z.number().int().min(100).max(120000).default(20000),
  apiKey: z.string().max(4096).optional(),
  credentials: z.record(z.string().max(4096)).default({}),
  enabled: z.boolean(),
  options: z.record(z.unknown()).default({}),
});
const benchmarkInput = z.object({
  serviceKind: z.enum(SERVICE_KINDS),
  configId: z.string().uuid().optional(),
  modelAlias: z.string().trim().min(1).max(160),
  score: z.number().finite(),
  sampleCount: z.number().int().min(1).max(100000),
  passed: z.boolean(),
  notes: z.string().max(2000).optional(),
});
const priceTypeSchema = z.enum([
  'input_token',
  'output_token',
  'per_character',
  'per_second',
  'per_call',
]);
const pricesInput = z.object({
  serviceKind: z.enum(PROVIDER_SERVICE_KINDS),
  configId: z.string().uuid().optional(),
  modelAlias: z.string().trim().min(1).max(160),
  prices: z.array(z.object({
    priceType: priceTypeSchema,
    unitPrice: z.number().finite().min(0).max(1_000_000),
  })).max(5),
});

export type ProviderConfigInput = z.input<typeof configInput>;

export interface PublicProviderConfig {
  id: string;
  serviceKind: ProviderServiceKind;
  providerPresetId: string;
  providerName: string;
  protocol: ProviderPreset['protocol'];
  baseUrl: string;
  modelAlias: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  credentialConfigured: boolean;
  options: Record<string, unknown>;
  updatedAt: string | null;
}

export interface RuntimeProviderConfig extends PublicProviderConfig {
  serviceKind: ServiceKind;
  apiKey?: string;
  credentials: Record<string, string>;
}

@Injectable()
export class ProviderConfigService {
  constructor(private readonly prisma: PrismaService) {}

  listCatalog(): ProviderPreset[] {
    return listProviderPresets();
  }

  async listPublicConfigs(): Promise<PublicProviderConfig[]> {
    const rows = await this.prisma.ai_provider_configs.findMany({
      orderBy: [{ serviceKind: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toPublic(row));
  }

  async listEnabledRuntimeConfigs(): Promise<RuntimeProviderConfig[]> {
    const rows = await this.prisma.ai_provider_configs.findMany({
      where: { enabled: true, serviceKind: { in: [...SERVICE_KINDS] } },
      orderBy: [{ serviceKind: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => {
      const config = this.toPublic(row);
      return {
        ...config,
        serviceKind: row.serviceKind as ServiceKind,
        credentials: row.credentialsCiphertext ? this.decrypt(row.credentialsCiphertext) : {},
      };
    });
  }

  async getEnabledRuntimeConfig(serviceKind: ServiceKind): Promise<RuntimeProviderConfig | undefined> {
    const row = await this.prisma.ai_provider_configs.findFirst({
      where: { serviceKind, enabled: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    if (!row?.enabled) return undefined;
    const config = this.toPublic(row);
    return {
      ...config,
      serviceKind,
      credentials: row.credentialsCiphertext ? this.decrypt(row.credentialsCiphertext) : {},
    };
  }

  async save(input: ProviderConfigInput): Promise<PublicProviderConfig> {
    const parsed = configInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const value = parsed.data;
    const preset = getProviderPreset(value.providerPresetId);
    if (!preset) throw new BadRequestException('未找到所选平台预置');
    if (!preset.services.includes(value.serviceKind)) {
      throw new BadRequestException(`${preset.name} 当前未配置 ${value.serviceKind.toUpperCase()} 协议`);
    }

    const existing = value.id
      ? await this.prisma.ai_provider_configs.findFirst({ where: { id: value.id, serviceKind: value.serviceKind } })
      : undefined;
    if (value.id && !existing) throw new BadRequestException('模型配置不存在或服务类型不匹配');
    const credentials = { ...value.credentials };
    if (value.apiKey?.trim()) credentials.apiKey = value.apiKey.trim();
    const requiredCredentialFields: Record<string, string[]> = {
      'baidu-qianfan': ['apiKey', 'secretKey'],
      'iflytek-spark': ['appId', 'apiKey', 'apiSecret'],
      'minimax': ['apiKey'],
      'volcengine': ['apiKey'],
      siliconflow: ['apiKey'],
      'tencent-cloud': ['secretId', 'secretKey'],
      'tencent-hunyuan': ['apiKey'],
      'bailian': ['apiKey'],
      'tencent-soe': ['appId', 'secretId', 'secretKey'],
      'azure-speech': ['subscriptionKey'],
      speechace: ['apiKey'],
      chivox: ['apiKey'],
    };
    const required = preset.id === 'iflytek-spark'
      ? value.serviceKind === 'pronunciation' ? ['appId', 'apiKey']
        : value.serviceKind === 'llm' ? ['apiKey'] : ['appId', 'apiKey', 'apiSecret']
      : requiredCredentialFields[preset.id] ?? [];
    const sameProvider = existing?.providerPresetId === preset.id;
    const existingCredentials = sameProvider && existing?.credentialsCiphertext
      ? this.decrypt(existing.credentialsCiphertext)
      : {};
    if (value.enabled && preset.credentialRequired && required.some((key) => !credentials[key]?.trim() && !existingCredentials[key]?.trim())) {
      throw new BadRequestException(`启用此平台前请填写：${required.join('、')}`);
    }
    const mergedCredentials = {
      ...existingCredentials,
      ...Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, value.trim()]).filter(([, value]) => Boolean(value))),
    };
    const credentialsCiphertext = Object.keys(mergedCredentials).length
      ? this.encrypt(mergedCredentials)
      : sameProvider ? existing?.credentialsCiphertext ?? null : null;
    const row = existing
      ? await this.prisma.ai_provider_configs.update({
        where: { id: existing.id },
        data: {
          providerPresetId: preset.id,
          protocol: preset.protocol,
          baseUrl: value.baseUrl,
          modelAlias: value.modelAlias,
          credentialsCiphertext,
          enabled: value.enabled,
          priority: value.priority,
          timeoutMs: value.timeoutMs,
          options: value.options as Prisma.InputJsonValue,
        },
      })
      : await this.prisma.ai_provider_configs.create({
        data: {
        serviceKind: value.serviceKind,
        providerPresetId: preset.id,
        protocol: preset.protocol,
        baseUrl: value.baseUrl,
        modelAlias: value.modelAlias,
        credentialsCiphertext,
        enabled: value.enabled,
        priority: value.priority,
        timeoutMs: value.timeoutMs,
        options: value.options as Prisma.InputJsonValue,
      },
    });
    await this.syncModelCatalog(value, row.id);
    return this.toPublic(row);
  }

  async deleteConfig(id: string) {
    const config = await this.prisma.ai_provider_configs.findUnique({ where: { id } });
    if (!config) throw new BadRequestException('模型配置不存在');
    await this.prisma.ai_provider_configs.delete({ where: { id } });
    if (config.serviceKind === 'pronunciation') {
      await this.prisma.ai_providers.updateMany({
        where: { alias: `configured_pronunciation_${id}` },
        data: { enabled: false },
      });
    }
    return { id, serviceKind: config.serviceKind as ProviderServiceKind };
  }

  async listBenchmarks(serviceKind: ServiceKind, configId?: string) {
    const provider = await this.prisma.ai_providers.findUnique({
      where: { alias: this.providerAlias(serviceKind, configId) },
      select: { id: true },
    });
    if (!provider) return [];
    const models = await this.prisma.ai_models.findMany({
      where: { providerId: provider.id },
      include: { benchmarks: { orderBy: { testedAt: 'desc' }, take: 10 } },
      orderBy: { createdAt: 'desc' },
    });
    return models.map((model) => ({
      modelAlias: model.alias,
      level: model.level,
      enabled: model.enabled,
      benchmarks: model.benchmarks,
    }));
  }

  async listRuntimeScores(serviceKind: ServiceKind) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.ai_usage_logs.findMany({
      where: { serviceKind, createdAt: { gte: since } },
      select: { providerAlias: true, modelAlias: true, latencyMs: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const grouped = new Map<string, {
      providerAlias: string;
      modelAlias: string;
      calls: number;
      latencyTotal: number;
      lastUsedAt: Date;
    }>();
    for (const row of rows) {
      const key = `${row.providerAlias}\u0000${row.modelAlias}`;
      const item = grouped.get(key) ?? {
        providerAlias: row.providerAlias,
        modelAlias: row.modelAlias,
        calls: 0,
        latencyTotal: 0,
        lastUsedAt: row.createdAt,
      };
      item.calls += 1;
      item.latencyTotal += row.latencyMs;
      grouped.set(key, item);
    }
    return [...grouped.values()].map((item) => {
      const averageLatencyMs = Math.round(item.latencyTotal / item.calls);
      const latencyScore = Math.max(0, Math.min(100, Math.round(100 * (1 - averageLatencyMs / 10000))));
      return {
        providerAlias: item.providerAlias,
        modelAlias: item.modelAlias,
        calls: item.calls,
        averageLatencyMs,
        lastUsedAt: item.lastUsedAt.toISOString(),
        latencyScore,
        scoreLabel: '运行速度分',
      };
    });
  }

  async recordBenchmark(input: unknown) {
    const parsed = benchmarkInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const value = parsed.data;
    const provider = await this.prisma.ai_providers.findUnique({
      where: { alias: this.providerAlias(value.serviceKind, value.configId) },
      select: { id: true },
    });
    if (!provider) throw new BadRequestException('请先保存该服务的模型接入配置');
    const model = await this.prisma.ai_models.findUnique({
      where: { providerId_alias: { providerId: provider.id, alias: value.modelAlias } },
      select: { id: true },
    });
    if (!model) throw new BadRequestException('当前服务配置中没有该模型');
    const benchmark = await this.prisma.ai_model_benchmarks.create({
      data: {
        modelId: model.id,
        benchmarkType: `${value.serviceKind}_child_english`,
        score: value.score,
        sampleCount: value.sampleCount,
        passed: value.passed,
        notes: value.notes?.trim() || null,
      },
    });
    return { ...benchmark, serviceKind: value.serviceKind, configId: value.configId };
  }

  async listPrices(serviceKind: ProviderServiceKind, configId?: string) {
    const provider = await this.prisma.ai_providers.findUnique({
      where: { alias: this.providerAlias(serviceKind, configId) },
      select: { id: true },
    });
    if (!provider) return [];
    const model = await this.prisma.ai_models.findFirst({
      where: { providerId: provider.id, enabled: true },
      include: { prices: { orderBy: { priceType: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return model?.prices.map(({ id, priceType, unitPrice, checkedAt }) => ({
      id,
      serviceKind,
      modelAlias: model.alias,
      priceType,
      unitPrice,
      checkedAt: checkedAt.toISOString(),
    })) ?? [];
  }

  async savePrices(input: unknown) {
    const parsed = pricesInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const value = parsed.data;
    if (new Set(value.prices.map((price) => price.priceType)).size !== value.prices.length) {
      throw new BadRequestException('同一计价单位不能重复填写');
    }
    const provider = await this.prisma.ai_providers.findUnique({
      where: { alias: this.providerAlias(value.serviceKind, value.configId) },
      select: { id: true },
    });
    if (!provider) throw new BadRequestException('请先保存该服务的模型接入配置');
    const model = await this.prisma.ai_models.findUnique({
      where: { providerId_alias: { providerId: provider.id, alias: value.modelAlias } },
      select: { id: true },
    });
    if (!model) throw new BadRequestException('当前服务配置中没有该模型');
    await this.prisma.$transaction(async (tx) => {
      await tx.ai_model_prices.deleteMany({ where: { modelId: model.id } });
      if (value.prices.length) {
        await tx.ai_model_prices.createMany({
          data: value.prices.map((price) => ({
            modelId: model.id,
            priceType: price.priceType,
            unitPrice: price.unitPrice,
            checkedAt: new Date(),
          })),
        });
      }
    });
    return this.listPrices(value.serviceKind, value.configId);
  }

  async hasPassingBenchmark(serviceKind: ServiceKind, modelAlias: string, configId?: string): Promise<boolean> {
    const provider = await this.prisma.ai_providers.findUnique({
      where: { alias: this.providerAlias(serviceKind, configId) },
      select: { id: true },
    });
    if (!provider) return false;
    const model = await this.prisma.ai_models.findUnique({
      where: { providerId_alias: { providerId: provider.id, alias: modelAlias } },
      include: {
        benchmarks: {
          where: {
            benchmarkType: `${serviceKind}_child_english`,
            passed: true,
            sampleCount: { gt: 0 },
          },
          take: 1,
        },
      },
    });
    return model?.enabled === true && model.benchmarks.length > 0;
  }

  // 管理路由由 main.ts 的 AdminAuthService 会话中间件统一保护。
  assertAdminToken(_received?: string): void {}

  encryptSecretRecord(value: Record<string, string>): string {
    return this.encrypt(value);
  }

  decryptSecretRecord(value: string): Record<string, string> {
    return this.decrypt(value);
  }

  private toPublic(row: {
    id: string;
    serviceKind: string;
    providerPresetId: string;
    protocol: string;
    baseUrl: string;
    modelAlias: string;
    credentialsCiphertext: string | null;
    enabled: boolean;
    priority: number;
    timeoutMs: number;
    options: unknown;
    updatedAt: Date;
  }): PublicProviderConfig {
    const preset = getProviderPreset(row.providerPresetId);
    return {
      id: row.id,
      serviceKind: row.serviceKind as ProviderServiceKind,
      providerPresetId: row.providerPresetId,
      providerName: preset?.name ?? row.providerPresetId,
      protocol: row.protocol as ProviderPreset['protocol'],
      baseUrl: row.baseUrl,
      modelAlias: row.modelAlias,
      enabled: row.enabled,
      priority: row.priority,
      timeoutMs: row.timeoutMs,
      credentialConfigured: Boolean(row.credentialsCiphertext),
      options: row.options && typeof row.options === 'object' && !Array.isArray(row.options)
        ? row.options as Record<string, unknown>
        : {},
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private providerAlias(serviceKind: ServiceKind | ProviderServiceKind, configId?: string): string {
    return `configured_${serviceKind}_${configId ?? ''}`;
  }

  private async syncModelCatalog(value: z.infer<typeof configInput>, configId: string): Promise<void> {
    const alias = this.providerAlias(value.serviceKind, configId);
    await this.prisma.$transaction(async (tx) => {
      const provider = await tx.ai_providers.upsert({
        where: { alias },
        create: {
          alias,
          kind: value.serviceKind,
          baseUrl: value.baseUrl,
          enabled: value.enabled,
        },
        update: { kind: value.serviceKind, baseUrl: value.baseUrl, enabled: value.enabled },
        select: { id: true },
      });
      await tx.ai_models.updateMany({
        where: { providerId: provider.id, alias: { not: value.modelAlias } },
        data: { enabled: false },
      });
      await tx.ai_models.upsert({
        where: { providerId_alias: { providerId: provider.id, alias: value.modelAlias } },
        create: {
          providerId: provider.id,
          alias: value.modelAlias,
          modelId: value.modelAlias,
          level: 'L1',
          enabled: value.enabled,
        },
        update: { modelId: value.modelAlias, enabled: value.enabled },
      });
    });
  }

  private encryptionKey(): Buffer {
    const raw = process.env.MODEL_CONFIG_ENCRYPTION_KEY ?? '';
    if (!/^[a-f0-9]{64}$/i.test(raw)) {
      throw new ServiceUnavailableException(
        '后台模型配置未启用：MODEL_CONFIG_ENCRYPTION_KEY 必须是 32 字节十六进制密钥',
      );
    }
    return Buffer.from(raw, 'hex');
  }

  private encrypt(value: Record<string, string>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(':');
  }

  private decrypt(value: string): Record<string, string> {
    const [version, ivHex, tagHex, bodyHex] = value.split(':');
    if (version !== 'v1' || !ivHex || !tagHex || !bodyHex) {
      throw new ServiceUnavailableException('已保存的模型密钥格式无法识别');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const decoded = Buffer.concat([
        decipher.update(Buffer.from(bodyHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
      try {
        const parsed: unknown = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        }
      } catch {
        return { apiKey: decoded };
      }
      return {};
    } catch {
      throw new ServiceUnavailableException('无法解密已保存的模型凭据；请检查 MODEL_CONFIG_ENCRYPTION_KEY');
    }
  }
}
