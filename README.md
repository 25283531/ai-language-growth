# AI Language Growth Platform

**Growth-type AI English platform for 6–9-year-old zero-basis children.**

A patient AI teacher that teaches word by word, like an adult teaching a child to speak — slow TTS with word / syllable / phoneme breakdown, phoneme-level pronunciation assessment, and a teaching state machine (teach → listen → score → break down further / encourage / advance), not a free-chat chatbot.

> **Status: M1 complete (pushed to `main`).** M0 delivered the design baseline (V1.1 design brief + `DECISIONS.md` + monorepo skeleton); M1 delivered the Next.js teaching workbench, NestJS backend, five-action teaching loop, Mock Provider Adapter, cost ledger, CI and the Android audio prototype. **Prototype only:** all thresholds are `uncalibrated`, all course content is `pending_review`, and no real model or real child-sample validation has been done — see [`docs/M1-QA-report.md`](docs/M1-QA-report.md) for the conditional Go/No-Go. License: TBD (no LICENSE file yet).

## Who it is for

- 6–9-year-old children with zero English basis
- Dual track: **language acquisition** (listening, speech discrimination, pronunciation, vocabulary, expression, dialogue) + **school English** (letters, phonics, word recognition, reading, spelling, grammar, simple writing). Neither replaces the other.

## Standards and growth model

- CEFR **Pre-A1 start, A1 as first-stage capability reference** (not a timetable; roughly 12–18 months at ~15 min/day is a rough reference only) + China 2022 Compulsory Education English Curriculum Standard.
- **7 growth stages:** 0 启蒙适应 → 1 听力理解与语言反应 → 2 声音辨别与发音形成 → 3 词汇理解与主动表达 → 4 短语与完整句子 → 5 对话与语言组织 → 6 自主日常交流. A child can be at different stages for different abilities.
- **5 mastery states:** 未接触 / 初步接触 / 正在形成 / 基本掌握 / 稳定迁移. Stable migration means independent use in two different scenarios plus unprompted recall the next day.
- **Learner model + evidence events:** every mastery change needs evidence (when, task type, prompted or not, scenario, credibility). No mastery change on LLM self-claim alone.
- **Teaching loop:** read learner state → set goal → organise activity → observe response → assess → update profile → adjust next teaching. Spaced review: short-term re-presentation, next-day unprompted recall, then interval adjusted by performance, in changed scenarios.

## Milestones (V1.1)

- **M0 — Teaching system + infra design:** 7 stages, dual track, ability graph, DB design, NestJS modules, Provider Adapter spec, LLM/TTS/ASR unified protocol, fixed teacher persona. *(Completed before implementation: `62e28d9`, design docs + skeleton only, no code by design.)*
- **M1 — Web teaching prototype:** Next.js workbench + NestJS backend, basic routing L0+L1+fallback, basic cost stats, minimal learner state, 3 themes (greetings / self-introduction / objects around the child), plus a parallel Android minimal audio prototype. Acceptance: teach / listen / evaluate / adjust / record all run. *(Completed: 15/15 loop checks, 28/28 unit tests, 5/5 DB constraints, CI + Android workflows green — see `docs/M1-QA-report.md`.)*
- **M2 — Learner engine + full routing:** multi-dim profile, evidence / mastery, long-term memory, controlled persona, planner, L1–L3 routing, Benchmark, ASR/TTS/pronunciation grading, budget / auto-degrade, review / migration.
- **M3 — Android formal client:** Kotlin + Jetpack Compose, child UI, voice, parent centre, same backend.
- **M4 — Curriculum expansion + commercialisation:** 7 stages, phonics / reading / writing, textbook mapping, parent report, membership / usage, privacy / guardian consent, Docker self-deploy, open-source docs.

## Three hard R&D constraints

1. **Teaching logic is separated from the client** — the backend decides the next step; web / Android / iOS share it.
2. **All models are replaceable** — no vendor or model names hard-coded in teaching logic; the Router owns selection.
3. **Teaching data must have reliable evidence** — source, task type, prompted or not, time, and credibility are stored with every evidence event.

## Tech stack

- **Clients:** Web first (Next.js, M1 validation); Android Kotlin + Jetpack Compose (M3).
- **Backend:** NestJS modular monolith, PostgreSQL + Redis, unified AI Gateway, BullMQ, S3-compatible storage + CDN, Docker, OpenTelemetry.
- **AI:** 4 teacher roles (planner / teacher / assessor / mentor) via one LLM with different prompts and tools. Multi-model routing L0 local / L1 light / L2 mid / L3 premium, LLM / ASR / TTS routed independently. ASR is not pronunciation assessment. TTS uses a unified voice identity + abstract `teacher_speed` (e.g. 0.65), not raw vendor speed.
- **Memory & persona:** learning memory (self-built, PostgreSQL), interaction memory (Mem0, batched at lesson end), teacher persona (self-built Personality Engine; fixed: patient, gentle, encouraging, no mocking, no rushing, honest AI identity). Full long-term memory and controlled adaptation land in M2; M1 uses a fixed persona + session memory only.

## Monorepo layout

```
apps/web            # Next.js teaching workbench (M1)
apps/admin-web      # Parent & admin console
apps/android        # Kotlin client (M3; M1 minimal audio prototype)
services/backend    # NestJS modular monolith
services/ai-evaluation  # Optional Python evaluation service
packages/curriculum packages/skill-graph packages/model-router
packages/ai-provider-sdk packages/shared-contracts
prompts/teacher prompts/planner prompts/assessment  # versioned prompts
docs/architecture docs/curriculum docs/api docs/database docs/deployment
deploy/docker
```

## Docs

- Design task book: [`docs/ai-language-growth-v1-1-design.pdf`](docs/ai-language-growth-v1-1-design.pdf)
- Decisions: [`DECISIONS.md`](DECISIONS.md) — unified draft, pending user confirmation as the single source of truth.

## Privacy

Guardian consent, no voiceprint ID, no long-term raw audio by default, delete function, no child self-purchase, no child-targeted ads. The teacher must not elicit private information or present as a parent / friend.
