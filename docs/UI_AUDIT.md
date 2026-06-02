# UI_AUDIT.md — UI/UX audit pass before M5

**Date:** 2026-06-02
**Stage:** development (pre-M5, [ADR-0011](adr/0011-repo-visibility.md) public window, synthetic-fixture corpus only)
**Audit scope:** all 11 user-facing surfaces shipped through M4, audited against [`styles/kramer-brand.css`](../styles/kramer-brand.css) tokens + iron rules.
**Audit shape (per `SESSION_PROTOCOL.md` Step 7 Sub-option scope-split decision):** Leg 1 = this doc (research-archetype, no production code). Leg 2 = per-slice polish PRs in follow-up Build sessions, sequenced by priority below.
**Roles tested:** anonymous (no `x-stub-user-role` header) on all 11 surfaces; `admin` (ModHeader-injected `x-stub-user-role: admin`) on 5 admin-rendered surfaces. `user` role not separately tested — `sensitivityAllowedForRole('user') = ['public','internal']` and all 28 seed entries are `internal`, so user-role visible content is identical to admin modulo write controls; the only visual differentiator would be a `restricted`-tier pill, which the synthetic seed doesn't produce. Production-stage transition should include a user-role pass against a seed containing all three tiers.

**Reproducibility recipe:**
```powershell
# 1. Boot stack
cd "C:\Users\galzi\OneDrive - Afiki-C\Development\Claude\PriorityKB"
docker compose up -d
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5432/priority_kb"
npx tsx scripts/seed-synthetic-entries.ts --apply   # if DB empty
npm run dev

# 2. In Chrome, install ModHeader. Add a profile sending
#    x-stub-user-role: admin scoped to https?://localhost:3000/.*
#    Disable the profile to test the anonymous path.

# 3. Visit each route in §Per-surface findings below.
```

**Rubric (6 axes per surface):**
1. **Brand** — palette tokens, GT Eesti via `getComputedStyle().fontFamily`, logo placement, link colors.
2. **Iron-rule #6 sensitivity** — server-side enforcement + visual `.sensitivity-pill` rendering wherever an entry appears.
3. **Hierarchy** — surface uses `--fs-title` (24px) / `--fs-subhead` (18px) / `--fs-body` (12px) tokens, not arbitrary sizes.
4. **Interaction states** — loading, error, empty, hover, focus-ring, anonymous-401 path.
5. **a11y / contrast / keyboard** — WCAG AA contrast per token-pair, tab order, keyboard-only nav.
6. **i18n/RTL + responsive** — Hebrew RTL rendering, mixed bidi, viewport breakpoints.

---

## §1 Cross-cutting findings table

Findings that span 2+ surfaces. Fix once, win everywhere. Sequence Leg-2 polish so cross-cutting lands BEFORE per-surface PRs (per `SESSION_PROTOCOL.md` Step 7 M6 finding — "freeze clause: no new components in per-surface PRs without re-running cross-cutting audit").

| ID | Severity | Finding | Surfaces affected | Source citation |
|---|---|---|---|---|
| **C1** | BLOCKING | **GT Eesti is silently not loading.** `body.fontFamily` computes to `"GT Eesti Display Lt", "GT Eesti Display", sans-serif` on every surface, but the `@font-face` blocks in `kramer-brand.css` are **commented out** and `public/fonts/` does not exist. Every render falls through to system sans (Segoe UI on Win11). The product has never actually rendered in its brand typography. | All 11 | `styles/kramer-brand.css:407-421` (commented) + `Glob public/fonts/**` empty |
| **C2** | MAJOR | **`KramerLogo` component doesn't exist.** The brand CSS at `kramer-brand.css:11` references `<KramerLogo />` as an M1 deliverable, but no such component exists in the codebase (`Grep KramerLogo` matches only the CSS comment itself, no `.tsx` file). The product has no logo anywhere — landing page, admin chrome, anywhere. | / (especially), entire admin section | `Grep KramerLogo` → only `styles/kramer-brand.css:11` |
| **C3** | MAJOR | **No global navigation chrome.** No header, no sidebar, no breadcrumbs from outside an entry context, no role indicator anywhere. Users (admin or otherwise) cannot tell at a glance which page they are on, who they are signed in as, or how to get home from `/query` without using browser back. The page title is hardcoded `"Priority Knowledge Base"` on every surface — `document.title` does not reflect the current view. | All 11 | Cross-surface `document.title` probe; no `<nav>` / `<header>` element on any surface |
| **C4** | MAJOR | **No `<title>` per surface.** Every page's `<title>` is the global `"Priority Knowledge Base"` from `app/layout.tsx:5-7`. Browser tabs, bookmarks, and history are all indistinguishable. | All 11 | `app/layout.tsx` `metadata.title = brand.name`; no per-page `export const metadata` overrides |
| **C5** | MAJOR | **Unbranded Next.js default 404** on 6 of 8 admin routes. `/admin/entries`, `/admin/entries/[id]/edit`, `/admin/entries/[id]/history`, `/admin/entries/[id]/history/[ver]`, `/admin/stale-entries`, `/admin/tags` all return the default `404 — This page could not be found.` chrome (white text, gray subtitle, no Kramer brand, no nav home). Only `/entries/[id]` has a branded `app/entries/[id]/not-found.tsx`. Inconsistent. | 6 admin surfaces | `Glob app/admin/**/not-found.tsx` — none exist |
| **C6** | MAJOR | **Inconsistent anonymous-access defense pattern.** Two ingest routes (`/admin/ingest`, `/admin/ingest/direct`) fully render their admin UI to anonymous visitors (API call gates the write); 6 other admin routes use existence-leak defense (`notFound()` for non-admins). Two different "anon hits admin page" patterns in the same admin section. Pick one — recommend existence-leak everywhere for iron-rule-#6 minimum-disclosure. | `/admin/ingest`, `/admin/ingest/direct` vs other 6 admin routes | Per-surface anon probes in §3 |
| **C7** | BLOCKING | **Neutral-bg + neutral-text invisible affordances.** At least two visible: (i) "Save changes" submit button on `/admin/entries/[id]/edit` renders as a blank ~80×30px rectangle (`bg: rgb(220,221,222)` = `--kramer-neutral`, text in the same color → invisible); (ii) Small pill next to `v1` row on `/admin/entries/[id]/history` shows the same blank rectangle pattern. The primary action of the editor is invisible. | edit, history list | `getComputedStyle(button).backgroundColor` returned `rgb(220, 221, 222)` matching `--kramer-neutral` |
| **C8** | MAJOR | **WCAG contrast not verified for the brand palette.** Purple `#8200b4` on dark `#121212` (CTA-default button surface), mint `#68ffc3` on dark (links, CTA), pink `#be0078` on dark (alerts) — no contrast ratios computed against AA 4.5:1 anywhere. Purple-on-dark is the most-likely failure (deep purple is dark; the contrast is low against very dark background). The base palette needs a one-time WCAG pass with concrete ratios per token-pair documented. | All 11 (every Kramer-colored element) | No `.a11y-contrast.md` exists; no audit script |
| **C9** | MAJOR | **No focus-ring or focus-visible test surface.** Tabbing through `/admin/entries`, `/admin/entries/[id]/edit`, or `/query` was not exercised live (out of scope of this audit's tooling); CSS scan finds focus styles only on `.chat-input:focus` (`kramer-brand.css:237-240`) and `.filter-chip-remove:focus-visible` (`:352-356`). The other 90% of interactive surfaces — every `button`, every `<a>`, every form input on `/admin/ingest/direct`, the search bar on `/admin/entries` — has no defined focus state and relies on browser defaults. WCAG 2.4.7 (Focus Visible). | All interactive surfaces | `Grep ":focus|focus-visible" styles/kramer-brand.css` — 2 matches only |
| **C10** | MAJOR | **Horizontal viewport space underused.** Every surface anchors content in the left/center ~60% of the viewport at 1920px. Right ~40% is empty black. No responsive breakpoints declared anywhere except `.chat-shell { max-width: 48rem }`. The product looks half-empty on common Israeli office monitors (1920×1080 standard). | All 11 (visible on all screenshots) | No `@media` queries in `kramer-brand.css` |
| **C11** | MINOR | **All 28 seed entries are `internal` sensitivity.** The synthetic seed script doesn't produce `public` or `restricted` entries; visual sensitivity-pill differentiation between the three tiers cannot be tested with the current corpus. Pill rendering verified live for `internal` only. | `/admin/entries`, `/entries/[id]`, `/query` citations | `Bash psql … entries` returned 28 rows, all `internal` |
| **C12** | MINOR | **`html lang="en"` hardcoded.** RTL is applied per-element via inline `dir="rtl"`; works correctly on `/admin/entries` for Hebrew titles, but `html.dir` is never `"rtl"`. For a Hebrew-primary user, no top-level RTL signal. | All 11 (Hebrew-rendering ones especially) | `app/layout.tsx:16` |
| **C13** | MINOR | **Source pointer editable on `/admin/entries/[id]/edit`.** The `source_pointer` field is the audit-trail provenance key; making it user-editable risks integrity loss (an admin could rewrite "synthetic-fixture-…" to look like a real ticket). Either lock it as read-only after creation, or require a typed reason field on change. | edit | Form input observed; iron-rule #2/3 conformance |

---

## §2 Severity-tagged polish backlog (Leg 2 candidates)

Sequenced for follow-up Build sessions. Cross-cutting first (per C1-C10 freeze rule), per-surface after.

### BLOCKING — ship before any other M5 work
1. **C1 — Bundle GT Eesti `.woff2` or pivot to a free brand-compatible alt.** The product is meant to be GT Eesti per the Kramer brand skill but never has been. Two paths: (a) license + bundle the `.woff2` files under `public/fonts/` and uncomment the `@font-face` blocks; (b) pick a free near-equivalent (Inter, IBM Plex Sans) and update `--font-body` / `--font-heading`. Either way, 1 PR pair, includes deletion of the GT Eesti family entry from the CSS if path (b).
2. **C7 — Fix invisible buttons.** Find every `bg: var(--kramer-neutral)` button (or button with implicit neutral bg) and either change to purple default OR set text color to dark. Audit `getComputedStyle(b).color === getComputedStyle(b).backgroundColor` programmatically. 1 PR pair; touches `EditForm.tsx` and history list component.

### MAJOR — Leg 2 cross-cutting (lands before any per-surface polish)
3. **C2 + C3 — Ship `KramerLogo` + minimal global nav chrome.** Build the base64-PNG `<KramerLogo />` component referenced in brand CSS; add a thin top-bar (logo left, role indicator right) wrapped around all `app/**/page.tsx` via a shared layout. 1 PR pair, ~200 lines.
4. **C4 — Per-page `<title>` via Next.js metadata.** Add `export const metadata = { title: "Edit entry · Priority KB" }` (etc) to each page. 1 PR pair, 11 small edits.
5. **C5 — Branded `not-found.tsx` for `/admin`.** Add `app/admin/not-found.tsx` mirroring `app/entries/[id]/not-found.tsx` (Kramer chrome, mint "← Back to entries" link). 1 PR pair.
6. **C6 — Unify anon-access pattern.** Pick existence-leak (recommended: minimum disclosure for iron-rule #6) and apply to `/admin/ingest` + `/admin/ingest/direct` via a wrapping check. 1 PR pair, ~50 lines of server-component header check.
7. **C8 — WCAG AA contrast pass + tokens revision.** Compute concrete ratios for every palette pair; if any < 4.5:1, propose a tonal adjustment that preserves brand identity (e.g., a brighter `--kramer-purple-strong` for accent-on-dark). Document in a new `docs/A11Y.md`. May produce ADR-0026. 1 research-shaped PR pair.
8. **C9 — Global `:focus-visible` outline.** Add `*:focus-visible { outline: 2px solid var(--kramer-mint); outline-offset: 2px }` to `kramer-brand.css`. Sweep for any element that overrides it. 1 PR pair, ~20 lines.
9. **C10 — Responsive breakpoints + sensible max-widths.** Define `--container-max: 64rem` (or per-surface), apply to all `app/**/page.tsx` wrappers. Add `@media (max-width: 768px)` rules for stacking. 1 PR pair.

### MAJOR per-surface (after cross-cutting lands)
10. **S7 polish** — `/admin/entries/[id]/edit`: add sensitivity-tier visual indicator next to the SELECT, sensitivity-change warning before save, source-pointer read-only or reason-gated (C13).
11. **S2 polish** — `/query`: empty-state copy with example queries; `Clear` button should disable when textarea is empty; auth-required hint for anonymous (C6 collapses anon to 404 — coordinate).
12. **S10 polish** — `/admin/stale-entries`: rewrite subtitle to drop internal milestone refs ("M4 #3 revert…") and use end-admin language.
13. **S11 polish** — `/admin/tags`: scroll-position-aware section nav (catalog + merge + suggest), reduce DOM weight (44 inputs collapsed via accordion or single-rename-row composition).

### MINOR
14. **C11** — Extend `seed-synthetic-entries.ts` to include `public` + `restricted` tier entries for visual pill differentiation.
15. **C12** — Conditional `html.dir = "rtl"` when first-strong-direction Hebrew detected (or per-user preference).
16. **S1 polish** — `/` landing: vertical-center is fine but could surface "what is this" copy + role-based CTAs (`Ask a question` for users, `Log a new entry` for admins).

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
| Iron-rule #6 | ⚠️ **C6** — page renders to anonymous, affordance leaks; API gates submit. Recommend collapse-to-not-found for non-authenticated. |
| Hierarchy | ✅ h1 24px. ⚠️ Form sits at top-center; entire lower viewport empty (C10). |
| Interaction | ✅ `Ask` button disabled when textarea empty (good). 🚨 `Clear` button stays enabled when textarea empty — should disable. 🚨 No empty-state copy explaining what to ask or that you need to be signed in. |
| a11y | C9 focus-ring. C8 contrast on Ask-purple-on-dark. |
| i18n/RTL | Not tested in empty state — would surface in response citations. |

---

### S3 — `/admin/ingest` (anonymous; **fully renders admin chat UI**)
**Probes:** h1 "Ingestion Agent"; subtitle "Admin-only chat for logging Priority knowledge entries."; chat textarea + Send button (mint CTA); empty chat region.

| Axis | Finding |
|---|---|
| Brand | ✅ Send button is mint (`.btn.cta`). |
| Iron-rule #6 | 🚨 **C6** — full admin UI exposed to anonymous user. The subtitle explicitly labels the page "Admin-only" but the page renders regardless. UI lies. |
| Hierarchy | ✅ tokens correct. |
| Interaction | Anonymous user can compose messages freely until they hit Send → API 401. No upfront indicator. |
| a11y | Empty chat region uses subtle dim background; need contrast verification (C8). |
| i18n/RTL | Untested. |

---

### S4 — `/admin/ingest/direct` (anonymous; **fully renders 7-input form**)
**Probes:** h1 "Direct Ingest"; subtitle "Submit an entry without the conversational agent."; 7 inputs (Title, Category, Tags, Source pointer, Last verified, Sensitivity SELECT [public/internal/restricted], Body); Submit button mint CTA; Back to chat purple.

| Axis | Finding |
|---|---|
| Brand | ✅ Submit mint, Back-to-chat purple. |
| Iron-rule #6 | 🚨 **C6** — same as S3. Sensitivity SELECT exposes the full three-tier enum to anonymous visitors. ⚠️ **C13** — source pointer is freely editable. |
| Hierarchy | ✅ tokens correct. Last-verified pre-filled with current ISO — good UX. |
| Interaction | Native browser date picker renders `2026-06-01T18:55:09.822Z`-style; styling diverges from other inputs. |
| a11y | C8/C9. |
| i18n/RTL | Untested. |

---

### S5 — `/admin/entries` (anonymous: 404 unbranded; admin: full list)
**Anon probes:** title "404: This page could not be found."; `h1` is the "404"; `bodyText.length = 33`.
**Admin probes (live):** h1 "Entries"; subtitle "Admin browser — read-only. 25 rows on this page."; mint "View stale entries →" cross-link; 25 entry cards each with title h2 + sensitivity-pill (`data-tier="internal"` purple) + "category: <name>" + tag chips (`.filter-chip` mint border) + "+N more" overflow + "verified YYYY-MM-DD · updated YYYY-MM-DD" + mint "Edit" link.

| Axis | Finding |
|---|---|
| Brand | ✅ palette correct live. ✅ filter-chip primitive renders. ✅ sensitivity-pill primitive renders (purple internal tier). |
| Iron-rule #6 | ✅ existence-leak 404 for non-admin (matches `lib/entries.ts` `findEntryForRole` defense). 🚨 **C5** — 404 is unbranded. |
| Hierarchy | ✅ h1 24px; cards use h2/h3 for entry titles. |
| Interaction | 🚨 Empty/unstyled button to right of search input — needs investigation, likely a placeholder. 🚨 Filter facets (M4 #1b) not visible in default view — verify whether they only appear when a filter is applied. |
| a11y | C8/C9. Search form has a visible label. ✅ `.sr-only` primitive in use elsewhere. |
| i18n/RTL | ✅ Hebrew titles like "מתי כדאי להשתמש ב-BPM לעומת טריגר פרוצדורלי בפריוריטי" render right-to-left within the h2. ✅ Mixed bidi (Latin BPM inside Hebrew sentence) handled correctly. |

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
**Admin probes (live):** breadcrumb "← Back to entries · Edit history" (both mint); h1 "Edit entry" 24px; subtitle "Current version: v1 — this edit becomes v2."; 7 inputs (Title, Category, Tags, Body, Source pointer, Last verified date-picker `27/05/2026` DD/MM/YYYY locale, Sensitivity SELECT defaulting to current value); tag preview chips under tags input ("4 tags: customers · import · excel · duplicates"); buttons: **Save changes** (`bg: rgb(220,221,222)` = neutral, invisible — C7), Cancel (purple).

| Axis | Finding |
|---|---|
| Brand | ✅ Cancel purple. 🚨 **C7** — Save invisible. |
| Iron-rule #6 | 🚨 **C13** — source pointer editable. Sensitivity SELECT works but no visual confirmation pill. |
| Hierarchy | ✅ h1 24px; field labels at body size. |
| Interaction | 🚨 No "sensitivity tier will change" warning on SELECT change. Native date picker styling inconsistent with other inputs. |
| a11y | 🚨 Save button color = bg color = invisible. C8/C9. |
| i18n/RTL | Tested on English entry. Hebrew entry edit not separately tested but field layout is LTR; Hebrew body content would flow RTL inside its textarea by default browser bidi handling. |

---

### S8 — `/admin/entries/[id]/history` (anonymous 404; admin renders list)
**Admin probes (live):** breadcrumb "← Back to entries · Edit current" (both mint); h1 "Version history"; subtitle: entry title "Fixing duplicate customer codes during Excel import"; secondary subtitle "Only the current version exists — no prior versions to compare or revert to." (good empty-state copy for single-version entries); 1 list row showing `v1` + small light pill (invisible — same C7 pattern) + timestamp `2026-06-01 18:57:24 UTC`.

| Axis | Finding |
|---|---|
| Brand | 🚨 **C7** — the small pill next to `v1` renders blank (neutral-bg, presumably "current"-label text in neutral too). |
| Iron-rule #6 | ✅ existence-leak for non-admin. |
| Hierarchy | ✅ tokens correct. |
| Interaction | Single-version empty state is informative. Need multi-version test (re-seed with edits) to audit diff list + revert button styling — out of scope for this pass. |
| a11y | C7/C9. |
| i18n/RTL | Untested (English entry). |

---

### S9 — `/admin/entries/[id]/history/[ver]` (anonymous 404; admin renders diff)
**Admin probes:** not separately exercised on a multi-version entry (synthetic seed creates v1 only); this surface only renders meaningfully once an entry has been edited at least once. **Reproducibility gap** — to audit, edit any entry once (creating v2), then visit `/admin/entries/<id>/history/1` to see the diff between v1 and current.

Recommended follow-up: extend the seed script to perform one edit on at least one entry so this surface is populated by default.

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
**Admin probes (live):** breadcrumb "← Back to entries"; h1 "Tag management"; subtitle: warning about per-rename Voyage embed cost ("Rename or delete tags across the corpus. Each operation loops the existing updateEntry pipeline per affected entry (lock, append version, re-chunk, re-embed, audit) — so a rename triggers N synchronous Voyage embed calls. Validate the target name carefully; renames are reversible only by another rename."); section "Catalog (40)" with 40+ tag rows visible (each: tag name left, `N entries` right); **44 form inputs on the page total**; merge form (PR-B yesterday) not visible in viewport — needs scroll to confirm rendering.

| Axis | Finding |
|---|---|
| Brand | ✅ palette correct. |
| Iron-rule #6 | ✅ existence-leak. ⚠️ Tag catalog visible to admins shows tag names of all entries regardless of sensitivity — verify that a `restricted`-tagged entry's unique tag wouldn't leak via the catalog count to a non-admin (currently moot since `/admin/tags` is admin-only, but worth a note for if user role ever gets read access to tag catalog). |
| Hierarchy | ✅ h1; section heading "Catalog (40)" as h2/h3. |
| Interaction | 🚨 44 inputs is heavy DOM; consider an accordion or single shared rename composer. Subtitle warning is accurate but intimidating — surface a "what happens when I rename" expandable tooltip rather than wall-of-text. Scroll-position-aware nav for catalog/merge/suggest sections would help. |
| a11y | 40 input rows = 40 tab stops; tab order needs verification. C9. |
| i18n/RTL | Mixed Hebrew + English tags ("hebrew" "customization" "אzh-vendor" etc.) — verify RTL rendering for any Hebrew-named tag in the catalog. |

---

## §4 Decision required at Leg 1 close (per Deferred-decision-audit sub-rule)

Three pre-enumerated alternatives for how the findings land in project state. Pick one:

| Option | Shape | When to pick |
|---|---|---|
| **A** | Keep as standalone `docs/UI_AUDIT.md` (this doc) + drop individual polish slices into `docs/BACKLOG.md` for the user to pluck between M5 items. | If M5 is the priority and UI polish is opportunistic. |
| **B** | This doc + new `M4.5 — UI polish` milestone block in `docs/ROADMAP.md` with the §2 backlog as its checklist, gating M5 on its acceptance. | If the audit findings should block M5. Recommended given the BLOCKING-class C1 (font never loaded) and C7 (invisible button). |
| **C** | This doc + ADR-0026 "Design-system tokens + brand-loading strategy" that decides the GT Eesti question, focus-ring tokens, contrast tokens. The cross-cutting fixes become an ADR-anchored phase; per-surface polish stays BACKLOG. | If the cross-cutting fixes need locked design decisions (most do — C1 font choice, C8 contrast tokens, C9 focus-ring color). |

Recommend **B + C**: a new milestone block AND a supporting ADR-0026 for the design-token decisions. The two are non-conflicting and reinforce each other.

---

## §5 What this audit did NOT cover (known gaps)

- **User-role (`x-stub-user-role: user`) sweep** — skipped because all 28 seed entries are `internal` and `sensitivityAllowedForRole('user') = ['public','internal']`, so user view ≡ admin view modulo write controls in current corpus. Re-run after C11 seed diversification.
- **Multi-version history view (S9)** — synthetic seed produces v1-only entries; the diff renderer at `/admin/entries/[id]/history/[ver]` is unreachable. Re-run after extending seed to include at least one edited entry.
- **Live tab-order / keyboard-only navigation** — manual interaction would need user-side; documented as C9 source-only finding.
- **Mobile / tablet rendering** — viewport tested at 1920×744-ish only (the Chrome MCP probe's default). Mobile breakpoints don't exist (C10) so the question is "what should they be" not "do they work".
- **Performance (CLS, LCP, font-load FOUT)** — not measured. Worth a Lighthouse pass once C1 lands.
- **Sensitivity-pill visual differentiation (all 3 tiers side-by-side)** — only `internal` visible in seed (C11).
