# packages/skill-graph — Ability Knowledge Graph

Skill nodes, dependencies, and the learner's ability graph. Core data asset, alongside the learner model and planning engine.

Tables (V1.1): `skill_nodes`, `skill_dependencies`, `learner_skill_states`, `learning_evidence`. No graph DB in v1; use PostgreSQL relations.

A child can be at different growth stages for different abilities. Mastery has 5 states: 未接触 / 初步接触 / 正在形成 / 基本掌握 / 稳定迁移. Stable migration requires independent use in two different scenarios plus unprompted recall the next day.
