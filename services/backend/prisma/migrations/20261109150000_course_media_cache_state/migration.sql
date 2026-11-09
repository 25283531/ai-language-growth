ALTER TABLE "media_assets"
  ADD COLUMN "cacheStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "cacheError" TEXT,
  ADD COLUMN "cacheExtension" TEXT;

CREATE INDEX "media_assets_kind_cacheStatus_createdAt_idx"
  ON "media_assets"("kind", "cacheStatus", "createdAt");
