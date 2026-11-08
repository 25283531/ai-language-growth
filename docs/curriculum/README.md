# Curriculum Operations

The admin curriculum workspace is available at `/curriculum`.

## Textbook catalog

Create textbook editions with publisher, publication year, grade, title, and edition. Units can be added through `POST /api/v1/admin/curriculum/textbooks/{textbookId}/units`. These fields are catalog metadata, not a required teaching sequence.

## Course production

1. Enter a title, a learning level (`pre-A`, `A`, `B`, or another configured label), an optional textbook edition/unit, and one vocabulary item per line.
2. Create the draft and request AI generation. Generation uses the configured `llm.learning_plan` route; if that route is unavailable, a structured placeholder draft remains available for editing.
3. Review and edit the structured content, then submit it for human review.
4. An administrator approves or rejects the draft. Only approved drafts can be published.

Publication requires supported activity types, existing skill-node references, and at least one activity. Image resources must include a public source URL and a license string; attribution is stored when provided. The admin must verify source availability and permission before approval.

## Adaptive sequencing

Textbook metadata links material to school curricula while the learner's skill states and due-review queue remain the authority for progression. A textbook unit order does not imply a fixed learner path. AI may propose teaching content and ordering, but the planner must enforce published status, prerequisites, evidence, review timing, and age-safety constraints. AI output cannot set mastery.

## API authorization

All `/api/v1/admin/curriculum/*` endpoints require `x-admin-token` matching the server-side `ADMIN_CONFIG_TOKEN`. Never store that token in this repository.
