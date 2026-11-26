import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.module';

export interface Mem0Memory {
  id: string;
  content: string;
  score: number | null;
  memoryType: string | null;
  metadata: Record<string, unknown>;
}

/**
 * L3 交互记忆的 Mem0 适配器。
 *
 * 约束：
 *  - 只发送已经由 MemoryManager 提取、可纠正的教学偏好，不发送原始对话或儿童个人信息；
 *  - PostgreSQL 的 interaction_memories 仍是可审计副本，Mem0 只做语义检索/更新；
 *  - 未配置、超时或返回格式异常时返回 null / 空数组，由调用方回落本地关系表。
 *
 * 默认按 Mem0 REST 接口约定：
 *   POST {baseUrl}/v1/memories/
 *   POST {baseUrl}/v1/memories/search/
 *   DELETE {baseUrl}/v1/memories/{id}/
 * 自部署版本可用 MEM0_ADD_PATH / MEM0_SEARCH_PATH / MEM0_DELETE_PATH 覆盖。
 */
@Injectable()
export class Mem0Client {
  private readonly logger = new Logger(Mem0Client.name);
  private lastErrorLogAt = 0;
  private retryAt = 0;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.mem0.baseUrl);
  }

  /** 熔断期内不再为每一轮课堂请求等待供应商超时。 */
  isDegraded(): boolean {
    return Date.now() < this.retryAt;
  }

  async add(input: {
    learnerId: string;
    localMemoryId: string;
    content: string;
    memoryType: string;
    importance: number;
    sourceSessionId: string | null;
  }): Promise<{ id: string | null }> {
    const body = {
      messages: [{ role: 'user', content: input.content }],
      user_id: input.learnerId,
      // 偏好已由本地 Memory Manager 提取，关闭 Mem0 的二次推断，避免改写或拆成多条。
      infer: false,
      metadata: {
        learner_id: input.learnerId,
        local_memory_id: input.localMemoryId,
        memory_type: input.memoryType,
        importance: input.importance,
        source_session_id: input.sourceSessionId,
      },
    };
    const response = await this.request(this.config.mem0.addPath, 'POST', body);
    if (!response) return { id: null };
    const rows = this.asRows(response);
    const id = rows.find((row) => typeof row.id === 'string')?.id;
    return { id: typeof id === 'string' ? id : null };
  }

  async search(input: {
    learnerId: string;
    query: string;
    limit: number;
  }): Promise<Mem0Memory[]> {
    const response = await this.request(this.config.mem0.searchPath, 'POST', {
      query: input.query.slice(0, 300),
      user_id: input.learnerId,
      limit: Math.max(1, Math.min(20, input.limit)),
    }, { timeoutMs: 2500 });
    if (!response) return [];
    return this.asRows(response)
      .map((row) => {
        const content = [row.memory, row.content, row.text]
          .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
        const metadata = this.asMetadata(row.metadata);
        return {
          id: typeof row.id === 'string' ? row.id : '',
          content: content?.trim() ?? '',
          score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null,
          memoryType: typeof metadata.memory_type === 'string' ? metadata.memory_type : null,
          metadata,
        };
      })
      .filter((memory) => memory.content.length > 0)
      .slice(0, Math.max(1, Math.min(20, input.limit)));
  }

  async delete(externalId: string): Promise<boolean> {
    if (!externalId) return false;
    const path = this.config.mem0.deletePath.replace('{id}', encodeURIComponent(externalId));
    const response = await this.request(path, 'DELETE', undefined);
    return response !== null;
  }

  /** 本地记忆被管理员修正后同步外部索引；失败只记日志，本地行仍是权威。 */
  async update(
    externalId: string,
    input: { localMemoryId: string; content: string; memoryType: string; importance: number },
  ): Promise<boolean> {
    if (!externalId) return false;
    const path = this.config.mem0.updatePath.replace('{id}', encodeURIComponent(externalId));
    const response = await this.request(path, 'PUT', {
      text: input.content,
      metadata: {
        local_memory_id: input.localMemoryId,
        memory_type: input.memoryType,
        importance: input.importance,
      },
    });
    return response !== null;
  }

  private async request(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown | null> {
    const baseUrl = this.config.mem0.baseUrl;
    if (!baseUrl) return null;
    if (Date.now() < this.retryAt) return null;
    const url = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
    const controller = new AbortController();
    const timeoutMs = Math.max(500, Math.min(this.config.mem0.timeoutMs, options.timeoutMs ?? this.config.mem0.timeoutMs));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.mem0.apiKey) headers.Authorization = `Token ${this.config.mem0.apiKey}`;
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.noteFailure(`HTTP ${response.status}`);
        return null;
      }
      this.retryAt = 0;
      if (response.status === 204) return {};
      const text = await response.text();
      if (!text.trim()) return {};
      return JSON.parse(text) as unknown;
    } catch (error) {
      this.noteFailure(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private asMetadata(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    // 部分自部署 Mem0 版本把 metadata 序列化成 JSON 字符串；解析失败按无元数据处理。
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
    }
    return {};
  }

  private asRows(response: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(response)) {
      return response.filter((row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === 'object' && !Array.isArray(row));
    }
    if (response && typeof response === 'object') {
      const record = response as Record<string, unknown>;
      for (const key of ['results', 'memories', 'data']) {
        const value = record[key];
        if (Array.isArray(value)) {
          return value.filter((row): row is Record<string, unknown> =>
            Boolean(row) && typeof row === 'object' && !Array.isArray(row));
        }
      }
      if (typeof record.id === 'string') return [record];
    }
    return [];
  }

  private noteFailure(message: string): void {
    this.retryAt = Date.now() + 60_000;
    if (Date.now() - this.lastErrorLogAt < 60_000) return;
    this.lastErrorLogAt = Date.now();
    this.logger.warn(`Mem0 不可用，L3 回落 PostgreSQL 交互记忆：${message}`);
  }
}