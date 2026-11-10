# AI Language Growth Platform

**Growth-type AI English platform for 6–9-year-old zero-basis children.**

A patient AI teacher that teaches word by word, like an adult teaching a child to speak — slow TTS with word / syllable / phoneme breakdown, phoneme-level pronunciation assessment, and a teaching state machine (teach → listen → score → break down further / encourage / advance), not a free-chat chatbot.

> **Status: M0–M2 code scope delivered; M3 in progress.** M0 technical baseline, M1 teaching prototype and M2 learner/routing code are documented in their audit files. M1 acceptance still has development focus areas for teaching quality, latency, guardian authorization and data deletion. 真实儿童样本相关验收属开发关注项，不再作为强制审核标准；改为投入真实使用后，以实际使用数据持续验证并留痕。其中监护人单独同意、授权撤回与儿童数据删除属于《中华人民共和国个人信息保护法》《儿童个人信息网络保护规定》的法定要求，不是项目可自行裁量的内部审核标准；投入真实儿童使用前应完成。 The M3 Android Compose client now has its first backend-connected lesson-start slice; HTTPS deployment and the remaining voice and parent workflows are pending. Thresholds remain `uncalibrated`; course content remains `pending_review`. See [`docs/M0-M1-audit.md`](docs/M0-M1-audit.md) and [`docs/M2-audit.md`](docs/M2-audit.md).

> **Live mode added (2026-11-07):** real LLM / ASR / TTS adapters are wired through config only, with Mock kept as the fallback. `AI_GATEWAY_MODE=mock` returns to a zero-call, zero-cost run; `AI_GATEWAY_LIVE_SERVICES` selects which services actually call out. End-to-end results, pricing caveats and the latency shortfall against the 1–2 s target: [`docs/M1-live-API-report.md`](docs/M1-live-API-report.md).

> **Provider hardening:** TTS supports both binary OpenAI-compatible responses (`TTS_PROTOCOL=openai_audio`) and signed JSON/Base64 responses (`TTS_PROTOCOL=signed_json_audio`). Live configuration is checked at startup; an unsupported protocol or incomplete signed-protocol configuration fails fast instead of silently selecting a different adapter. In non-production runs, `GET /api/v1/config/audit` exposes redacted routing details for diagnosis; it never returns credential values.

> **Verification-entry config change (2026-11-09, 验证入口配置变更):** live verification now uses Tencent Cloud `TextToVoice` (natural-language tier `VoiceType=502001`, signed JSON/Base64 protocol) for TTS and Zhipu `glm-5.3-flash` for LLM; ASR stays `FunAudioLLM/SenseVoiceSmall`, pronunciation assessment stays `mock_pronunciation`. This is a verification-entry config change only — **not** a formal vendor selection, not a real-time/latency sign-off, not a zero-cost claim. The **48/48** result is a `2026-11-07 21:25:22` pre-script-revision snapshot of this same configuration (neither a 2026-11-09 run nor the old-configuration baseline, which is 34/34); the 2026-11-09 revised-script live re-run gave **23 PASS / 21 FAIL**, caused by post-`188d369` contract gates (quota-reservation / learner-id / login, `assertLearnerOwnership`, `budgetExhausted` on historical usage), unrelated to this round's 9 files. Pure unit tests `70/70`; root `npm test` has three conditions (final result = (a)): (a) freshly started mock backend + `DATABASE_URL`(15434)/`REDIS_URL`(16381) → **64/64/0 EXIT 0** (35/35, 19/19, 10/10); the two `64/63/1` variants are conditional environment notes only — (b) a repeat run in the same :3100 process hits the in-memory TTS cache (`cached=true`, test-isolation / process-state pollution), (c) no `DATABASE_URL` injection fails `prisma.users.create()` — neither is a code regression. The first code commit `0fe159b` was pushed to `main` and triggered CI run `42593265380` / sha `0fe159b2` / `completed / success` (`https://github.com/25283531/ai-language-growth/actions/runs/42593265380`, job `build-and-test` success), covering build / typecheck / unit tests / mock integration only — **not** live end-to-end (still 23/21); the CI run for the follow-up documentation commit is pending. `51/51` is a historical record; `verify_m1_loop.sh` has **15 `ok()` assertions** and runs **6 PASS / 9 FAIL** at current HEAD (historical 15/15 was an older HEAD). Pricing stays `unpriced` (`costCny=0` = no price table wired, not zero cost; prepaid resource packs are not free). The 1–2 s single-turn target is **not met**, and multiple items remain **unverified**. Full evidence, root causes and unverified list: [`docs/M1-live-API-report.md`](docs/M1-live-API-report.md).

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
- **M3 — Android formal client:** in progress; Compose classroom shell and lesson start are implemented, with voice and parent workflows to follow.
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
