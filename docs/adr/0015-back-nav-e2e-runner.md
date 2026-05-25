# ADR-0015 — Browser-mediated e2e runtime: Playwright

**Status:** Accepted
**Date:** 2026-05-30
**Scope:** Pick the browser-mediated test runtime that will exercise the BACKLOG:77 back-nav restoration UX on `app/query/page.tsx`. Closes the "door left open for Playwright" reservation in [ADR-0014](0014-e2e-page-status-tests.md) §5 and §Consequences ("a future ADR can introduce Playwright for browser-mediated assertions; BACKLOG:77 back-nav restoration spec is the natural trigger").

---

## Context

BACKLOG:77 shipped 2026-05-29 as the URL-`?q=` mirror via `history.replaceState` plus a `sessionStorage` key `kbQueryState:v1` that carries terminal `QueryState` so back-nav from `/entries/[id]` restores the rendered answer without re-firing `POST /api/retrieve`. The implementation lives at [app/query/page.tsx](../../app/query/page.tsx) lines 60-245; the URL encoder/decoder at [lib/query-url-state.ts](../../lib/query-url-state.ts) is already unit-tested.

What's NOT covered by any existing test layer:

1. After `/query` produces a terminal answer, navigating to `/entries/[id]` and then clicking back actually restores the rendered answer in the DOM.
2. `POST /api/retrieve` fires **exactly once** across `submit → nav → back` — the load-bearing performance assertion (a regression here means every back-nav on the live-synth path costs a Claude + Voyage round-trip).
3. URL `?q=<encoded>` survives the back-nav round-trip.
4. The `q !== currentQ` gate at [app/query/page.tsx:131](../../app/query/page.tsx) rejects a stale-answer cross-replay when URL has a different `?q=` than `sessionStorage` stores.

[ADR-0014](0014-e2e-page-status-tests.md) shipped vitest + fetch + `next start` as the runtime for HTTP-status assertions and explicitly scoped its decision *away* from browser-mediated tests — §5 ("Playwright … rejected for *this surface*") and §Consequences ("Door left open for Playwright"). The four assertions above are not HTTP-layer facts; they require a real browser back-button + a sessionStorage layer that survives a DOM render cycle.

Iron rules this ADR is bound by:

| # | Rule | How this ADR satisfies it |
|---|---|---|
| #2 | All KB writes go through the Ingestion Agent. No raw DB inserts. | Spec seeds via `POST /api/ingest` with `x-stub-user-role: admin` — same iron-rule-#2 carve-out [ADR-0014 §3](0014-e2e-page-status-tests.md) codified for new tests. |
| #6 | Sensitivity respected server-side. | The spec asserts existing behavior; sessionStorage's per-tab scope and iron-rule-#6 reasoning are already documented at [app/query/page.tsx:81-88](../../app/query/page.tsx). The spec does not change this surface. |
| #8 | Tests never call live embedding/Claude/Voyage APIs. | Subprocess started without `EMBEDDING_PROVIDER` / `RERANK_PROVIDER` / `SYNTH_PROVIDER` env vars; the factories at [lib/embedding.ts:169](../../lib/embedding.ts), [lib/retrieval.ts:200](../../lib/retrieval.ts), [lib/retrieval.ts:238](../../lib/retrieval.ts) all default to `"stub"`. Full-stub mode is automatic — no live API calls reach the subprocess. Codified in §4 below. |

---

## Decision

### §1 — Runtime: Playwright (`@playwright/test`)

Pin exact version of `@playwright/test`; the browser-binary version is locked by the package — bump in lockstep. This is the trigger that ADR-0014 §5 "leaves the door open" for ("Playwright remains the right answer for future user-facing UX tests that require DOM / browser-history assertions, e.g., a back-nav restoration spec for BACKLOG:77") and that ADR-0014 §Consequences names explicitly ("BACKLOG:77 back-nav restoration spec is the natural trigger").

### §2 — Directory `e2e/`, naming `*.spec.ts`

Specs live at `e2e/**/*.spec.ts`. `playwright.config.ts` pins `testMatch: "e2e/**/*.spec.ts"` so Playwright's default `**/*.@(spec|test).?(c|m)[jt]s?(x)` does NOT pick up vitest's `tests/*.e2e.test.ts` files (different runner, different assertion library; a cross-pickup would fail at import time). The `vitest.config.ts` and `vitest.e2e.config.ts` globs do not include `e2e/`, so the reverse direction is also clean.

### §3 — Subprocess lifecycle: reuse `scripts/start-test-server.ts` via Playwright `globalSetup`

Playwright's built-in `webServer` config option is rejected in favor of reusing the existing vitest e2e subprocess helper. Reasons:

- **Single source of truth for "how to spawn `next start`".** `scripts/start-test-server.ts` already handles ephemeral-port discovery, ready-poll, exit-during-boot detection, Windows-aware `npx`, and SIGTERM/SIGKILL cleanup. Re-implementing those in Playwright's `webServer` config divergence is the failure mode this rule prevents.
- **Type-safe `baseUrl` back to specs.** `globalSetup` stashes the subprocess's allocated `baseUrl` on `process.env.PLAYWRIGHT_BASE_URL`; `playwright.config.ts` reads it into `use.baseURL`. Specs then use Playwright's `page.goto("/query")` against the dynamic port.
- **`globalTeardown`** calls `kill()` on the subprocess handle stored in a module-level variable. SIGTERM → 5s grace → SIGKILL fallback (already implemented by the helper).

The shared helper is the contract; Playwright is one consumer, vitest e2e is another.

### §4 — Iron-rule-#8: env-driven stub mode on the subprocess

The subprocess is spawned with `NODE_ENV=test` and WITHOUT `EMBEDDING_PROVIDER` / `RERANK_PROVIDER` / `SYNTH_PROVIDER` env vars. The route-handler factories default to `"stub"` when the respective env var is unset; full-stub mode is automatic. No live API calls reach the subprocess.

`page.route()` interception is NOT used for `/api/retrieve` or `/entries/[id]`:

- **SSE constraint.** `page.route().fulfill({body})` is single-shot; the production page consumes `/api/retrieve` as a multi-event SSE stream via [lib/sse-parse.ts](../../lib/sse-parse.ts). Mocking SSE at the fetch layer would either require concatenating all events into one body (parser-tolerant but stripping the timing/order signal that BACKLOG:77's restoration logic depends on) or a custom CDP-mediated streaming mock (not officially stable). Using the server-side stub layer side-steps the constraint entirely.
- **Server Component constraint.** `/entries/[id]` is a Server Component; its render does not go through `fetch` and `page.route()` cannot intercept it. The page MUST be served by a real `next start` against a real Postgres — there is no client-side mock path.

Reserved for future use: `page.route()` for sites where (a) no server-side stub hook exists and (b) the response is single-shot. None in scope for BACKLOG:77.

### §5 — DB seeding: `DATABASE_URL` gate + `POST /api/ingest`

Specs gate on `DATABASE_URL` (same gating as ADR-0014 §3: skip if unset and not in CI, throw if unset in CI). Seeds are written via `POST /api/ingest` with `x-stub-user-role: admin` — same iron-rule-#2 carve-out codified in ADR-0014 §3.

The CI `e2e-browser` job's Postgres service container uses the same pinned `pgvector/pgvector:pg16` image digest as the existing `node` and `e2e` jobs (per ADR-0008 and ADR-0011 cost-trim). Image digest is bumped in lockstep across all three jobs.

### §6 — Auth fixture

`page.setExtraHTTPHeaders({ "x-stub-user-role": "user" })` in a `beforeEach` (or Playwright fixture). Header applies to every browser-initiated request including in-page navigations (back-button click is one) which would otherwise bypass per-`fetch` header injection. Admin-seeding requests in `beforeAll` use a separately-headed `request` context.

**M5 migration note.** When the Entra ID swap lands, the auth surface moves from headers to cookies. The fixture migrates to `context.addCookies(...)`; the spec body is otherwise unchanged.

### §7 — Trace / video / retry artifact policy

- `trace: "on-first-retry"` — Playwright records full DevTools trace on retry; cheap on success, debuggable on flake.
- `video: "retain-on-failure"` — video kept only when the test fails; cheap CI artifact storage.
- `retries: 0` — single-spec suite; treat flakes as bugs, not noise. Bump only if a load-bearing flake source is identified and accepted as such.
- `workers: 1` initially — single-spec suite; no parallelism gain. Bump when the suite grows past 3 specs or when wall-clock dominates.

### §8 — CI job `e2e-browser`

Independent of `node` and `e2e` jobs, parallel firing:

- Postgres service container (same pinned digest, per §5).
- `actions/setup-node@v6` + `npm ci`.
- `actions/cache@v4` on `~/.cache/ms-playwright` keyed by `${{ runner.os }}-playwright-${{ hashFiles('package-lock.json') }}` — cache hit avoids the ~30s Chromium download.
- `psql -f db/init.sql` + `npm run db:migrate`.
- `npm run build`.
- `npx playwright install --with-deps chromium` (no-op on cache hit).
- `npm run e2e:browser` → `playwright test`.

**Cost budget.** Cold cache: ~30s install + ~30s Chromium download + ~45s build + ~20s spec = +~125s vs `node` job baseline. Warm cache (Chromium cached, npm cached): ~5s install + ~0s download + ~45s build + ~20s spec = +~70s. Falls within ADR-0011 cost-trim envelope (the deleted Python/Eval lanes left ~40-50% of pre-trim billed minutes free; +125s cold / +70s warm fits).

### §9 — Browser matrix: Chromium only

Single browser initially. **Trigger to widen:** add Firefox + WebKit when the second browser-spec lands OR when a back-nav bug reproduces only in Safari/WebKit. Single-spec suite does not justify a 3× CI bill or a 3× Chromium-download cost. Mirrors ADR-0013's deferred-with-trigger pattern.

### §10 — `playwright.config.ts` location: repo root

Lives at repo root, not in `e2e/`. Reasons:

- Playwright's CLI defaults to looking at the repo root.
- `package.json` script `e2e:browser` can be `playwright test` (no `--config` flag needed).
- Foot-gun if anyone runs `npx playwright test` from `e2e/` without `--config` — accepted (the README points at `npm run e2e:browser`, which always uses the root config).

### §11 — Rejected alternatives

**Vitest browser mode (`vitest --browser`).** Same alternative ADR-0014 §5 rejected for HTTP-status tests; the rejection grounds carry over: still flagged experimental in the v2.x line this repo pins ([package.json](../../package.json)); introduces a third test stack (Node + Node-with-DB + browser); brings the same ~300MB browser-binary overhead as Playwright without Playwright's cross-browser coverage or mature tooling (traces, codegen). For browser-mediated tests specifically, Playwright's tooling depth (page.goBack, page.evaluate, page.on("request"), traces, codegen) is the differentiator vitest browser mode does not match.

**JSDOM / happy-dom.** Cannot simulate the browser's real back-button. JSDOM exposes `window.history.back()` but it does not trigger a route change or a re-render — the navigation stack is a stub. The whole point of the spec is to assert behavior *across* a real back-nav, which JSDOM cannot provide.

**Cypress.** Functionally comparable to Playwright for this surface. Rejected on three grounds: (a) lower Next.js community momentum than Playwright over the last two years; (b) Cypress's test-runner architecture (iframe-hosted app) interacts oddly with Next 16's RSC streaming compared to Playwright's CDP-direct model; (c) introducing a second browser-test framework (we already have Playwright muscle memory implied by ADR-0014's "door left open"). No load-bearing capability difference.

**Storybook + interaction tests.** The natural "test the page in isolation without a real server" framework. Rejected: not in repo; would require a new infra layer (Storybook config + addon-interactions + a story-level mock of the entire Next.js app router context); the back-nav assertion specifically needs the real router + real navigation stack, which Storybook intentionally abstracts away.

**MSW + vitest browser mode.** Rejected on the same grounds as ADR-0014 §5 — MSW is the wrong layer (mocks fetch in the browser), but iron-rule-#8 stub-mode already gives us deterministic responses without needing fetch interception.

---

## Consequences

- **New test runtime convention:** `e2e/**/*.spec.ts` files run via `npm run e2e:browser` (Playwright). `tests/*.e2e.test.ts` files continue to run via `npm run e2e` (vitest). The two suites coexist; their globs do not overlap.
- **New dev dependency:** `@playwright/test` pinned exact. Browser binary cached via `actions/cache`.
- **CI minute cost:** +~125s cold / +~70s warm per PR. Within ADR-0011 envelope.
- **`e2e-browser` job is independent** of `node` and `e2e`. All three fire in parallel; failures are independently visible. Gating policy: `npm run check` does NOT chain `npm run e2e:browser` (same rationale as ADR-0014 §4 — `next build` + browser launch would dominate the local dev pre-push loop).
- **Iron-rule-#8 carve-out for browser specs codified:** subprocess full-stub mode via unset `*_PROVIDER` env vars. Future spec authors targeting a page that calls a route handler whose factory does NOT auto-default to stub mode MUST add a stub-mode env var to the factory before writing the spec — `page.route()` interception is reserved for cases where this is impossible, and none currently exist.
- **Iron-rule-#2 fixture-seeding policy carries over:** seeds go through `POST /api/ingest`. Raw INSERT in an `e2e/**/*.spec.ts` is rejected at code review (same rule as ADR-0014 §3).
- **Door closed:** the reservation ADR-0014 §5 and §Consequences left open is now filled. Future browser-test ADRs introduce frameworks for specific surfaces (e.g., visual regression via Percy/Chromatic, mobile-specific via Playwright's device emulation) but do not re-open this runtime decision.

---

## Implementation files (this PR)

This is a Research-archetype slice — **ADR-only**. The actual `package.json` install, `playwright.config.ts`, `e2e/back-nav.spec.ts` first spec, and `.github/workflows/ci.yml` job land in a separate Build PR.

- `docs/adr/0015-back-nav-e2e-runner.md` (this file).
- `docs/adr/README.md` index entry.
- `docs/BACKLOG.md` line 77 receives an "ADR-0015 written; implementation PR queued" breadcrumb (does NOT mark RESOLVED — the implementation still has to land).
