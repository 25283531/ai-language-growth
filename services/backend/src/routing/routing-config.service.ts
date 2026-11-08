import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  DEFAULT_ROUTER_CONFIG,
  ModelRouterImpl,
  type RouterConfig,
} from '@alg/model-router';
import {
  ESCALATION_SIGNALS,
  MODEL_LEVELS,
  SERVICE_KINDS,
  TASK_ROUTES,
  type ServiceKind,
} from '@alg/shared-contracts';
import { PrismaService } from '../prisma/prisma.service';

const endpointSchema = z.object({
  providerAlias: z.string().trim().min(1).max(120),
  modelAlias: z.string().trim().min(1).max(160),
  level: z.enum(MODEL_LEVELS),
});
const routeSchema = z.object({
  taskRoute: z.enum(TASK_ROUTES),
  primary: endpointSchema,
  fallback: z.array(endpointSchema).max(8),
  maxConcurrency: z.number().int().min(1).max(1000),
  dailyBudgetCny: z.number().min(0).max(1_000_000),
  enabled: z.boolean(),
});
const configSchema = z.object({
  rules: z.array(routeSchema).min(1).max(100),
  escalationTargets: z.record(
    z.enum(SERVICE_KINDS),
    z.record(z.enum(ESCALATION_SIGNALS), z.enum(MODEL_LEVELS)),
  ),
  fallbackOrder: z.array(z.enum(MODEL_LEVELS)).min(1).max(4),
});

@Injectable()
export class RoutingConfigService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly router: ModelRouterImpl,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureDefaults();
    this.router.setConfig(await this.loadConfig());
  }

  getSnapshot(): RouterConfig {
    return this.router.getConfig();
  }

  async reload(): Promise<RouterConfig> {
    const config = await this.loadConfig();
    this.router.setConfig(config);
    return config;
  }

  async save(input: unknown): Promise<RouterConfig> {
    const parsed = configSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const value = parsed.data;
    if (new Set(value.rules.map((route) => route.taskRoute)).size !== value.rules.length) {
      throw new BadRequestException('同一任务路由不能重复配置');
    }
    const serviceByRoute = new Map<string, ServiceKind>();
    for (const route of value.rules) {
      const serviceKind = route.taskRoute.split('.')[0] as ServiceKind;
      serviceByRoute.set(route.taskRoute, serviceKind);
    }

    await this.prisma.$transaction(async (tx) => {
      for (const route of value.rules) {
        const serviceKind = serviceByRoute.get(route.taskRoute)!;
        const primaryId = await this.ensureModel(tx, serviceKind, route.primary);
        const fallbackIds: string[] = [];
        for (const candidate of route.fallback) {
          fallbackIds.push(await this.ensureModel(tx, serviceKind, candidate));
        }
        await tx.ai_task_routes.upsert({
          where: { taskRoute_serviceKind: { taskRoute: route.taskRoute, serviceKind } },
          create: {
            taskRoute: route.taskRoute,
            serviceKind,
            primaryModelId: primaryId,
            fallbackModelIds: fallbackIds,
            maxConcurrency: route.maxConcurrency,
            dailyBudgetCny: route.dailyBudgetCny,
            fallbackOrder: value.fallbackOrder,
            enabled: route.enabled,
          },
          update: {
            primaryModelId: primaryId,
            fallbackModelIds: fallbackIds,
            maxConcurrency: route.maxConcurrency,
            dailyBudgetCny: route.dailyBudgetCny,
            fallbackOrder: value.fallbackOrder,
            enabled: route.enabled,
          },
        });
      }
      await tx.ai_route_rules.deleteMany({});
      for (const [serviceKind, signals] of Object.entries(value.escalationTargets)) {
        for (const [signal, targetLevel] of Object.entries(signals ?? {})) {
          const taskRoutes = value.rules
            .filter((route) => route.taskRoute.startsWith(`${serviceKind}.`))
            .map((route) => route.taskRoute);
          for (const taskRoute of taskRoutes) {
            await tx.ai_route_rules.create({
              data: { taskRoute, escalationSignal: signal, targetLevel, enabled: true },
            });
          }
        }
      }
    });
    return this.reload();
  }

  private async ensureDefaults(): Promise<void> {
    const count = await this.prisma.ai_task_routes.count();
    if (count === 0) {
      await this.save(DEFAULT_ROUTER_CONFIG);
      return;
    }
    const current = await this.loadConfig();
    const existing = new Set(current.rules.map((rule) => rule.taskRoute));
    const missing = DEFAULT_ROUTER_CONFIG.rules.filter((rule) => !existing.has(rule.taskRoute));
    if (missing.length) await this.save({ ...current, rules: [...current.rules, ...missing] });
  }

  private async ensureModel(
    tx: Prisma.TransactionClient,
    serviceKind: ServiceKind,
    endpoint: { providerAlias: string; modelAlias: string; level: string },
  ): Promise<string> {
    const provider = await tx.ai_providers.upsert({
      where: { alias: endpoint.providerAlias },
      create: { alias: endpoint.providerAlias, kind: serviceKind, enabled: true },
      update: { kind: serviceKind },
      select: { id: true },
    });
    const model = await tx.ai_models.upsert({
      where: { providerId_alias: { providerId: provider.id, alias: endpoint.modelAlias } },
      create: {
        providerId: provider.id,
        alias: endpoint.modelAlias,
        modelId: endpoint.modelAlias,
        level: endpoint.level,
        enabled: true,
      },
      update: { modelId: endpoint.modelAlias, level: endpoint.level },
      select: { id: true },
    });
    return model.id;
  }

  private async loadConfig(): Promise<RouterConfig> {
    const [routes, escalationRows] = await Promise.all([
      this.prisma.ai_task_routes.findMany({
        include: { primary: { include: { provider: true } } },
        orderBy: { taskRoute: 'asc' },
      }),
      this.prisma.ai_route_rules.findMany({ where: { enabled: true } }),
    ]);
    if (!routes.length) return DEFAULT_ROUTER_CONFIG;
    const fallbackIds = routes.flatMap((row) => {
      const ids = Array.isArray(row.fallbackModelIds) ? row.fallbackModelIds : [];
      return ids.filter((id): id is string => typeof id === 'string');
    });
    const fallbackModels = await this.prisma.ai_models.findMany({
      where: { id: { in: fallbackIds } },
      include: { provider: true },
    });
    const byId = new Map(fallbackModels.map((model) => [model.id, model]));
    const rules = routes.flatMap((row) => {
      if (!row.primary) return [];
      const fallback = (Array.isArray(row.fallbackModelIds) ? row.fallbackModelIds : [])
        .map((id) => byId.get(String(id)))
        .filter((model): model is NonNullable<typeof model> => Boolean(model))
        .map((model) => ({
          providerAlias: model.provider.alias,
          modelAlias: model.alias,
          level: model.level as 'L0' | 'L1' | 'L2' | 'L3',
        }));
      return [{
        taskRoute: row.taskRoute,
        primary: {
          providerAlias: row.primary.provider.alias,
          modelAlias: row.primary.alias,
          level: row.primary.level as 'L0' | 'L1' | 'L2' | 'L3',
        },
        fallback,
        maxConcurrency: row.maxConcurrency,
        dailyBudgetCny: row.dailyBudgetCny,
        enabled: row.enabled,
      }];
    });
    const escalationTargets = structuredClone(DEFAULT_ROUTER_CONFIG.escalationTargets);
    for (const row of escalationRows) {
      const serviceKind = row.taskRoute.split('.')[0] as ServiceKind;
      if (serviceKind in escalationTargets && row.escalationSignal in escalationTargets[serviceKind]) {
        escalationTargets[serviceKind][row.escalationSignal as keyof typeof escalationTargets[typeof serviceKind]] =
          row.targetLevel as 'L0' | 'L1' | 'L2' | 'L3';
      }
    }
    const fallbackOrder = Array.isArray(routes[0]?.fallbackOrder)
      ? routes[0].fallbackOrder.filter(
          (level): level is 'L0' | 'L1' | 'L2' | 'L3' =>
            typeof level === 'string' && ['L0', 'L1', 'L2', 'L3'].includes(level),
        )
      : DEFAULT_ROUTER_CONFIG.fallbackOrder;
    return { rules, escalationTargets, fallbackOrder };
  }
}
