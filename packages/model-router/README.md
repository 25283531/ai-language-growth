# packages/model-router — AI Model Router

Multi-model routing, separate from the AI Gateway. Levels: L0 local rules/cache (0 API), L1 light free/low-cost, L2 mid, L3 premium reasoning.

Routing is by tested task performance, not parameter size. Escalation must NOT use model self-reported confidence. Signals include JSON schema compliance, task completion, ASR failure, pronunciation difficulty, repeated "不懂", method already changed, and conflict with the learner profile.

LLM / ASR / TTS are routed independently. TTS uses a unified voice identity and an abstract `teacher_speed` (e.g. 0.65), converted per provider — never a raw vendor speed.

Optimisation metric: effective teaching cost = total API cost / effective learning goals completed. Initial L1 70% / L2 25% / L3 5% split is illustrative, not measured.

M1: L0 + L1 + fallback with a unified Router interface. M2: full L1-L3 + Benchmark + dynamic escalation + budget / auto-degrade + failover.
