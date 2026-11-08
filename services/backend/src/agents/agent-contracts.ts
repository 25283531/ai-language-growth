/**
 * Backend contracts for the four teaching roles plus the supporting memory/personality
 * agents (D-009). Roles are separate responsibilities and task routes, not separate
 * model deployments.
 */
export const TEACHING_AGENTS = {
  teacher_orchestrator: {
    purpose: 'Run the deterministic teaching loop, assemble bounded context, and invoke only the role needed for the current event.',
    triggers: ['every_learner_turn'],
    taskRoutes: [],
    authoritativeInputs: ['session_state', 'current_directive', 'learner_evidence', 'quota_and_policy'],
    outputs: ['next_teaching_directive', 'assessment_request', 'evidence_write_request'],
    mayChangeMastery: false,
  },
  planner: {
    purpose: 'Choose the next learning objective and explain why it is appropriate.',
    triggers: [
      'lesson_start',
      'activity_completed_when_next_activity_needed',
      'rule_threshold_after_repeated_failure',
      'lesson_finish_stage_review',
    ],
    taskRoutes: ['llm.learning_plan', 'llm.method_adaptation'],
    authoritativeInputs: ['published_activities', 'skill_states', 'learning_evidence', 'review_schedule', 'textbook_mapping'],
    outputs: ['candidate_activity_id', 'rationale', 'next_focus_skill_node_ids'],
    mayChangeMastery: false,
  },
  teacher: {
    purpose: 'Demonstrate, explain, ask, encourage, correct, and adapt teaching language.',
    triggers: ['learner_turn_requiring_language_reasoning', 'child_question', 'child_small_talk'],
    taskRoutes: ['llm.simple_dialogue', 'llm.teaching_explanation', 'llm.method_adaptation'],
    authoritativeInputs: ['current_directive', 'bounded_learner_context', 'teacher_profile'],
    outputs: ['child_safe_utterance', 'teaching_explanation'],
    mayChangeMastery: false,
  },
  assessment: {
    purpose: 'Produce structured task observations from speech services, task results, and deterministic rules.',
    triggers: ['eligible_speech_task', 'completed_learning_task', 'scheduled_review'],
    taskRoutes: ['asr.free_speech', 'asr.follow_read', 'pronunciation.word', 'pronunciation.phoneme'],
    authoritativeInputs: ['task_result', 'speech_service_result', 'assessment_threshold'],
    outputs: ['assessment_record', 'append_only_learning_evidence'],
    mayChangeMastery: false,
  },
  growth_mentor: {
    purpose: 'Explain longitudinal progress and suggest a focus to caregivers from verified structured records.',
    triggers: ['lesson_finish'],
    taskRoutes: ['llm.growth_report'],
    authoritativeInputs: ['growth_snapshot', 'verified_evidence_summary', 'review_schedule'],
    outputs: ['strengths', 'practice_focus', 'caregiver_guidance'],
    mayChangeMastery: false,
  },
  memory_manager: {
    purpose: 'Extract, classify, expire, and audit explicit reusable interaction preferences; runtime retrieval is bounded by the orchestrator.',
    triggers: ['lesson_finish_batch_only', 'caregiver_memory_review_without_model_rewrite'],
    taskRoutes: ['llm.memory_extraction'],
    authoritativeInputs: ['explicit_preference_signals', 'lesson_evidence_summary'],
    outputs: ['bounded_interaction_memory_candidates'],
    mayChangeMastery: false,
  },
  personality_engine: {
    purpose: 'Adapt per-learner teaching style within server-owned adjustable trait allowlists.',
    triggers: ['lesson_finish_when_evidence_or_preference_changed', 'caregiver_profile_review_without_core_trait_change'],
    taskRoutes: ['llm.personality_adjustment'],
    authoritativeInputs: ['verified_lesson_evidence', 'approved_interaction_memories', 'current_profile_version'],
    outputs: ['validated_profile_change_with_reason_and_history'],
    mayChangeMastery: false,
  },
} as const;

export type TeachingAgentRole = keyof typeof TEACHING_AGENTS;

export const AGENT_INVOCATION_POLICY = {
  learner_turn: ['teacher_orchestrator', 'teacher_or_small_talk_or_question', 'assessment_only_when_learning_task_requires_it'],
  lesson_start: ['planner'],
  activity_completed: ['planner_only_when_next_activity_needed'],
  repeated_failure: ['teacher_method_ladder', 'planner_after_rule_threshold'],
  lesson_finish: ['planner_stage_review', 'growth_mentor', 'memory_manager', 'personality_engine'],
  memory_extraction: ['memory_manager'],
  personality_change: ['personality_engine'],
} as const;
