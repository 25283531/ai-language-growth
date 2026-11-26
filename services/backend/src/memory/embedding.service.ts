import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { ProviderConfigService } from '../providers/provider-config.service';

interface EmbeddingEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

/**
 * Embedding 适配器：OpenAI 兼容 /embeddings 协议。
 *
 * 配置来源按 D-029：
 *  1. 管理后台 serviceKind=embedding 的最高优先级启用配置；
 *  2. 环境变量 EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL（自部署兜底）。
 *
 * 未配置或调用失败时返回 null，L5 检索自动回落词法匹配；不得伪造向量。
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private lastErrorLogAt = 0;
  private retryAt = 0;

  constructor(
    private readonly providerConfigs: ProviderConfigService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(await this.resolveEndpoint());
  }

  /** 供应商连续失败后的短时熔断状态，供管理端只读展示。 */
  isDegraded(): boolean {
    return Date.now() < this.retryAt;
  }

  async embed(texts: string[], options: { timeoutMs?: number } = {}): Promise<{ vectors: number[][]; model: string } | null> {
    if (!texts.length) return { vectors: [], model: 'none' };
    // 连续失败时短暂熔断：课堂问答不能为每次检索都等一次供应商超时。
    if (Date.now() < this.retryAt) return null;
    const endpoint = await this.resolveEndpoint();
    if (!endpoint) return null;
    const controller = new AbortController();
    const timeoutMs = Math.max(500, Math.min(endpoint.timeoutMs, options.timeoutMs ?? endpoint.timeoutMs));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.embeddingsUrl(endpoint.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: endpoint.model, input: texts }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.noteFailure(`HTTP ${response.status}`);
        return null;
      }
      const payload = await response.json() as {
        data?: Array<{ embedding?: unknown }>;
        embeddings?: unknown;
        model?: string;
      };
      const raw = Array.isArray(payload.data)
        ? payload.data.map((item) => item.embedding)
        : Array.isArray(payload.embeddings)
          ? payload.embeddings
          : [];
      const vectors = raw.map((vector) => this.toVector(vector)).filter((vector): vector is number[] => vector !== null);
      if (vectors.length !== texts.length) {
        this.noteFailure(`返回向量数量 ${vectors.length} 与输入 ${texts.length} 不一致`);
        return null;
      }
      this.retryAt = 0;
      return { vectors, model: payload.model?.trim() || endpoint.model };
    } catch (error) {
      this.noteFailure(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveEndpoint(): Promise<EmbeddingEndpoint | null> {
    const database = await this.providerConfigs.getEnabledRuntimeConfig('embedding').catch(() => undefined);
    if (database?.baseUrl && database.modelAlias) {
      return {
        baseUrl: database.baseUrl,
        model: database.modelAlias,
        apiKey: database.credentials.apiKey ?? database.apiKey,
        timeoutMs: Math.max(1000, Math.min(30000, database.timeoutMs ?? 10000)),
      };
    }
    if (this.config.embedding.baseUrl && this.config.embedding.model) {
      return {
        baseUrl: this.config.embedding.baseUrl,
        model: this.config.embedding.model,
        apiKey: this.config.embedding.apiKey,
        timeoutMs: 10000,
      };
    }
    return null;
  }

  private embeddingsUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '');
    if (/\/embeddings$/i.test(trimmed)) return trimmed;
    return `${trimmed}/embeddings`;
  }

  private toVector(value: unknown): number[] | null {
    if (!Array.isArray(value) || !value.length) return null;
    const vector = value.map((item) => typeof item === 'number' ? item : Number.NaN);
    return vector.every((item) => Number.isFinite(item)) ? vector : null;
  }

  private noteFailure(message: string): void {
    this.retryAt = Date.now() + 60_000;
    if (Date.now() - this.lastErrorLogAt < 60_000) return;
    this.lastErrorLogAt = Date.now();
    this.logger.warn(`Embedding 不可用，L5 回落到词法检索：${message}`);
  }
}