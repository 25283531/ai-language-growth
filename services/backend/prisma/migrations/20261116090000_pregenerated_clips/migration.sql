-- 预生成语音索引表（腾讯 TTS 批量产物接入）。
-- 生产已按同一 DDL 建表，此处以 IF NOT EXISTS 对齐仓库内可复现性：
-- 任何环境执行 migrate deploy 后都应存在这两张表，运行时代码不再依赖手工建表。
BEGIN;

CREATE TABLE IF NOT EXISTS pregenerated_clips (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "clipKey"       text        NOT NULL,
  lang            text        NOT NULL,
  "textHash"      text        NOT NULL,
  "normalizedText" text       NOT NULL,
  "speedTier"     text        NOT NULL,
  "teacherSpeed"  double precision NOT NULL,
  "voiceId"       text        NOT NULL,
  engine          text        NOT NULL,
  "engineVersion" text        NOT NULL,
  "taskId"        text,
  "audioFile"     text        NOT NULL,
  "audioRef"      text        NOT NULL,
  "mimeType"      text        NOT NULL DEFAULT 'audio/mpeg',
  "sampleRate"    integer     NOT NULL DEFAULT 24000,
  "durationMs"    integer     NOT NULL,
  bytes           integer     NOT NULL,
  sha256          text        NOT NULL,
  scope           text        NOT NULL DEFAULT 'PUBLIC_CURRICULUM',
  status          text        NOT NULL DEFAULT 'ready',
  "importedAt"    timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pregenerated_clips_clip_key_uniq UNIQUE ("clipKey"),
  CONSTRAINT pregenerated_clips_identity_uniq UNIQUE ("textHash", lang, "speedTier", "engineVersion"),
  CONSTRAINT pregenerated_clips_speed_tier_chk CHECK ("speedTier" IN ('normal', 'slow', 'very_slow')),
  CONSTRAINT pregenerated_clips_lang_chk CHECK (lang IN ('en', 'zh')),
  CONSTRAINT pregenerated_clips_status_chk CHECK (status IN ('ready', 'stale', 'missing', 'disabled')),
  CONSTRAINT pregenerated_clips_audio_file_chk CHECK ("audioFile" ~ '^[a-f0-9]{24}\.(mp3|wav|m4a)$'),
  CONSTRAINT pregenerated_clips_audio_ref_chk CHECK ("audioRef" = '/api/v1/media/audio/' || "audioFile")
);

CREATE INDEX IF NOT EXISTS pregenerated_clips_lookup_idx
  ON pregenerated_clips (lang, "speedTier", status);
CREATE INDEX IF NOT EXISTS pregenerated_clips_hash_idx
  ON pregenerated_clips ("textHash");
CREATE INDEX IF NOT EXISTS pregenerated_clips_version_idx
  ON pregenerated_clips (status, "engineVersion");

CREATE TABLE IF NOT EXISTS pregeneration_batches (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  engine                 text        NOT NULL,
  "engineVersion"        text        NOT NULL,
  "sourceManifestSha256" text        NOT NULL,
  "taskCount"            integer     NOT NULL DEFAULT 0,
  "importedCount"        integer     NOT NULL DEFAULT 0,
  "skippedCount"         integer     NOT NULL DEFAULT 0,
  "mismatchCount"        integer     NOT NULL DEFAULT 0,
  "startedAt"            timestamptz NOT NULL DEFAULT now(),
  "finishedAt"           timestamptz,
  note                   text
);

CREATE INDEX IF NOT EXISTS pregeneration_batches_version_idx
  ON pregeneration_batches ("engineVersion", "startedAt" DESC);

COMMIT;
