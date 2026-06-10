/*
 * Contrast mechanical floor — per ADR-0026 §3 + docs/A11Y.md.
 *
 * Computes WCAG 2.1 §1.4.3 contrast ratios for the meaningful text/bg
 * surfaces defined in styles/kramer-brand.css and asserts each meets
 * its threshold. Sister floor to styles/brand-tokens.test.ts (M4.5/A):
 * brand-tokens guards token existence; this guards token contrast.
 *
 * Covers BOTH solid-token pairs AND composited surfaces (alpha-blended
 * pinks/purples over --kramer-dark). The composited cases are the
 * load-bearing ones — a token that passes against solid dark can still
 * fail against a translucent pink/purple background, which is exactly
 * what tripped the original (pre-review) plan's `#e0399a` pick.
 *
 * Methodology — WCAG 2.1 §1.4.3:
 *   L = 0.2126*R + 0.7152*G + 0.0722*B   (linearized sRGB; per channel:
 *                                          c<=0.03928 ? c/12.92
 *                                                     : ((c+0.055)/1.055)^2.4)
 *   ratio = (max(L1,L2) + 0.05) / (min(L1,L2) + 0.05)
 *
 * Thresholds:
 *   - AA normal text: 4.5:1
 *   - AA large text:  3:1 (≥18pt or ≥14pt bold)
 *   All 5 -strong-migrated surfaces in this repo are normal text
 *   (font sizes 0.6875rem-1rem, no bold ≥14pt) — large-text exception
 *   does NOT apply. See docs/A11Y.md §"Large-text exception".
 *
 * Limitations / blind spots (acceptable today):
 *   - Token-definition regex captures hex literals only. `var()` indirection
 *     (e.g., `--kramer-x: var(--kramer-y);`) is NOT followed; today the
 *     file has no such indirection. A future PR adding one will surface
 *     in code review.
 *   - WCAG 1.4.11 (non-text 3:1 for borders, icons, focus indicators) is
 *     out of scope; BACKLOG entry queued.
 *   - Test files (*.test.ts / *.test.tsx) are not scanned for token uses —
 *     this floor asserts EXACT surface descriptors below, not a sweep of
 *     all uses.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Token parser -----------------------------------------------------------

const HEX_DEF_REGEX = /(--kramer-[a-zA-Z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g;

function readBrandTokens(): Record<string, string> {
  const text = readFileSync(join(REPO_ROOT, "styles/kramer-brand.css"), "utf8");
  const out: Record<string, string> = {};
  for (const m of text.matchAll(HEX_DEF_REGEX)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

// --- WCAG luminance + ratio -------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relLum(hex: string): number {
  const linear = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function wcagRatio(fgHex: string, bgHex: string): number {
  const lFg = relLum(fgHex);
  const lBg = relLum(bgHex);
  return (Math.max(lFg, lBg) + 0.05) / (Math.min(lFg, lBg) + 0.05);
}

/**
 * Alpha-composite `fg` over `bg` (both #rrggbb), returning #rrggbb.
 * Mirrors browser rendering of `rgba(...)` over a solid base. The CSS
 * doesn't actually composite at parse time — the browser does — but the
 * effective rendered color is what governs contrast.
 */
function compositeOver(fgHex: string, alpha: number, bgHex: string): string {
  const [fr, fg, fb] = hexToRgb(fgHex);
  const [br, bg, bb] = hexToRgb(bgHex);
  const r = Math.round(fr * alpha + br * (1 - alpha));
  const g = Math.round(fg * alpha + bg * (1 - alpha));
  const b = Math.round(fb * alpha + bb * (1 - alpha));
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// --- Surface descriptors ----------------------------------------------------
// Each descriptor: a (text, effective-bg) pair drawn from a real CSS rule.
// Includes both solid-token pairs and the three composited-pink-on-dark
// translucent surfaces (chat-tool-chip.error, chat-banner.error,
// sensitivity-pill restricted) plus the composited-purple-on-dark
// sensitivity-pill internal. WCAG 2.1 §1.4.3 AA threshold = 4.5:1 normal.

type Surface = {
  name: string;
  cssRule: string; // for failure diagnostics
  fg: (T: Record<string, string>) => string;
  bg: (T: Record<string, string>) => string;
  threshold: number;
};

const SURFACES: readonly Surface[] = [
  {
    name: "body text (neutral on dark)",
    cssRule: "html, body",
    fg: (T) => T["--kramer-neutral"],
    bg: (T) => T["--kramer-dark"],
    threshold: 4.5,
  },
  {
    name: "primary link (mint on dark)",
    cssRule: "a",
    fg: (T) => T["--kramer-mint"],
    bg: (T) => T["--kramer-dark"],
    threshold: 4.5,
  },
  {
    name: "hover link (purple-strong on dark) — fixed by M4.5/E",
    cssRule: "a:hover",
    fg: (T) => T["--kramer-purple-strong"],
    bg: (T) => T["--kramer-dark"],
    threshold: 4.5,
  },
  {
    name: "primary button text (neutral on purple)",
    cssRule: "button, .btn",
    fg: (T) => T["--kramer-neutral"],
    bg: (T) => T["--kramer-purple"],
    threshold: 4.5,
  },
  {
    name: "cta button text (dark on mint)",
    cssRule: "button.cta, .btn.cta",
    fg: (T) => T["--kramer-dark"],
    bg: (T) => T["--kramer-mint"],
    threshold: 4.5,
  },
  {
    name: "danger button text (neutral-strong on pink) — fixed by M4.5/E",
    cssRule: "button.alert, .btn.alert",
    fg: (T) => T["--kramer-neutral-strong"],
    bg: (T) => T["--kramer-pink"],
    threshold: 4.5,
  },
  {
    name: "chat-tool-chip.error (pink-strong on rgba(190,0,120,.10)/dark) — fixed by M4.5/E",
    cssRule: ".chat-tool-chip.error",
    fg: (T) => T["--kramer-pink-strong"],
    bg: (T) => compositeOver("#be0078", 0.1, T["--kramer-dark"]),
    threshold: 4.5,
  },
  {
    name: "chat-banner.error (pink-strong on rgba(190,0,120,.12)/dark) — fixed by M4.5/E",
    cssRule: ".chat-banner.error",
    fg: (T) => T["--kramer-pink-strong"],
    bg: (T) => compositeOver("#be0078", 0.12, T["--kramer-dark"]),
    threshold: 4.5,
  },
  {
    name: "sensitivity-pill internal (purple-strong on rgba(130,0,180,.12)/dark) — fixed by M4.5/E",
    cssRule: '.sensitivity-pill[data-tier="internal"]',
    fg: (T) => T["--kramer-purple-strong"],
    bg: (T) => compositeOver("#8200b4", 0.12, T["--kramer-dark"]),
    threshold: 4.5,
  },
  {
    name: "sensitivity-pill restricted (pink-strong on rgba(190,0,120,.14)/dark) — fixed by M4.5/E",
    cssRule: '.sensitivity-pill[data-tier="restricted"]',
    fg: (T) => T["--kramer-pink-strong"],
    bg: (T) => compositeOver("#be0078", 0.14, T["--kramer-dark"]),
    threshold: 4.5,
  },
  // --- Forward-looking coverage (already passing today, pinned to catch
  // future-PR regression when a bg or fg token shifts).
  {
    name: "chat-banner.warn (neutral on rgba(130,0,180,.12)/dark)",
    cssRule: ".chat-banner.warn",
    fg: (T) => T["--kramer-neutral"],
    bg: (T) => compositeOver("#8200b4", 0.12, T["--kramer-dark"]),
    threshold: 4.5,
  },
  {
    name: "chat-banner.info (mint on rgba(104,255,195,.10)/dark)",
    cssRule: ".chat-banner.info",
    fg: (T) => T["--kramer-mint"],
    bg: (T) => compositeOver("#68ffc3", 0.1, T["--kramer-dark"]),
    threshold: 4.5,
  },
  {
    name: "sensitivity-pill public (mint on rgba(104,255,195,.12)/dark)",
    cssRule: '.sensitivity-pill[data-tier="public"]',
    fg: (T) => T["--kramer-mint"],
    bg: (T) => compositeOver("#68ffc3", 0.12, T["--kramer-dark"]),
    threshold: 4.5,
  },
  {
    name: "chat-msg-assistant (neutral on rgba(220,221,222,.08)/dark)",
    cssRule: ".chat-msg-assistant",
    fg: (T) => T["--kramer-neutral"],
    bg: (T) => compositeOver("#dcddde", 0.08, T["--kramer-dark"]),
    threshold: 4.5,
  },
];

describe("WCAG 2.1 §1.4.3 contrast floor (ADR-0026 §3)", () => {
  const tokens = readBrandTokens();

  it("parses all -strong tokens from kramer-brand.css :root", () => {
    expect(tokens["--kramer-purple-strong"]).toBeDefined();
    expect(tokens["--kramer-pink-strong"]).toBeDefined();
    expect(tokens["--kramer-neutral-strong"]).toBeDefined();
    expect(tokens["--kramer-dark"]).toBeDefined();
    expect(tokens["--kramer-pink"]).toBeDefined();
  });

  for (const surface of SURFACES) {
    it(`${surface.name} meets ${surface.threshold}:1 AA`, () => {
      const fg = surface.fg(tokens);
      const bg = surface.bg(tokens);
      const r = wcagRatio(fg, bg);
      if (r < surface.threshold) {
        throw new Error(
          `WCAG 1.4.3 FAIL: ${surface.cssRule} ${fg} on ${bg} = ${r.toFixed(2)}:1, ` +
            `below ${surface.threshold}:1. See docs/A11Y.md for remediation alternatives.`,
        );
      }
      expect(r).toBeGreaterThanOrEqual(surface.threshold);
    });
  }
});

describe("WCAG floor — positive controls (regex-rot + math-rot guards)", () => {
  // Mirror brand-tokens.test.ts:143-149 pattern: feed a KNOWN-FAILING pair
  // and assert the floor's machinery rejects it. If a future edit weakens
  // wcagRatio() or the threshold check, the main test could silently pass
  // on wrong inputs; this control proves the machinery is the one that
  // triggers.

  it("positive control: known-failing pair #be0078 on #121212 = 3.09:1 (below 4.5)", () => {
    const r = wcagRatio("#be0078", "#121212");
    expect(r).toBeLessThan(4.5);
    expect(r).toBeGreaterThan(3.0); // sanity bound — should be ~3.09
  });

  it("positive control: known-passing pair #ffffff on #121212 ≈ 18.7:1 (far above 4.5)", () => {
    // Pure black on white would be 21:1; #121212 isn't pure black so a bit less.
    const r = wcagRatio("#ffffff", "#121212");
    expect(r).toBeGreaterThan(15);
  });

  it("compositeOver: rgba(190,0,120,0.10) over #121212 yields ~#23101c", () => {
    // Exact math: (190*0.10 + 18*0.90, 0*0.10 + 18*0.90, 120*0.10 + 18*0.90)
    //           = (35.2, 16.2, 28.2) → #23101c after rounding.
    expect(compositeOver("#be0078", 0.1, "#121212")).toBe("#23101c");
  });

  it("compositeOver: full opacity returns the fg color", () => {
    expect(compositeOver("#abcdef", 1, "#000000")).toBe("#abcdef");
  });

  it("compositeOver: zero opacity returns the bg color", () => {
    expect(compositeOver("#abcdef", 0, "#123456")).toBe("#123456");
  });
});

describe("WCAG floor — negative controls (asserts BASE tokens fail; A11Y.md doc-claim guard)", () => {
  // If a future PR makes these pass, the docs/A11Y.md claim that base
  // purple/pink fail AA on dark becomes inaccurate. These tests pin the
  // failure state. Also documents that the original C8 finding remains
  // grounded.

  it("base --kramer-purple on --kramer-dark is BELOW 4.5:1 (the C8 failure)", () => {
    const T = readBrandTokens();
    const r = wcagRatio(T["--kramer-purple"], T["--kramer-dark"]);
    expect(r).toBeLessThan(4.5); // empirically ~2.33:1
  });

  it("base --kramer-pink on --kramer-dark is BELOW 4.5:1 (the C8 failure)", () => {
    const T = readBrandTokens();
    const r = wcagRatio(T["--kramer-pink"], T["--kramer-dark"]);
    expect(r).toBeLessThan(4.5); // empirically ~3.09:1
  });

  it("base --kramer-neutral on --kramer-pink is BELOW 4.5:1 (the .btn.alert C8 failure)", () => {
    const T = readBrandTokens();
    const r = wcagRatio(T["--kramer-neutral"], T["--kramer-pink"]);
    expect(r).toBeLessThan(4.5); // empirically ~4.46:1
  });
});
