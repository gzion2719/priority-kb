# ADR-0027 — M5 production foundation: hosting bundle + Microsoft Entra ID auth

- **Date:** 2026-06-11
- **Status:** Proposed (research draft — gates M5 implementation; no code shipped with this ADR)
- **Deciders:** Gal Zilberman + Claude (with independent plan reviewer)

## Context

M5 ("Production") turns the development-stage app into a hosted, real-auth system. The milestone checklist names nine items; this ADR decides the two that everything else hangs off:

- **M5 #1 / #2 — auth:** register a Microsoft Entra ID OAuth app (dev + prod tenants), derive role from group membership, remove stub auth and enforce Entra everywhere.
- **M5 #3 — hosting:** pick a provider (the ROADMAP names Azure App Service / Vercel + managed Postgres / VPS) "via ADR."

These two are recorded together because they are coupled at three load-bearing seams:

1. **Both trip the same gate.** [ADR-0011 Amendment 2026-05-27](0011-repo-visibility.md#amendment-2026-05-27--revert-trigger-event-gated-to-production-stage-transition) defines the **production-stage transition** with four limbs: (a) real customer/vendor identifiers ingested, (b) the database hosted off the developer's local machine, (c) Entra ID replacing stub auth, (d) manual override. Landing M5 hosting fires (b); landing Entra fires (c). Either lever — independent of whether real data (a) has landed — forces the repo-visibility revert-to-private. The auth and hosting decisions therefore cannot be sequenced as if they were independent of the visibility gate.
2. **The recommended provider supplies both.** If Azure is chosen, one vendor supplies hosting, managed Postgres, blob storage, secrets vault, *and* the Entra IdP — a single procurement and a single trust boundary.
3. **The repo already has Azure gravity.** [ADR-0022](0022-ocr-adapter.md) commits the OCR primary path to **Azure Document Intelligence** (M2b #6, shipped). The org's identity is already Microsoft (`kramerav.com` Entra tenant — the user's account).

What is already built and shapes the auth decision:

- Stub auth is a single seam by design. `lib/auth.ts` exposes `resolveRoleFromHeader` (the canonical `x-stub-user-role` parser), `withAdmin` (admin-only routes → 401/403), and `withUserOrAdmin` (authenticated read routes, injects `Role`). Both wrappers *and* the server-component entry-detail page at `app/entries/[id]/page.tsx:52` call `resolveRoleFromHeader` — the page does **not** read the raw header itself. The "M5 swaps it for Entra middleware is a one-file change" contract (`lib/auth.ts:5-8`) holds because of that single producer.
- `sensitivityAllowedForRole(role)` maps `admin → [public, internal, restricted]`, `user → [public, internal]` (iron-rule #6; reconciled to spec 2026-05-24). Entra must preserve this exact mapping.

What is deferred and must not be re-decided here: blob-storage implementation, idempotency-key scoping, audit-log retention, optimistic locking, connection pooling — all already in BACKLOG against M5 (see §Deferred-implementation index).

## Decision

Two independently-rateable sub-decisions. **D2 (auth) is near-forced by the existing tenant; D1 (host everything on Azure) is the elective inference** — they are separated so the user can ratify Entra-on-Azure-auth while still redirecting D1 to a non-Azure host.

### D1 — Hosting bundle: **Azure-first** (recommended; elective)

Adopt the Azure bundle for the production foundation:

| Concern | Choice | Replaces (dev) |
|---|---|---|
| App host | Azure App Service (Next.js standalone output) | `next dev` on localhost |
| Database | Azure Database for PostgreSQL **Flexible Server** + `pgvector` extension | docker-compose Postgres at `localhost:5432` |
| Blob storage | Azure Blob Storage (the S3-compatible `BlobStore` target) | `LocalFSBlobStore` (`app/api/ingest/upload/route.ts:128` `getBlobStore()`) |
| Secrets | Azure Key Vault | `.env` files (iron-rule #1) |
| Worker | Azure App Service / Container App running `python -m api.worker` | local `python -m api.worker` |

**Why a single vendor bundle and not best-of-breed:** the elective part of this decision is hosting + DB + blob + vault on Azure rather than on a Vercel/Neon/R2 split. It is justified — not forced — by: (i) D2 puts the IdP on Entra regardless, so a same-vendor host keeps one trust boundary and one billing relationship; (ii) ADR-0022's Azure DocIntel dependency already exists, so the project is partly Azure-coupled today; (iii) `pgvector` on Flexible Server is first-class. The honest cost is vendor lock-in across four services at once (see §Alternatives).

**`pgvector` precondition:** Azure Database for PostgreSQL Flexible Server supports `pgvector`, but the HNSW index (ADR-0001) and the `unaccent` extension (ADR-0013) must both be on the server's allow-extensions list. **Empirical check required before D1 is ratified to Accepted:** confirm `vector` (≥0.5.0, for HNSW) and `unaccent` are available on the target Flexible Server tier (per the Platform-capability-empirical-check sub-rule). If HNSW is unavailable, D1 must fall back to IVFFlat (a contract change to ADR-0001) or to a different host — this is a hard gate, not a detail.

### D2 — Auth model: **Microsoft Entra ID OAuth**, group-derived roles (near-forced)

- **App registrations:** two separate registrations — one **dev** tenant, one **prod** tenant — each with its own redirect URI set, rather than one registration with multiple redirect URIs. Separate registrations keep dev experiments from touching prod consent grants and let the prod app enforce admin-consent-only. (M5 #1 explicitly requires "dev + prod tenants".)
- **Role source:** Entra **security-group membership** → app role. Two groups: `kb-admins` → `admin`, `kb-users` → `user`. Iron-rule #11 (≥2 admins) is satisfied by ≥2 members in `kb-admins`, enforced at the directory level rather than in code.
- **Role mapping is preserved verbatim:** the Entra layer resolves a request to the same `Role` union (`"admin" | "user"`) that `resolveRoleFromHeader` returns today, so `sensitivityAllowedForRole` and every downstream SQL `WHERE` are unchanged. Iron-rule #6 contract is re-implemented, not modified.
- **Failure-closed posture (security-load-bearing):** when role cannot be established from the token — groups claim absent, or **group overage** (Entra omits the `groups` claim and emits `_claim_names`/`_claim_sources` when a user is in >150 groups, forcing a Microsoft Graph callback) — the request resolves to **least privilege**, never silent `admin`. Concretely: unresolvable role on an admin route → 401 (same shape as today's stub `unauthorized()`); on a read route → either 401 or `user`-tier, never elevated. The groups-overage Graph callback is named as an implementation requirement, not hand-waved.
- **Swap surface (the "one-file" claim, corrected):** the production swap edits the auth resolver and its callers:
  - `lib/auth.ts` — `resolveRoleFromHeader` becomes an Entra token/session resolver; `withAdmin` / `withUserOrAdmin` keep their signatures and 401/403 semantics.
  - `app/entries/[id]/page.tsx:52` — already routes through `resolveRoleFromHeader`, so it inherits the swap with no page-level change (this is *why* the single-producer contract matters).
  - **BACKLOG option:** lift the gate to a `middleware.ts` route-segment matcher (BACKLOG line 120) so pages stop reading headers entirely. Not required for the swap; a cleanliness follow-up.

### Hard prerequisite — repo visibility (gates BOTH sub-decisions at implementation time)

Landing D1 (hosting, limb b) or D2 (Entra, limb c) **completes the ADR-0011 production-stage transition** and forces the repo revert-to-private. On GitHub Free this is the documented dead end: [ADR-0011 Amendment 2026-05-25 — "Free-plan private-trap: revert blocked"](0011-repo-visibility.md#amendment-2026-05-25--free-plan-private-trap-revert-blocked) records that flipping to private auto-strips branch protection with no API path to restore it on Free+Private. Resolution requires one of that amendment's options at transition time:

- **(i)** purchase GitHub Pro (~$4/mo) — restores private-repo branch-protection API; revert tooling works as designed; **recommended**;
- **(ii)** cost-trim already dropped CI below cap with margin — revert unnecessary; or
- **(iii)** `npm run revert:private -- --apply --i-accept-free-plan-trap` — accept unmanaged protection on private (mechanical PreToolUse hooks become the only floor).

The first M5 implementation PR that lands hosting or Entra MUST resolve this in the same session. This ADR names it; the purchase itself is the user's action (out of scope for the ADR).

## Consequences

**Positive.**
- One vendor, one trust boundary, one billing relationship; Entra is the IdP the org already runs.
- The stub-auth single-producer design (`resolveRoleFromHeader`) pays off: the swap is genuinely localized to `lib/auth.ts`.
- Records the ADR-0011 production-stage / private-trap dependency *before* implementation, so it can't ambush a future session mid-cutover (it cost a full session-leg once already).

**Negative / accepted.**
- **Four-service vendor lock-in at once** (host + DB + blob + vault). Mitigations: the `BlobStore` interface (`lib/blob-storage.ts`) already isolates storage; the embedding abstraction already isolates the model vendor; Postgres is portable SQL. App Service and Key Vault are the stickier couplings.
- **Entra is the first real exercise of the auth boundary** (ADR-0001 §Consequences flagged this at bootstrap). Mitigation: the stub contract was shaped for exactly this swap.
- The standalone-output prompt-tracing trap (BACKLOG line 31): `lib/prompts.ts:77,132` read `prompts/*.md` via `readFileSync` at module boot; Azure App Service standalone builds won't bundle `prompts/` without `outputFileTracingIncludes`. Must be fixed in the hosting-cut PR or agent routes ENOENT at boot. Iron-rule #10-load-bearing.

## Alternatives considered

- **Vercel + managed Postgres (Neon/Supabase) + Cloudflare R2, with Entra still as IdP.** Viable — Entra OAuth is host-agnostic. Rejected as the recommendation, not as impossible: splits the trust boundary and billing across three vendors, and Neon/Vercel-Postgres `pgvector` + HNSW support needs the same empirical check as Azure. Keeps D2 intact; only D1 differs. This is the live fallback if D1's `pgvector`/HNSW check fails on Azure or the user prefers Vercel's Next.js DX.
- **Self-managed VPS (Postgres + Next.js + worker on one box).** Rejected: cheapest sticker price, highest ops burden (backups, patching, TLS, restore drills all hand-rolled) — wrong trade for a small-team internal KB whose M5 acceptance already demands a tested restore drill.
- **Keep stub auth, gate by network/VPN only.** Rejected: violates iron-rule #4 (server-side role enforcement) and #11 (≥2 *identified* admins); a network gate authenticates nothing.
- **Two separate ADRs (0027 hosting + 0028 auth).** Considered per the repo's one-decision-per-file norm (0008/0019/0022/0025). Rejected in favor of one ADR with separable D1/D2 because both levers trip the *same* ADR-0011 gate and the recommended outcome is a single Azure-bundle procurement — but D1/D2 are structured to be independently ratifiable so the file can be partially accepted (e.g., accept D2, redirect D1 to Vercel) without a rewrite.

## Deferred-implementation index (not decided here; cross-refs existing M5 work)

Each is an M5 implementation concern this ADR deliberately does **not** resolve:

- **M5 #4 — S3-compatible `BlobStore`** → BACKLOG "S3-compatible `BlobStore` implementation (M5 hosting)" (line 54). Azure Blob impl behind the existing interface.
- **M5 #5 — backups** (nightly `pg_dump` → object storage, 30-day retention) → builds on the M1 `scripts/backup-db.ps1` stub; iron-rule #5.
- **M5 #6 — restore drill** → M5 Acceptance gate ("Restore drill passes"); runbook required.
- **M5 #7 — secrets in Key Vault** → D1 names the vault; the migration off `.env` is implementation.
- **M5 #8 — rate limits** on ingestion + retrieval endpoints → **net-new, not yet in BACKLOG**; named here so the "production foundation" framing doesn't silently drop it.
- **M5 #9 — production observability dashboard** (token cost/day, retrieval p95, eval pass-rate trend) → **net-new**; the `lib/log.ts` LogEvent stream (ADR-0005) is the data source.
- **Next.js standalone `prompts/*.md` tracing** (ENOENT trap) → BACKLOG line 31.
- **Per-tenant idempotency-key scoping** for `/api/ingest/upload` → BACKLOG (multi-admin Entra makes `sha256(uploader_id + contentHash)` necessary).
- **`audit_log` retention + partition pruning** → BACKLOG line 125.
- **Optimistic-lock `If-Match` token** for the admin editor → BACKLOG (pairs with multi-admin Entra).
- **`api/worker.py` connection pooling** + **OCR worker startup smoke-probe** → BACKLOG (M5 prod tuning).
- **Cost-trim wave-2** (security.yml cron cadence; 7-day billing-delta measurement) → ADR-0011 Amendment 2026-05-25; fires when the revert lands.

## Cross-references

- [ADR-0011](0011-repo-visibility.md) — production-stage transition (limbs b/c) + Free-plan private-trap; the hard prerequisite above.
- [ADR-0001](0001-bootstrap.md) — original auth ("Entra ID in M5") + HNSW-not-IVFFlat pins this ADR must honor.
- [ADR-0022](0022-ocr-adapter.md) — existing Azure Document Intelligence dependency (bundle-gravity for D1).
- [ADR-0013](0013-hybrid-rrf-tsvector.md) — `unaccent` extension dependency for the keyword lane (Flexible Server allow-list check).
- `lib/auth.ts` — `resolveRoleFromHeader` / `withAdmin` / `withUserOrAdmin` / `sensitivityAllowedForRole`; the swap surface for D2.
- `lib/blob-storage.ts`, `app/api/ingest/upload/route.ts:128` — the `BlobStore` seam for D1.
- `lib/prompts.ts:77,132` — the boot-time `readFileSync` that needs standalone tracing.
- ROADMAP M5 — the nine-item checklist this ADR's two decisions gate.
- Iron rules #1 / #4 / #5 / #6 / #11 / #12 (`CLAUDE.md`) — re-implemented by D1/D2, contracts unchanged.
