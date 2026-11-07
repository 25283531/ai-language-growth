# packages/ai-provider-sdk — Provider Adapters

Unified LLM / TTS / ASR provider protocol. One adapter per provider; teaching logic never calls a vendor directly.

Providers are configured, not hard-coded. Free-model rate limits are per-account, not per-key, so free models can never be the sole dependency — fallback goes free → paid low-cost → protect key teaching interactions → cached audio. Commercial terms for multi-tenant resale must be checked per provider.
