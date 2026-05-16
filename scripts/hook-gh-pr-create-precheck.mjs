#!/usr/bin/env node
// Claude Code PreToolUse hook for the Bash tool. Intercepts any
// `gh pr create` invocation, extracts the --title argument, and runs
// scripts/precheck-pr-title.mjs against it. Blocks the tool call if the
// title would fail .github/workflows/pr-title.yml.
//
// Wired in .claude/settings.json under hooks.PreToolUse for matcher
// "Bash". Mechanical floor on top of the prose Title-allowlist sub-rule
// in SESSION_PROTOCOL.md — fires without Claude's intervention.
//
// See docs/adr/0004-pr-title-mechanical-floor.md.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Split a shell command into "logical" segments (commands separated by
// `&&`, `||`, `;`, `|`, or newline), being careful not to split inside
// single or double quotes. Returns an array of trimmed segments.
function splitShellSegments(command) {
  const segments = [];
  let buf = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote) {
      buf += c;
      if (c === "\\" && next) {
        buf += next;
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "\n" || c === ";") {
      segments.push(buf);
      buf = "";
      continue;
    }
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
      segments.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (c === "|") {
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf) segments.push(buf);
  return segments.map((s) => s.trim()).filter(Boolean);
}

// Strip a leading shell-comment marker if the segment starts with one.
// Also returns null when the segment is purely a comment.
function stripCommentSegment(segment) {
  if (segment.startsWith("#")) return null;
  return segment;
}

// A segment is a `gh pr create` invocation if, after dropping leading
// env-var assignments and the optional command-substitution prefixes,
// the first token chain begins with `gh` and is followed by `pr` and
// `create` within the next few tokens (gh accepts global flags between
// the binary and the subcommand).
function isGhPrCreateSegment(segment) {
  const stripped = stripCommentSegment(segment);
  if (!stripped) return false;
  // Drop leading env-var assignments like FOO=bar BAR=baz gh pr create
  let s = stripped.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  // Anchor: gh must be at the START of the segment, not anywhere in it.
  return /^gh(\s+--?\S+)*\s+pr(\s+--?\S+)*\s+create\b/.test(s);
}

function extractTitle(command) {
  // Quoted forms are the only reliable extraction. Bare-unquoted --title
  // values are ambiguous (multi-word titles silently truncate at the
  // first space), so we don't try — gh's own handling will route the
  // command and CI will catch any leak.
  const patterns = [
    /--title[=\s]+"((?:[^"\\]|\\.)*)"/,
    /--title[=\s]+'((?:[^'\\]|\\.)*)'/,
    /\s-t\s+"((?:[^"\\]|\\.)*)"/,
    /\s-t\s+'((?:[^'\\]|\\.)*)'/,
  ];
  for (const re of patterns) {
    const m = command.match(re);
    if (m) return m[1];
  }
  return null;
}

const payload = readStdinJson();
if (!payload) process.exit(0); // Nothing to validate; let the call through.

const toolName = payload.tool_name || payload.toolName;
if (toolName !== "Bash") process.exit(0);

const rawCommand = payload.tool_input?.command || payload.toolInput?.command || "";
if (!rawCommand) process.exit(0);

const segments = splitShellSegments(rawCommand);
const ghSegment = segments.find(isGhPrCreateSegment);
if (!ghSegment) process.exit(0);

const title = extractTitle(ghSegment);
if (!title) {
  // `gh pr create` without --title (or with a bare-unquoted --title):
  // gh will pull the title from the head commit's message, which goes
  // through the commitlint commit-msg hook. Let the call through.
  process.exit(0);
}

const result = spawnSync(process.execPath, [resolve(__dirname, "precheck-pr-title.mjs"), title], {
  cwd: repoRoot,
  encoding: "utf8",
});

if (result.status === 0) process.exit(0);

const errMsg = [
  "PR title blocked by precheck-pr-title hook.",
  `Title: "${title}"`,
  "",
  "This title would fail .github/workflows/pr-title.yml.",
  "Fix the --title argument and retry, or run:",
  `  node scripts/precheck-pr-title.mjs "<your title>"`,
  "",
  "Common fixes: lowercase the first char of the subject;",
  "use a type from the allowlist (feat|fix|chore|docs|refactor|test|ci|release).",
  "",
  result.stderr || "",
].join("\n");

process.stderr.write(errMsg);
process.exit(2);
