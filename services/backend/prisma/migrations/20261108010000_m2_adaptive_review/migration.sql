ALTER TABLE "lesson_sessions"
ADD COLUMN "currentReviewScheduleId" TEXT;

ALTER TABLE "review_schedules"
ADD COLUMN "consecutiveSuccesses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "learningItemId" TEXT,
ADD COLUMN "activeKey" TEXT,
ADD COLUMN "claimedBySessionId" TEXT,
ADD COLUMN "claimExpiresAt" TIMESTAMP(3);

WITH ranked_pending AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "learnerId", "skillNodeId", COALESCE("learningItemId", '*')
      ORDER BY "dueAt" ASC, "createdAt" ASC, "id" ASC
    ) AS position
  FROM "review_schedules"
  WHERE "completedAt" IS NULL
)
UPDATE "review_schedules" AS schedules
SET "completedAt" = CURRENT_TIMESTAMP
FROM ranked_pending
WHERE schedules."id" = ranked_pending."id"
  AND ranked_pending.position > 1;

UPDATE "review_schedules"
SET "activeKey" = "learnerId" || '::' || "skillNodeId" || '::' || COALESCE("learningItemId", '*')
WHERE "completedAt" IS NULL;

CREATE UNIQUE INDEX "review_schedules_activeKey_key"
ON "review_schedules"("activeKey");

CREATE UNIQUE INDEX "review_schedules_claimedBySessionId_key"
ON "review_schedules"("claimedBySessionId");

CREATE INDEX "review_schedules_learnerId_completedAt_dueAt_idx"
ON "review_schedules"("learnerId", "completedAt", "dueAt");

ALTER TABLE "review_schedules"
ADD CONSTRAINT "review_schedules_learningItemId_fkey"
FOREIGN KEY ("learningItemId") REFERENCES "learning_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "review_schedules_learnerId_dueAt_idx";
