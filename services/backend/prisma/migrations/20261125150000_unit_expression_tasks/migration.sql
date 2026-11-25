CREATE TABLE "unit_expression_tasks" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scenarioZh" TEXT NOT NULL,
    "promptEn" TEXT NOT NULL,
    "promptZh" TEXT NOT NULL,
    "referenceAnswer" TEXT NOT NULL,
    "requiredPhrases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceSentenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unit_expression_tasks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_expression_tasks_unitId_key" ON "unit_expression_tasks"("unitId");
CREATE INDEX "unit_expression_tasks_topicId_idx" ON "unit_expression_tasks"("topicId");