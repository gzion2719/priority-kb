# ADR-0026 — Design-system tokens + brand-loading strategy

- **Date:** 2026-06-02
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent plan-reviewer subagent)

## Context

The UI/UX audit at [`docs/UI_AUDIT.md`](../UI_AUDIT.md) (once PR #406 lands, otherwise on `chore/ui-audit-2026-06-02`) surfaced three in-scope BLOCKING findings whose fixes hit the same surface (`styles/kramer-brand.css`) plus two MAJOR cross-cutting findings on the same coupled set of decisions: typography, focus-visible compliance, contrast tokens, button primitive extraction, and a 6-file `--kramer-bg` CSS-variable typo. Shipping these as independent polish PRs without a locked design decision would let each PR re-decide the same questions inconsistently (token names, font choice, focus-ring color, button API shape).

This ADR locks the five decisions. Implementation lands in follow-up PRs that constitute the M4.5 milestone block (per the audit's §4 B+C choice).

### What the audit caught that this ADR responds to

- **C1 BLOCKING** — GT Eesti has never actually loaded. `@font-face` blocks in `styles/kramer-brand.css:400-421` are commented out and `public/fonts/` does not exist. Every render falls through to system sans. The product has never rendered in its declared brand typography since M1.
- **C7 BLOCKING** — Six admin client-component buttons use `color: var(--kramer-bg)` inline. `--kramer-bg` is not defined anywhere in `styles/kramer-brand.css` (the real var is `--kramer-dark`); undefined CSS vars fall back to `inherit` → `--kramer-neutral` → invisible buttons. Affected files: `app/admin/entries/[id]/edit/EditForm.tsx:367`, `app/admin/entries/[id]/history/page.tsx:115`, `app/admin/entries/[id]/history/[versionNo]/RevertForm.tsx:140`, `app/admin/entries/page.tsx:286`, `app/admin/tags/RenameForm.tsx:153`, `app/admin/tags/MergeForm.tsx:232`.
- **C9 BLOCKING** — `:focus-visible` outline missing on 90% of interactive surfaces (only `.chat-input:focus` and `.filter-chip-remove:focus-visible` declare focus styles); WCAG 2.4.7 Level AA regression.
- **C8 / C15 MAJOR** (cross-cutting) — WCAG AA contrast not verified for the palette; client-component admin forms bypass the brand `.btn` primitive via inline styles.

C13 (source-pointer editable, iron-rule #7) is also BLOCKING in the audit but is a domain-logic decision about the edit form, not a design-token decision; it is out of scope for ADR-0026 (see "Out of scope" at bottom).

### `--kramer-*` reference surface (world-fact at ADR-0026 commit time)

Three distinct `--kramer-*` identifiers appear in `app/`: `--kramer-bg` (undefined → the C7 bug), `--kramer-mint` (defined), `--kramer-neutral` (defined). The kramer-brand.css `:root` block defines five tokens: `--kramer-dark`, `--kramer-mint`, `--kramer-neutral`, `--kramer-pink`, `--kramer-purple`. `--kramer-bg` is the only undefined-var typo at commit time; Decision 5's lint floor catches future regressions; today's scope is the surgical 6-file rename.

*(The grep commands that produced these counts live in the PR body, not the ADR, per the Context-section discipline sub-rule in `docs/adr/README.md`.)*

### Brand-skill divergence

The Kramer brand skill (`anthropic-skills:kramer-brand`, referenced in `styles/kramer-brand.css:4` and ADR-0001 §"Brand standards") ships GT Eesti as canonical. Pivoting this project to IBM Plex Sans (Decision 1 below) creates a drift between (a) this deployed product, (b) the upstream skill any new Claude-bootstrapped project inherits, and (c) ADR-0001's stated brand standards section. This ADR accepts that drift for the PriorityKB project; updating the upstream skill is out of scope for this repo's authority. See Consequences below.

## Decision

### 1. Typography — pivot from GT Eesti to IBM Plex Sans (free, self-hosted)

**Font family:** IBM Plex Sans + IBM Plex Sans Hebrew, self-hosted via `public/fonts/`.

**License:** SIL Open Font License 1.1 ([IBM/plex `LICENSE.txt`](https://github.com/IBM/plex/blob/master/LICENSE.txt)). Verified empirically pre-plan-lock (Platform-capability-empirical-check sub-rule).

**Weights shipped:** Light (300) for body; Medium (500) for headings. Both weights exist for the Hebrew variant per the IBM Plex 8-weight family (Thin / ExtraLight / Light / Regular / Text / Medium / SemiBold / Bold).

**Files to bundle under `public/fonts/`:**

```
public/fonts/
├── IBMPlexSans-Light.woff2
├── IBMPlexSans-Medium.woff2
├── IBMPlexSansHebrew-Light.woff2
└── IBMPlexSansHebrew-Medium.woff2
```

Exact file names + release version pinned at M4.5/D impl time against the [IBM/plex GitHub releases](https://github.com/IBM/plex/releases) (the v6+ releases moved to per-script package layout; file names verified against the chosen release tag at bundle time).

**Loading strategy:** `font-display: swap` — render with fallback immediately; swap to Plex when loaded. No FOIT (no flash of invisible text), no LCP regression. Brief FOUT (flash of unstyled text) is acceptable for an internal-use KB.

**Fallback stack:**

```css
--font-body:    "IBM Plex Sans", "IBM Plex Sans Hebrew", system-ui, "Segoe UI", "Helvetica Neue", sans-serif;
--font-heading: "IBM Plex Sans", "IBM Plex Sans Hebrew", system-ui, "Segoe UI", "Helvetica Neue", sans-serif;
```

Hebrew variant follows the Latin name in the stack — browsers walk the stack per glyph, so Latin glyphs match `"IBM Plex Sans"` and Hebrew glyphs cascade to `"IBM Plex Sans Hebrew"`. The `system-ui` / `"Segoe UI"` intermediates cover the FOUT window and the worst-case "woff2 failed to load" scenario.

**Brand-standards override.** This decision overrides:
- **ADR-0001 §"Brand standards"** ("GT Eesti typography"). Override mechanism: M4.5/D adds an in-place `## Amendment 2026-06-02 — Typography pivot per ADR-0026` section to `docs/adr/0001-bootstrap.md` (matching the dominant amend-in-place pattern set by ADR-0005, ADR-0010, ADR-0011 — verified against the ADR index). ADR-0007 is the lone "new ADR supersedes older spec" precedent, and that pattern is reserved for CLAUDE.md / non-negotiable changes per its own framing; ADR-0001 is amended in place.
- **CLAUDE.md non-negotiable #13** ("typography (GT Eesti)"). M4.5/D edits the iron-rule's literal text in the same PR — drops "(GT Eesti)", inserts "(IBM Plex Sans)", adds a back-pointer to this ADR. This matches the ADR-0007 precedent for CLAUDE.md changes (a new ADR plus an explicit edit to the rule it supersedes).

Rationale for override: cost (SIL OFL = $0 vs ~$500-1200/year per-style GT Eesti license for an internal-use KB), empirically-verified Hebrew weight availability (Plex Hebrew ships Light + Medium per IBM/plex GitHub releases — the v6+ releases at https://github.com/IBM/plex/releases ; impl-PR pins the exact release version), and the fact that the product has rendered in system-sans fallback since M1 — pivoting to IBM Plex IS the brand uplift, not a regression.

### 2. Focus-ring tokens + global `:focus-visible` rule

**New CSS custom properties:**

```css
:root {
  --focus-ring-color: var(--kramer-mint);
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
}
```

**Global rule (zero-specificity via `:where()` so surface-specific carve-outs win):**

```css
:where(*):focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
}
```

`:where(*)` has zero specificity, so the existing carve-outs continue to win without per-surface rewriting:

- **`.chat-input:focus` at `kramer-brand.css:237-240`** — specificity (0,1,1). Beats the global (0,1,0) for keyboard focus on the chat input; the carve-out's 1px mint outline + offset-0 renders. Mouse-clicks on `.chat-input` fire `:focus` but NOT `:focus-visible`, so only the carve-out applies. Composition correct.
- **`.filter-chip-remove:focus-visible` at `:352-356`** — specificity (0,1,1). This carve-out sets `opacity: 1; background: rgba(255,255,255,0.06);` but **does NOT set `outline`**, so the global rule's outline composes ON TOP of the carve-out's opacity/background changes. This is the intended behavior — the filter-chip remove `×` gets the standard mint focus ring AND its hover-like visual treatment. If the design intent is no outline on the remove button, M4.5/C adds an explicit `outline: none;` line to the carve-out.

Closes C9 (WCAG 2.4.7 Level AA — Focus Visible).

### 3. WCAG AA contrast — process locked, numbers empirical

**Threshold pinned:** WCAG 2.1 §1.4.3 Level AA — **4.5:1** for normal text, **3:1** for large text (≥18pt or ≥14pt bold).

**Process locked here; numbers computed at impl time:**

1. Compute contrast ratios for every meaningful token pair: `neutral-on-dark`, `mint-on-dark`, `purple-on-dark`, `pink-on-dark`, `dark-on-mint` (mint CTA-button text), `neutral-on-purple` (default-button text), `neutral-on-pink` (alert-button text).
2. Document concrete ratios in a new `docs/A11Y.md`.
3. For any pair that fails 4.5:1 (or 3:1 for large), pick one remediation from the alternatives below.

**Alternatives enumerated up-front (per Deferred-decision-audit sub-rule):**

| Remediation | When to pick |
|---|---|
| **(a)** Add a brighter `-strong` variant token (e.g., `--kramer-purple-strong: #a330d4`) and use it everywhere the failing pair appears | If the underlying color identity is load-bearing for the brand (purple = primary action; can't drop it) |
| **(b)** Switch to an outline-button pattern for failing button surfaces (text in the brand color, transparent bg + 1px border) | If the failing pair is a button background + text combo and outline maintains hierarchy |
| **(c)** Invert: dark text on mint/purple/pink background instead of light text on the brand color | If the brand color is bright enough to pass with dark text (mint passes easily; purple/pink probably fail) |

ADR-0026 does not pre-decide which colors will need `-strong` variants — that's an empirical outcome of the impl-PR's ratio computation. The above table is the closed enumeration of fixes available; impl-PR picks per failing pair without re-deciding.

#### Amendment 2026-06-10 — M4.5/E empirical hex picks

The parenthetical example `--kramer-purple-strong: #a330d4` in row (a) above was illustrative; empirical computation during M4.5/E found it fails AA at 3.51:1 against `--kramer-dark`. The impl-PR's actual picks (in `styles/kramer-brand.css` and documented in `docs/A11Y.md`):

- `--kramer-purple-strong: #d378ff` — 7.05:1 vs dark (min 6.82:1 on composited purple-over-dark surfaces)
- `--kramer-pink-strong: #ff5fb0` — 6.70:1 vs dark (min 6.33:1 on composited pink-over-dark surfaces)
- `--kramer-neutral-strong: #f5f5f5` — 5.57:1 on `--kramer-pink` (for `.btn.alert` text fix)

A first round of picks used the minimum-delta candidates (`#c050ff`, `#e0399a`, `#ffffff`); plan-CR caught that the pink-strong candidate failed against the **actual rendered composited** backgrounds (4.43-4.49:1 across the 3 translucent pink surfaces) — not the solid `--kramer-dark` token used in the original 7-pair table. The composited-bg coverage is now baked into `styles/contrast.test.ts` as the mechanical floor.

Closes C8.

### 4. `<Button>` primitive React component

**File location:** `components/Button.tsx` at repo root (Next.js convention). No `components/` directory exists today; this ADR's impl-PR creates it.

**Server / Client boundary:** `components/Button.tsx` ships with `"use client"` directive at the top of the file. Every import of `<Button>` therefore lives in a client component boundary. This is acceptable because every Button consumer in the codebase IS interactive (has `onClick` or `type="submit"`). If a future server-rendered nav surface needs the button's visual identity without interactivity, a separate `<ButtonLink>` (server-safe, `<a>`-based) ships in a follow-up ADR — not in this scope.

**Type skeleton** (per ADR-with-new-types sub-rule):

```ts
"use client";

export type ButtonVariant = "primary" | "cta" | "secondary" | "danger";

// Consumer props: variant + the small set of HTML button attrs the consumer
// is allowed to pass through. className + style are intentionally OMITTED to
// enforce variant-as-only-styling-vector (closes C15 — no more inline CSS
// overrides that bypass the brand .btn primitive). ref is typed for React 19
// plain-`ref`-prop semantics — `RefObject<HTMLButtonElement | null>` matches
// what `useRef<HTMLButtonElement>(null)` returns. data-* attrs admitted via
// index signature for test selectors (data-testid etc).
export type ButtonProps = {
  variant?: ButtonVariant;                                  // default "primary"
  type?: "button" | "submit" | "reset";                     // default "button" (Safari historical: <button> outside <form> defaulted to submit; defensive default)
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  children: React.ReactNode;
  ref?: React.Ref<HTMLButtonElement | null>;
} & Pick<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  | "name" | "value" | "form"                                                   // form-association attrs
  | "formAction" | "formMethod" | "formNoValidate" | "formTarget" | "formEncType" // form-submit override attrs
  | "autoFocus" | "tabIndex"                                                    // a11y attrs
  | "aria-label" | "aria-labelledby" | "aria-describedby"                       // a11y labeling
  | "aria-pressed" | "aria-expanded" | "aria-controls"                          // a11y state
  | "title"                                                                     // tooltip
> & {
  // data-* index signature for test selectors (data-testid, data-*). Required
  // because data-* attrs aren't pickable from ButtonHTMLAttributes.
  [key: `data-${string}`]: string | number | undefined;
};

// Ambient declaration — implementation in components/Button.tsx (M4.5/B).
export declare function Button(props: ButtonProps): React.ReactElement;
```

**Variant → brand-CSS class mapping.** The component always renders `<button className="btn <modifier>">` — `.btn` is the base, variant adds a conditional modifier class:

| `variant` | Rendered `className` | Underlying CSS rule | Visual |
|---|---|---|---|
| `"primary"` (default) | `"btn"` | `button, .btn` at `kramer-brand.css:73-83` | Purple bg, neutral text |
| `"cta"` | `"btn cta"` | `button.cta, .btn.cta` at `:85-89` | Mint bg, dark text — primary calls to action (Save, Submit, Send) |
| `"secondary"` | `"btn secondary"` | **NEW** `.btn.secondary` (transparent bg + neutral border) shipped in M4.5/B | Used for Cancel / Back actions |
| `"danger"` | `"btn alert"` | `button.alert, .btn.alert` at `:91-93` | Pink bg, neutral text — used for Delete / destructive actions |

The existing brand CSS selectors are `button, .btn` (compound: element OR class); `<button className="btn">` matches both, so element-base styles + class-base styles compose correctly. `.btn.secondary` is the only new rule added in M4.5/B.

**Mechanical migration target** (impl-PR scope): 6 admin inline-styled buttons listed in C7 above. After migration, all use `<Button variant="...">` and the brand `.btn` primitive is the only path to a Kramer-branded button. Closes C15.

**Deliberate non-features:**
- No polymorphism (`as="a"`, `<Button asChild>`). `<Button>` is button-only. **`<ButtonLink>` follow-up trigger:** the first consumer that needs a link-styled-as-button — likely C2's KramerLogo nav surface, OR a future rejudging of the audit's 4 mint breadcrumb links (`← Back to entries · …`) as button-visual. Keeps the type narrow until a real need surfaces.
- No `loading` / `pending` state. Consumers handle their own disabled state via `disabled={isPending}`. Pending-state visual primitive is out of scope.

### 5. `--kramer-bg` retirement + lint floor

**Mechanical retirement.** Rename `var(--kramer-bg)` → `var(--kramer-dark)` in all 6 affected files (enumerated in Context above). Add a back-pointer comment in `kramer-brand.css` next to `--kramer-dark`:

```css
--kramer-dark: #121212;
/* Renamed from a typo `--kramer-bg` per ADR-0026 §5 — see lint floor at
 * styles/brand-tokens.test.ts. */
```

After retirement, `Grep var(--kramer-bg)` returns 0 across the repo.

**Lint floor** (mechanical, mirrors the `lib/embedding.test.ts:217-251` non-negotiable #8 source-file-scan precedent):

```ts
// styles/brand-tokens.test.ts — mechanical floor against undefined --kramer-* vars

function listDefinedTokens(cssGlobPatterns: readonly string[]): Set<string>;
function listUsedTokens(usageGlobPatterns: readonly string[]): readonly {
  token: string;
  file: string;
  line: number;
}[];
function assertUsedTokensAreDefined(
  used: ReturnType<typeof listUsedTokens>,
  defined: Set<string>,
): void;
// Guard test: assert that exactly one CSS file defines --kramer-* tokens
// (kramer-brand.css). Future-proofs against the split-CSS false-negative
// where defs silently disappear from one file while uses keep being scanned.
function assertSingleDefinitionSource(
  cssGlobPattern: string,
  expectedSourcePath: string,
): void;
```

**Scan scope (globs):**
- **Definitions:** `styles/**/*.css` (passed to `listDefinedTokens`). `assertSingleDefinitionSource("styles/**/*.css", "styles/kramer-brand.css")` enforces that kramer-brand.css is the only definition source today; if a future PR splits the file, the assertion fails and the split is gated until the lint floor is updated.
- **Uses:** `app/**/*.{ts,tsx}`, `components/**/*.{ts,tsx}` (once Decision 4's dir exists), `styles/**/*.css` (CSS-side typos are the more dangerous class — silent browser fallback exactly like C7).

**Regex policy:** scan literal `var(--kramer-IDENT)` and `var(--kramer-IDENT, fallback)`. Template-literal dynamic construction (`` `var(--kramer-${tier})` ``) is a known blind spot — documented in the test file's header. The blind spot is acceptable because no current code uses template-literal `--kramer-*` construction; if a future PR adds one, the regression surfaces during code review of that PR, not at lint time. CSS-side `--kramer-X:` *definitions* are not flagged as uses (regex matches only `var(...)` syntax, which appears in CSS uses only).

**Positive-control test** (proves the scan actually catches the failure mode it claims to):

```ts
test("scan catches a known-bad undefined --kramer-* reference", () => {
  const defined = listDefinedTokens("styles/kramer-brand.css");
  const synthetic = [{ token: "--kramer-NONEXISTENT", file: "<fixture>", line: 1 }];
  expect(() => assertUsedTokensAreDefined(synthetic, defined)).toThrow(
    /--kramer-NONEXISTENT.*not defined/,
  );
});
```

Closes C7 (mechanical fix today; lint prevents recurrence).

## Consequences

**Positive.**

- The product finally renders in a brand-coherent font for the first time since M1. Hebrew + Latin both supported with appropriate glyph variants.
- WCAG 2.4.7 (Focus Visible) compliance via global rule + zero-specificity composition that doesn't fight existing carve-outs.
- C7's invisible-buttons class is closed twice: once by mechanical fix today, again by lint floor that catches future `--kramer-*` typos before they reach review.
- C15's "every admin form reimplements buttons inline" structural debt is closed: variant becomes the only styling vector. The new `<Button>` primitive forces consumers to think in design tokens, not inline styles.
- WCAG AA contrast process is locked even though numbers aren't — impl-PR runs deterministic ratio computation and applies the pre-enumerated remediation table without re-deciding the design.

**Negative / accepted.**

- **Brand divergence from the Kramer brand skill.** The upstream `anthropic-skills:kramer-brand` skill continues to ship GT Eesti as canonical. New projects bootstrapped via that skill will inherit GT Eesti; PriorityKB diverges. Mitigation: nothing actionable from this repo — updating the upstream skill is out of this repo's authority. Documented here so future maintainers don't re-collide when adding new Kramer-brand surfaces. If the skill is eventually updated upstream, a follow-up ADR-0026 amendment can re-converge.
- **`<Button>` ships with `"use client"`.** Every import is a client-component boundary. Most current admin surfaces are already client-component-heavy (forms, SSE consumers), so this is non-disruptive. The cost surfaces if a future server-rendered nav surface needs button-visual without interactivity — that's the `<ButtonLink>` follow-up trigger, not a current problem.
- **Decision 3 defers the ratio numbers.** Impl-PR could surface a surprise (e.g., 4 of 7 pairs fail AA), forcing a larger token-revision PR than planned. Mitigation: the pre-enumerated remediation table caps the scope of "surprise" to known shapes (`-strong` variant / outline pattern / inversion); impl-PR doesn't re-decide what's possible.
- **`@font-face` cascade quirk.** Hebrew + Latin fallback ordering relies on browsers walking the font stack per-glyph; this works in all modern browsers but is undertested for edge cases (e.g., mixed bidi within a single word like `BPM-טריגר`). Mitigation: the existing `dir="auto"` carve-outs (e.g., `app/admin/entries/page.tsx:392`) already exercise this; visual regression is testable via the audit's reproducibility recipe.
- **Skipping polymorphic `<Button>`.** The audit's 4 mint breadcrumb links (`← Back to entries · …`) stay as raw `<a>` tags with inline mint styling. They aren't visually-button surfaces today, so this is moot; if a future polish PR wants link-styled-as-button, that's `<ButtonLink>`.

## Alternatives considered

- **License GT Eesti from Grilli Type and honor the original brand.** ~$500-1200/year per-style. Rejected for an internal-use KB project where the brand identity is internally-facing and the cost outpaces the rendering-quality benefit. If the project ever opens to external users (post-M5 production decision), revisit.
- **Pivot to Noto Sans + Noto Sans Hebrew.** Comprehensive multilingual coverage, very neutral identity. Rejected because IBM Plex has stronger visual character that pairs better with the dark/neon Kramer palette; Noto is intentionally low-personality.
- **Pivot to Inter.** Most popular geometric sans, English-leaning, weaker Hebrew design. Rejected — Hebrew is a primary corpus language for this product.
- **Strip the custom font entirely; ship with system-ui.** This is the current de-facto state (C1). Rejected — the audit's whole point is to actually deliver a brand experience, not formalize the absence of one.
- **Split into two ADRs (typography + Button = 0026; focus-ring + contrast + lint = 0027).** Rejected by the user during planning — the 5 decisions are tightly coupled to the same `kramer-brand.css` surface and one audit pass, so coherence wins over per-ADR-size.
- **Per-element focus styles instead of global rule.** Rejected — 90% of interactive elements would need per-surface rewriting; the global rule with `:where(*)` for zero specificity is the lower-cost path with identical visual outcome.
- **`<Button asChild>` / polymorphic API.** Rejected for v1; narrow type beats broad-but-leaky type. Polymorphism adds runtime branching and an `as` prop that consumers can misuse.
- **Stylelint custom rule instead of vitest scan for the lint floor.** Rejected — vitest is already in the gate, mirrors the existing non-negotiable #8 source-file-scan precedent at `lib/embedding.test.ts`, and doesn't add a new tool to CI. Stylelint would also miss the `.tsx` inline-style cases where the typo lives today (all 6 C7 sites are inline `style={{ color: "var(--kramer-bg)" }}` in `.tsx`, not in `.css`).
- **CLAUDE.md non-negotiable #13 edit deferred to a separate PR.** Rejected — the override must land in the same PR as the ADR or new sessions read "(GT Eesti)" as canonical and drift fires every chat (per plan-CR B1 finding). The wording edit is one line and ships in this PR.

## Implementation outline

The five decisions land in 4 follow-up PRs. Together these constitute the new "M4.5 — UI polish" milestone block (separate small ROADMAP.md edit PR ships after this ADR merges).

| PR | Decision(s) | Scope | Depends on |
|---|---|---|---|
| **M4.5/A** | 5 (lint floor + typo rename) | New `styles/brand-tokens.test.ts` per the test-helper skeleton (incl. `assertSingleDefinitionSource` guard); covers `app/`, `components/` (when it exists), `styles/`; positive-control test. **AND** mechanically rename `var(--kramer-bg)` → `var(--kramer-dark)` in the 6 affected files in the same PR, so the lint floor merges green (without the rename, the lint would fail immediately on the 6 known sites). Add the `/* renamed from --kramer-bg per ADR-0026 §5 */` back-pointer comment near `--kramer-dark`. | None |
| **M4.5/B** | 4 (Button primitive + 6-site migration) | New `components/Button.tsx` per type skeleton; new `.btn.secondary` CSS class; migrate the 6 admin inline-styled buttons (EditForm + RenameForm + MergeForm + RevertForm + history/page.tsx + entries/page.tsx) to `<Button variant="...">`. After migration the 6 sites no longer reference any `--kramer-*` directly — they get brand-class styling through the Button primitive. Update CLAUDE.md File Map to include `components/`. | None — independent of A (after A's rename, the buttons still reference `--kramer-dark`; B replaces those references with the Button primitive entirely) |
| **M4.5/C** | 2 (focus-ring tokens + global rule) | Add 3 new CSS custom properties; add `:where(*):focus-visible` global rule; document the 2 existing carve-outs in CSS comments + this ADR's Decision 2 reference. | None |
| **M4.5/D** | 1 (font pivot) + amendments | Bundle 4 IBM Plex `.woff2` files (file names + release version pinned against the [IBM/plex release tag](https://github.com/IBM/plex/releases) chosen at impl time) under `public/fonts/`; uncomment + rewrite `@font-face` blocks in `kramer-brand.css`; delete the legacy GT Eesti commented block; update `--font-body` / `--font-heading` tokens; rewrite the `kramer-brand.css:1-12` header comment; **add `## Amendment 2026-06-02 — Typography pivot per ADR-0026` section to `docs/adr/0001-bootstrap.md`** (matching the dominant amend-in-place pattern); **edit CLAUDE.md non-negotiable #13 wording** (drop "(GT Eesti)" → "(IBM Plex Sans)" with back-pointer to ADR-0026); update CLAUDE.md File Map to include `public/fonts/`. | None |
| **M4.5/E** | 3 (WCAG AA contrast pass) | Compute ratios for the 7 meaningful pairs; document in new `docs/A11Y.md`; for each failing pair, apply the pre-enumerated remediation; add `-strong` variants only as needed. Update CLAUDE.md File Map to include `docs/A11Y.md`. | None |

**PR sequencing freedom:** all four PRs are independent of each other and can ship in any order or in parallel. The four PRs together close UI_AUDIT.md findings C1, C7, C8, C9, C15.

**Out of scope for the M4.5 block** (separate BACKLOG slices — per UI_AUDIT.md §2): C2 (KramerLogo), C3 (global nav chrome), C4 (per-page titles), C5 (branded admin 404), C6 (anon-access unification), C10 + C14 (responsive + viewport), C11 (seed diversification), C12 (`html.dir="rtl"`), C13 (source-pointer lock — domain logic, not design tokens), C16 (aria-live).
