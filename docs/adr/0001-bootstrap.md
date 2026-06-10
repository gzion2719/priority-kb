# ADR-0001 — Bootstrap-time decisions

- **Date:** 2026-05-14
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent architectural review from a Plan-subagent)

## Context

Starting a new project: an agent-driven knowledge base for Priority ERP. Admins log workflows / fixes / walkthroughs / Q&A by chatting with an Ingestion Agent and attaching media. End users query via a Retrieval Agent that answers with citations. Hebrew + English content. Local-first development, hosting decision deferred. Single dev today, small team consumption.

The bootstrap interview surfaced several load-bearing choices that need to be locked in before any feature work, because changing them later is expensive.

## Decision

### Repo location: `C:\dev\PriorityKB` (off OneDrive)

OneDrive's file-locking and sync behavior conflicts with `.git/index`, `node_modules`, and Python venvs. The independent review flagged this as a likely corruption source. Project lives at `C:\dev\PriorityKB` and is **not** OneDrive-synced.

### Stack

- **Frontend:** Next.js (React).
- **Backend M1:** Next.js API routes + Postgres.
- **Backend M2b+:** Python FastAPI worker + job queue (`pgqueuer`) for parsing / OCR / embedding — added when media ingestion lands, not before.
- **DB:** PostgreSQL + pgvector (HNSW index, not IVFFlat — better recall under our expected corpus growth).
- **Embeddings:** Voyage AI `voyage-3-large` (multilingual, top MTEB, Anthropic-recommended).
- **Reranker:** Voyage `rerank-2` — second-stage in retrieval pipeline (not a "polish" item; part of minimum viable retrieval).
- **Models:** Haiku (ingestion), Sonnet (retrieval), Opus (evals / LLM-as-judge).
- **OCR:** Azure Document Intelligence primary, Tesseract fallback. Hebrew + English.
- **Auth:** stub header in dev/M1-M4, Microsoft Entra ID OAuth in M5.
- **Schema migrations:** Alembic (Python side); SQL files versioned in `db/migrations/` until Python lands.

### Sequencing

- **M3 (retrieval) before M2b (media ingestion).** Text-only retrieval working end-to-end is the proof of viability. Media is a side quest that can wait until retrieval is honest.
- **Evals, observability, backups all land in M1.** Adding them later means we can't tell if M3 is good.

### Type skeleton — entry shape

```ts
type Entry = {
  id: string;                                  // uuid
  title: string;
  body: string;                                // markdown
  category: string;                            // free-text; aligned via list_categories tool
  tags: string[];
  source: { kind: "ticket" | "doc" | "convo" | "other"; ref: string };
  last_verified_at: string;                    // ISO date
  sensitivity: "public" | "internal" | "restricted";
  embedding_model: string;                     // e.g. "voyage-3-large"
  embedding_version: string;                   // for re-embed migrations
};
```

### Test-helper signature — ingestion fixtures

```ts
function fakeEntry(overrides?: Partial<Entry>): Entry;
function fakeEmbedding(dim?: number): number[];     // deterministic, no API calls
function withStubAuth(role: "admin" | "user"): Headers;
```

### Git remote

Private GitHub repo (`priority-kb`). Local-only refused per the bootstrap rule. Pushed via `gh repo create priority-kb --private --source=. --remote=origin --push` after first commit.

### CI/CD

Full CI on `push` to `main` and on `pull_request`. Node lane (ESLint + Prettier --check + `tsc --noEmit` + Vitest) lights up in M1; Python lane (Ruff + Black --check + Mypy --strict + Pytest) lights up in M2b.

### Brand standards

Kramer brand — GT Eesti typography, `--kramer-*` color palette, embedded logo. Canonical CSS in `styles/kramer-brand.css`. Applied to every page unless an explicit user override.

#### Amendment 2026-06-10 — Typography pivot per ADR-0026

Typography is now IBM Plex Sans Light/Medium (with IBM Plex Sans Hebrew variant for Hebrew text), self-hosted under `public/fonts/` per [ADR-0026 §1](0026-design-system-tokens-and-brand-loading.md). The pivot rationale: GT Eesti never actually loaded since M1 (commented-out `@font-face` blocks + `public/fonts/` did not exist — UI_AUDIT C1), and the commercial GT Eesti license (~$500-1200/year per-style) does not pencil for an internal-use KB. IBM Plex Sans ships under SIL OFL 1.1 (free), has full Hebrew coverage, and pairs better with the dark/neon Kramer palette than the alternatives considered (Noto, Inter — see ADR-0026 §Alternatives considered). The brand-skill divergence (`anthropic-skills:kramer-brand` continues to ship GT Eesti) is accepted; updating the upstream skill is out of this repo's authority. CLAUDE.md non-negotiable #13 also edited in the same PR to drop the "(GT Eesti)" parenthetical. The `--kramer-*` color palette is unchanged.

Cross-ref: [ADR-0026 §1](0026-design-system-tokens-and-brand-loading.md), [docs/A11Y.md](../A11Y.md) (the WCAG AA contrast pass that landed alongside in M4.5/E).

### Non-negotiables (also listed in `CLAUDE.md`)

13 rules. The load-bearing ones: prompts hashed, embedding model+version per row, tests never call live APIs, every retrieval cites sources, every entry has source + `last_verified_at`, sensitivity tag respected on retrieval, ≥2 admins, degraded mode required.

## Consequences

**Positive.**
- One DB, one observability story, one auth boundary.
- Embedding abstraction means we can swap Voyage → OpenAI → Cohere without schema migration; just re-embed.
- Sequencing M3 before M2b means we can kill the project early if retrieval quality is unrecoverable on text-only content.
- Brand standards from skill = consistent UI without bikeshedding.

**Negative / accepted.**
- Two-stack project (Node + Python from M2b) doubles CI lanes and dev tooling. Accepted because Python ecosystem strength for parsing/OCR outweighs the cost.
- Voyage is a vendor lock until embedding abstraction migration is exercised. Mitigation: model+version per row makes the migration mechanical.
- Hebrew OCR quality is the #1 unknown. Mitigation: M1 includes a 1-day spike against real Priority screenshots before committing to the M2b plan.
- Stubbing auth in dev means M5's Entra ID integration is the first time the real auth boundary is exercised end-to-end. Mitigation: keep the stub header contract (`x-stub-user-role`) shaped so the eventual middleware swap is a one-file change.

## Alternatives considered

- **LangChain / LlamaIndex framework.** Rejected — hides moving parts in a system whose core value is adapting how entries get structured / embedded / ranked. Direct Anthropic SDK preferred.
- **Single-stack Next.js (no Python).** Rejected for M2b once OCR + PDF parsing enter scope; Node ecosystem for those is materially weaker than Python's.
- **Local-only repo.** Rejected per bootstrap rule — losing the KB to a disk failure or OneDrive folder rename is catastrophic.
- **Voyage `voyage-3` (smaller) instead of `voyage-3-large`.** Rejected for production; quality matters more than cost at our scale, especially on Hebrew.
- **OpenAI `text-embedding-3-large`.** Held as fallback. Voyage's multilingual Hebrew performance is materially better in current benchmarks.
- **IVFFlat pgvector index.** Rejected; HNSW is better for our corpus growth profile and recall expectations.
