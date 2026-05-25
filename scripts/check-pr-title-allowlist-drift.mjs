#!/usr/bin/env node
// scripts/check-pr-title-allowlist-drift.mjs
//
// Mechanical floor for the "PR-title type allowlist drift" class. ADR-0004
// declares `commitlint.config.cjs` `type-enum` as THE source of truth; the
// same allowlist is duplicated across 3 other surfaces and historically
// nothing enforced that they stay in sync. Concrete failure mode this
// prevents: someone adds a new conventional-commit type (e.g. `perf`) to
// `commitlint.config.cjs` + `pr-title.yml` but forgets the normalizer's
// shell regex; the normalizer's `prefix_re` no longer matches, so a
// `Perf: …` title silently skips Layer 2 normalization and falls through
// to Layer 3 validate (which rejects it).
//
// Surfaces parsed (in declared scope):
//   1. commitlint.config.cjs                         — rule (source of truth)
//   2. .github/workflows/pr-title.yml                — workflow input
//   3. .github/workflows/pr-title-normalize.yml      — shell regex prefix_re
//   4. scripts/hook-gh-pr-create-precheck.mjs        — error-message string
//
// Exit 0 = aligned; exit 1 = drift detected (diff printed to stderr).
//
// Cross-refs: ADR-0004 §"Revisit triggers" line on this script;
// docs/adr/0004-pr-title-mechanical-floor.md Amendment 2026-05-25 — drift floor.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, resolve as pathResolve } from "node:path";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = pathResolve(__dirname, "..");
const require = createRequire(import.meta.url);

export const COMMITLINT_CONFIG_PATH = pathResolve(repoRoot, "commitlint.config.cjs");
export const PR_TITLE_YML_PATH = pathResolve(repoRoot, ".github/workflows/pr-title.yml");
export const PR_TITLE_NORMALIZE_YML_PATH = pathResolve(
  repoRoot,
  ".github/workflows/pr-title-normalize.yml",
);
export const HOOK_PRECHECK_PATH = pathResolve(repoRoot, "scripts/hook-gh-pr-create-precheck.mjs");

/**
 * Loads commitlint.config.cjs via `require()` (not regex) and returns the
 * type-enum rule's allowlist array. Runtime-load is robust to any refactor
 * (extracted constant, spread, conditional rules) that a regex parser would
 * silently miss.
 *
 * @param {string} configPath absolute path to commitlint.config.cjs
 * @returns {string[]} the type allowlist (e.g. ["feat","fix",...])
 */
export function parseCommitlintTypes(configPath) {
  // Bust require cache so repeated calls in tests pick up file mutations.
  delete require.cache[configPath];
  const config = require(configPath);
  const rule = config?.rules?.["type-enum"];
  if (!Array.isArray(rule) || rule.length < 3 || !Array.isArray(rule[2])) {
    throw new Error(
      `commitlint.config.cjs: type-enum rule shape unexpected — got ${JSON.stringify(rule)}`,
    );
  }
  return [...rule[2]];
}

/**
 * Parses pr-title.yml as YAML (not regex) and reads the `types:` input under
 * `jobs.validate.steps[].with.types`. The value is a literal-block string with
 * one type per line; split + trim.
 *
 * @param {string} yamlText file contents
 * @returns {string[]} the types declared in the workflow input
 */
export function parsePrTitleWorkflowTypes(yamlText) {
  const parsed = YAML.parse(yamlText);
  const steps = parsed?.jobs?.validate?.steps;
  if (!Array.isArray(steps)) {
    throw new Error("pr-title.yml: jobs.validate.steps not found");
  }
  const stepWithTypes = steps.find((s) => s && typeof s === "object" && s.with && s.with.types);
  if (!stepWithTypes) {
    throw new Error("pr-title.yml: no step under jobs.validate.steps has `with.types`");
  }
  const value = stepWithTypes.with.types;
  // YAML can deliver `types` as either an array (flow syntax `[a, b, c]` or
  // block-list `- a\n- b`) or a string (literal block `|` with one per line).
  // Handle both shapes so a future reformat doesn't silently mis-parse.
  if (Array.isArray(value)) {
    return value.map((s) => String(s).trim()).filter(Boolean);
  }
  return String(value)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses pr-title-normalize.yml's shell regex `prefix_re='^((TYPE|TYPE|...)(...))...'`
 * and extracts the alternation group's pipe-separated types. The regex is
 * an inline shell string assignment, so a YAML pass followed by a string
 * search is the cleanest extraction.
 *
 * @param {string} yamlText file contents
 * @returns {string[]} the types declared in the normalizer's regex
 */
export function parsePrTitleNormalizeRegexTypes(yamlText) {
  // The script body sits inside `jobs.normalize.steps[0].run` as a literal
  // shell heredoc. Grep for the prefix_re assignment line.
  const m = yamlText.match(/prefix_re='\^\(\(([^)]+)\)/);
  if (!m) {
    throw new Error(
      "pr-title-normalize.yml: prefix_re alternation group not found (expected pattern ^((TYPE|TYPE...)(...))",
    );
  }
  return m[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses the hook script's error-message string — an inline `(a|b|c)`
 * alternation embedded in a user-facing diagnostic. Cosmetic-only surface
 * (doesn't gate behavior), but included so that the error message stays
 * truthful when new types are added.
 *
 * @param {string} hookText file contents
 * @returns {string[]} the types named in the hook's error message
 */
export function parseHookErrorMessageTypes(hookText) {
  // Anchor on the surrounding phrase to avoid matching any other alternation
  // group that might appear in the hook script.
  const m = hookText.match(/allowlist \(([^)]+)\)/);
  if (!m) {
    throw new Error(
      "hook-gh-pr-create-precheck.mjs: 'allowlist (TYPE|TYPE...)' error-message phrase not found",
    );
  }
  return m[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Compares a set of named (label, types[]) pairs. The first pair is the
 * source of truth; every other pair is compared to it. Returns the per-pair
 * drift breakdown.
 *
 * @param {Array<{label: string, types: string[]}>} surfaces
 * @returns {{
 *   ok: boolean,
 *   sourceLabel: string,
 *   drifts: Array<{label: string, missingFromHere: string[], extraHere: string[]}>
 * }}
 */
export function compareTypeLists(surfaces) {
  if (surfaces.length < 2) {
    throw new Error("compareTypeLists requires at least 2 surfaces");
  }
  const [source, ...rest] = surfaces;
  const sourceSet = new Set(source.types);
  const drifts = [];
  for (const surface of rest) {
    const here = new Set(surface.types);
    const missingFromHere = [...sourceSet].filter((t) => !here.has(t)).sort();
    const extraHere = [...here].filter((t) => !sourceSet.has(t)).sort();
    drifts.push({ label: surface.label, missingFromHere, extraHere });
  }
  const ok = drifts.every((d) => d.missingFromHere.length === 0 && d.extraHere.length === 0);
  return { ok, sourceLabel: source.label, drifts };
}

/**
 * Formats a compareTypeLists result as an actionable, human-readable diff.
 * Returns empty string when ok: true.
 */
export function formatDriftMessage(result) {
  if (result.ok) return "";
  const lines = [
    `PR-title type-enum allowlist DRIFT detected.`,
    `Source of truth: ${result.sourceLabel}`,
    "",
  ];
  for (const d of result.drifts) {
    if (d.missingFromHere.length === 0 && d.extraHere.length === 0) continue;
    lines.push(`  ${d.label}:`);
    if (d.missingFromHere.length > 0) {
      lines.push(`    missing: ${d.missingFromHere.join(", ")}`);
    }
    if (d.extraHere.length > 0) {
      lines.push(`    extra:   ${d.extraHere.join(", ")}`);
    }
  }
  lines.push("");
  lines.push("Fix: add the missing types to each named surface (or remove the extras).");
  lines.push("All 4 surfaces must carry the same type list. See ADR-0004 Amendment 2026-05-25.");
  return lines.join("\n");
}

export function readAllSurfaces({
  commitlintPath = COMMITLINT_CONFIG_PATH,
  prTitlePath = PR_TITLE_YML_PATH,
  prTitleNormalizePath = PR_TITLE_NORMALIZE_YML_PATH,
  hookPath = HOOK_PRECHECK_PATH,
} = {}) {
  return [
    { label: "commitlint.config.cjs", types: parseCommitlintTypes(commitlintPath) },
    {
      label: ".github/workflows/pr-title.yml",
      types: parsePrTitleWorkflowTypes(readFileSync(prTitlePath, "utf8")),
    },
    {
      label: ".github/workflows/pr-title-normalize.yml",
      types: parsePrTitleNormalizeRegexTypes(readFileSync(prTitleNormalizePath, "utf8")),
    },
    {
      label: "scripts/hook-gh-pr-create-precheck.mjs",
      types: parseHookErrorMessageTypes(readFileSync(hookPath, "utf8")),
    },
  ];
}

function main() {
  const surfaces = readAllSurfaces();
  const result = compareTypeLists(surfaces);
  if (result.ok) {
    return;
  }
  process.stderr.write(formatDriftMessage(result) + "\n");
  process.exit(1);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-pr-title-allowlist-drift.mjs")
) {
  main();
}
