# apps/admin-web — Parent & Admin Console

Next.js operator console for model provider settings. Open at port 3001 in the Docker Compose setup.

The model connection page offers provider presets for LLM, TTS, standard ASR, and phoneme pronunciation assessment. Provider-specific fields are encrypted and saved by the backend; use `ADMIN_CONFIG_TOKEN` to access config endpoints and `MODEL_CONFIG_ENCRYPTION_KEY` to protect credentials at rest. Supported adapters and their platform API notes are in `docs/architecture/model-provider-console.md`.

The page never reads saved secret values back from the API. Secret fields left blank keep the credentials already stored for that same provider. The operator can change the service URL to follow regional endpoints or provider URL changes.

Future parent progress, curriculum, and cost dashboards remain separate from this operator screen.
