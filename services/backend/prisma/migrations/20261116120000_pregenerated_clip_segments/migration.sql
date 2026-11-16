-- 分段预生成：中英混合句按语言切段后各段独立合成，请求时按段顺序下发。
-- 中文段自然语速（三档共用同一文件），英文段按档位渲染，因此三档差异只落在英文段。
CREATE TABLE IF NOT EXISTS "pregenerated_clip_segments" (
    "id"           TEXT NOT NULL,
    "clipId"       UUID NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "lang"         TEXT NOT NULL,
    "segmentText"  TEXT NOT NULL,
    "audioFile"    TEXT NOT NULL,
    "audioRef"     TEXT NOT NULL,
    "sha256"       TEXT NOT NULL,
    "bytes"        INTEGER NOT NULL,
    "durationMs"   INTEGER NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pregenerated_clip_segments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pregenerated_clip_segments_clipId_segmentIndex_key"
    ON "pregenerated_clip_segments" ("clipId", "segmentIndex");

CREATE INDEX IF NOT EXISTS "pregenerated_clip_segments_clipId_idx"
    ON "pregenerated_clip_segments" ("clipId");

-- 已经用 TEXT 建过表的环境：就地转成 UUID，避免与 pregenerated_clips.id 比较时报类型错。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'pregenerated_clip_segments'
       AND column_name = 'clipId'
       AND data_type = 'text'
  ) THEN
    ALTER TABLE "pregenerated_clip_segments"
      ALTER COLUMN "clipId" TYPE UUID USING "clipId"::uuid;
  END IF;
END $$;
