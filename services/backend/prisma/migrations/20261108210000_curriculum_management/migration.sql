ALTER TABLE "curriculum_units"
ADD COLUMN "level" TEXT NOT NULL DEFAULT 'A',
ADD COLUMN "textbookUnitId" TEXT,
ADD COLUMN "publishedAt" TIMESTAMP(3);

CREATE TABLE "textbook_catalogs" (
    "id" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "publicationYear" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "title" TEXT,
    "edition" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "textbook_catalogs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "textbook_units" (
    "id" TEXT NOT NULL,
    "textbookId" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "textbook_units_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "curriculum_drafts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "topicId" TEXT,
    "textbookId" TEXT,
    "textbookUnitId" TEXT,
    "wordList" JSONB NOT NULL,
    "generatedContent" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT,
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "generatedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "curriculum_drafts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "curriculum_review_records" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reviewer" TEXT,
    "note" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "curriculum_review_records_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "teacher_profiles"
ADD COLUMN "learnerId" TEXT;

ALTER TABLE "media_assets"
ADD COLUMN "sourceUrl" TEXT,
ADD COLUMN "attribution" TEXT,
ADD COLUMN "license" TEXT,
ADD COLUMN "sourceProvider" TEXT;

CREATE UNIQUE INDEX "teacher_profiles_learnerId_key" ON "teacher_profiles"("learnerId");
CREATE UNIQUE INDEX "textbook_catalogs_publisher_publicationYear_grade_title_edition_key"
ON "textbook_catalogs"("publisher", "publicationYear", "grade", "title", "edition");
CREATE INDEX "textbook_catalogs_publisher_publicationYear_grade_idx"
ON "textbook_catalogs"("publisher", "publicationYear", "grade");
CREATE UNIQUE INDEX "textbook_units_textbookId_unitCode_key" ON "textbook_units"("textbookId", "unitCode");
CREATE INDEX "textbook_units_textbookId_order_idx" ON "textbook_units"("textbookId", "order");
CREATE INDEX "curriculum_units_level_reviewStatus_idx" ON "curriculum_units"("level", "reviewStatus");
CREATE INDEX "curriculum_units_textbookUnitId_idx" ON "curriculum_units"("textbookUnitId");
CREATE INDEX "curriculum_drafts_status_level_idx" ON "curriculum_drafts"("status", "level");
CREATE INDEX "curriculum_drafts_textbookId_textbookUnitId_idx" ON "curriculum_drafts"("textbookId", "textbookUnitId");
CREATE INDEX "curriculum_review_records_draftId_createdAt_idx" ON "curriculum_review_records"("draftId", "createdAt");

ALTER TABLE "curriculum_units"
ADD CONSTRAINT "curriculum_units_textbookUnitId_fkey"
FOREIGN KEY ("textbookUnitId") REFERENCES "textbook_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "textbook_units"
ADD CONSTRAINT "textbook_units_textbookId_fkey"
FOREIGN KEY ("textbookId") REFERENCES "textbook_catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "curriculum_drafts"
ADD CONSTRAINT "curriculum_drafts_textbookId_fkey"
FOREIGN KEY ("textbookId") REFERENCES "textbook_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "curriculum_drafts"
ADD CONSTRAINT "curriculum_drafts_textbookUnitId_fkey"
FOREIGN KEY ("textbookUnitId") REFERENCES "textbook_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "curriculum_review_records"
ADD CONSTRAINT "curriculum_review_records_draftId_fkey"
FOREIGN KEY ("draftId") REFERENCES "curriculum_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teacher_profiles"
ADD CONSTRAINT "teacher_profiles_learnerId_fkey"
FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
