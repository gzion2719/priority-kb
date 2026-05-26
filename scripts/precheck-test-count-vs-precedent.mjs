#!/usr/bin/env node
// scripts/precheck-test-count-vs-precedent.mjs
//
// Mechanical floor for the "new test file ships absurdly few tests" recurrence
// class. Per memory `feedback_prefer_mechanical_over_prose`, the 3rd recurrence
// (2026-05-26 M2b #2 plan-CR M6 — api/log.py originally planned 2 tests vs
// lib/log.test.ts precedent of ~50) triggers a script-level enforcement, not
// another paragraph in a protocol file.
//
// Scope (v1, sub-pattern A only — "far too few tests"):
//   - Walks tracked test files via `git ls-files`:
//       *.test.ts  *.test.tsx  api/tests/test_*.py
//     (Python pattern is rooted at api/tests/ to match the M2b #2 scaffold
//     layout; bump to api/**/test_*.py if M2b ever introduces nested test
//     dirs like api/workers/tests/.)
//   - Excludes `tests/*.e2e.test.ts` (those run via vitest.e2e.config.ts under
//     `npm run e2e`, often have legitimately small case counts per scenario;
//     mirrors the vitest.config.ts L18-23 exclude rule).
//   - Counts TEST DECLARATIONS (NOT parametrized cases):
//       TS:  `\b(it|test|describe)(\.\w+)?\(`  matches `it(`, `test(`, `it.skip(`,
//            `it.only(`, `it.each(`, `test.each(`, `describe.each(`. Bare
//            `describe(` (group, not case) is excluded by an in-loop filter.
//            Chained `it.each.each(` is matched once (the `\.\w+` doesn't span
//            multiple dots — only the first method-suffix counts).
//       PY:  `^\s*(async\s+)?def test_` matches sync + async test functions,
//            one-per-line. The `async\s+` group is optional so the same
//            regex catches plain `def test_X` (sync) AND `async def test_X`
//            (asyncio + pytest-asyncio). M2b #3's api/tests/test_jobs.py is
//            the first file mostly-async; previously the regex silently
//            counted 1 (the lone bare-def test).
//     Source is comment-stripped before matching (line + block comments) so
//     `// it("x")` inside a file does NOT inflate the count. String literals
//     are NOT stripped — a test file that includes quoted source like
//     `expect(out).toContain("it('expected')")` WILL overcount. This is an
//     accepted limitation: stripping strings would need template-literal /
//     escaped-quote handling that's better solved by an AST parser; the
//     test-file-quoting-test-shapes case is rare in production code (mostly
//     this script's own test file). Authors hitting the overcount can self-
//     document via KNOWN_SMALL_FILES with a "true-count-is-N" reason.
//   - Threshold: 4 declarations. Below 4, the file is almost certainly
//     under-tested; above is a judgment call (handled by Step 7b unbiased
//     review, not this floor).
//
// Non-goals (sub-pattern B — "fewer than reviewer expected within reasonable
// band, e.g. 5→7, 8→14") and other deferred work:
//   - Sibling-precedent comparison (file vs paired production module's
//     test-precedent) — filed to BACKLOG as a v2 follow-up.
//   - `.each([...])` row expansion / stacked `@pytest.mark.parametrize`
//     Cartesian — the approximation undercounts but the threshold is still
//     meaningful for sub-pattern A. Authors using heavy parametrize that
//     legitimately falls under threshold-4-declarations should add the file
//     to KNOWN_SMALL_FILES with a "parametrize-expanded count is N" reason.
//   - Dynamic test generators (`for (const x of arr) { it(x, ...) }`) — static
//     parse can't see the count; counted as 0; dynamic-shape test files are a
//     separate smell.
//
// Gate: this script is advisory (exits 0 on success and on internal error —
// see try/catch in main()). The vitest test at
// tests/scripts/precheck-test-count-vs-precedent.test.ts is the gate — it runs
// under `npm run check` via vitest and fails when a sub-threshold file
// appears outside KNOWN_SMALL_FILES.
//
// Pattern mirror: scripts/verify-roadmap-tickboxes.mjs (advisory script +
// vitest gate); scripts/check-pr-title-allowlist-drift.mjs (typed-export
// constants for the gate to consume).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = pathResolve(__dirname, "..");

export const THRESHOLD = 4;

// One file per entry. The `reason` is mandatory — gate fires when a
// sub-threshold file appears outside this allowlist, so EVERY entry must
// document why the file is legitimately small at this count.
export const KNOWN_SMALL_FILES = [
  {
    path: "tests/smoke.test.ts",
    reason: "single-purpose @/* alias resolution + brand-metadata smoke (1 case by design)",
  },
  {
    path: "api/tests/test_healthz.py",
    reason: "single-endpoint liveness smoke (1 case by design — /healthz returns a pinned shape)",
  },
  {
    path: "lib/query-url-state.test.ts",
    reason:
      "Style choice — 2 bundled multi-assertion declarations cover positive round-trip (6 cases via inner for loop) + rejection path (4 boundary cases via 4 expects). True per-case count is ~10; one-assertion-per-it would be 6-8 declarations with marginally better failure localization. Allowlisted as-is per author's existing style; revisit if a per-case rewrite happens in another PR.",
  },
  {
    path: "app/healthz/route.test.ts",
    reason:
      "3 declarations fully cover the route's status-code surface (200 pgvector=true; 503 extension missing; 503 DB unreachable). Production module is 28 LOC; the file is complete at 3.",
  },
];

const TS_DECL_RE = /\b(it|test|describe)(\.\w+)?\(/g;
const PY_DECL_RE = /^\s*(async\s+)?def test_/gm;

// Block comment + line comment strippers. Run before TS_DECL_RE so quoted
// `// it("x")` in source doesn't inflate the count. Strings are intentionally
// NOT stripped — see scope notes at the top of this file.
const TS_COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
// Python uses `#` for comments + triple-quoted strings for docstrings.
// `def test_X` inside a docstring is a real edge case but rare; we strip line
// comments only (block "comments" in Python are actually strings).
const PY_COMMENT_RE = /#[^\n]*/g;

/**
 * Counts test declarations in source text.
 *
 *   TS:  matches `it(`, `test(`, `it.skip(`, `it.each(`, `describe.each(`, etc.
 *        Includes `describe.each` (parametrized describe blocks count as a
 *        declaration; the `it()` calls inside count separately). Does NOT
 *        include bare `describe(` — that's a group, not a test case.
 *   PY:  matches `def test_*` AND `async def test_*` at the start of any
 *        line (top-level functions AND methods on TestCase classes; sync
 *        and asyncio shapes). Excludes `def _test_helper` and similar.
 *
 * Approximate: does NOT expand `.each([rows])` row counts or stacked
 * `@pytest.mark.parametrize` Cartesian products. The undercount is intentional
 * — the threshold is meant to flag "almost no tests" (sub-pattern A), not
 * second-guess parametrize-heavy files (which can self-document via
 * KNOWN_SMALL_FILES with a "parametrize-expanded count is N" reason).
 *
 * @param {string} text source file contents
 * @param {string} ext file extension including leading dot (".ts", ".tsx", ".py")
 * @returns {number} count of test declarations
 */
export function countTestDeclarations(text, ext) {
  if (ext === ".ts" || ext === ".tsx") {
    const stripped = text.replace(TS_COMMENT_RE, "");
    let count = 0;
    for (const m of stripped.matchAll(TS_DECL_RE)) {
      // Skip plain `describe(` (a group, not a case). `describe.each(` does count.
      if (m[1] === "describe" && !m[2]) continue;
      count += 1;
    }
    return count;
  }
  if (ext === ".py") {
    const stripped = text.replace(PY_COMMENT_RE, "");
    return [...stripped.matchAll(PY_DECL_RE)].length;
  }
  return 0;
}

/**
 * Lists tracked test files via `git ls-files`. Uses git (not fs walk) so that
 * node_modules / .next / .claude/worktrees are naturally excluded without
 * per-directory ignore logic.
 *
 * Excludes `tests/*.e2e.test.ts` to mirror vitest.config.ts L18-23.
 *
 * @param {string} repoRoot absolute path to the repo root
 * @returns {string[]} relative paths (POSIX-style separators from git)
 */
export function walkTestFiles(repoRoot) {
  const stdout = execFileSync(
    "git",
    ["--no-optional-locks", "ls-files", "*.test.ts", "*.test.tsx", "api/tests/test_*.py"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const lines = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.filter((p) => !/\.e2e\.test\.tsx?$/.test(p));
}

/**
 * @typedef {{ path: string, count: number }} TestFileCount
 */

/**
 * Returns the sorted list of test files with their declaration counts.
 *
 * @param {string} repoRoot
 * @returns {TestFileCount[]}
 */
export function countAllTestFiles(repoRoot) {
  const out = [];
  for (const relPath of walkTestFiles(repoRoot)) {
    const abs = pathResolve(repoRoot, relPath);
    const text = readFileSync(abs, "utf8");
    const dot = relPath.lastIndexOf(".");
    const ext = dot === -1 ? "" : relPath.slice(dot);
    const count = countTestDeclarations(text, ext);
    out.push({ path: relPath, count });
  }
  // Locale-pinned to "en" so Windows + CI Linux ordering matches.
  out.sort((a, b) => a.count - b.count || a.path.localeCompare(b.path, "en"));
  return out;
}

/**
 * @param {string} repoRoot
 * @param {number} threshold
 * @returns {TestFileCount[]}
 */
export function findSubThresholdFiles(repoRoot, threshold = THRESHOLD) {
  return countAllTestFiles(repoRoot).filter((r) => r.count < threshold);
}

function main() {
  try {
    const all = countAllTestFiles(REPO_ROOT);
    const subThreshold = all.filter((r) => r.count < THRESHOLD);
    const widthPath = Math.max(...all.map((r) => r.path.length));
    const lines = ["test-count-vs-precedent floor", `  threshold = ${THRESHOLD} declarations`, ""];
    if (subThreshold.length === 0) {
      lines.push("  (no sub-threshold files; gate is the vitest test under `npm run check`)");
    } else {
      lines.push("  sub-threshold files (must be in KNOWN_SMALL_FILES or gate fails):");
      for (const r of subThreshold) {
        const allowed = KNOWN_SMALL_FILES.some((k) => k.path === r.path);
        lines.push(
          `    ${r.path.padEnd(widthPath)}  ${String(r.count).padStart(3)}  ${
            allowed ? "(allowlisted)" : "(*** NOT ALLOWLISTED ***)"
          }`,
        );
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
  } catch (err) {
    // Script is advisory — failures here shouldn't kill `npm run check`.
    // The vitest test is the gate; if THAT errors, the test framework reports
    // the underlying issue properly. Loud banner so this doesn't silently
    // scroll past in a 60-second pre-push gate run.
    const msg = err instanceof Error ? err.message : String(err);
    const banner = "*".repeat(72);
    process.stderr.write(
      `\n${banner}\n` +
        `*** precheck-test-count-vs-precedent: SCRIPT INTERNAL ERROR\n` +
        `*** ${msg}\n` +
        `*** Advisory exit-0 preserved; the vitest gate at\n` +
        `*** tests/scripts/precheck-test-count-vs-precedent.test.ts\n` +
        `*** is the real enforcement and will fail loudly if affected.\n` +
        `${banner}\n\n`,
    );
  }
  process.exit(0);
}

// Standard "run when invoked as a script" check. Works on Windows + Unix.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
