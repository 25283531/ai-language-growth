CREATE TABLE "unit_cloze_items" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "itemIndex" INTEGER NOT NULL,
    "grammarPointId" TEXT NOT NULL DEFAULT '',
    "sentence" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "explanationZh" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unit_cloze_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_cloze_items_unitId_itemIndex_key" ON "unit_cloze_items"("unitId", "itemIndex");
CREATE INDEX "unit_cloze_items_topicId_idx" ON "unit_cloze_items"("topicId");