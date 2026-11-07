# services/ai-evaluation — Optional Python Evaluation Service

Optional Python service for pronunciation assessment and model benchmarking experiments.

It does NOT decide mastery on its own. Scores are evidence fed to the backend's hybrid decision (deterministic rules + LLM reasoning + professional pronunciation API). Generic ASR is not pronunciation assessment; child speech (6-9) must be validated with real child samples before any vendor is locked in.
