ALTER TABLE "ai_usage_logs"
ADD COLUMN "providerAlias" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "modelAlias" TEXT NOT NULL DEFAULT 'unknown';
