-- L3 交互记忆的 Mem0 外部 ID。PostgreSQL 行仍是可审计副本；
-- 外部 ID 只用于语义检索命中后的更新/删除，不参与教学判定。
ALTER TABLE "interaction_memories"
    ADD COLUMN "externalId" TEXT,
    ADD COLUMN "externalProvider" TEXT;

CREATE INDEX "interaction_memories_externalId_idx"
    ON "interaction_memories" ("externalId");

-- L5 课程知识库 RAG 分块。
-- embedding 可空：未配置 Embedding 时保留文本与词法检索，配置后写向量做语义召回。
CREATE TABLE "curriculum_knowledge_chunks" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "topicId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" JSONB,
    "embeddingModel" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "curriculum_knowledge_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "curriculum_knowledge_chunks_sourceType_sourceId_key"
    ON "curriculum_knowledge_chunks" ("sourceType", "sourceId");

CREATE INDEX "curriculum_knowledge_chunks_topicId_idx"
    ON "curriculum_knowledge_chunks" ("topicId");

CREATE INDEX "curriculum_knowledge_chunks_updatedAt_idx"
    ON "curriculum_knowledge_chunks" ("updatedAt");