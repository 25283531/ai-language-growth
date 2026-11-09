# Curriculum Operations

The admin curriculum workspace is available at `/curriculum`.

## CEFR curriculum package import

The curriculum admin page accepts a ZIP containing `curriculum-package.json` at its root. Package schema version 1 contains the seven ordered levels `pre-A1`, `A1`, `A2`, `B1`, `B2`, `C1`, and `C2`; each level contains can-do goals and units, and each unit contains objectives, vocabulary, sentence patterns, and lesson activities.

Import uses `POST /api/v1/admin/curriculum/package/import` as multipart form data with the file field named `file`. The ZIP is limited to 15 MB and its curriculum JSON to 10 MB. The server creates generated drafts only; it does not approve or publish imported material. The normal edit, submit, approval, and publication workflow still applies. A stable `packageId` and unit code make repeat imports idempotent.

The locally prepared package `G:\workbuddy\课程\儿童英语_CEFR七级成长课程_v1.zip` is intentionally not stored in this repository. It is an original, child-context adaptation guided by the Council of Europe's CEFR Companion Volume (2020) descriptors and the project brief's page 3, not a copy of descriptor text. Level outcomes are references rather than deadlines or a mandatory course order. The refreshed package contains roughly 400 entries per level (8 units, 32+ additions per unit), with IPA and Chinese glosses populated where the source dictionary provides them. The supplemental entries are sourced from ECDICT under its MIT license; the ZIP contains `SOURCES.txt`. The level bands are frequency-based production suggestions and still require human review. Image assets are omitted; any later image additions require a verified source and license.

Importing it creates review drafts only; it does not bypass human approval.

## Textbook catalog

Create textbook editions with publisher, publication year, grade, title, and edition. Units can be added through `POST /api/v1/admin/curriculum/textbooks/{textbookId}/units`. These fields are catalog metadata, not a required teaching sequence.

## Course production

1. Enter a title, a learning level (`pre-A`, `A`, `B`, or another configured label), an optional textbook edition/unit, and one vocabulary item per line.
2. Create the draft and request AI generation. Generation uses the configured `llm.learning_plan` route; if that route is unavailable, a structured placeholder draft remains available for editing.
3. Review and edit the structured content, then submit it for human review.
4. An administrator approves or rejects the draft. Only approved drafts can be published.

Publication requires supported activity types, existing skill-node references, at least one activity, and a task-level assessment rule. Point-selection tasks need `acceptedImageIds`; fixed text or speech tasks need `acceptedTexts` or `requiredPhrases`; genuinely open responses must set `openResponse=true`; pronunciation tasks must declare the pronunciation assessment route. Passive listening/reading may be completed without an answer, but it never creates mastery evidence. Image resources must include a public source URL and a license string; attribution is stored when provided. The admin must verify source availability and permission before approval.

When a package is imported, licensed image suggestions are recorded as pending media assets and the backend starts downloading them in the background during idle time; publication also registers any images added during review. Downloaded files live under `AI_MEDIA_CACHE_DIR` and are served through the media endpoint after the asset is marked cached; published activity content includes `imageAssets` references so clients can render the cached resource. Failed downloads are retried after a cooldown, and stale downloads are recovered. TTS audio and image binaries are runtime cache files; database backups contain only media metadata, never these binary cache directories. Persist the backend `/app/.cache` volume if the cache should survive container replacement.

## Adaptive sequencing

Textbook metadata links material to school curricula while the learner's skill states and due-review queue remain the authority for progression. A textbook unit order does not imply a fixed learner path. AI may propose teaching content and ordering, but the planner must enforce published status, prerequisites, evidence, review timing, and age-safety constraints. AI output cannot set mastery.

## API authorization

All `/api/v1/admin/curriculum/*` endpoints require a valid administrator session. The session is created after login with the deployment-configured administrator account and stored in an HttpOnly cookie.
