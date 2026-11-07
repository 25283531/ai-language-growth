-- Runtime model connections configured from the operator console.
-- API credentials are application-encrypted before they reach this table.
CREATE TABLE "ai_provider_configs" (
    "id" TEXT NOT NULL,
    "serviceKind" TEXT NOT NULL,
    "providerPresetId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "modelAlias" TEXT NOT NULL,
    "credentialsCiphertext" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_provider_configs_serviceKind_key"
    ON "ai_provider_configs"("serviceKind");
