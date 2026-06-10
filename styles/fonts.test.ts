/*
 * Font-file mechanical floor — per ADR-0026 §1 + M4.5/D.
 *
 * Parses @font-face src: url(...) declarations from kramer-brand.css and
 * asserts each URL resolves to a file under public/. Catches font-file
 * deletion + URL typos at gate time. Sister to:
 *  - styles/brand-tokens.test.ts (M4.5/A — --kramer-* def/use lint)
 *  - styles/contrast.test.ts     (M4.5/E — WCAG ratio floor)
 *
 * Regex policy:
 *  - Matches `src: url("/fonts/<name>.woff2")` and the single-quoted form.
 *  - Captures the literal path inside the url(...).
 *  - Does NOT follow `local()` srcs (kramer-brand.css doesn't use them today;
 *    a future PR adding one surfaces in code review).
 *  - Does NOT handle multi-src declarations (each @font-face declares one
 *    src today; the regex captures the first url() per @font-face).
 *
 * Positive-control test (regex-rot guard, mirrors brand-tokens.test.ts and
 * contrast.test.ts patterns): feeds a synthetic url("/fonts/MISSING.woff2")
 * to the assertion helper and asserts the throw fires.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_ROOT = join(REPO_ROOT, "public");

// Matches: src: url("/path/file.ext") OR src: url('/path/file.ext')
// Captures the path inside the url() — group 1.
const URL_REGEX = /src:\s*url\(\s*["']([^"')]+)["']\s*\)/g;

function listFontFaceUrls(): string[] {
  const text = readFileSync(join(REPO_ROOT, "styles/kramer-brand.css"), "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(URL_REGEX)) {
    out.push(m[1]);
  }
  return out;
}

function assertUrlResolves(url: string): void {
  // Strip the leading "/" — Next.js serves public/ at /, so /fonts/x.woff2
  // maps to public/fonts/x.woff2. URLs starting with `/` map to PUBLIC_ROOT;
  // any other shape (./, http://) is rejected as outside the contract.
  if (!url.startsWith("/")) {
    throw new Error(
      `Font URL "${url}" does not start with "/" — only root-anchored URLs ` +
        `under public/ are supported (e.g., "/fonts/Foo.woff2").`,
    );
  }
  const fsPath = join(PUBLIC_ROOT, url.slice(1));
  if (!existsSync(fsPath)) {
    throw new Error(
      `Font URL "${url}" does not resolve to an existing file (expected at ${fsPath}). ` +
        `See ADR-0026 §1 for the canonical IBM Plex font bundle.`,
    );
  }
}

describe("Font-file floor (ADR-0026 §1)", () => {
  it("every @font-face url() in kramer-brand.css resolves to a real file", () => {
    const urls = listFontFaceUrls();
    expect(urls.length).toBeGreaterThan(0); // sanity: regex didn't break
    for (const u of urls) {
      assertUrlResolves(u);
    }
  });

  it("the M4.5/D bundle (4 IBM Plex woff2 files) is present", () => {
    // Explicit enumeration — guards against partial-bundle ships (e.g.,
    // someone deletes one of the Hebrew files thinking it's unused).
    const expected = [
      "fonts/IBMPlexSans-Light.woff2",
      "fonts/IBMPlexSans-Medium.woff2",
      "fonts/IBMPlexSansHebrew-Light.woff2",
      "fonts/IBMPlexSansHebrew-Medium.woff2",
    ];
    for (const rel of expected) {
      expect(existsSync(join(PUBLIC_ROOT, rel))).toBe(true);
    }
  });

  it("SIL OFL 1.1 LICENSE.txt is bundled alongside the fonts", () => {
    // OFL §5: license text must be distributed with the fonts when redistributing.
    expect(existsSync(join(PUBLIC_ROOT, "fonts/LICENSE.txt"))).toBe(true);
  });
});

describe("Font-file floor — positive controls (regex-rot guards)", () => {
  it("assertUrlResolves throws on a synthetic missing /fonts/MISSING.woff2", () => {
    expect(() => assertUrlResolves("/fonts/MISSING-FONT-FILE.woff2")).toThrow(/does not resolve/);
  });

  it("assertUrlResolves rejects non-root-anchored URLs", () => {
    expect(() => assertUrlResolves("./fonts/foo.woff2")).toThrow(/does not start with "\/"/);
    expect(() => assertUrlResolves("https://cdn.example/foo.woff2")).toThrow(
      /does not start with "\/"/,
    );
  });

  it("URL_REGEX captures both double and single quoted url() forms", () => {
    expect(`src: url("/fonts/a.woff2")`.match(URL_REGEX)?.[0]).toBeTruthy();
    expect(`src: url('/fonts/b.woff2')`.match(URL_REGEX)?.[0]).toBeTruthy();
  });
});
