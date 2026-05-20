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

/**
 * UTF-8-decoded text of the ingestion-agent system prompt, sealed at
 * process boot. This is the `system_prompt` value the SSE agent route
 * (ADR-0010 §1) feeds to `AgentClient.streamMessages`.
 *
 * **Iron rule #10 provenance guarantee:** the hash above is computed on
 * the raw on-disk Buffer; this constant is the UTF-8-decoded form. If
 * the file contained a BOM or used a different newline encoding from
 * what the bytes-to-string round-trip preserves, `sha256(string)` would
 * differ from `INGESTION_AGENT_PROMPT_HASH` and we would silently ship a
 * prompt whose provenance claim is wrong. The assertion at module init
 * below proves byte-identity by re-hashing the UTF-8 encoding of the
 * decoded string and comparing to the canonical hex; mismatch throws
 * `RangeError` at boot, refusing to start the process.
 *
 * Hashing the *decoded then re-encoded* string is the symmetric check:
 * if it equals the buffer hash, then the string we send to Anthropic is
 * the same byte sequence we hashed for the audit log.
 */
export const INGESTION_AGENT_PROMPT: string = readFileSync(INGESTION_AGENT_PROMPT_PATH, "utf8");

const _PROMPT_ROUNDTRIP_HASH = createHash("sha256")
  .update(Buffer.from(INGESTION_AGENT_PROMPT, "utf8"))
  .digest("hex");

if (_PROMPT_ROUNDTRIP_HASH !== INGESTION_AGENT_PROMPT_HASH) {
  throw new RangeError(
    `INGESTION_AGENT_PROMPT byte-roundtrip hash mismatch: ` +
      `buffer-hash=${INGESTION_AGENT_PROMPT_HASH} ` +
      `string-roundtrip-hash=${_PROMPT_ROUNDTRIP_HASH}. ` +
      `Iron rule #10 provenance would silently break — refusing to boot. ` +
      `Likely cause: prompts/ingestion-agent.md has a BOM or non-UTF-8 bytes.`,
  );
}

/** Absolute path to the retrieval-agent system prompt. */
export const RETRIEVAL_AGENT_PROMPT_PATH = fileURLToPath(
  new URL("../prompts/retrieval-agent.md", import.meta.url),
);

/**
 * Canonical SHA-256 hex of the retrieval-agent system prompt, sealed at
 * process boot. Will be stored on every `audit_log` row written through
 * the retrieval path (`kind:"agent_retrieval"`) once M3 item 3 lands the
 * retrieval pipeline + audit-row writer. The DB CHECK
 * `audit_log_prompt_hash_required_for_agent` is the storage-layer
 * backstop; this constant is the application-layer source.
 *
 * Resolution model mirrors INGESTION_AGENT_PROMPT_HASH: if
 * `prompts/retrieval-agent.md` is edited mid-process, in-flight requests
 * after the edit still write the boot-time hash. Treat the prompt file
 * as append-only between deploys; an edit + redeploy is the supported
 * way to bump the canonical hash.
 *
 * Path resolution uses `import.meta.url` rather than `process.cwd()`,
 * for the same Next-standalone reasons documented at the top of this
 * module. When Next.js hosting lands (M5), `prompts/*.md` must be added
 * to `outputFileTracingIncludes` so it gets bundled — captured in
 * BACKLOG.
 */
export const RETRIEVAL_AGENT_PROMPT_HASH = loadPromptHash(RETRIEVAL_AGENT_PROMPT_PATH);

/**
 * UTF-8-decoded text of the retrieval-agent system prompt, sealed at
 * process boot. Will be the `system_prompt` value the retrieval route
 * (M3 item 3) feeds to `AgentClient.streamMessages`.
 *
 * **Iron rule #10 provenance guarantee:** the hash above is computed on
 * the raw on-disk Buffer; this constant is the UTF-8-decoded form. The
 * assertion at module init below proves byte-identity by re-hashing the
 * UTF-8 encoding of the decoded string and comparing to the canonical
 * hex; mismatch throws `RangeError` at boot, refusing to start the
 * process. Symmetric with the INGESTION_AGENT_PROMPT assertion above.
 */
export const RETRIEVAL_AGENT_PROMPT: string = readFileSync(RETRIEVAL_AGENT_PROMPT_PATH, "utf8");

const _RETRIEVAL_PROMPT_ROUNDTRIP_HASH = createHash("sha256")
  .update(Buffer.from(RETRIEVAL_AGENT_PROMPT, "utf8"))
  .digest("hex");

if (_RETRIEVAL_PROMPT_ROUNDTRIP_HASH !== RETRIEVAL_AGENT_PROMPT_HASH) {
  throw new RangeError(
    `RETRIEVAL_AGENT_PROMPT byte-roundtrip hash mismatch: ` +
      `buffer-hash=${RETRIEVAL_AGENT_PROMPT_HASH} ` +
      `string-roundtrip-hash=${_RETRIEVAL_PROMPT_ROUNDTRIP_HASH}. ` +
      `Iron rule #10 provenance would silently break — refusing to boot. ` +
      `Likely cause: prompts/retrieval-agent.md has a BOM or non-UTF-8 bytes.`,
  );
}
