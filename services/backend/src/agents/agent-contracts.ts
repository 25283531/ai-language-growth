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
    purpose: 'Select the next eligible published activity from server-filtered candidates and explain the choice.',
    triggers: [
      'lesson_start',
      'activity_completed_when_next_activity_needed',
      'adaptive_candidate_set_has_multiple_eligible_activities',
      'lesson_finish_long_term_focus',
    ],
    taskRoutes: ['llm.learning_plan', 'llm.learning_plan_tiebreak'],
    authoritativeInputs: ['published_activities', 'skill_states', 'learning_evidence', 'review_schedule', 'textbook_mapping'],
    outputs: ['candidate_activity_id', 'rationale', 'next_focus_skill_node_ids'],
    mayChangeMastery: false,
    constraints: [
      'May only rank activities already filtered by server eligibility rules.',
      'Repeated failure keeps the current activity and advances the deterministic method ladder; it does not invoke the planner.',
      'No eligible next activity means the lesson can finish; the planner cannot invent one.',
    ],
  },
  teacher: {
    purpose: 'Respond conversationally to a child question or small talk without changing the active learning task.',
    triggers: ['child_question', 'child_small_talk'],
    taskRoutes: ['llm.simple_dialogue'],
    authoritativeInputs: ['current_directive', 'bounded_learner_context', 'teacher_profile'],
    outputs: ['child_safe_utterance'],
    mayChangeMastery: false,
    constraints: [
      'The orchestrator handles routine instruction, correction, and deterministic method changes without an LLM call.',
      'Conversation replies do not assess the active task, write learning evidence, or advance the activity.',
    ],
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
  learner_turn: ['teacher_orchestrator', 'teacher_only_for_question_or_small_talk', 'assessment_only_for_configured_learning_response'],
  lesson_start: ['planner_for_first_eligible_activity'],
  activity_completed: ['planner_to_find_next_activity', 'finish_when_no_eligible_activity_remains'],
  repeated_failure: ['deterministic_method_ladder_only', 'planner_not_invoked_while_current_activity_remains'],
  lesson_finish: ['growth_mentor', 'memory_manager', 'personality_engine', 'rule_based_long_term_focus'],
  memory_extraction: ['memory_manager'],
  personality_change: ['personality_engine'],
} as const;
