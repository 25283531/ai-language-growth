# docs/database

Database design: PostgreSQL + Redis. Key tables — `users`, `learner_profiles`, `skill_nodes`, `skill_dependencies`, `learner_skill_states`, `learning_evidence`, `lesson_sessions`, `interaction_events`, `assessment_records`, `review_schedules`, plus Router tables (`ai_providers`, `ai_models`, `ai_model_capabilities`, `ai_model_prices`, `ai_model_limits`, `ai_task_routes`, `ai_route_rules`, `ai_model_benchmarks`, `ai_usage_logs`, `ai_fallback_logs`).

Privacy: guardian consent, no voiceprint ID, no long-term raw audio by default, delete function, no child self-purchase, no child-targeted ads.
