#!/usr/bin/env node
// Validates a proposed PR title against commitlint.config.cjs — the
// single source of truth shared with the pre-commit commit-msg hook
// (see .pre-commit-config.yaml) and aligned with
// .github/workflows/pr-title.yml. Run before every `gh pr create`.
//
// Usage:
//   node scripts/precheck-pr-title.mjs "<proposed title>"
//
// Exit 0 = title is acceptable. Exit 1 = title rejected (commitlint
// errors printed on stderr).
//
// See docs/adr/0004-pr-title-mechanical-floor.md for design + history.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const title = process.argv.slice(2).join(" ").trim();
if (!title) {
  process.stderr.write(
    "precheck-pr-title: empty title (pass as argv: node scripts/precheck-pr-title.mjs <title>)\n",
  );
  process.exit(1);
}

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--no-install", "commitlint", "--config", "commitlint.config.cjs"],
  {
    cwd: repoRoot,
    input: title + "\n",
    encoding: "utf8",
    shell: process.platform === "win32",
  },
);

if (result.error) {
  process.stderr.write(`precheck-pr-title: failed to run commitlint (${result.error.message})\n`);
  process.exit(1);
}

if (result.status === 0) {
  process.exit(0);
}

process.stderr.write(`precheck-pr-title: title rejected — "${title}"\n`);
if (result.stdout) process.stderr.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(1);
