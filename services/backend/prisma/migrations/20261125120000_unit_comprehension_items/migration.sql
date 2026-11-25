CREATE TABLE "unit_comprehension_items" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "itemIndex" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "answer" TEXT NOT NULL,
    "explanationZh" TEXT NOT NULL DEFAULT '',
    "sourceSentenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unit_comprehension_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_comprehension_items_unitId_itemIndex_key" ON "unit_comprehension_items"("unitId", "itemIndex");
CREATE INDEX "unit_comprehension_items_topicId_idx" ON "unit_comprehension_items"("topicId");