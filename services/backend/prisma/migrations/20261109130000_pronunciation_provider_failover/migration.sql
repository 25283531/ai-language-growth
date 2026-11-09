DROP INDEX IF EXISTS "ai_provider_configs_serviceKind_key";

ALTER TABLE "ai_provider_configs"
    ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN "timeoutMs" INTEGER NOT NULL DEFAULT 20000;

CREATE INDEX "ai_provider_configs_serviceKind_enabled_priority_idx"
    ON "ai_provider_configs"("serviceKind", "enabled", "priority");

UPDATE "ai_providers" AS provider
SET "alias" = 'configured_pronunciation_' || config."id"
FROM "ai_provider_configs" AS config
WHERE config."serviceKind" = 'pronunciation'
  AND provider."alias" = 'configured_pronunciation';
