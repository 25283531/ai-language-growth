-- P0: ECDICT 词族词库 + 已上线单元版本/可用性。
-- 全部为增量变更：旧单元 currentVersion=1、availability=active，可继续读取。

ALTER TABLE "curriculum_units"
ADD COLUMN "content" JSONB,
ADD COLUMN "contentVersion" TEXT,
ADD COLUMN "currentVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "availability" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN "stageHint" INTEGER;

ALTER TABLE "curriculum_units"
ADD CONSTRAINT "curriculum_units_availability_chk"
CHECK ("availability" IN ('active', 'disabled'));

CREATE INDEX "curriculum_units_availability_reviewStatus_idx"
ON "curriculum_units" ("availability", "reviewStatus");

CREATE TABLE "curriculum_unit_versions" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "curriculum_unit_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "curriculum_unit_versions_unitId_version_key"
ON "curriculum_unit_versions" ("unitId", "version");

CREATE INDEX "curriculum_unit_versions_unitId_createdAt_idx"
ON "curriculum_unit_versions" ("unitId", "createdAt");

ALTER TABLE "curriculum_unit_versions"
ADD CONSTRAINT "curriculum_unit_versions_unitId_fkey"
FOREIGN KEY ("unitId") REFERENCES "curriculum_units"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "lexicon_entries" (
    "id" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "lemma" TEXT NOT NULL DEFAULT '',
    "familyKey" TEXT NOT NULL DEFAULT '',
    "familyRank" INTEGER,
    "phonetic" TEXT NOT NULL DEFAULT '',
    "pos" TEXT NOT NULL DEFAULT '',
    "meaningZh" TEXT NOT NULL DEFAULT '',
    "frequencyRank" INTEGER,
    "bncRank" INTEGER,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "variants" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "collocations" JSONB NOT NULL DEFAULT '[]',
    "examples" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'ecdict',
    "license" TEXT NOT NULL DEFAULT 'MIT',
    "childSafe" BOOLEAN NOT NULL DEFAULT true,
    "isCore" BOOLEAN NOT NULL DEFAULT false,
    "isFunctionWord" BOOLEAN NOT NULL DEFAULT false,
    "textbookUnitIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lexicon_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lexicon_entries_word_key" ON "lexicon_entries" ("word");
CREATE INDEX "lexicon_entries_familyKey_idx" ON "lexicon_entries" ("familyKey");
CREATE INDEX "lexicon_entries_familyRank_idx" ON "lexicon_entries" ("familyRank");
CREATE INDEX "lexicon_entries_frequencyRank_idx" ON "lexicon_entries" ("frequencyRank");
CREATE INDEX "lexicon_entries_source_idx" ON "lexicon_entries" ("source");
CREATE INDEX "lexicon_entries_domains_gin" ON "lexicon_entries" USING GIN ("domains");
CREATE INDEX "lexicon_entries_variants_gin" ON "lexicon_entries" USING GIN ("variants");
CREATE INDEX "lexicon_entries_textbookUnitIds_gin" ON "lexicon_entries" USING GIN ("textbookUnitIds");

