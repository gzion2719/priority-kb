# ADR-0014 — End-to-end page-status testing: vitest + fetch + `next start` subprocess

**Status:** Accepted
**Date:** 2026-05-29
**Scope:** ROADMAP M3 item 5 follow-up — the test runtime for HTTP-level assertions against Next.js page renders (e.g., `notFound()` actually returns HTTP 404, `force-dynamic` actually defeats Next's full route cache across role flips, audit rows write on both served and denied branches). Closes BACKLOG entry "Page-surface HTTP-status integration tests for `app/entries/[id]/page.tsx`."

---

## Context

The M3 item 5 detail page (`app/entries/[id]/page.tsx`) enforces iron-rule #6 sensitivity by calling `findEntryForRole` and collapsing every non-served outcome (missing id, malformed id, sensitivity-mismatch, null role) into the same `null` → `notFound()`. Two existing test layers cover parts of this surface:

- `lib/entries.test.ts` — unit tests on `findEntryForRole` with a mocked `Pool`; proves null-collapse from the data layer.
- `tests/entries.integration.test.ts` — DB-gated integration; proves the SQL WHERE actually filters against real Postgres.

What's NOT covered by either layer:

1. That `notFound()` from a Server Component actually produces HTTP 404 (not 200 with the not-found HTML body).
2. That `dynamic = "force-dynamic"` actually defeats Next's full route cache across role flips on the same id.
3. That the `audit_log` row writes happen on both served and denied branches (the page calls `writeViewAuditRow` before the `notFound()` short-circuit; only an end-to-end test against the running server can prove the row landed before the response was returned to the client).

The BACKLOG entry that surfaced this gap names two candidate runtimes: "Next's experimental test runtime or a Playwright E2E." This ADR picks neither; the analysis below explains why.

Iron rules this ADR is bound by:

| # | Rule | How this ADR satisfies it |
|---|---|---|
| #2 | All KB writes go through the Ingestion Agent. No raw DB inserts. | E2E spec seeds via `POST /api/ingest` with `x-stub-user-role: admin` — exercises the ingestion path under test. This closes the "test fixtures bypass non-negotiable #2" carve-out question for new tests. Existing `tests/entries.integration.test.ts` uses raw `INSERT INTO entries` for unit-adjacent DB-shape proofs; new e2e specs use the route. |
| #6 | Sensitivity respected server-side. | The whole point of the spec is to prove iron-rule #6 holds at the HTTP layer. The "byte-identical 404 body for restricted-as-user vs missing-id" assertion is the existence-leak defense. |
| #8 | Tests never call live embedding/Claude/Voyage APIs. | E2E specs run only against pages whose render path has zero downstream live-API calls. `/entries/[id]` is a Server Component that reads Postgres only — satisfied. Specs for pages with synth calls (a future `/query` e2e) MUST stub via the existing `setSynthesizerForTests` / `setEmbedderForTests` / `setRerankerForTests` hooks before the test server starts, OR the spec is rejected. Codified as a constraint in §3 below. |

No code that ships in production changes here. The implementation lands `scripts/start-test-server.mjs`, `vitest.e2e.config.ts`, `tests/entries-page.e2e.test.ts`, an `e2e` npm script, and a new `e2e` CI job.

---

## Decision

### §1 — Runtime: vitest + fetch + `next start` subprocess

The spec runs in vitest (same runner as every other test in the repo), spawns `next start -p <ephemeral>` in `beforeAll`, hits the server with `fetch`, asserts on status / headers / body, queries `audit_log` via the existing `pg` pool, and kills the subprocess in `afterAll`.

This is the cheapest runtime that satisfies the three named assertions (404 vs 200, force-dynamic across role flips, audit row on both branches), all of which are pure HTTP-layer facts. No browser is needed.

### §2 — Test-server helper signature (per ADR Test-helper-signature sub-rule)

```ts
// scripts/start-test-server.ts
export interface StartTestServerOptions {
  /** Port to bind. Default: ephemeral (Node-allocated free port). */
  port?: number;
  /** Extra env merged into the spawned process env. Useful for stub flags. */
  env?: Record<string, string>;
  /** ms to wait for the server to respond on /healthz. Default 30000. */
  readyTimeoutMs?: number;
}

export interface TestServer {
  port: number;
  baseUrl: string;            // `http://127.0.0.1:${port}`
  kill: () => Promise<void>;  // SIGTERM, awaits process exit
}

export async function startTestServer(opts?: StartTestServerOptions): Promise<TestServer>;
```

Caller pattern (one server per `describe` block, NOT one per `it` — `next start` cold-start is ~3-5s):

```ts
let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { await server.kill(); });
```

### §3 — Spec gating + file naming

- Specs live at `tests/*.e2e.test.ts`. The default `vitest.config.ts` excludes that glob; `vitest.e2e.config.ts` includes only that glob.
- `npm run e2e` runs `vitest run --config vitest.e2e.config.ts`. Default `npm test` and `npm run check` never touch e2e files.
- Specs require `DATABASE_URL` (same gating as `tests/*.integration.test.ts`). If unset and not in CI, the suite skips; if unset in CI, the suite throws (`isCi && !databaseUrl` pattern from `tests/entries.integration.test.ts:15`).
- Specs MUST NOT exercise pages whose render path makes live API calls to Voyage / Anthropic. For pages that do (a future `/query` e2e), the spec MUST inject stubs via `setSynthesizerForTests` / `setEmbedderForTests` / `setRerankerForTests` BEFORE `startTestServer` spawns the subprocess. This is the iron-rule-#8 carve-out for e2e tests, codified here so a future spec author can't drift.
- Seeds go through `POST /api/ingest` with `x-stub-user-role: admin`. Raw INSERT in an e2e spec is rejected at code review.

### §4 — CI integration

A separate `e2e` job in `.github/workflows/ci.yml`:

- Same Postgres service container as the `node` job (pinned pgvector image per ADR-0008).
- `actions/setup-node@v6` + `npm ci`.
- `psql -f db/init.sql` + `npm run db:migrate` (same bootstrap as `node` job).
- `npm run build` (next requires build output before `next start`).
- `npm run e2e`.

The `e2e` job is independent of the `node` job (both fire on the same events, in parallel). They can fail independently — e2e flaking does not block lint/typecheck/unit-test signal. Gating policy: `npm run check` does NOT chain `npm run e2e` because (a) check is the local dev pre-push loop and a 30-60s `next build` step would dominate the cycle; (b) the e2e suite needs `DATABASE_URL` plus a built `.next/` directory, which most local sessions don't have ready. Local e2e runs are `npm run build && npm run e2e` with explicit `DATABASE_URL`.

### §5 — Rejected alternatives

**Playwright.** The standard choice and the BACKLOG entry's first-named candidate. Rejected for this surface because none of the three named assertions require a browser:

- HTTP 404 vs 200 is a `response.status` field on any fetch.
- `force-dynamic` cache defeat across role flips is two sequential requests with different headers — verifiable by asserting each response body matches its role's expected content.
- `audit_log` writes are verified by `SELECT` after the request, not by anything browser-side.

A browser would prove the same facts at ~10× the CI cost: ~300MB Chromium download per fresh CI cache miss, ~10s browser startup per worker, plus an entire dependency on `@playwright/test`. The cost is real (`docs/BACKLOG.md` cost-trim entries explicitly track CI-minute usage). Playwright remains the right answer for future user-facing UX tests that require DOM / browser-history assertions (e.g., a back-nav restoration spec for BACKLOG:77); this ADR scopes the decision to HTTP-status tests only and leaves the door open for a separate Playwright ADR when that need crystallizes.

**Next.js experimental Node test runner.** The BACKLOG entry's second candidate. Rejected: experimental → churn risk; the mock surface for `next/headers` / `next/navigation` is fragile and version-coupled; depending on an experimental runtime for an iron-rule-defending test layer is a bad bet. The vitest + `next start` approach uses only stable Next.js public APIs (the `next start` command) and the stable Node fetch API.

**MSW + vitest browser mode (`vitest --browser`).** Stress-tested by the planning reviewer. Rejected: vitest's browser mode is itself experimental, introduces a third test stack (Node + Node-with-DB + browser), and brings the same ~300MB browser-binary overhead as Playwright without the cross-browser coverage that justifies it. MSW is the wrong layer entirely — it intercepts fetch in the browser, but we want to assert on the real server's response, not a mocked one.

**supertest against `next start` (via the `request(app)` pattern).** Stress-tested by the planning reviewer. Functionally equivalent to vitest + fetch + `next start`; rejected only because adding `supertest` as a new dependency provides no capability above what Node's built-in `fetch` already gives us. The chosen runtime is the supertest pattern without the dependency.

**Function-level test with `next/navigation.notFound` mocked.** Rejected by the BACKLOG entry verbatim: "What's NOT tested is the rendered HTTP response from `app/entries/[id]/page.tsx` itself — that `notFound()` actually produces HTTP 404 (not 200 with the not-found HTML)." A mock that asserts `notFound()` was called proves nothing about the HTTP response — which is exactly the gap this ADR closes.

### §6 — Spec coverage for BACKLOG:79 (first spec, `tests/entries-page.e2e.test.ts`)

The first (and currently only) e2e spec covers the full BACKLOG:79 surface in one file:

1. Admin GET `/entries/<restricted-id>` returns 200 + the entry body.
2. User GET same `/entries/<restricted-id>` returns 404.
3. **Byte-identical existence-leak defense:** user's 404 body equals missing-id's 404 body (`response.text()` equality).
4. `audit_log` has matching rows with correct `payload.outcome` for both branches (one `served`, one `not_found_or_unauthorized`).
5. **Force-dynamic cache defeat:** sequential admin → user requests against the same id return the admin's body to admin and the user's 404 to user (cache, if active, would return admin's body to both).

No follow-up test-sweep PR planned at ADR time — the surface above IS BACKLOG:79's stated scope.

---

## Consequences

- **New test runtime convention:** `tests/*.e2e.test.ts` files run only via `npm run e2e`, gated on `DATABASE_URL`, spawning a real Next.js server. Documented in `WORKFLOW.md` Pre-push gate section update (next: BACKLOG follow-up).
- **CI minute cost:** e2e job adds ~90-120s to total CI time per PR (npm ci ~30s + build ~45s + e2e suite ~30s, parallel with node job). Falls within ADR-0011 cost-trim envelope (no Python/Eval lanes; e2e replaces dead lanes' billed time).
- **Iron-rule-#2 fixture-seeding policy clarified:** new tests use ingestion-path seeding; raw INSERT is grandfathered in pre-existing tests only. ADR is the canonical reference for future code reviewers.
- **Door left open for Playwright:** a future ADR can introduce Playwright for browser-mediated assertions (BACKLOG:77 back-nav restoration spec is the natural trigger). This ADR's runtime decision is scoped to HTTP-status tests, not all e2e tests.

---

## Implementation files (this PR)

- `scripts/start-test-server.ts` — helper per §2 signature.
- `vitest.e2e.config.ts` — includes `tests/*.e2e.test.ts`, excluded from default config.
- `tests/entries-page.e2e.test.ts` — first spec per §6.
- `package.json` — `e2e` script.
- `.github/workflows/ci.yml` — new `e2e` job per §4.
- `docs/adr/README.md` — index entry.
- `docs/BACKLOG.md` — line 79 marked RESOLVED with pointer.
