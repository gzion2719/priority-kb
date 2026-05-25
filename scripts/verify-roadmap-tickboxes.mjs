#!/usr/bin/env node
// Mechanical floor for the "previous-session Next session: line names a focus
// that's actually already shipped" stale-pointer class. See docs/BACKLOG.md
// "verify-roadmap-tickboxes" entry + SESSION_PROTOCOL.md Step 6
// verify-before-recommending sub-rule.
//
// Scope (v1): markdown links of the form [text](relative/path.ext) inside
// unchecked `- [ ]` tickboxes in docs/ROADMAP.md, where `.ext` is a
// "claim-shaped" extension (code/test/eval/style). A tickbox is a stale
// candidate when ≥1 such link resolves to an existing file in the repo.
//
// Non-goals (queued in BACKLOG):
//   - Backtick-only path references like `pyproject.toml` with no markdown link.
//   - Symbol-name references like `RETRIEVAL_AGENT_PROMPT_HASH`.
//   - `.md` links (treated as reference/precondition pointers, never claims).
//
// Gate: this script is advisory (exits 0). The vitest test at
// tests/scripts/verify-roadmap-tickboxes.test.ts is the gate — it runs under
// `npm run check` via vitest and fails when a new candidate appears outside
// its KNOWN_PENDING_TICKBOXES allowlist.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLAIM_EXTS = new Set([".ts", ".tsx", ".mjs", ".js", ".yaml", ".yml", ".sql", ".css", ".ps1"]);

const LINK_RE = /\]\(([^)\s]+)\)/g;
const EXT_RE = /\.[A-Za-z0-9]+$/;

export function parseTickboxes(roadmapText) {
  const lines = roadmapText.split(/\r?\n/);
  const tickboxes = [];
  let current = null;

  const flush = () => {
    if (current) tickboxes.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tickMatch = line.match(/^- \[([ xX])\] (.*)$/);
    if (tickMatch) {
      flush();
      current = {
        lineNumber: i + 1,
        checked: tickMatch[1] !== " ",
        firstLine: tickMatch[2],
        body: tickMatch[2],
      };
      continue;
    }
    if (!current) continue;
    if (line === "" || /^- \[/.test(line) || /^#{1,6} /.test(line)) {
      flush();
      continue;
    }
    current.body += "\n" + line;
  }
  flush();
  return tickboxes;
}

function normalizeSep(p) {
  return sep === "\\" ? p.replace(/\//g, "\\") : p;
}

export function extractLinkPaths(body) {
  const out = [];
  for (const m of body.matchAll(LINK_RE)) {
    const raw = m[1];
    if (/^[a-z]+:/i.test(raw)) continue;
    if (raw.startsWith("#")) continue;
    out.push(raw.split("#")[0]);
  }
  return out;
}

function resolveLink(rawPath, repoRoot, roadmapDir) {
  const stripped = rawPath.replace(/^(\.\.\/)+/, "");
  const candidates = [
    pathResolve(repoRoot, normalizeSep(stripped)),
    pathResolve(roadmapDir, normalizeSep(rawPath)),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function findStaleCandidates({ roadmapPath, repoRoot }) {
  const text = readFileSync(roadmapPath, "utf8");
  const roadmapDir = dirname(roadmapPath);
  const tickboxes = parseTickboxes(text);
  const out = [];
  for (const tb of tickboxes) {
    if (tb.checked) continue;
    const links = extractLinkPaths(tb.body);
    const resolvedClaims = [];
    for (const rawPath of links) {
      const ext = (rawPath.match(EXT_RE) || [""])[0].toLowerCase();
      if (!CLAIM_EXTS.has(ext)) continue;
      const resolved = resolveLink(rawPath, repoRoot, roadmapDir);
      if (resolved) resolvedClaims.push({ rawPath, resolved });
    }
    if (resolvedClaims.length > 0) {
      out.push({
        lineNumber: tb.lineNumber,
        firstLine: tb.firstLine,
        resolvedClaims,
      });
    }
  }
  return out;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = pathResolve(here, "..");
  const roadmapPath = pathResolve(repoRoot, "docs", "ROADMAP.md");
  const candidates = findStaleCandidates({ roadmapPath, repoRoot });
  if (candidates.length === 0) {
    console.log("No stale-tickbox candidates found.");
    return;
  }
  console.log(
    `${candidates.length} unchecked tickbox(es) reference existing claim-shaped artifacts:`,
  );
  for (const c of candidates) {
    console.log(`\n  L${c.lineNumber}: ${c.firstLine}`);
    for (const claim of c.resolvedClaims) {
      console.log(`    → ${claim.rawPath}`);
    }
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("verify-roadmap-tickboxes.mjs")
) {
  main();
}
