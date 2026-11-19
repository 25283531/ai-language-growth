-- 课程版本化双速/拆读音频。
-- 身份含 contentVersion 与 sentence/word clipKey，编辑后旧版本自然失效但仍可回滚。
CREATE TABLE "curriculum_audio_clips" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "contentVersion" TEXT NOT NULL,
    "clipKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "partIndex" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "speedTier" TEXT NOT NULL,
    "speed" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    "audioRef" TEXT,
    "durationMs" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "curriculum_audio_clips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "curriculum_audio_clip_identity"
    ON "curriculum_audio_clips"("unitId", "contentVersion", "clipKey", "kind", "partIndex", "speedTier");

CREATE INDEX "curriculum_audio_clips_unitId_contentVersion_status_idx"
    ON "curriculum_audio_clips"("unitId", "contentVersion", "status");

CREATE INDEX "curriculum_audio_clips_topicId_contentVersion_idx"
    ON "curriculum_audio_clips"("topicId", "contentVersion");

ALTER TABLE "curriculum_audio_clips"
    ADD CONSTRAINT "curriculum_audio_clips_unitId_fkey"
    FOREIGN KEY ("unitId") REFERENCES "curriculum_units"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
