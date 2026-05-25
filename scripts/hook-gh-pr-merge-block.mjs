#!/usr/bin/env node
// Claude Code PreToolUse hook for the Bash tool. Blocks any `gh pr merge`
// invocation — including `--auto` — with exit 2. Mechanical floor for
// WORKFLOW.md "Claude never merges its own PRs". PR #35 auto-merge
// incident (2026-05-16) was the codifying recurrence.
//
// Known bypass classes (consistent with sibling hook-gh-pr-create-precheck.mjs):
//   - `bash -c "gh pr merge ..."`  (subshell as first token, not gh)
//   - `$(gh pr merge ...)` / `` `gh pr merge ...` ``  (command substitution)
//   - Anything that hides the literal `gh pr merge` from the segment-anchor
// These are out of scope; the floor is "best effort against accidental
// direct invocation", same posture as the create-side floor.

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Keep in sync with scripts/hook-gh-pr-create-precheck.mjs splitShellSegments
// — extract to a shared module on the 3rd consumer.
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

// Keep in sync with scripts/hook-gh-pr-create-precheck.mjs stripCommentSegment.
function stripCommentSegment(segment) {
  if (segment.startsWith("#")) return null;
  return segment;
}

function isGhPrMergeSegment(segment) {
  const stripped = stripCommentSegment(segment);
  if (!stripped) return false;
  // Drop leading env-var assignments like FOO=bar BAR=baz gh pr merge ...
  const s = stripped.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  return /^gh(\s+--?\S+)*\s+pr(\s+--?\S+)*\s+merge\b/.test(s);
}

function hasAutoFlag(segment) {
  return /\s--auto\b/.test(segment);
}

const payload = readStdinJson();
if (!payload) process.exit(0);

const toolName = payload.tool_name || payload.toolName;
if (toolName !== "Bash") process.exit(0);

const rawCommand = payload.tool_input?.command || payload.toolInput?.command || "";
if (!rawCommand) process.exit(0);

const segments = splitShellSegments(rawCommand);
const mergeSegment = segments.find(isGhPrMergeSegment);
if (!mergeSegment) process.exit(0);

const autoNote = hasAutoFlag(mergeSegment)
  ? "Includes --auto — auto-merge queues a merge without the user's click; this was the PR #35 incident that codified the rule."
  : "";

const errMsg = [
  "PR merge blocked by hook-gh-pr-merge-block.",
  "",
  "WORKFLOW.md: Claude never merges its own PRs — the user's click on Merge in the GitHub UI is the gate that forces second-look discipline (see Step 7b Amplified sub-rule).",
  autoNote,
  "",
  "If you genuinely need to run `gh pr merge` yourself (rare), do it from a shell outside Claude Code.",
  "For `gh pr merge --help`, run it in a separate terminal.",
]
  .filter(Boolean)
  .join("\n");

process.stderr.write(errMsg);
process.exit(2);
