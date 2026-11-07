-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'guardian',
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learner_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "ageGroup" TEXT NOT NULL DEFAULT '6-9',
    "entryLevel" TEXT NOT NULL DEFAULT 'pre_a1',
    "target" TEXT NOT NULL DEFAULT 'daily_communication',
    "guardianId" TEXT NOT NULL,
    "currentTopic" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learner_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learner_preferences" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "speechSpeed" DOUBLE PRECISION NOT NULL DEFAULT 0.65,
    "repeatMode" TEXT NOT NULL DEFAULT 'patient',
    "feedbackStyle" TEXT NOT NULL DEFAULT 'encouraging',
    "theme" TEXT NOT NULL DEFAULT 'default',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learner_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_nodes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abilityCategory" TEXT NOT NULL,
    "growthStage" INTEGER NOT NULL,
    "track" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '[]',
    "objective" TEXT NOT NULL,
    "masteryCriteria" TEXT NOT NULL,
    "m1Scope" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_dependencies" (
    "id" TEXT NOT NULL,
    "skillNodeId" TEXT NOT NULL,
    "dependsOnSkillNodeId" TEXT NOT NULL,
    "dependencyType" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "skill_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learner_skill_states" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "skillNodeId" TEXT NOT NULL,
    "masteryCode" INTEGER NOT NULL DEFAULT 0,
    "evidenceIds" JSONB NOT NULL DEFAULT '[]',
    "independentScenarios" JSONB NOT NULL DEFAULT '[]',
    "lastUnpromptedRecallAt" TIMESTAMP(3),
    "lastIndependentUseAt" TIMESTAMP(3),
    "calibrationStatus" TEXT NOT NULL DEFAULT 'uncalibrated',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learner_skill_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_items" (
    "id" TEXT NOT NULL,
    "skillNodeId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "topicId" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending_review',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_stages" (
    "id" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "curriculum_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_units" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending_review',

    CONSTRAINT "curriculum_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vocabulary_items" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "phonetic" TEXT NOT NULL,
    "syllables" JSONB NOT NULL,
    "meaningZh" TEXT NOT NULL,
    "imageRef" TEXT,
    "collocations" JSONB NOT NULL DEFAULT '[]',
    "exampleSentences" JSONB NOT NULL DEFAULT '[]',
    "difficultPhonemes" JSONB NOT NULL DEFAULT '[]',
    "skillNodeIds" JSONB NOT NULL DEFAULT '[]',
    "relatedWords" JSONB NOT NULL DEFAULT '[]',
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending_review',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vocabulary_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phoneme_items" (
    "id" TEXT NOT NULL,
    "phoneme" TEXT NOT NULL,
    "ipa" TEXT NOT NULL,
    "descriptionZh" TEXT NOT NULL,
    "difficulty" INTEGER NOT NULL DEFAULT 1,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending_review',

    CONSTRAINT "phoneme_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentence_patterns" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "zh" TEXT NOT NULL,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "skillNodeIds" JSONB NOT NULL DEFAULT '[]',
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending_review',

    CONSTRAINT "sentence_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "countsForTransfer" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_thresholds" (
    "id" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "scenario" TEXT,
    "passScore" DOUBLE PRECISION NOT NULL,
    "minSamplesForming" INTEGER NOT NULL DEFAULT 2,
    "minSamplesMastered" INTEGER NOT NULL DEFAULT 2,
    "minScenariosTransferred" INTEGER NOT NULL DEFAULT 2,
    "minIntervalTransferredMs" INTEGER NOT NULL DEFAULT 86400000,
    "source" TEXT NOT NULL DEFAULT 'm1_provisional',
    "calibrationStatus" TEXT NOT NULL DEFAULT 'uncalibrated',
    "version" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_sessions" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "methodState" JSONB NOT NULL DEFAULT '{}',
    "currentActivityId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" TEXT,

    CONSTRAINT "lesson_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interaction_events" (
    "id" TEXT NOT NULL,
    "lessonSessionId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "turnIndex" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interaction_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_records" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "lessonSessionId" TEXT NOT NULL,
    "skillNodeId" TEXT NOT NULL,
    "learningItemId" TEXT,
    "taskType" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "prompted" BOOLEAN NOT NULL DEFAULT false,
    "independent" BOOLEAN NOT NULL DEFAULT false,
    "score" DOUBLE PRECISION,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "assessmentSource" TEXT NOT NULL,
    "evidenceId" TEXT,
    "thresholdVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_evidence" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "lessonSessionId" TEXT,
    "skillNodeId" TEXT NOT NULL,
    "learningItemId" TEXT,
    "abilityCategory" TEXT NOT NULL,
    "vocabularyDimension" TEXT,
    "source" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "prompted" BOOLEAN NOT NULL DEFAULT false,
    "independent" BOOLEAN NOT NULL DEFAULT false,
    "scenario" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credibility" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "contributesToPromotion" BOOLEAN NOT NULL DEFAULT true,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "score" DOUBLE PRECISION,
    "errorUnits" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "thresholdVersion" TEXT,
    "ruleVersion" TEXT,

    CONSTRAINT "learning_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_schedules" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "skillNodeId" TEXT NOT NULL,
    "intervalDays" INTEGER NOT NULL DEFAULT 1,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "textbook_mappings" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "currentUnit" TEXT NOT NULL,
    "skillNodeIds" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "textbook_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "voiceIdentity" TEXT,
    "teacherSpeed" DOUBLE PRECISION,
    "durationMs" INTEGER,
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "coreTraits" JSONB NOT NULL,
    "adjustable" JSONB NOT NULL,
    "style" TEXT NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teacher_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persona_history" (
    "id" TEXT NOT NULL,
    "teacherProfileId" TEXT NOT NULL,
    "learnerId" TEXT,
    "changeContent" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "rollbackOf" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "persona_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interaction_memories" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "teacherProfileId" TEXT,
    "memoryType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "source" TEXT NOT NULL DEFAULT 'batch_extract',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interaction_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_providers" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "concurrencyLimit" INTEGER NOT NULL DEFAULT 8,
    "circuitBreaker" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_models" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "version" TEXT,
    "level" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_capabilities" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ai_model_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_prices" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "priceType" TEXT NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_limits" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "limitType" TEXT NOT NULL,
    "limitValue" DOUBLE PRECISION NOT NULL,
    "window" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ai_model_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_task_routes" (
    "id" TEXT NOT NULL,
    "taskRoute" TEXT NOT NULL,
    "serviceKind" TEXT NOT NULL,
    "primaryModelId" TEXT,
    "fallbackModelIds" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_task_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_route_rules" (
    "id" TEXT NOT NULL,
    "taskRoute" TEXT NOT NULL,
    "escalationSignal" TEXT NOT NULL,
    "targetLevel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ai_route_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_benchmarks" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "benchmarkType" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "testedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_model_benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT,
    "lessonSessionId" TEXT,
    "modelId" TEXT,
    "serviceKind" TEXT NOT NULL,
    "taskRoute" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "ttsCharacters" INTEGER NOT NULL DEFAULT 0,
    "asrSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pronunciationCalls" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostCny" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_fallback_logs" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT,
    "lessonSessionId" TEXT,
    "taskRoute" TEXT NOT NULL,
    "fromModelId" TEXT,
    "toModelId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_fallback_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "learnerId" TEXT,
    "consentType" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT false,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "learner_profiles_guardianId_idx" ON "learner_profiles"("guardianId");

-- CreateIndex
CREATE UNIQUE INDEX "learner_preferences_learnerId_key" ON "learner_preferences"("learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_nodes_code_key" ON "skill_nodes"("code");

-- CreateIndex
CREATE INDEX "skill_nodes_abilityCategory_idx" ON "skill_nodes"("abilityCategory");

-- CreateIndex
CREATE INDEX "skill_nodes_growthStage_idx" ON "skill_nodes"("growthStage");

-- CreateIndex
CREATE INDEX "skill_dependencies_dependsOnSkillNodeId_idx" ON "skill_dependencies"("dependsOnSkillNodeId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_dependencies_skillNodeId_dependsOnSkillNodeId_depende_key" ON "skill_dependencies"("skillNodeId", "dependsOnSkillNodeId", "dependencyType");

-- CreateIndex
CREATE INDEX "learner_skill_states_learnerId_idx" ON "learner_skill_states"("learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "learner_skill_states_learnerId_skillNodeId_key" ON "learner_skill_states"("learnerId", "skillNodeId");

-- CreateIndex
CREATE INDEX "learning_items_skillNodeId_idx" ON "learning_items"("skillNodeId");

-- CreateIndex
CREATE INDEX "learning_items_itemType_idx" ON "learning_items"("itemType");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_stages_stage_key" ON "curriculum_stages"("stage");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_stages_code_key" ON "curriculum_stages"("code");

-- CreateIndex
CREATE INDEX "curriculum_units_topicId_idx" ON "curriculum_units"("topicId");

-- CreateIndex
CREATE INDEX "vocabulary_items_topicId_idx" ON "vocabulary_items"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "phoneme_items_phoneme_key" ON "phoneme_items"("phoneme");

-- CreateIndex
CREATE INDEX "sentence_patterns_topicId_idx" ON "sentence_patterns"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "scenarios_code_key" ON "scenarios"("code");

-- CreateIndex
CREATE INDEX "assessment_thresholds_taskType_version_idx" ON "assessment_thresholds"("taskType", "version");

-- CreateIndex
CREATE INDEX "lesson_sessions_learnerId_startedAt_idx" ON "lesson_sessions"("learnerId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "interaction_events_idempotencyKey_key" ON "interaction_events"("idempotencyKey");

-- CreateIndex
CREATE INDEX "interaction_events_learnerId_idx" ON "interaction_events"("learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "interaction_events_lessonSessionId_turnIndex_key" ON "interaction_events"("lessonSessionId", "turnIndex");

-- CreateIndex
CREATE INDEX "assessment_records_learnerId_createdAt_idx" ON "assessment_records"("learnerId", "createdAt");

-- CreateIndex
CREATE INDEX "assessment_records_lessonSessionId_idx" ON "assessment_records"("lessonSessionId");

-- CreateIndex
CREATE INDEX "learning_evidence_learnerId_skillNodeId_occurredAt_idx" ON "learning_evidence"("learnerId", "skillNodeId", "occurredAt");

-- CreateIndex
CREATE INDEX "learning_evidence_lessonSessionId_idx" ON "learning_evidence"("lessonSessionId");

-- CreateIndex
CREATE INDEX "review_schedules_learnerId_dueAt_idx" ON "review_schedules"("learnerId", "dueAt");

-- CreateIndex
CREATE INDEX "media_assets_checksum_idx" ON "media_assets"("checksum");

-- CreateIndex
CREATE INDEX "interaction_memories_learnerId_idx" ON "interaction_memories"("learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_providers_alias_key" ON "ai_providers"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_providerId_alias_key" ON "ai_models"("providerId", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_capabilities_modelId_capability_key" ON "ai_model_capabilities"("modelId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_prices_modelId_priceType_key" ON "ai_model_prices"("modelId", "priceType");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_limits_modelId_limitType_key" ON "ai_model_limits"("modelId", "limitType");

-- CreateIndex
CREATE UNIQUE INDEX "ai_task_routes_taskRoute_serviceKind_key" ON "ai_task_routes"("taskRoute", "serviceKind");

-- CreateIndex
CREATE UNIQUE INDEX "ai_route_rules_taskRoute_escalationSignal_key" ON "ai_route_rules"("taskRoute", "escalationSignal");

-- CreateIndex
CREATE INDEX "ai_model_benchmarks_modelId_idx" ON "ai_model_benchmarks"("modelId");

-- CreateIndex
CREATE INDEX "ai_usage_logs_learnerId_createdAt_idx" ON "ai_usage_logs"("learnerId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_logs_lessonSessionId_idx" ON "ai_usage_logs"("lessonSessionId");

-- CreateIndex
CREATE INDEX "ai_fallback_logs_lessonSessionId_idx" ON "ai_fallback_logs"("lessonSessionId");

-- CreateIndex
CREATE INDEX "consent_records_userId_idx" ON "consent_records"("userId");

-- AddForeignKey
ALTER TABLE "learner_profiles" ADD CONSTRAINT "learner_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learner_preferences" ADD CONSTRAINT "learner_preferences_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_dependencies" ADD CONSTRAINT "skill_dependencies_skillNodeId_fkey" FOREIGN KEY ("skillNodeId") REFERENCES "skill_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_dependencies" ADD CONSTRAINT "skill_dependencies_dependsOnSkillNodeId_fkey" FOREIGN KEY ("dependsOnSkillNodeId") REFERENCES "skill_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learner_skill_states" ADD CONSTRAINT "learner_skill_states_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learner_skill_states" ADD CONSTRAINT "learner_skill_states_skillNodeId_fkey" FOREIGN KEY ("skillNodeId") REFERENCES "skill_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_skillNodeId_fkey" FOREIGN KEY ("skillNodeId") REFERENCES "skill_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interaction_events" ADD CONSTRAINT "interaction_events_lessonSessionId_fkey" FOREIGN KEY ("lessonSessionId") REFERENCES "lesson_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interaction_events" ADD CONSTRAINT "interaction_events_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_records" ADD CONSTRAINT "assessment_records_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_records" ADD CONSTRAINT "assessment_records_lessonSessionId_fkey" FOREIGN KEY ("lessonSessionId") REFERENCES "lesson_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_records" ADD CONSTRAINT "assessment_records_skillNodeId_fkey" FOREIGN KEY ("skillNodeId") REFERENCES "skill_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_records" ADD CONSTRAINT "assessment_records_learningItemId_fkey" FOREIGN KEY ("learningItemId") REFERENCES "learning_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_records" ADD CONSTRAINT "assessment_records_scenario_fkey" FOREIGN KEY ("scenario") REFERENCES "scenarios"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_skillNodeId_fkey" FOREIGN KEY ("skillNodeId") REFERENCES "skill_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_learningItemId_fkey" FOREIGN KEY ("learningItemId") REFERENCES "learning_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_lessonSessionId_fkey" FOREIGN KEY ("lessonSessionId") REFERENCES "lesson_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_scenario_fkey" FOREIGN KEY ("scenario") REFERENCES "scenarios"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_schedules" ADD CONSTRAINT "review_schedules_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "persona_history" ADD CONSTRAINT "persona_history_teacherProfileId_fkey" FOREIGN KEY ("teacherProfileId") REFERENCES "teacher_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interaction_memories" ADD CONSTRAINT "interaction_memories_teacherProfileId_fkey" FOREIGN KEY ("teacherProfileId") REFERENCES "teacher_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_model_capabilities" ADD CONSTRAINT "ai_model_capabilities_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_model_prices" ADD CONSTRAINT "ai_model_prices_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_model_limits" ADD CONSTRAINT "ai_model_limits_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_task_routes" ADD CONSTRAINT "ai_task_routes_primaryModelId_fkey" FOREIGN KEY ("primaryModelId") REFERENCES "ai_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_model_benchmarks" ADD CONSTRAINT "ai_model_benchmarks_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_lessonSessionId_fkey" FOREIGN KEY ("lessonSessionId") REFERENCES "lesson_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- M1 数据完整性约束（手写，Prisma schema 无法表达）
-- ============================================================================

-- 掌握状态机读编码约束：只允许 0-4，与 shared-contracts MASTERY_STATE_CODES 一一对应
ALTER TABLE "learner_skill_states"
  ADD CONSTRAINT "ck_mastery_code_range" CHECK ("masteryCode" BETWEEN 0 AND 4);

-- 证据可信度范围
ALTER TABLE "learning_evidence"
  ADD CONSTRAINT "ck_evidence_credibility_range" CHECK ("credibility" BETWEEN 0 AND 1);

-- 评估得分范围
ALTER TABLE "assessment_records"
  ADD CONSTRAINT "ck_assessment_score_range" CHECK ("score" IS NULL OR ("score" BETWEEN 0 AND 100));

-- LLM 判断不得单独构成晋级依据（约束三：不得凭 AI 自我声称就改写掌握状态）
ALTER TABLE "learning_evidence"
  ADD CONSTRAINT "ck_llm_no_promotion"
  CHECK (NOT ("source" = 'llm_judgement' AND "contributesToPromotion" = true));

-- learning_evidence 只允许 INSERT，不允许 UPDATE / DELETE。
-- 证据必须可追溯、可重放，事后修改会破坏「状态变更均可追溯到证据事件」的验收口径。
CREATE OR REPLACE FUNCTION forbid_evidence_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'learning_evidence is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_learning_evidence_append_only
  BEFORE UPDATE OR DELETE ON "learning_evidence"
  FOR EACH ROW EXECUTE FUNCTION forbid_evidence_mutation();

-- 幂等键唯一（同一 key 重复提交不重复写证据、不重复计费）
CREATE UNIQUE INDEX "uq_interaction_idempotency_key" ON "interaction_events" ("idempotencyKey");
