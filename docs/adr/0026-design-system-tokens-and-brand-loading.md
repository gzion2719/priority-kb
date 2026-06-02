# ADR-0026 — Design-system tokens + brand-loading strategy

- **Date:** 2026-06-02
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent plan-reviewer subagent)

## Context

The UI/UX audit at [`docs/UI_AUDIT.md`](../UI_AUDIT.md) (landed same day in PR #406) surfaced four BLOCKING findings whose fixes all hit the same surface (`styles/kramer-brand.css`) and the same coupled set of decisions: typography, focus-visible compliance, contrast tokens, button primitive extraction, and a 6-file `--kramer-bg` CSS-variable typo. Shipping these as five independent polish PRs without a locked design decision would let each PR re-decide the same questions inconsistently (token names, font choice, focus-ring color, button API shape).

This ADR locks the five decisions. Implementation lands in follow-up PRs that constitute the M4.5 milestone block (per the audit's §4 B+C choice).

### What the audit caught that this ADR responds to

- **C1 BLOCKING** — GT Eesti has never actually loaded. `@font-face` blocks in `styles/kramer-brand.css:400-421` are commented out and `public/fonts/` does not exist. Every render falls through to system sans. The product has never rendered in its declared brand typography since M1.
- **C7 BLOCKING** — Six admin client-component buttons use `color: var(--kramer-bg)` inline. `--kramer-bg` is not defined anywhere in `styles/kramer-brand.css` (the real var is `--kramer-dark`); undefined CSS vars fall back to `inherit` → `--kramer-neutral` → invisible buttons. Affected files: `app/admin/entries/[id]/edit/EditForm.tsx:367`, `app/admin/entries/[id]/history/page.tsx:115`, `app/admin/entries/[id]/history/[versionNo]/RevertForm.tsx:140`, `app/admin/entries/page.tsx:286`, `app/admin/tags/RenameForm.tsx:153`, `app/admin/tags/MergeForm.tsx:232`.
- **C9 BLOCKING** — `:focus-visible` outline missing on 90% of interactive surfaces (only `.chat-input:focus` and `.filter-chip-remove:focus-visible` declare focus styles); WCAG 2.4.7 Level AA regression.
- **C13 BLOCKING** — `source_pointer` editable on the edit form — iron-rule #7 (provenance) risk. *(NOTE: ADR-0026 does NOT cover C13. C13 is a domain-logic decision about the edit form, not a design-token decision. It ships as its own M4.5 BACKLOG item per the audit §2 backlog item 4. Cross-referenced here so future readers don't expect ADR-0026 to address it.)*
- **C8 / C15 MAJOR** (cross-cutting) — WCAG AA contrast not verified for the palette; client-component admin forms bypass the brand `.btn` primitive via inline styles.

### Pre-coding verification (per Mechanical-floor-surface-enumeration sub-rule)

Before locking Decision 5 (the lint floor against undefined `--kramer-*` vars), enumerated all references and definitions empirically:

```
$ grep -rohE "var\(--kramer-[a-z-]+(?:,[^)]*)?\)" app/ | sort -u
var(--kramer-bg)        ← UNDEFINED (the C7 bug)
var(--kramer-mint)      ← defined ✓
var(--kramer-neutral)   ← defined ✓

$ grep -oE "^\s*--kramer-[a-z-]+" styles/kramer-brand.css | sort -u
--kramer-dark
--kramer-mint
--kramer-neutral
--kramer-pink
--kramer-purple
```

`--kramer-bg` is the only undefined-var typo today. The lint floor (Decision 5) catches future regressions; today's scope is the surgical 6-file rename.

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

**Loading strategy:** `font-display: swap` — render with fallback immediately; swap to Plex when loaded. No FOIT (no flash of invisible text), no LCP regression. Brief FOUT (flash of unstyled text) is acceptable for an internal-use KB.

**Fallback stack:**

```css
--font-body:    "IBM Plex Sans", "IBM Plex Sans Hebrew", system-ui, "Segoe UI", "Helvetica Neue", sans-serif;
--font-heading: "IBM Plex Sans", "IBM Plex Sans Hebrew", system-ui, "Segoe UI", "Helvetica Neue", sans-serif;
```

Hebrew variant follows the Latin name in the stack — browsers walk the stack per glyph, so Latin glyphs match `"IBM Plex Sans"` and Hebrew glyphs cascade to `"IBM Plex Sans Hebrew"`. The `system-ui` / `"Segoe UI"` intermediates cover the FOUT window and the worst-case "woff2 failed to load" scenario.

**Brand-standards override.** This decision overrides:
- **ADR-0001 §"Brand standards"** ("GT Eesti typography"). ADR-0001 is amended via the precedent that newer ADRs supersede older ones on their specific subject matter.
- **CLAUDE.md non-negotiable #13** ("typography (GT Eesti)"). Wording edit lands in the same PR — the iron-rule's literal text changes from "(GT Eesti)" to "(IBM Plex Sans)" with a back-pointer to this ADR.

Rationale for override: cost (SIL OFL = $0 vs ~$500-1200/year per-style GT Eesti license for an internal-use KB), empirically-verified Hebrew weight availability (Plex Hebrew ships Light + Medium per IBM/plex GitHub releases), and the fact that the product has rendered in system-sans fallback since M1 — pivoting to IBM Plex IS the brand uplift, not a regression.

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

`:where(*)` has zero specificity, so the existing carve-outs (`.chat-input:focus` at `kramer-brand.css:237-240`, `.filter-chip-remove:focus-visible` at `:352-356`) continue to win without per-surface rewriting. Carve-outs are intentional and documented in their respective CSS comment blocks.

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
// overrides that bypass the brand .btn primitive). ref-forwarding is allowed
// via React 19's plain `ref` prop on function components (no forwardRef).
export type ButtonProps = {
  variant?: ButtonVariant;                                  // default "primary"
  type?: "button" | "submit" | "reset";                     // default "button"
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  children: React.ReactNode;
  ref?: React.Ref<HTMLButtonElement>;
} & Pick<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  | "name" | "value" | "form" | "formAction" | "formMethod"  // form-association attrs
  | "autoFocus" | "tabIndex"                                // a11y attrs
  | "aria-label" | "aria-labelledby" | "aria-describedby"   // a11y attrs
  | "aria-pressed" | "aria-expanded" | "aria-controls"      // a11y attrs
  | "title"                                                 // tooltip
>;

export function Button(props: ButtonProps): React.ReactElement;
```

**Variant → brand-CSS class mapping:**

| `variant` | CSS class | Visual |
|---|---|---|
| `"primary"` (default) | `.btn` | Purple bg, neutral text |
| `"cta"` | `.btn.cta` | Mint bg, dark text — primary calls to action (Save, Submit, Send) |
| `"secondary"` | `.btn.secondary` (new — transparent bg + neutral border) | Used for Cancel / Back actions |
| `"danger"` | `.btn.alert` | Pink bg, neutral text — used for Delete / destructive actions |

`.btn.secondary` is a new CSS class added in the same PR.

**Mechanical migration target** (impl-PR scope): 6 admin inline-styled buttons listed in C7 above. After migration, all use `<Button variant="...">` and the brand `.btn` primitive is the only path to a Kramer-branded button. Closes C15.

**Deliberate non-features:**
- No polymorphism (`as="a"`, `<Button asChild>`). `<Button>` is button-only. If link-styled-as-button is needed later, a separate `<ButtonLink>` ships in a follow-up ADR. Keeps the type narrow.
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

function listDefinedTokens(cssPath: string): Set<string>;
function listUsedTokens(globPatterns: readonly string[]): readonly {
  token: string;
  file: string;
  line: number;
}[];
function assertUsedTokensAreDefined(
  used: ReturnType<typeof listUsedTokens>,
  defined: Set<string>,
): void;
```

**Scan scope (glob):**
- `app/**/*.{ts,tsx}` — page + component source
- `components/**/*.{ts,tsx}` — once Decision 4's dir exists
- `styles/**/*.css` — typos in CSS are the more dangerous class (silent browser fallback exactly like C7)

**Regex policy:** scan literal `var(--kramer-IDENT)` (optionally with fallback: `var(--kramer-IDENT, anything)`). Template-literal dynamic construction (`` `var(--kramer-${tier})` ``) is a known blind spot — documented in the test file's header. The blind spot is acceptable because no current code uses template-literal `--kramer-*` construction; if a future PR adds one, the regression surfaces during code review of that PR, not at lint time.

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

The five decisions land in 4 follow-up PRs (not 5 — PR 1 from the prior plan absorbed into PR 2 per plan-CR m1 finding). Together these constitute the new "M4.5 — UI polish" milestone block (separate small ROADMAP.md edit PR ships after this ADR merges).

| PR | Decision(s) | Scope | Depends on |
|---|---|---|---|
| **M4.5/A** | 5 (lint floor) | New `styles/brand-tokens.test.ts` per the test-helper skeleton above; covers `app/`, `components/` (when it exists), `styles/`. Positive-control test for known-bad ref. **Does NOT include the `--kramer-bg` rename** — that ships with M4.5/B (the rename disappears as a side effect of replacing the inline buttons with `<Button>`). | None |
| **M4.5/B** | 4 (Button) + 5 (typo rename via Button migration) | New `components/Button.tsx` per type skeleton; new `.btn.secondary` CSS class; migrate the 6 admin inline-styled buttons to `<Button variant="...">`. The 6 sites currently using `var(--kramer-bg)` no longer reference it after migration. | M4.5/A merged (so the lint floor exists when M4.5/B's migration runs through it) |
| **M4.5/C** | 2 (focus-ring tokens + global rule) | Add 3 new CSS custom properties; add `:where(*):focus-visible` global rule; document the 2 existing carve-outs. | None — can ship in parallel with A/B |
| **M4.5/D** | 1 (font pivot) | Bundle 4 IBM Plex `.woff2` files under `public/fonts/`; uncomment + rewrite `@font-face` blocks in `kramer-brand.css` (and delete the legacy GT Eesti commented block); update `--font-body` / `--font-heading` tokens with the new family stack; rewrite the `kramer-brand.css:1-12` header comment; **edit CLAUDE.md non-negotiable #13 wording** (drop "(GT Eesti)" → "(IBM Plex Sans)" with back-pointer to ADR-0026); update CLAUDE.md File Map if needed. | None — can ship in parallel |
| **M4.5/E** | 3 (WCAG AA contrast pass) | Compute ratios for the 7 meaningful pairs; document in new `docs/A11Y.md`; for each failing pair, apply the pre-enumerated remediation; add `-strong` variants only as needed. Update CLAUDE.md File Map to include `docs/A11Y.md`. | None — independent |

**PR sequencing freedom:** only M4.5/B depends on M4.5/A. The other three (C, D, E) ship in parallel with no inter-dependencies. The four PRs together close UI_AUDIT.md findings C1, C7, C8, C9, C15.

**Out of scope for the M4.5 block** (separate BACKLOG slices — per UI_AUDIT.md §2): C2 (KramerLogo), C3 (global nav chrome), C4 (per-page titles), C5 (branded admin 404), C6 (anon-access unification), C10 + C14 (responsive + viewport), C11 (seed diversification), C12 (`html.dir="rtl"`), C13 (source-pointer lock), C16 (aria-live).
