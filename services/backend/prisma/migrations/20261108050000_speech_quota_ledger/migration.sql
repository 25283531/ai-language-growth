CREATE TABLE "speech_quota_buckets" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "usageDate" DATE NOT NULL,
    "serviceKind" TEXT NOT NULL,
    "limitUnits" DOUBLE PRECISION NOT NULL,
    "reservedUnits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "consumedUnits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "speech_quota_buckets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "speech_quota_reservations" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "serviceKind" TEXT NOT NULL,
    "requestedUnits" DOUBLE PRECISION NOT NULL,
    "consumedUnits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "bucketId" TEXT NOT NULL,
    CONSTRAINT "speech_quota_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "speech_quota_buckets_learnerId_usageDate_serviceKind_key"
  ON "speech_quota_buckets"("learnerId", "usageDate", "serviceKind");
CREATE INDEX "speech_quota_buckets_learnerId_usageDate_idx"
  ON "speech_quota_buckets"("learnerId", "usageDate");
CREATE UNIQUE INDEX "speech_quota_reservations_idempotencyKey_key"
  ON "speech_quota_reservations"("idempotencyKey");
CREATE INDEX "speech_quota_reservations_learnerId_serviceKind_status_idx"
  ON "speech_quota_reservations"("learnerId", "serviceKind", "status");
CREATE INDEX "speech_quota_reservations_expiresAt_idx"
  ON "speech_quota_reservations"("expiresAt");

ALTER TABLE "speech_quota_reservations"
  ADD CONSTRAINT "speech_quota_reservations_bucketId_fkey"
  FOREIGN KEY ("bucketId") REFERENCES "speech_quota_buckets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
