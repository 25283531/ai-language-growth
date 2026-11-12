import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { getProviderPreset } from '@alg/ai-provider-sdk';
import {
  PROVIDER_SERVICE_KINDS,
  type ProviderServiceKind,
} from '@alg/shared-contracts';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderConfigService } from './provider-config.service';

const runInput = z.object({
  serviceKind: z.enum(PROVIDER_SERVICE_KINDS),
  configId: z.string().uuid(),
});

/** 运行准入只看最近 30 天真实账本，最多取 2000 条，避免一次查询拖住后台。 */
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 2000;

const policies: Record<Exclude<ProviderServiceKind, 'embedding'>, {
  minCalls: number;
  maxAverageLatencyMs: number;
  maxP95LatencyMs: number;
}> = {
  llm: { minCalls: 5, maxAverageLatencyMs: 8000, maxP95LatencyMs: 12000 },
  tts: { minCalls: 3, maxAverageLatencyMs: 12000, maxP95LatencyMs: 18000 },
  asr: { minCalls: 3, maxAverageLatencyMs: 15000, maxP95LatencyMs: 22500 },
  pronunciation: { minCalls: 3, maxAverageLatencyMs: 15000, maxP95LatencyMs: 22500 },
};

export type RuntimeBenchmarkConfig = {
  providerPresetId: string;
  baseUrl: string;
  modelAlias: string;
  enabled: boolean;
  credentials: Record<string, string>;
};

export type RuntimeBenchmarkResult = {
  score: number;
  sampleCount: number;
  passed: boolean;
  notes: string;
};

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]!;
}

/**
 * 运行准入评估：只使用真实账本中的成功调用，不用人工填写分数，也不调用供应商。
 * 它验证“配置完整 + 已有真实运行样本 + 延迟在可接受范围”，不评价儿童发音或教学质量。
 */
export function evaluateRuntimeReadiness(input: {
  serviceKind: ProviderServiceKind;
  config: RuntimeBenchmarkConfig;
  latenciesMs: number[];
  truncated?: boolean;
}): RuntimeBenchmarkResult {
  const { serviceKind, config, latenciesMs } = input;
  if (serviceKind === 'embedding') {
    return {
      score: 0,
      sampleCount: 0,
      passed: false,
      notes: 'Embedding 尚未接入教学调用链，不能生成运行准入结果；请先完成检索链路后再评估。',
    };
  }

  const policy = policies[serviceKind];
  const preset = getProviderPreset(config.providerPresetId);
  const preflight: string[] = [];
  if (!config.baseUrl.trim()) preflight.push('接入地址为空');
  if (!config.modelAlias.trim()) preflight.push('模型名称为空');
  if (!preset) preflight.push('供应商预置不存在');
  if (preset?.credentialRequired && !Object.values(config.credentials).some((value) => value.trim())) {
    preflight.push('尚未保存平台凭据');
  }

  const samples = Math.min(latenciesMs.length, MAX_SAMPLES);
  const latencies = latenciesMs.slice(0, MAX_SAMPLES);
  const averageLatencyMs = samples
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / samples)
    : 0;
  const p95LatencyMs = Math.round(percentile(latencies, 0.95));
  const sampleFactor = Math.min(1, samples / policy.minCalls);
  const latencyFactor = samples
    ? Math.max(0, 1 - averageLatencyMs / policy.maxAverageLatencyMs)
    : 0;
  const score = preflight.length
    ? 0
    : Math.round(100 * (0.4 * sampleFactor + 0.6 * latencyFactor));
  const passed = preflight.length === 0
    && samples >= policy.minCalls
    && averageLatencyMs <= policy.maxAverageLatencyMs
    && p95LatencyMs <= policy.maxP95LatencyMs;

  const prefix = preflight.length
    ? `配置预检未通过：${preflight.join('、')}。`
    : samples === 0
      ? '近 30 天没有真实调用，无法形成运行准入样本。'
      : `近 30 天真实调用 ${samples} 次，平均 ${averageLatencyMs}ms，P95 ${p95LatencyMs}ms。`;
  const truncated = input.truncated ? `仅统计最近 ${MAX_SAMPLES} 条。` : '';
  return {
    score,
    sampleCount: samples,
    passed,
    notes: `${prefix}${truncated}门槛：至少 ${policy.minCalls} 次、平均不超过 ${policy.maxAverageLatencyMs}ms、P95 不超过 ${policy.maxP95LatencyMs}ms。仅验证运行可用性，不替代儿童教学质量评估。`,
  };
}

/** 执行一次运行准入评估，并把结果写入 ai_model_benchmarks，供管理端展示与生产门禁读取。 */
@Injectable()
export class ProviderBenchmarkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configs: ProviderConfigService,
  ) {}

  async run(input: unknown) {
    const parsed = runInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { serviceKind, configId } = parsed.data;
    if (serviceKind === 'embedding') {
      throw new BadRequestException('Embedding 尚未接入教学调用链，暂不支持运行准入 Benchmark。');
    }
    const config = await this.configs.getRuntimeConfigForBenchmark(serviceKind, configId);
    const since = new Date(Date.now() - LOOKBACK_MS);
    const rows = await this.prisma.ai_usage_logs.findMany({
      where: {
        providerAlias: `configured_${serviceKind}_${configId}`,
        modelAlias: config.modelAlias,
        createdAt: { gte: since },
      },
      select: { latencyMs: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_SAMPLES + 1,
    });
    const evaluation = evaluateRuntimeReadiness({
      serviceKind,
      config,
      latenciesMs: rows.map((row) => Math.max(0, row.latencyMs)),
      truncated: rows.length > MAX_SAMPLES,
    });
    const benchmark = await this.configs.recordRuntimeBenchmark({
      serviceKind,
      configId,
      modelAlias: config.modelAlias,
      ...evaluation,
    });
    return { ...benchmark, serviceKind, configId, modelAlias: config.modelAlias };
  }
}
