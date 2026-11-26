# 文档索引

本目录存放 `ai-language-growth` 的设计、开发任务、课程/词库、测试验收与运维文档。新增文档时请同步更新本索引。

## 设计与开发任务

- [AI Language Growth V1.1 总体设计（PDF）](./ai-language-growth-v1-1-design.pdf)
- [开发任务书：教材课文与教学资源 v1.1](./开发任务书-教材课文与教学资源-v1.1.md)
- [开发任务书：教材课文与教学资源 v1.0（历史版本）](./开发任务书-教材课文与教学资源-v1.0.md)
- [开发计划 v1.1](./development-plan-v1.1.md)
- [L1/L3/L5 记忆与知识检索实现](./memory-architecture.md) — Redis 工作记忆、Mem0 交互记忆、PostgreSQL 课程知识 RAG 与降级边界
- [开发要点](./development-key-points.md)
- [任务书第 1—5 节审计](./taskbook-sections-1-5-audit.md)

## 课程、词库与本地运行

- [本地数据库与词库导入](./本地数据库与词库导入.md) — PostgreSQL `15433` 启动、Prisma 迁移、ECDICT 导入、seed、M1 集成测试与停止命令
- [教材词表 → 完整课程 / CEFR 预置课程](./curriculum-generation.md)
- [词库扩容覆盖报告](./lexicon-coverage.md) — 3,000 核心 → 5,000 族的教材/课标优先词覆盖对比与缺口
- [课程生成器](./curriculum-generator.md)
- [Curriculum Operations](./curriculum/README.md) — 管理端课程导入、词库、教材目录与发布/回滚操作
- [课程相关文档目录](./curriculum/)

## 验收、测试与审计

- [M0 冻结记录](./M0-freeze.md)
- [M0—M1 审计](./M0-M1-audit.md)
- [M1 QA 报告](./M1-QA-report.md)
- [M1 真实模型接入与实测报告](./M1-live-API-report.md)
- [M2 审计](./M2-audit.md)
- [P1-4 家长门](./P1-4-parent-gate.md)
- [P1-6 自适应 Planner](./P1-6-adaptive-planner.md)
- [P1-7 运行准入 Benchmark](./P1-7-benchmark-readiness.md)
- [P2-2E 用量对账](./P2-2E-usage-reconciliation.md)

## 专题说明

- [隐私政策](./privacy-policy.md)
- [发音评估分析](./pronunciation-assessment-analysis.md)
- [发音阈值校准](./pronunciation-threshold-calibration.md)
- [TTS Matcha API](./tts-matcha-api.md)
- [五项目核实：可复用部分与许可证](./五项目核实：可复用部分与许可证.html)

## 子目录

- [API 文档](./api/)
- [架构文档](./architecture/)
- [数据库文档](./database/)
- [部署文档](./deployment/)
  - [远程联调服务](./deployment/remote-services.md) — 联调环境的迁移与 seed；与 staging 分环境，seed 不作为 staging 证据
  - [Staging 迁移检查清单](./deployment/staging-migration-checklist.md) — 生产迁移前的 staging 验证；禁止 seed 和集成测试
- [课程文档](./curriculum/)
