# BACKLOG.md — Priority Knowledge Base

Scope-creep capture. Anything out-of-scope for the current milestone but worth keeping lands here. Reviewed every 5 sessions (per `SESSION_PROTOCOL.md` hygiene cadence).

Categories chosen for this project's shape.

---

## Architecture & Infra

- Multi-tenant data isolation strategy (if M6 multi-tenant happens).
- Vector index re-tuning playbook: HNSW `ef_construction` / `m` sweep when corpus passes 50k chunks.
- Postgres → external vector store (Qdrant / Weaviate) cutover criteria — only if pgvector recall stops being acceptable.
- Cold storage tier for entries older than 2 years that are rarely retrieved.

## Ingestion

- **Stronger Hebrew OCR**: evaluate Google Document AI alongside Azure DI on a 30-image Hebrew Priority screenshot set; pick winner by accuracy + cost.
- Bulk import from existing sources: email threads, Teams export, old Confluence dump.
- Auto-suggest tags from existing taxonomy during ingestion chat.
- Inline duplicate detection: when admin starts an entry, retrieve top-3 similar existing entries and offer "edit existing" instead of "create new".
- Screenshot annotation extraction: arrows/circles/highlights in Priority screenshots often mark the relevant field — extract as structured hints.

## Retrieval

- **Stale-entry "is this still true?" agent** — periodic re-verification pass (M6 candidate).
- Multi-turn retrieval: clarifying questions when the query is ambiguous, instead of guessing.
- Personalized retrieval: user's recent queries weight the search slightly toward their working context.
- Cross-language retrieval audit: Hebrew query → English entry retrieval quality check (Voyage handles it in theory; measure in practice).
- Negative-result UX: when retrieval finds nothing relevant, say so explicitly — don't synthesize.

## Quality & Evals

- Expand `evals/golden_set.yaml` to 100+ pairs across all major Priority modules.
- Adversarial eval set: queries with subtle wording, mixed Hebrew/English, typos, outdated terminology.
- Citation-quality eval: does the cited entry actually support the answer? (LLM-as-judge with Opus.)
- Retrieval-vs-baseline tracking: keep a "no reranker / no hybrid" config running in CI for regression baseline.

## Tooling & DX

- Local seed data script: 20 realistic-shaped entries for new dev onboarding.
- Prompt diff viewer: when `prompts/*.md` changes, show the eval delta vs. previous prompt version.
- Cost dashboard: daily Claude + Voyage spend, broken down by ingestion vs. retrieval vs. evals.

## Open Questions

- How do we handle entries that are **wrong but historically right** (Priority changed, fix no longer applies)? Soft-delete with `superseded_by`? Tombstone with retention?
- Do we want admin-vs-admin entry approval (4-eyes) for `restricted`-tagged entries? Adds friction but adds safety.
- Should the Retrieval Agent ever refuse to answer (no high-confidence citation found)? What's the threshold?
- Backup encryption at rest — required from M1 or M5?
