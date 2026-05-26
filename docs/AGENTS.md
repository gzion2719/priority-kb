# AGENTS.md — Priority Knowledge Base

Internal agent roles. Both call the Claude API directly (no framework). Both have system prompts versioned in `prompts/*.md`; the prompt's SHA-256 hash is stored alongside every response in `audit_log` for attribution and reproducibility.

This file is **Step-4b reading**, not Step-4 — only load when the current focus touches an agent's behavior, prompt, or tools.

---

## Ingestion Agent

**Role.** Admin-only. Guides the admin through producing a well-structured KB entry via a chat conversation, optionally accepting file attachments. Refuses to write to the DB unless the entry passes structural validation.

**Model.** `claude-haiku-4-5-20251001` — ingestion is mostly form-filling; cheap is fine.

**Interfaces.**
- Input: chat messages from an admin + file attachments (text-only in M2a; PDF/Word/images in M2b).
- Output: streamed conversation + a final structured JSON object (`title, category, tags[], body, source, last_verified_at, sensitivity`).
- Side effects: calls `POST /api/ingest` once the admin confirms; never bypasses validation.

**System prompt.** `prompts/ingestion-agent.md`. Versioned in git. Hash stored on the resulting entry's `audit_log` row.

**Non-negotiables.**
- Refuses to ingest without a `source` pointer and a `last_verified_at` date.
- Refuses `restricted` sensitivity without an explicit admin confirmation step.
- Strips obvious PII (emails, phone numbers, customer IDs) from `body` before commit; surfaces what was stripped for admin review.
- Never writes raw DB; only calls the validated ingestion endpoint.
- Logs all model calls via the structured observability helper (tokens, latency, cost, prompt hash).

**Media-ingest surface (M2b #3 onward).** When the admin attaches a file (screenshot, PDF, Word doc), the route layer enqueues a job via `lib/jobs.ts` `enqueueJob` rather than calling the parsing/OCR pipeline inline — the Python FastAPI worker (`api/jobs.py`) consumes the queue and produces the entry asynchronously. The enqueue path stays admin-gated (`withAdmin` HOF on the route); the worker is not publicly reachable. The job payload is a control-plane envelope (`entry_id`, `blob_storage_path`, `content_type`, metadata) — never the binary itself — and MUST NOT carry a `sensitivity` snapshot at any depth (iron-rule #6 mechanical floor; the worker re-reads `entries.sensitivity` at chunk-write time, so a payload-borne snapshot would let a stale tier slip through if the entry is re-tagged during queue dwell). See [ADR-0019](adr/0019-job-queue.md).

---

## Retrieval Agent

**Role.** Everyone (admin + user). Answers Priority questions using ONLY content retrieved from the KB. Cites every claim back to the entry(ies) that supported it.

**Model.** `claude-sonnet-4-6` — synthesis benefits from the smarter model.

**Interfaces.**
- Input: user query (Hebrew or English).
- Output: streamed answer with inline citations referencing `entry_id`s.
- Side effects: read-only DB queries via the retrieval service; logs every call via the observability helper.

**System prompt.** `prompts/retrieval-agent.md`. Versioned in git. Hash stored on the response's `audit_log` row.

**Pipeline.**
1. Embed query via Voyage `voyage-3-large`.
2. pgvector HNSW top-K search (K=20 default).
3. Voyage `rerank-2` → top-N (N=5 default).
4. Hybrid: blend with Postgres `tsvector` keyword scores (M3).
5. Pass top-N chunk contents + parent entry metadata to Claude (Sonnet) with `prompts/retrieval-agent.md`.
6. Stream answer to user; include `[entry_id]` citation markers inline.

**Non-negotiables.**
- **Never** answer without at least one citation. If retrieval returns nothing high-confidence, say so explicitly; do not synthesize from training data.
- Respects entry sensitivity vs. requester role: `user` cannot see `restricted` entries; `restricted` content never enters the prompt for a `user` request.
- Mirrors the user's input language (Hebrew → Hebrew, English → English) — see `CLAUDE.md` language convention.
- Degraded mode (Claude/Voyage outage): falls back to keyword-only Postgres search, returns ranked entry list without synthesis, banners the UI.
- Logs all model calls via the structured observability helper.

---

## Tools available to both agents (anticipated)

- `search_kb(query, k=20, sensitivity_max="public"|"internal"|"restricted")` — pgvector + tsvector hybrid search.
- `get_entry(entry_id)` — full entry record.
- `list_categories()` — for Ingestion's category-suggestion flow.
- `embed_text(text)` — abstracted Voyage call (per non-negotiable #9, records model + version on the resulting row).

Tools are exposed via the Anthropic SDK's tool-use mechanism. Schemas land in `prompts/tools.json` or co-located TS/Python definitions when M2a builds them.
