/*
 * Brand-token lint floor — per ADR-0026 §5.
 *
 * Mechanical scan that fails the gate if any `var(--kramer-IDENT)` reference
 * in app/, components/, or styles/ names a token not defined in
 * styles/kramer-brand.css. Mirrors the lib/embedding.test.ts non-negotiable
 * #8 source-file-scan precedent (regex + positive-control regex-rot guard).
 *
 * Closes UI_AUDIT.md C7 against recurrence: the original bug (--kramer-bg
 * typo in 6 admin client-components, undefined → invisible buttons) shipped
 * to production unnoticed because nothing flagged the undefined reference.
 * After this floor, any future typo of the same shape FAILs the gate at
 * vitest time.
 *
 * Documented blind spots (acceptable per ADR-0026 §5):
 *   - Template-literal dynamic construction: `var(--kramer-${tier})` —
 *     no current code uses this shape (empirically verified
 *     pre-implementation); a future PR adding one surfaces in code review.
 *   - Test files (*.test.ts / *.test.tsx) are excluded from the usage scan
 *     so this file's own synthetic fixture strings (e.g.,
 *     "--kramer-NONEXISTENT" passed by name only, never wrapped in
 *     var(...)) cannot self-trigger the floor.
 *   - components/ does not exist today (M4.5/B will create it); the walker
 *     guards with a missing-dir check and silently skips. The positive
 *     control still fires regardless of whether components/ exists, so a
 *     silently-empty `used` array cannot mask regex breakage.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, sep, posix, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TOKEN_USE_REGEX = /var\(\s*(--kramer-[a-zA-Z0-9_-]+)\s*(?:,[^)]*)?\s*\)/g;
const TOKEN_DEF_REGEX = /(--kramer-[a-zA-Z0-9_-]+)\s*:/g;

type TokenUse = { token: string; file: string; line: number };

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

function walk(rootRelative: string, exts: readonly string[]): string[] {
  const absRoot = join(REPO_ROOT, rootRelative);
  if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) return [];
  const entries = readdirSync(absRoot, { recursive: true, withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent =
      typeof entry.parentPath === "string" ? entry.parentPath : (entry as { path?: string }).path;
    if (!parent) continue;
    const fullPath = join(parent, entry.name);
    if (!exts.some((ext) => entry.name.endsWith(ext))) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
    out.push(toPosix(fullPath.slice(REPO_ROOT.length + 1)));
  }
  return out.sort();
}

function listDefinedTokens(cssRootRelative: string): Set<string> {
  const files = walk(cssRootRelative, [".css"]);
  const defined = new Set<string>();
  for (const relPath of files) {
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    for (const match of text.matchAll(TOKEN_DEF_REGEX)) {
      defined.add(match[1]);
    }
  }
  return defined;
}

function listUsedTokens(
  usageRoots: readonly { root: string; exts: readonly string[] }[],
): TokenUse[] {
  const out: TokenUse[] = [];
  for (const { root, exts } of usageRoots) {
    const files = walk(root, exts);
    for (const relPath of files) {
      const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const match of line.matchAll(TOKEN_USE_REGEX)) {
          out.push({ token: match[1], file: relPath, line: i + 1 });
        }
      }
    }
  }
  return out;
}

function assertUsedTokensAreDefined(used: readonly TokenUse[], defined: ReadonlySet<string>): void {
  const undefined_ = used.filter((u) => !defined.has(u.token));
  if (undefined_.length === 0) return;
  const lines = undefined_.map((u) => `  ${u.token} not defined — used at ${u.file}:${u.line}`);
  throw new Error(
    `Brand-token lint floor: ${undefined_.length} undefined --kramer-* reference(s):\n${lines.join("\n")}`,
  );
}

function assertSingleDefinitionSource(cssRootRelative: string, expectedSourcePath: string): void {
  const files = walk(cssRootRelative, [".css"]);
  const sources = files.filter((relPath) => {
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    return TOKEN_DEF_REGEX.test(text);
  });
  TOKEN_DEF_REGEX.lastIndex = 0;
  const expectedPosix = toPosix(expectedSourcePath);
  if (sources.length !== 1 || sources[0] !== expectedPosix) {
    throw new Error(
      `assertSingleDefinitionSource: expected the only --kramer-* definition source under ${cssRootRelative}/ ` +
        `to be ${expectedPosix}, found: [${sources.join(", ")}]. ` +
        `If a CSS split is intended, update the lint floor to scan every new definition source.`,
    );
  }
}

const USAGE_ROOTS = [
  { root: "app", exts: [".ts", ".tsx"] as const },
  { root: "components", exts: [".ts", ".tsx"] as const }, // missing today; guarded by walk()
  { root: "styles", exts: [".css"] as const },
];

describe("brand-token lint floor (ADR-0026 §5)", () => {
  it("every var(--kramer-*) reference names a token defined in styles/kramer-brand.css", () => {
    const defined = listDefinedTokens("styles");
    const used = listUsedTokens(USAGE_ROOTS);
    expect(used.length).toBeGreaterThan(0); // sanity: regex didn't break + repo isn't empty
    expect(() => assertUsedTokensAreDefined(used, defined)).not.toThrow();
  });

  it("assertSingleDefinitionSource holds today: only kramer-brand.css defines --kramer-* tokens", () => {
    expect(() => assertSingleDefinitionSource("styles", "styles/kramer-brand.css")).not.toThrow();
  });

  // Positive-control: regex-rot guard. If a future edit accidentally weakens
  // the assertion (e.g., changes `!defined.has(u.token)` to `defined.has(u.token)`),
  // the main scan would silently pass on any input. This control proves the
  // assertion is the one that triggers, by feeding it a known-bad fixture.
  it("positive control: assertUsedTokensAreDefined throws on a synthetic --kramer-NONEXISTENT", () => {
    const defined = new Set(["--kramer-dark", "--kramer-mint"]);
    const synthetic: TokenUse[] = [{ token: "--kramer-NONEXISTENT", file: "<fixture>", line: 1 }];
    expect(() => assertUsedTokensAreDefined(synthetic, defined)).toThrow(
      /--kramer-NONEXISTENT.*not defined/,
    );
  });

  // Historical-surfaces test: proves the lint floor WOULD have caught C7 if it
  // had existed pre-rename. Constructs synthetic uses at the 6 file:line tuples
  // from UI_AUDIT.md C7 + ADR-0026 §Context, with the original --kramer-bg
  // token name (not the renamed --kramer-dark). Asserts the throw enumerates
  // all 6 surfaces. Cross-ref: WORKFLOW.md Negative-assertion-tests sub-rule
  // (the test is constructed so it would have passed if --kramer-bg were
  // defined and would fail under the actual pre-rename repo state).
  it("would have caught C7: synthetic uses of --kramer-bg at the 6 historical surfaces throw", () => {
    const defined = listDefinedTokens("styles"); // current state: --kramer-bg is NOT defined
    const historical: TokenUse[] = [
      { token: "--kramer-bg", file: "app/admin/entries/page.tsx", line: 286 },
      { token: "--kramer-bg", file: "app/admin/entries/[id]/edit/EditForm.tsx", line: 367 },
      { token: "--kramer-bg", file: "app/admin/entries/[id]/history/page.tsx", line: 115 },
      {
        token: "--kramer-bg",
        file: "app/admin/entries/[id]/history/[versionNo]/RevertForm.tsx",
        line: 140,
      },
      { token: "--kramer-bg", file: "app/admin/tags/MergeForm.tsx", line: 232 },
      { token: "--kramer-bg", file: "app/admin/tags/RenameForm.tsx", line: 153 },
    ];
    let caught: Error | undefined;
    try {
      assertUsedTokensAreDefined(historical, defined);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const message = caught!.message;
    expect(message).toMatch(/6 undefined --kramer-\* reference\(s\)/);
    for (const h of historical) {
      expect(message).toContain(`${h.file}:${h.line}`);
    }
  });
});
