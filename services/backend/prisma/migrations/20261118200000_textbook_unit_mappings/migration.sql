-- 教材单元级内容生产映射：学校 A-E 模块、主题领域、建议阶段与能力节点。
-- 与面向学习者的 textbook_mappings 分开，避免把课程内容配置写进学习者记录。
CREATE TABLE "textbook_unit_mappings" (
    "id" TEXT NOT NULL,
    "textbookId" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "skillNodeIds" JSONB NOT NULL DEFAULT '[]',
    "domains" JSONB NOT NULL DEFAULT '[]',
    "schoolModules" JSONB NOT NULL DEFAULT '[]',
    "stageHint" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'editorial',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "textbook_unit_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "textbook_unit_mappings_textbookId_unitCode_key"
    ON "textbook_unit_mappings"("textbookId", "unitCode");

CREATE INDEX "textbook_unit_mappings_textbookId_idx"
    ON "textbook_unit_mappings"("textbookId");

ALTER TABLE "textbook_unit_mappings"
    ADD CONSTRAINT "textbook_unit_mappings_textbookId_fkey"
    FOREIGN KEY ("textbookId") REFERENCES "textbook_catalogs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
