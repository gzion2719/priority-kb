#!/usr/bin/env node
// Claude Code PostToolUse hook for the Write and Edit tools. Runs
// `prettier --write --ignore-unknown` against the file Claude just wrote
// or edited, so the next `npm run check` (which runs `prettier --check .`)
// doesn't fail on cosmetic drift that should have been formatted on the
// way out.
//
// Wired in .claude/settings.json under hooks.PostToolUse for matcher
// `Write|Edit`. The matcher uses the documented exact-string-alternation
// form (Claude Code hooks docs: a matcher containing only letters,
// digits, `_`, and `|` is treated as a `|`-separated exact-string list,
// not a regex). The script-side `toolName` guard below is defensive
// belt-and-braces and mirrors scripts/hook-gh-pr-create-precheck.mjs:122.
//
// Defense-in-depth shape (same shape as — but not the same kind of floor
// as — ADR-0004 docs/adr/0004-pr-title-mechanical-floor.md, which is a
// BLOCKING floor on PR titles. This hook is best-effort: prettier on a
// half-written file must not cascade, so the hook never blocks):
//   Convenience layer — this PostToolUse hook    (format on write)
//   Local gate        — `npm run format:check`   (catch on pre-push)
//                       inside `npm run check`
//   CI gate           — `npm run format:check`   (catch on PR)
//                       in .github/workflows/ci.yml
// The two gates already exist; this convenience layer closes the
// format-on-the-way-out gap that produced the recurring "prettier-retry"
// friction in the closing rituals of 2026-05-18 and 2026-05-19.
//
// PostToolUse semantics:
//   • The hook fires AFTER the Write/Edit tool has already mutated the
//     filesystem. It cannot prevent the original write — that's a
//     PreToolUse concern.
//   • The hook does NOT block the agent loop on exit code; exit 2 only
//     surfaces stderr to Claude (per the Claude Code hooks docs).
//     We exit 0 unconditionally — formatting is cosmetic; a transient
//     prettier failure on a half-written file must not cascade.
//   • Recursive-loop concern: PostToolUse fires on AGENT tool calls, not
//     on filesystem writes. When prettier rewrites the file, no new tool
//     call is dispatched, so the hook does not re-fire on itself.
//
// Future extension: when MultiEdit lands in the documented Claude Code
// hook surface, extend the matcher in .claude/settings.json AND the
// toolName guard below. NotebookEdit uses tool_input.notebook_path
// (not file_path) and is out of scope for this hook.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function log(msg) {
  process.stderr.write(`[hook-prettier] ${msg}\n`);
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// path.relative + normalization for the outside-repo check. On Windows,
// case-insensitive drive letters and short-vs-long names defeat naive
// startsWith(repoRoot). path.relative computes the actual difference;
// an outside-repo path produces a result that either starts with `..`
// or is itself absolute (different drive).
function isInsideRepoRoot(abs) {
  const rel = relative(repoRoot, abs);
  if (!rel) return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

const payload = readStdinJson();
if (!payload) process.exit(0); // Nothing to act on; pass through silently.

const toolName = payload.tool_name || payload.toolName;
if (toolName !== "Write" && toolName !== "Edit") process.exit(0);

const filePath =
  payload.tool_input?.file_path ||
  payload.toolInput?.file_path ||
  payload.tool_input?.filePath ||
  payload.toolInput?.filePath;
if (!filePath || typeof filePath !== "string") process.exit(0);

const absPath = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);

if (!isInsideRepoRoot(absPath)) {
  // Edits to files outside the repo (e.g., memory files under the user's
  // ~/.claude) are not subject to this project's prettier config. Skip.
  process.exit(0);
}

// Probe for a locally-installed prettier. We deliberately avoid `npx` —
// on Windows it resolves through a `.cmd` shim that interacts badly with
// spawnSync's argv-passing (no shell:true), and forcing shell:true would
// re-introduce quoting concerns on a path whose root contains a space
// (the OneDrive root). Direct-node invocation mirrors the sibling hook
// at scripts/hook-gh-pr-create-precheck.mjs:139.
//
// Test-only overrides (BOTH clearly suffixed `_FOR_TESTS`):
//   • PRETTIER_HOOK_BIN_FOR_TESTS — substitute the prettier bin path,
//     so tests/hook-prettier-write.test.ts can point at a hang stub to
//     drive the ETIMEDOUT branch below without monkey-patching
//     node_modules.
//   • PRETTIER_HOOK_TIMEOUT_MS_FOR_TESTS — substitute the 10_000ms
//     spawnSync timeout, so the ETIMEDOUT test runs in ~250ms instead
//     of waiting 10s. Parsed defensively: NaN / non-positive / missing
//     all fall back to the 10s default so a typo in the env var name
//     can't silently drop the timeout (which is exactly the bug class
//     the test exists to catch).
const prettierBin =
  process.env.PRETTIER_HOOK_BIN_FOR_TESTS ??
  resolve(repoRoot, "node_modules/prettier/bin/prettier.cjs");

const timeoutOverrideRaw = process.env.PRETTIER_HOOK_TIMEOUT_MS_FOR_TESTS;
const timeoutOverrideParsed = timeoutOverrideRaw ? Number(timeoutOverrideRaw) : NaN;
const timeoutMs =
  Number.isFinite(timeoutOverrideParsed) && timeoutOverrideParsed > 0
    ? timeoutOverrideParsed
    : 10_000;
if (!existsSync(prettierBin)) {
  // No local prettier (e.g., a freshly-cut worktree without `npm install`
  // yet). Best-effort: log once and exit 0; the gate will catch any
  // formatting drift on push.
  log(`prettier not installed at ${prettierBin} — skip`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [prettierBin, "--write", "--ignore-unknown", absPath], {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: timeoutMs,
});

const relPath = relative(repoRoot, absPath) || absPath;

// Silent on success (the dominant case — including .prettierignore'd files,
// for which prettier exits 0 cleanly with no rewrite). Log only when the
// hook noticed something worth surfacing: a timeout, a spawn error, or a
// non-zero exit from prettier itself (parse failure, internal error).
if (result.error) {
  if (result.error.code === "ETIMEDOUT") {
    log(`timeout (${timeoutMs / 1000}s) — skipped ${relPath}`);
  } else {
    log(`spawn-error ${relPath}: ${result.error.code || result.error.message}`);
  }
} else if (result.status !== 0) {
  const errSnippet = (result.stderr || result.stdout || "").trim().split("\n")[0] || "unknown";
  log(`failed ${relPath}: ${errSnippet}`);
}

process.exit(0);
