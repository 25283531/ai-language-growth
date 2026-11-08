ALTER TABLE "interaction_memories"
ADD COLUMN "sourceSessionId" TEXT;

CREATE UNIQUE INDEX "interaction_memories_sourceSessionId_key"
ON "interaction_memories"("sourceSessionId");

ALTER TABLE "interaction_memories"
ADD CONSTRAINT "interaction_memories_learnerId_fkey"
FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "interaction_memories_sourceSessionId_fkey"
FOREIGN KEY ("sourceSessionId") REFERENCES "lesson_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "learner_growth_snapshots" (
  "id" TEXT NOT NULL,
  "learnerId" TEXT NOT NULL,
  "lessonSessionId" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "learner_growth_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "learner_growth_snapshots_lessonSessionId_key"
ON "learner_growth_snapshots"("lessonSessionId");

CREATE INDEX "learner_growth_snapshots_learnerId_createdAt_idx"
ON "learner_growth_snapshots"("learnerId", "createdAt");

ALTER TABLE "learner_growth_snapshots"
ADD CONSTRAINT "learner_growth_snapshots_learnerId_fkey"
FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "learner_growth_snapshots_lessonSessionId_fkey"
FOREIGN KEY ("lessonSessionId") REFERENCES "lesson_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
