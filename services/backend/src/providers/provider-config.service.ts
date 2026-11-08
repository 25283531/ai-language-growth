import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { ServiceKind } from '@alg/shared-contracts';
import {
  getProviderPreset,
  listProviderPresets,
  type ProviderPreset,
} from '@alg/ai-provider-sdk';
import { PrismaService } from '../prisma/prisma.service';

const serviceKinds = ['llm', 'tts', 'asr', 'pronunciation'] as const;
const configInput = z.object({
  serviceKind: z.enum(serviceKinds),
  providerPresetId: z.string().min(1).max(80),
  baseUrl: z.string().url().max(2048),
  modelAlias: z.string().trim().min(1).max(160),
  apiKey: z.string().max(4096).optional(),
  credentials: z.record(z.string().max(4096)).default({}),
  enabled: z.boolean(),
  options: z.record(z.unknown()).default({}),
});
const benchmarkInput = z.object({
  serviceKind: z.enum(serviceKinds),
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
  serviceKind: z.enum(serviceKinds),
  modelAlias: z.string().trim().min(1).max(160),
  prices: z.array(z.object({
    priceType: priceTypeSchema,
    unitPrice: z.number().finite().min(0).max(1_000_000),
  })).max(5),
});

export type ProviderConfigInput = z.input<typeof configInput>;

export interface PublicProviderConfig {
  serviceKind: ServiceKind;
  providerPresetId: string;
  providerName: string;
  protocol: ProviderPreset['protocol'];
  baseUrl: string;
  modelAlias: string;
  enabled: boolean;
  credentialConfigured: boolean;
  options: Record<string, unknown>;
  updatedAt: string | null;
}

export interface RuntimeProviderConfig extends PublicProviderConfig {
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
    const rows = await this.prisma.ai_provider_configs.findMany();
    return rows.map((row) => this.toPublic(row));
  }

  async listEnabledRuntimeConfigs(): Promise<RuntimeProviderConfig[]> {
    const rows = await this.prisma.ai_provider_configs.findMany({ where: { enabled: true } });
    return rows.map((row) => {
      const config = this.toPublic(row);
      return {
        ...config,
        credentials: row.credentialsCiphertext ? this.decrypt(row.credentialsCiphertext) : {},
      };
    });
  }

  async getEnabledRuntimeConfig(serviceKind: ServiceKind): Promise<RuntimeProviderConfig | undefined> {
    const row = await this.prisma.ai_provider_configs.findUnique({ where: { serviceKind } });
    if (!row?.enabled) return undefined;
    const config = this.toPublic(row);
    return {
      ...config,
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

    const existing = await this.prisma.ai_provider_configs.findUnique({
      where: { serviceKind: value.serviceKind },
    });
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
    const row = await this.prisma.ai_provider_configs.upsert({
      where: { serviceKind: value.serviceKind },
      create: {
        serviceKind: value.serviceKind,
        providerPresetId: preset.id,
        protocol: preset.protocol,
        baseUrl: value.baseUrl,
        modelAlias: value.modelAlias,
        credentialsCiphertext,
        enabled: value.enabled,
        options: value.options as Prisma.InputJsonValue,
      },
      update: {
        providerPresetId: preset.id,
        protocol: preset.protocol,
        baseUrl: value.baseUrl,
        modelAlias: value.modelAlias,
        credentialsCiphertext,
        enabled: value.enabled,
        options: value.options as Prisma.InputJsonValue,
      },
    });
    await this.syncModelCatalog(value);
    return this.toPublic(row);
  }

  async listBenchmarks(serviceKind: ServiceKind) {
    const provider = await this.prisma.ai_providers.findUnique({
      where: { alias: `configured_${serviceKind}` },
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

  async recordBenchmark(input: unknown) {
    const parsed = benchmarkInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const value = parsed.data;
    const provider = await this.prisma.ai_providers.findUnique({
      where: { alias: `configured_${value.serviceKind}` },
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
    return { ...benchmark, serviceKind: value.serviceKind };
  }

  async listPrices(serviceKind: ServiceKind) {
    const provider = await this.prisma.ai_providers.findUnique({
      where: { alias: `configured_${serviceKind}` },
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
      where: { alias: `configured_${value.serviceKind}` },
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
    return this.listPrices(value.serviceKind);
  }

  async hasPassingBenchmark(serviceKind: ServiceKind, modelAlias: string): Promise<boolean> {
    const provider = await this.prisma.ai_providers.findUnique({
      where: { alias: `configured_${serviceKind}` },
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

  assertAdminToken(received: string | undefined): void {
    const expected = process.env.ADMIN_CONFIG_TOKEN;
    if (!expected) {
      throw new ServiceUnavailableException('后台模型配置未启用：请配置 ADMIN_CONFIG_TOKEN');
    }
    if (!received) throw new BadRequestException('缺少后台管理令牌');
    const expectedBytes = Buffer.from(expected, 'utf8');
    const receivedBytes = Buffer.from(received, 'utf8');
    if (expectedBytes.length !== receivedBytes.length || !timingSafeEqual(expectedBytes, receivedBytes)) {
      throw new BadRequestException('后台管理令牌无效');
    }
  }

  encryptSecretRecord(value: Record<string, string>): string {
    return this.encrypt(value);
  }

  decryptSecretRecord(value: string): Record<string, string> {
    return this.decrypt(value);
  }

  private toPublic(row: {
    serviceKind: string;
    providerPresetId: string;
    protocol: string;
    baseUrl: string;
    modelAlias: string;
    credentialsCiphertext: string | null;
    enabled: boolean;
    options: unknown;
    updatedAt: Date;
  }): PublicProviderConfig {
    const preset = getProviderPreset(row.providerPresetId);
    return {
      serviceKind: row.serviceKind as ServiceKind,
      providerPresetId: row.providerPresetId,
      providerName: preset?.name ?? row.providerPresetId,
      protocol: row.protocol as ProviderPreset['protocol'],
      baseUrl: row.baseUrl,
      modelAlias: row.modelAlias,
      enabled: row.enabled,
      credentialConfigured: Boolean(row.credentialsCiphertext),
      options: row.options && typeof row.options === 'object' && !Array.isArray(row.options)
        ? row.options as Record<string, unknown>
        : {},
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async syncModelCatalog(value: z.infer<typeof configInput>): Promise<void> {
    const alias = `configured_${value.serviceKind}`;
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
