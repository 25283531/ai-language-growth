# AI Language Growth Platform

**Growth-type AI English platform for 6–9-year-old zero-basis children.**

A patient AI teacher that teaches word by word, like an adult teaching a child to speak — slow TTS with word / syllable / phoneme breakdown, phoneme-level pronunciation assessment, and a teaching state machine (teach → listen → score → break down further / encourage / advance), not a free-chat chatbot.

> **Status: M0/M1 not acceptance-complete.** The M0 design set and M1 prototype are present, but M0 was not formally frozen before implementation. GitHub Actions now runs a PostgreSQL-backed API smoke flow for lesson start/turn/finish, idempotency, TTS cache, repeat/slow controls, and growth archive. M1 still has open gates: Android does not upload audio bytes, three-topic/browser coverage and progressive difficulty/free conversation are incomplete, and consent/auth/data-deletion are not implemented. See [`docs/M0-M1-audit.md`](docs/M0-M1-audit.md). Thresholds remain `uncalibrated`; all course content remains `pending_review`. License: TBD (no LICENSE file yet).

> **Live mode added (2026-11-07):** real LLM / ASR / TTS adapters are wired through config only, with Mock kept as the fallback. `AI_GATEWAY_MODE=mock` returns to a zero-call, zero-cost run; `AI_GATEWAY_LIVE_SERVICES` selects which services actually call out. End-to-end results, pricing caveats and the latency shortfall against the 1–2 s target: [`docs/M1-live-API-report.md`](docs/M1-live-API-report.md).

> **Provider hardening:** TTS supports both binary OpenAI-compatible responses (`TTS_PROTOCOL=openai_audio`) and signed JSON/Base64 responses (`TTS_PROTOCOL=signed_json_audio`). Live configuration is checked at startup; an unsupported protocol or incomplete signed-protocol configuration fails fast instead of silently selecting a different adapter. In non-production runs, `GET /api/v1/config/audit` exposes redacted routing details for diagnosis; it never returns credential values.

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

- **M0 — Teaching system + infra design:** 7 stages, dual track, ability graph, DB design, NestJS modules, Provider Adapter spec, LLM/TTS/ASR unified protocol, fixed teacher persona. *(Design set delivered; formal baseline freeze and complete API/data dictionary review remain open — see `docs/M0-M1-audit.md`.)*
- **M1 — Web teaching prototype:** Next.js workbench + NestJS backend, basic routing L0+L1+fallback, basic cost stats, minimal learner state, 3 themes (greetings / self-introduction / objects around the child), plus a parallel Android minimal audio prototype. *(Prototype delivered, acceptance partial: see `docs/M0-M1-audit.md` and the conditional report `docs/M1-QA-report.md`.)*
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
