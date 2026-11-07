# services/backend — NestJS Modular Monolith

The single backend that decides teaching. NestJS modular monolith, PostgreSQL + Redis.

Modules (M0 design, to be locked before M1 implementation):
- Learner Engine (learner profile, skill states, evidence events)
- Planner (lesson planning from learner state)
- Orchestrator (`POST /lessons/{id}/turn`)
- AI Model Router (L0 local / L1 light / L2 mid / L3 premium, with Benchmark and Cost & Quota)
- AI Gateway (provider calls only; Router owns selection)
- Memory Manager and Personality Engine (reserved in M0/M1; full long-term memory and controlled persona in M2)
- Pronunciation / ASR / TTS adapters (vendor behind a unified protocol)

Three hard R&D constraints: (1) backend decides the next teaching step; (2) all models replaceable, no vendor/model names hard-coded in teaching logic; (3) no mastery change without evidence (source, task type, prompted or not, time, credibility).
