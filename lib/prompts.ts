// lib/prompts.ts — agent-prompt provenance.
//
// Iron rule #10: prompts live in prompts/*.md in git, hashed; the hash is
// stored alongside every agent response. This module is the single source
// of the hash. Callers MUST NOT accept a prompt_hash from user input or
// recompute it ad-hoc — they import the module-level constant. That is
// the mechanical floor that distinguishes "agent wrote the canonical
// hash" from "agent wrote any 64-hex string".
//
// Hash format: lowercase hex SHA-256, 64 chars. DO NOT switch to base64
// without coordinating with `audit_log.prompt_hash` readers — the column
// is `text` and downstream tooling will parse the value as hex.
//
// Resolution model: hash is sealed at process boot via a top-level
// `readFileSync`. If `prompts/ingestion-agent.md` is edited mid-process,
// in-flight requests after the edit still write the boot-time hash.
// Treat the prompt file as append-only between deploys; an edit + redeploy
// is the supported way to bump the canonical hash.
//
// Path resolution uses `import.meta.url` rather than `process.cwd()` so
// the file is found relative to the compiled module, not relative to the
// shell that started the server. (process.cwd() is unreliable under
// Next.js standalone output where cwd is .next/standalone/.) When Next.js
// hosting lands (M5), `prompts/*.md` must be added to
// outputFileTracingIncludes so it gets bundled — captured in BACKLOG.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Compute the canonical SHA-256 hash (lowercase hex) of a prompt file's
 * bytes. Hashes the raw Buffer — not a utf8-decoded string — so the
 * result is immune to JS string-decoder quirks (BOM stripping, surrogate
 * normalization) that could silently change the hash across Node versions.
 *
 * Throws (NodeJS.ErrnoException with code "ENOENT") if the path is missing.
 */
export function loadPromptHash(absPath: string): string {
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

/** Absolute path to the ingestion-agent system prompt. */
export const INGESTION_AGENT_PROMPT_PATH = fileURLToPath(
  new URL("../prompts/ingestion-agent.md", import.meta.url),
);

/**
 * Canonical SHA-256 hex of the ingestion-agent system prompt, sealed at
 * process boot. Stored on every `audit_log` row written via the agent
 * path (`kind:"agent_ingest"` / `"agent_ingest_update"`). The DB CHECK
 * `audit_log_prompt_hash_required_for_agent` is the storage-layer
 * backstop; this constant is the application-layer source.
 */
export const INGESTION_AGENT_PROMPT_HASH = loadPromptHash(INGESTION_AGENT_PROMPT_PATH);
