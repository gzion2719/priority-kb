# UI_AUDIT.md — UI/UX audit pass before M5

**Date:** 2026-06-02 (revised same day after independent code-review pass — see §7 changelog at bottom).
**Stage:** development (pre-M5, [ADR-0011](adr/0011-repo-visibility.md) public window, synthetic-fixture corpus only)
**Audit scope:** all 11 user-facing surfaces shipped through M4, audited against [`styles/kramer-brand.css`](../styles/kramer-brand.css) tokens + iron rules.
**Audit shape (per `SESSION_PROTOCOL.md` Step 7 Sub-option scope-split decision):** Leg 1 = this doc (research-archetype, no production code). Leg 2 = per-slice polish PRs in follow-up Build sessions, sequenced by priority below.
**Roles tested:** anonymous (no `x-stub-user-role` header) on all 11 surfaces; `admin` (ModHeader-injected `x-stub-user-role: admin`) on 5 admin-rendered surfaces. `user` role not separately tested — `sensitivityAllowedForRole('user') = ['public','internal']` and all 28 seed entries are `internal`, so user-role visible content is identical to admin modulo write controls; the only visual differentiator would be a `restricted`-tier pill, which the synthetic seed doesn't produce. Production-stage transition should include a user-role pass against a seed containing all three tiers (cross-ref C11 + §5 user-role pass).

**Reproducibility recipe:**

Prerequisites: Node 20+, Docker Desktop running, ~5 min for first boot. The repo at `C:\Users\galzi\OneDrive - Afiki-C\Development\Claude\PriorityKB` must have `node_modules/` (run `npm install` if absent).

```powershell
# 1. Boot stack
cd "C:\Users\galzi\OneDrive - Afiki-C\Development\Claude\PriorityKB"
docker compose up -d
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5432/priority_kb"
# Note: seed script defaults to --dry-run; --apply commits to DB.
# Stub-vector seed is fine for UI audit (no semantic recall needed).
npx tsx scripts/seed-synthetic-entries.ts --apply   # if DB empty
npm run dev

# 2. In Chrome, install ModHeader (https://modheader.com/).
#    - Add a Request header (NOT Response, NOT Cookie):
#      Name: x-stub-user-role   Value: admin
#    - Optionally scope to localhost via Filters → URL Pattern (regex mode
#      required in some ModHeader builds): https?://localhost:3000/.*
#    - Toggle the profile OFF to test the anonymous path.

# 3. Visit each route in §3 below.
```

**Rubric (6 axes per surface):**
1. **Brand** — palette tokens, GT Eesti via `getComputedStyle().fontFamily`, logo placement, link colors.
2. **Iron-rule #6 sensitivity** — server-side enforcement + visual `.sensitivity-pill` rendering wherever an entry appears.
3. **Hierarchy** — surface uses `--fs-title` (24px) / `--fs-subhead` (18px) / `--fs-body` (12px) tokens, not arbitrary sizes.
4. **Interaction states** — loading, error, empty, hover, focus-ring, anonymous-401 path.
5. **a11y / contrast / keyboard** — WCAG AA contrast per token-pair, tab order, keyboard-only nav, aria-live for streaming, focus-visible.
6. **i18n/RTL + responsive** — Hebrew RTL rendering, mixed bidi, viewport breakpoints.

---

## §1 Cross-cutting findings table

Findings that span 2+ surfaces. Fix once, win everywhere. Sequence Leg-2 polish so cross-cutting lands BEFORE per-surface PRs (freeze clause: no new components in per-surface PRs without re-running cross-cutting audit).

| ID | Severity | Finding | Surfaces affected | Source citation |
|---|---|---|---|---|
| **C1** | BLOCKING | **GT Eesti is silently not loading.** `body.fontFamily` computes to `"GT Eesti Display Lt", "GT Eesti Display", sans-serif` on every surface, but the `@font-face` blocks in `kramer-brand.css` are **commented out** and `public/fonts/` does not exist. Every render falls through to system sans (Segoe UI on Win11). The product has never actually rendered in its brand typography. | All 11 | `styles/kramer-brand.css:400-421` (comment block + commented @font-face) + `Glob public/fonts/**` empty |
| **C7** | BLOCKING | **`--kramer-bg` is undefined — 6-surface invisible-button bug.** Six admin client-component buttons use `color: var(--kramer-bg)` inline. The variable `--kramer-bg` is **not defined anywhere** in `kramer-brand.css` (the real var is `--kramer-dark`). Undefined CSS vars fall back to `inherit`, which resolves to `--kramer-neutral` from `body`. Result: every affected button renders as a `--kramer-neutral` rectangle with text in `--kramer-neutral` — invisible. Mechanical fix: rename `--kramer-bg` → `--kramer-dark` in all 6 files. **Cited surfaces:** `app/admin/entries/[id]/edit/EditForm.tsx:367` (Save changes), `app/admin/entries/[id]/history/page.tsx:115`, `app/admin/entries/[id]/history/[versionNo]/RevertForm.tsx:140`, `app/admin/entries/page.tsx:286`, `app/admin/tags/RenameForm.tsx:153`, `app/admin/tags/MergeForm.tsx:232`. | edit form, history list, revert form, entries list, tag rename, tag merge | `Grep --kramer-bg` → 6 hits across `app/admin/`; `Grep --kramer-bg styles/kramer-brand.css` → 0 hits |
| **C9** | BLOCKING | **No `:focus-visible` outline on 90% of interactive surfaces — WCAG 2.4.7 Level AA regression.** CSS scan finds focus styles only on `.chat-input:focus` (`kramer-brand.css:237-240`) and `.filter-chip-remove:focus-visible` (`:352-356`). Every other interactive element — every `button`, every `<a>`, every form input on `/admin/ingest/direct`, the search bar on `/admin/entries`, the tag rename/delete forms — relies on browser defaults, which Chrome strips for mouse-clicked but unfocused-via-keyboard elements. Keyboard-only users cannot tell where focus is on any admin surface. | All interactive surfaces | `Grep ":focus|focus-visible" styles/kramer-brand.css` → 2 matches only |
| **C13** | BLOCKING | **Source pointer is editable on `/admin/entries/[id]/edit` — iron-rule #7 integrity risk.** Non-negotiable #7 says "every entry stores `source pointer` (ticket #, conversation, doc link) and `last_verified_at`." The `source_pointer` field is the audit-trail provenance key; making it freely editable lets an admin rewrite `synthetic-fixture-2026-05-27-…` to look like a real ticket (or vice versa), silently destroying provenance. **Tier-up rationale per code-review pass:** this is iron-rule territory, not a per-surface polish. Either lock the field read-only after creation, or require a typed reason field on change. | edit | Form-input observation; iron-rule #7 conformance |
| **C2** | MAJOR | **`KramerLogo` component doesn't exist.** The brand CSS at `kramer-brand.css:11` references `<KramerLogo />` as an M1 deliverable, but no such component exists in the codebase (`Grep KramerLogo` matches only the CSS comment itself, no `.tsx` file). The product has no logo anywhere — landing page, admin chrome, anywhere. | / (especially), entire admin section | `Grep KramerLogo` → only `styles/kramer-brand.css:11` |
| **C3** | MAJOR | **No GLOBAL navigation chrome.** No top-bar, no sidebar, no role indicator anywhere. Per-page breadcrumbs DO exist on 4 admin surfaces (`/admin/entries/[id]/edit` "← Back to entries · View history", `/admin/entries/[id]/history` "← Back to entries · Edit current", `/admin/stale-entries` "← Back to entries", `/admin/tags` "← Back to entries") and use ad-hoc inline styles, not a shared `<nav>` component. Users (admin or otherwise) cannot tell at a glance who they are signed in as, or how to get home from `/query` without using browser back. | All 11 | Cross-surface probe; no `<nav>` / `<header>` element rendered globally; 4 per-surface breadcrumbs verified in §3 |
| **C4** | MAJOR | **No `<title>` per surface.** Every page's `<title>` is the global `"Priority Knowledge Base"` from `app/layout.tsx:5-7`. Browser tabs, bookmarks, and history are all indistinguishable. | All 11 | `app/layout.tsx` `metadata.title = brand.name`; no per-page `export const metadata` overrides |
| **C5** | MAJOR | **Unbranded Next.js default 404** on 6 of 8 admin routes. `/admin/entries`, `/admin/entries/[id]/edit`, `/admin/entries/[id]/history`, `/admin/entries/[id]/history/[ver]`, `/admin/stale-entries`, `/admin/tags` all return the default `404 — This page could not be found.` chrome (white text, gray subtitle, no Kramer brand, no nav home). Only `/entries/[id]` has a branded `app/entries/[id]/not-found.tsx`. Inconsistent. | 6 admin surfaces | `find app -name not-found.tsx` → 1 result (`app/entries/[id]/not-found.tsx`) |
| **C6** | MAJOR | **6 admin pages defend at the page boundary; 2 ingest pages do not. Iron-rule #6 is intact — this is a UI-honesty issue, not a security defect.** Six admin pages (`/admin/entries`, `/admin/entries/[id]/edit`, `/admin/entries/[id]/history`, `/admin/entries/[id]/history/[ver]`, `/admin/stale-entries`, `/admin/tags`) call `resolveRoleFromHeader` + `notFound()` at the page server-component, hiding the existence of the surface from non-admins. Two ingest pages (`/admin/ingest`, `/admin/ingest/direct`) are `"use client"` components with no auth code at the page boundary at all — they render the full admin UI to anonymous visitors. The actual write paths ARE server-gated by `withAdmin` (verified at `app/api/ingest/route.ts` + `app/api/agent/ingest/route.ts`), so iron-rule #6 is enforced. The defect: anonymous users see "Admin-only chat for logging Priority knowledge entries" + a working textarea + a Send button that only 401s on submit. Recommendation: hoist the page-component existence-leak pattern (from the other 6) into a shared check so all 8 admin surfaces use it. | `/admin/ingest`, `/admin/ingest/direct` vs other 6 admin routes | `app/admin/ingest/page.tsx:1` is `"use client"`, no `resolveRoleFromHeader` call; spot-check of 6 other pages confirms `notFound()` on non-admin |
| **C8** | MAJOR | **WCAG contrast not verified for the brand palette.** Purple `#8200b4` on dark `#121212` (CTA-default button surface), mint `#68ffc3` on dark (links, CTA), pink `#be0078` on dark (alerts) — no contrast ratios computed against AA 4.5:1 anywhere. Purple-on-dark is the most-likely failure (deep purple is dark; the contrast is low against very dark background). The base palette needs a one-time WCAG pass with concrete ratios per token-pair documented. | All 11 (every Kramer-colored element) | No `docs/A11Y.md` exists; no audit script |
| **C10** | MAJOR | **Horizontal viewport space underused.** Every surface anchors content in the left/center ~60% of the viewport at 1920px. Right ~40% is empty black. No responsive breakpoints declared anywhere except `.chat-shell { max-width: 48rem }`. The product looks half-empty on common Israeli office monitors (1920×1080 standard). | All 11 (visible on all screenshots) | No `@media` queries in `kramer-brand.css` |
| **C14** | MAJOR | **No `viewport` metadata export in `app/layout.tsx`.** Next.js 14+ deprecates `viewport` inside `metadata` and expects a separate `export const viewport`. The current `layout.tsx` exports `metadata` only; no `viewport` field anywhere. Mobile rendering relies on Next.js's default `width=device-width`, but the project never declares its intent. Combined with C10 (no `@media` queries), this is a real responsive failure: mobile devices may not get the proper viewport meta tag injected reliably across Next versions. | All 11 (via root layout) | `Grep viewport app/layout.tsx` → 0 hits |
| **C15** | MAJOR | **Client-component admin forms bypass the `.btn` primitive entirely.** `kramer-brand.css` defines `button { background: var(--kramer-purple); color: var(--kramer-neutral); }` + `.btn.cta { background: var(--kramer-mint); color: var(--kramer-dark); }` as the canonical button primitives. But all 6 admin client forms (`EditForm.tsx`, `RenameForm.tsx`, `MergeForm.tsx`, `RevertForm.tsx`, `app/admin/entries/[id]/history/page.tsx` inline forms, `app/admin/entries/page.tsx` search button) override the styles inline (`primaryButtonStyle: React.CSSProperties`). The brand primitive is bypass-by-default. C7 is a symptom of this structural issue — fixing only the typo leaves the same class of bug to recur on every new admin form. Recommended fix: extract a `<Button variant="primary"|"cta"|"secondary">` component using the brand `.btn` classes; sweep all 6 inline-styled buttons to use it. | 6 admin client forms | `Grep "primaryButtonStyle\|background.*kramer-neutral" app/admin/` → 6 hits |
| **C16** | MAJOR | **No `aria-live` / `role="status"` on the SSE-streaming surfaces.** `/admin/ingest` and `/query` both stream Claude tokens into the DOM. For screen-reader users, streamed content is silent unless the receiving container is wrapped in an `aria-live="polite"` region. Grep across `app/admin/ingest/page.tsx`, `app/admin/ingest/direct/page.tsx`, `app/query/page.tsx` returns zero `aria-live` / `role="status"` declarations. The product is unusable with a screen reader during streaming. | `/admin/ingest`, `/query` | `Grep "aria-live\|role=.status." app/` → 0 hits |
| **C11** | MINOR | **All 28 seed entries are `internal` sensitivity.** The synthetic seed script doesn't produce `public` or `restricted` entries; visual sensitivity-pill differentiation between the three tiers cannot be tested with the current corpus. Pill rendering verified live for `internal` only. Cross-ref §5 user-role pass — both deferrals collapse once the seed includes all three tiers. | `/admin/entries`, `/entries/[id]`, `/query` citations | `Bash psql … entries` returned 28 rows, all `internal` |
| **C12** | MINOR | **`html lang="en"` hardcoded.** RTL is applied per-element via `dir="auto"` (e.g., `app/admin/entries/page.tsx:392`), which works correctly on Hebrew titles by first-strong-char detection — but `html.dir` is never `"rtl"`. For a Hebrew-primary user, no top-level RTL signal. The audit's earlier prose said `dir="rtl"`; the actual implementation uses `dir="auto"`. | All 11 (Hebrew-rendering ones especially) | `app/layout.tsx:16`; `app/admin/entries/page.tsx:392` uses `dir="auto"` |

---

## §2 Severity-tagged polish backlog (Leg 2 candidates)

Sequenced for follow-up Build sessions. Cross-cutting first (per freeze rule), per-surface after.

### BLOCKING — ship before any other M5 work
1. **C7 + C15 paired fix — `--kramer-bg` → `--kramer-dark` sweep, then extract `<Button>` primitive.** Step 1 (1 commit, ~6 lines): rename `--kramer-bg` to `--kramer-dark` in all 6 files (`Grep --kramer-bg` then `Edit replace_all`). Verify each affected button is now visible. Step 2 (separate PR pair): extract a `<Button variant="primary"|"cta"|"secondary">` component using the brand `.btn` classes; sweep all 6 inline-styled buttons to use it. Step 1 is the one-char surgical fix that ships visibility today; Step 2 is the structural fix that prevents recurrence.
2. **C1 — Bundle GT Eesti `.woff2` or pivot to a free brand-compatible alt.** Two paths: (a) license + bundle the `.woff2` files under `public/fonts/` and uncomment the `@font-face` blocks; (b) pick a free near-equivalent (Inter, IBM Plex Sans) and update `--font-body` / `--font-heading`. Either way, 1 PR pair. This decision belongs in ADR-0026 (recommendation §4).
3. **C9 — Global `:focus-visible` outline.** Add `*:focus-visible { outline: 2px solid var(--kramer-mint); outline-offset: 2px }` to `kramer-brand.css`. Sweep for any element that overrides it. 1 PR pair, ~20 lines. WCAG 2.4.7 Level AA compliance.
4. **C13 — Lock or reason-gate `source_pointer` on edit.** Iron-rule #7 integrity. Either render the field read-only post-create, or require a typed reason field on any change (audited separately). 1 PR pair, ~30 lines + an audit-log column for the reason if path B.

### MAJOR — Leg 2 cross-cutting (lands before any per-surface polish)
5. **C2 + C3 — Ship `KramerLogo` + minimal global nav chrome.** Build the base64-PNG `<KramerLogo />` component referenced in brand CSS; add a thin top-bar (logo left, role indicator right) wrapped around all `app/**/page.tsx` via a shared layout. Replace the 4 ad-hoc per-surface breadcrumbs with a shared `<Breadcrumb>` component. 1 PR pair, ~250 lines.
6. **C4 — Per-page `<title>` via Next.js metadata.** Add `export const metadata = { title: "Edit entry · Priority KB" }` (etc) to each page. 1 PR pair, 11 small edits.
7. **C5 — Branded `not-found.tsx` for `/admin`.** Add `app/admin/not-found.tsx` mirroring `app/entries/[id]/not-found.tsx` (Kramer chrome, mint "← Back to entries" link). 1 PR pair.
8. **C6 — Unify anon-access pattern.** Apply the `resolveRoleFromHeader` + `notFound()` existence-leak pattern to `/admin/ingest` + `/admin/ingest/direct`. Tricky because both are `"use client"` — needs either a server-component wrapper or moving the auth check into a server-side parent page that conditionally renders the client component. 1 PR pair, ~80 lines. **Note: iron-rule #6 already intact server-side — this PR is UI honesty / minimum disclosure only, not a security fix.**
9. **C8 — WCAG AA contrast pass + tokens revision.** Compute concrete ratios for every palette pair; if any < 4.5:1, propose a tonal adjustment that preserves brand identity (e.g., a brighter `--kramer-purple-strong` for accent-on-dark). Document in a new `docs/A11Y.md`. This decision belongs in ADR-0026 (recommendation §4).
10. **C10 + C14 — Responsive breakpoints + viewport metadata.** Add `export const viewport = { width: "device-width", initialScale: 1 }` to `app/layout.tsx`. Define `--container-max: 64rem`, apply to all `app/**/page.tsx` wrappers. Add `@media (max-width: 768px)` rules for stacking. 1 PR pair.
11. **C16 — `aria-live` on SSE-streaming surfaces.** Wrap the streaming Claude-response container in `<div aria-live="polite" role="status">` on `/admin/ingest` + `/query`. 1 PR pair, ~10 lines.

### MAJOR per-surface (after cross-cutting lands)
12. **S7 polish** — `/admin/entries/[id]/edit`: add sensitivity-tier visual indicator next to the SELECT, sensitivity-change warning before save, native date picker styling unification.
13. **S2 polish** — `/query`: empty-state copy with example queries; `Clear` button should disable when textarea is empty; auth-required hint for anonymous (C6 collapses anon to 404 — coordinate).
14. **S10 polish** — `/admin/stale-entries`: rewrite subtitle to drop internal milestone refs ("M4 #3 revert…") and use end-admin language.
15. **S11 polish** — `/admin/tags`: scroll-position-aware section nav (catalog + merge + suggest), reduce DOM weight (44 inputs collapsed via accordion or single-rename-row composition).

### MINOR
16. **C11** — Extend `seed-synthetic-entries.ts` to include `public` + `restricted` tier entries for visual pill differentiation. Cross-ref §5 user-role pass.
17. **C12** — Conditional `html.dir = "rtl"` when first-strong-direction Hebrew detected (or per-user preference).
18. **S1 polish** — `/` landing: vertical-center is fine but could surface "what is this" copy + role-based CTAs (`Ask a question` for users, `Log a new entry` for admins).

---

## §3 Per-surface findings

Each section: route, role tested, key probe data, 6-axis findings.

### S1 — `/` (landing, anonymous)
**Computed-style probes:** `body.fontFamily = "GT Eesti Display Lt"` *(C1 — falls back to system sans)*; `body.bg = rgb(18,18,18)` = `--kramer-dark` ✓; `body.color = rgb(220,221,222)` = `--kramer-neutral` ✓; `body.fontSize = 12px` ✓; `h1` = `"Priority Knowledge Base"` at 24px ✓; `html.lang = "en"`, `html.dir = (default LTR)`.

| Axis | Finding |
|---|---|
| Brand | ✅ palette tokens correct. 🚨 C1 font. 🚨 C2 no logo. |
| Iron-rule #6 | N/A — landing page has no entries. |
| Hierarchy | ✅ uses `--fs-title`/`--fs-body` tokens. ⚠️ Visual hierarchy is just title + subtitle + 1 link — no sense of product structure. |
| Interaction | Only one interactive element: "Ask the KB →" link (mint, hover changes to purple per CSS). ⚠️ No `:focus-visible` (C9). |
| a11y | Mint link `#68ffc3` on dark — pending C8. Hover state changes to purple — pending C8. |
| i18n/RTL | English-only; no Hebrew test here. |

---

### S2 — `/query` (anonymous; renders, API will 401 on submit)
**Probes:** h1 "Ask the KB" 24px neutral; "Question in, cited answer out." subtitle mint; 1 textarea; 2 buttons (`Clear` enabled purple, `Ask` disabled purple); 0 sensitivity pills (empty state); 0 banners; `hasRoleIndicator: false`.

| Axis | Finding |
|---|---|
| Brand | ✅ purple buttons match `--kramer-purple`. ✅ mint subtitle matches `--kramer-mint`. |
| Iron-rule #6 | ⚠️ **C6** — page renders to anonymous, affordance leaks; API gates submit. Iron-rule #6 intact server-side. |
| Hierarchy | ✅ h1 24px. ⚠️ Form sits at top-center; entire lower viewport empty (C10). |
| Interaction | ✅ `Ask` button disabled when textarea empty (good). 🚨 `Clear` button stays enabled when textarea empty — should disable. 🚨 No empty-state copy explaining what to ask or that you need to be signed in. 🚨 C16 — no `aria-live` on response area. |
| a11y | C9 focus-ring. C8 contrast on Ask-purple-on-dark. C16 SSE. |
| i18n/RTL | Not tested in empty state — would surface in response citations. |

---

### S3 — `/admin/ingest` (anonymous; **fully renders admin chat UI** — `"use client"`, no page-level auth check)
**Probes:** h1 "Ingestion Agent"; subtitle "Admin-only chat for logging Priority knowledge entries."; chat textarea + Send button (mint CTA); empty chat region.

| Axis | Finding |
|---|---|
| Brand | ✅ Send button is mint (`.btn.cta`). |
| Iron-rule #6 | 🚨 **C6** — full admin UI exposed to anonymous user (no page-level auth gate). The subtitle explicitly labels the page "Admin-only" but the page renders regardless. UI lies. Iron-rule #6 intact server-side (`app/api/agent/ingest/route.ts` uses `withAdmin`). |
| Hierarchy | ✅ tokens correct. |
| Interaction | Anonymous user can compose messages freely until they hit Send → API 401. No upfront indicator. C16 — no `aria-live` on streaming chat region. |
| a11y | Empty chat region uses subtle dim background; need contrast verification (C8). |
| i18n/RTL | Untested. |

---

### S4 — `/admin/ingest/direct` (anonymous; **fully renders 7-input form** — `"use client"`, no page-level auth check)
**Probes:** h1 "Direct Ingest"; subtitle "Submit an entry without the conversational agent."; 7 inputs (Title, Category, Tags, Source pointer, Last verified, Sensitivity SELECT [public/internal/restricted], Body); Submit button mint CTA; Back to chat purple.

| Axis | Finding |
|---|---|
| Brand | ✅ Submit mint, Back-to-chat purple. |
| Iron-rule #6 | 🚨 **C6** — same as S3. Sensitivity SELECT exposes the full three-tier enum to anonymous visitors. ⚠️ **C13** — source pointer is freely editable (iron-rule #7 risk, now BLOCKING). Iron-rule #6 intact server-side (`app/api/ingest/route.ts` uses `withAdmin`). |
| Hierarchy | ✅ tokens correct. Last-verified pre-filled with current ISO — good UX. |
| Interaction | Native browser date picker renders `2026-06-01T18:55:09.822Z`-style; styling diverges from other inputs. |
| a11y | C8/C9. |
| i18n/RTL | Untested. |

---

### S5 — `/admin/entries` (anonymous: 404 unbranded; admin: full list)
**Anon probes:** title "404: This page could not be found."; `h1` is the "404"; `bodyText.length = 33`.
**Admin probes (live):** h1 "Entries"; subtitle "Admin browser — read-only. 25 rows on this page."; mint "View stale entries →" cross-link; 25 entry cards each with title h2 (uses `dir="auto"` per `app/admin/entries/page.tsx:392` — auto-direction by first-strong-char, NOT explicit `rtl`) + sensitivity-pill (`data-tier="internal"` purple) + "category: <name>" + tag chips (`.filter-chip` mint border) + "+N more" overflow + "verified YYYY-MM-DD · updated YYYY-MM-DD" + mint "Edit" link.

| Axis | Finding |
|---|---|
| Brand | ✅ palette correct live. ✅ filter-chip primitive renders. ✅ sensitivity-pill primitive renders (purple internal tier). |
| Iron-rule #6 | ✅ existence-leak 404 for non-admin (matches `lib/entries.ts` `findEntryForRole` defense). 🚨 **C5** — 404 is unbranded. |
| Hierarchy | ✅ h1 24px; cards use h2/h3 for entry titles. |
| Interaction | 🚨 Empty/unstyled button to right of search input — needs investigation, likely a placeholder or another C7-class invisible button (search confirms `app/admin/entries/page.tsx:286` uses `--kramer-bg` typo). 🚨 Filter facets (M4 #1b) not visible in default view — verify whether they only appear when a filter is applied. |
| a11y | C8/C9. Search form has a visible label. ✅ `.sr-only` primitive in use elsewhere. |
| i18n/RTL | ✅ Hebrew titles like "מתי כדאי להשתמש ב-BPM לעומת טריגר פרוצדורלי בפריוריטי" render right-to-left within the h2 via `dir="auto"`. ✅ Mixed bidi (Latin BPM inside Hebrew sentence) handled correctly by `dir="auto"`. |

---

### S6 — `/entries/[id]` (anonymous English + Hebrew IDs both → branded 404)
**Probes:** h1 "Entry not found"; subtitle "We couldn't find the entry you're looking for. It may have been removed, or you may have followed an outdated link."; mint "← Back to query" link.

| Axis | Finding |
|---|---|
| Brand | ✅ Branded 404. Mint back link. *(This is the model the other 6 admin routes should follow — C5.)* |
| Iron-rule #6 | ✅ existence-leak collapses auth-fail + missing-id into same 404. |
| Hierarchy | ✅ tokens correct. |
| Interaction | Single mint link to `/query` for recovery. Good. |
| a11y | C8/C9. |
| i18n/RTL | English-language 404 copy. |

*(Admin-rendered detail view not tested live — would require seed-restricted entries to verify sensitivity-pill visual differentiation; C11.)*

---

### S7 — `/admin/entries/[id]/edit` (anonymous 404; admin renders form)
**Admin probes (live):** breadcrumb "← Back to entries · Edit history" (both mint); h1 "Edit entry" 24px; subtitle "Current version: v1 — this edit becomes v2."; 7 inputs (Title, Category, Tags, Body, Source pointer, Last verified date-picker `27/05/2026` DD/MM/YYYY locale, Sensitivity SELECT defaulting to current value); tag preview chips under tags input ("4 tags: customers · import · excel · duplicates"); buttons: **Save changes** (invisible — `EditForm.tsx:367` `color: var(--kramer-bg)` undefined → C7), Cancel (purple).

| Axis | Finding |
|---|---|
| Brand | ✅ Cancel purple. 🚨 **C7** — Save invisible (root cause `--kramer-bg` typo at `EditForm.tsx:367`). 🚨 **C15** — every inline-styled button bypasses the `.btn` primitive. |
| Iron-rule #6 | 🚨 **C13** — source pointer editable (BLOCKING, iron-rule #7 risk). Sensitivity SELECT works but no visual confirmation pill. |
| Hierarchy | ✅ h1 24px; field labels at body size. |
| Interaction | 🚨 No "sensitivity tier will change" warning on SELECT change. Native date picker styling inconsistent with other inputs. |
| a11y | 🚨 Save button invisible. C8/C9. |
| i18n/RTL | Tested on English entry. Hebrew entry edit not separately tested but field layout is LTR; Hebrew body content would flow RTL inside its textarea by default browser bidi handling. |

---

### S8 — `/admin/entries/[id]/history` (anonymous 404; admin renders list)
**Admin probes (live):** breadcrumb "← Back to entries · Edit current" (both mint); h1 "Version history"; subtitle: entry title "Fixing duplicate customer codes during Excel import"; secondary subtitle "Only the current version exists — no prior versions to compare or revert to." (good empty-state copy for single-version entries); 1 list row showing `v1` + small invisible pill (same C7 root cause — `app/admin/entries/[id]/history/page.tsx:115` uses `--kramer-bg`) + timestamp `2026-06-01 18:57:24 UTC`.

| Axis | Finding |
|---|---|
| Brand | 🚨 **C7** — the small pill next to `v1` renders invisible (same `--kramer-bg` typo at `history/page.tsx:115`). 🚨 **C15**. |
| Iron-rule #6 | ✅ existence-leak for non-admin. |
| Hierarchy | ✅ tokens correct. |
| Interaction | Single-version empty state is informative. Need multi-version test (re-seed with edits) to audit diff list + revert button styling — out of scope for this pass. |
| a11y | C7/C9. |
| i18n/RTL | Untested (English entry). |

---

### S9 — `/admin/entries/[id]/history/[ver]` (COVERAGE GAP — synthetic seed produces v1-only entries)
**Status:** This surface only renders meaningfully once an entry has been edited at least once. Synthetic seed creates v1 → unreachable in current dev state. **Reproducibility gap acknowledged in §5.**

Recommended follow-up: extend the seed script to perform one edit on at least one entry so this surface is populated by default; OR run a manual edit-flow as part of the audit reproducibility recipe.

Pre-emptive finding from source code (`RevertForm.tsx:140` cited in C7) suggests the Revert button on this surface is invisible too — same `--kramer-bg` typo class.

---

### S10 — `/admin/stale-entries` (anonymous 404; admin renders empty-state)
**Admin probes (live):** breadcrumb "← Back to entries"; h1 "Stale entries"; subtitle "Entries un-reverified for more than 180 days, oldest first. Open one in the editor to re-attest the verification date. Note: a M4 #3 revert restores content but does NOT touch `last_verified_at` — a reverted entry stays listed here until the admin separately re-verifies."; body "No stale entries — every entry has been verified within the last 180 days." (good empty-state copy for fresh seed).

| Axis | Finding |
|---|---|
| Brand | ✅ palette correct. |
| Iron-rule #6 | ✅ existence-leak. |
| Hierarchy | ✅ h1 24px. |
| Interaction | 🚨 Subtitle mixes internal milestone language: "a M4 #3 revert…" — that's developer terminology that means nothing to an end-admin. Rewrite as plain English. |
| a11y | C8/C9. |
| i18n/RTL | Subtitle is English-only; would need translation for Hebrew-primary admins. |

---

### S11 — `/admin/tags` (anonymous 404; admin renders catalog)
**Admin probes (live):** breadcrumb "← Back to entries"; h1 "Tag management"; subtitle: warning about per-rename Voyage embed cost ("Rename or delete tags across the corpus. Each operation loops the existing updateEntry pipeline per affected entry (lock, append version, re-chunk, re-embed, audit) — so a rename triggers N synchronous Voyage embed calls. Validate the target name carefully; renames are reversible only by another rename."); section "Catalog (40)" with 40+ tag rows visible (each: tag name left, `N entries` right); **44 form inputs on the page total** (40 catalog rows ≈ 4 per row form + the merge form's 4 inputs probably below fold); merge form (PR-B yesterday) not visible in viewport — needs scroll to confirm rendering.

| Axis | Finding |
|---|---|
| Brand | ✅ palette correct. 🚨 **C7** — `RenameForm.tsx:153` + `MergeForm.tsx:232` both use `--kramer-bg` typo; rename / merge submit buttons likely invisible. |
| Iron-rule #6 | ✅ existence-leak. ⚠️ Tag catalog visible to admins shows tag names of all entries regardless of sensitivity — verify that a `restricted`-tagged entry's unique tag wouldn't leak via the catalog count to a non-admin (currently moot since `/admin/tags` is admin-only, but worth a note for if user role ever gets read access to tag catalog). |
| Hierarchy | ✅ h1; section heading "Catalog (40)" as h2/h3. |
| Interaction | 🚨 44 inputs is heavy DOM; consider an accordion or single shared rename composer. Subtitle warning is accurate but intimidating — surface a "what happens when I rename" expandable tooltip rather than wall-of-text. Scroll-position-aware nav for catalog/merge/suggest sections would help. |
| a11y | 40 input rows = 40 tab stops; tab order needs verification. C9. |
| i18n/RTL | Mixed Hebrew + English tags ("hebrew" "customization" etc.) — verify RTL rendering for any Hebrew-named tag in the catalog. |

---

## §4 Decision required at Leg 1 close (per Deferred-decision-audit sub-rule)

Four pre-enumerated alternatives for how the findings land in project state. Pick one:

| Option | Shape | When to pick |
|---|---|---|
| **A** | Keep as standalone `docs/UI_AUDIT.md` (this doc) + drop individual polish slices into `docs/BACKLOG.md` for the user to pluck between M5 items. | If M5 is the priority and UI polish is opportunistic. |
| **B** | This doc + new `M4.5 — UI polish` milestone block in `docs/ROADMAP.md` with the §2 backlog as its checklist, gating M5 on its acceptance. | If the audit findings should block M5. Recommended given the 4 BLOCKING-class findings (C1 font, C7 invisible buttons, C9 focus-ring, C13 source-pointer). |
| **C** | This doc + ADR-0026 "Design-system tokens + brand-loading strategy" that decides the GT Eesti question, focus-ring tokens, contrast tokens, button primitive extraction (C15). The cross-cutting fixes become an ADR-anchored phase; per-surface polish stays BACKLOG. | If the cross-cutting fixes need locked design decisions (most do — C1 font choice, C8 contrast tokens, C9 focus-ring color, C15 button primitive). |
| **D** | Split this doc into `docs/UI_AUDIT_CROSS_CUTTING.md` (the §1 + §2 cross-cutting findings) + `docs/UI_AUDIT_PER_SURFACE.md` (the §3 per-surface appendix). The cross-cutting doc then becomes the evidence file referenced from ADR-0026. | If ADR-0026 wants a clean evidence anchor without dragging per-surface prose along, and per-surface findings deserve their own iterating doc as polish slices land. |

Recommended: **B + C** (gating milestone + supporting ADR). Option D is reasonable if the per-surface appendix grows substantially in future audits.

---

## §5 What this audit did NOT cover (known gaps)

- **User-role (`x-stub-user-role: user`) sweep** — skipped because all 28 seed entries are `internal` and `sensitivityAllowedForRole('user') = ['public','internal']`, so user view ≡ admin view modulo write controls in current corpus. Re-run after C11 seed diversification.
- **Multi-version history view (S9)** — synthetic seed produces v1-only entries; the diff renderer at `/admin/entries/[id]/history/[ver]` is unreachable. Re-run after extending seed to include at least one edited entry.
- **Live tab-order / keyboard-only navigation** — manual interaction would need user-side; documented as C9 source-only finding.
- **Mobile / tablet rendering** — viewport tested at 1920×744-ish only (the Chrome MCP probe's default). Mobile breakpoints don't exist (C10 + C14) so the question is "what should they be" not "do they work".
- **Performance (CLS, LCP, font-load FOUT)** — not measured. Worth a Lighthouse pass once C1 lands.
- **Sensitivity-pill visual differentiation (all 3 tiers side-by-side)** — only `internal` visible in seed (C11).
- **Hydration mismatch warnings in dev console** — not checked. Client-component date pickers and `useState(() => new Date())` patterns (common in `/admin/ingest/direct`) are classic SSR-mismatch vectors. Verify by opening Chrome DevTools console on each admin surface in dev mode.
- **Error boundary behavior** — `Glob app/error.tsx` finds nothing; no top-level `app/error.tsx` is shipped. Verify what happens when a server component throws (likely Next.js default error screen — unbranded, similar to the C5 404 problem).
- **`robots.txt` / `sitemap.xml`** — a dev-stage public repo should have at least a `noindex` meta tag or `robots.txt` Disallow rule to prevent the localhost (or any future preview deploy) from being indexed. Not checked.
- **Security headers (CSP, X-Frame-Options, Referrer-Policy)** — no `next.config.js` headers audit performed. The SSE streaming routes are CSP-sensitive (need `connect-src 'self'`); the chat UI is iframe-sensitive (X-Frame-Options).
- **`/healthz` UX** — ROADMAP M1 says `/healthz` exists. The audit didn't visit it. Worth ~30 seconds to verify what it renders (should be JSON, but UX matters if a human ever hits it).

---

## §6 Verification probes (reproducible — re-run to confirm any finding)

| Probe | Command | Validates |
|---|---|---|
| GT Eesti not loaded | `getComputedStyle(document.body).fontFamily` in DevTools on any surface | C1 |
| `--kramer-bg` undefined | `grep -n "\-\-kramer-bg" styles/kramer-brand.css` returns 0 | C7 root cause |
| `--kramer-bg` typo callers | `grep -rn "\-\-kramer-bg" app/` returns 6 hits | C7 scope |
| KramerLogo missing | `grep -rn "KramerLogo" .` returns only CSS comment | C2 |
| Per-page title missing | `grep -n "export const metadata" app/**/page.tsx` returns no `title:` overrides | C4 |
| Branded 404 single | `find app -name not-found.tsx` returns only `app/entries/[id]/not-found.tsx` | C5 |
| Admin ingest not gated | `head -1 app/admin/ingest/page.tsx` shows `"use client"` | C6 |
| Viewport missing | `grep -n "viewport" app/layout.tsx` returns no hits | C14 |
| Aria-live missing | `grep -rn "aria-live\|role=.status." app/` returns 0 | C16 |
| Focus-visible scarce | `grep -n ":focus\|focus-visible" styles/kramer-brand.css` returns 2 | C9 |
| Error boundary missing | `find app -maxdepth 3 -name "error.tsx"` returns 0 | §5 error-boundary gap |
| Media queries missing | `grep -n "@media" styles/kramer-brand.css` returns 0 | C10 |

---

## §7 Changelog — revisions after code-review pass (same day, 2026-06-02)

Original audit went through independent reviewer per `feedback_unbiased_review_after_step_7`. 17 findings (2 BLOCKING, 6 MAJOR, 5 MINOR, 4 NITS, 3 PRAISE); all classified `Agree + fix`, no disagreements. Material changes from the original draft:

- **C7 rewritten** — original mis-attributed root cause to "neutral-bg + neutral-text coincidence." Real cause: undefined CSS variable `--kramer-bg` in 6 files. Verified by `Grep --kramer-bg` (6 hits in `app/`, 0 in `kramer-brand.css`). The Mechanical-floor-surface-enumeration sub-rule should have fired pre-Step-7b — when identifying a one-surface bug, grep the literal across the repo.
- **C6 reframed** — original said "two competing defense philosophies." Reality: 6 pages gate, 2 don't (`"use client"` with no page-level auth). Iron-rule #6 explicitly clarified intact server-side (writes gated by `withAdmin`).
- **C9 tier-upped MAJOR → BLOCKING** — WCAG 2.4.7 Focus Visible is Level AA; keyboard-only users cannot operate the product.
- **C13 tier-upped MINOR → BLOCKING** — iron-rule #7 (source pointer is provenance) — making it editable risks audit-trail integrity.
- **3 new findings added** — C14 (no `viewport` metadata export), C15 (inline buttons bypass `.btn` primitive — structural parent of C7), C16 (no `aria-live` on SSE streaming).
- **C3 reworded** — "no GLOBAL nav chrome" (per-page breadcrumbs DO exist on 4 admin surfaces; corrected the negative-assertion claim).
- **C12 reworded** — `dir="auto"` is the actual implementation, not `dir="rtl"`. Verified at `app/admin/entries/page.tsx:392`.
- **§2 re-sequenced** — C7 + C15 paired; new "C10 + C14 viewport pairing"; new "C16 aria-live" entry.
- **§4 gained option D** — split into cross-cutting + per-surface docs.
- **§5 expanded** — added hydration mismatches, error boundary, robots/sitemap, security headers, `/healthz` UX.
- **§6 added** — verification probes table (reproducible single-line commands per finding).
- **Reproducibility recipe** — added prereqs line, dry-run trap note, ModHeader "Request headers" category specification + URL filter regex caveat.

Skipped (none — all reviewer findings applied).
