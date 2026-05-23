// lib/retrieval-retry-prefix.ts — ADR-0012 §5 stricter-prefix constant + hash.
//
// Extracted to its own module so the orchestrator AND the future 2c-iii
// per-reason prefix table (BACKLOG "Per-reason retry-prefix table") both
// consume from one canonical site. The per-reason table will add a sibling
// export `prefixForFailure(v): {prefix, hash}` here without churning the
// orchestrator's import boundary.
//
// The prefix is route-layer scope, NOT part of the hashed retrieval-agent
// prompt. Iron rule #10's `prompt_hash` continues to pin
// RETRIEVAL_AGENT_PROMPT_HASH on every audit row; this prefix's own SHA-256
// is computed at module load and recorded on the audit row as
// `retry_prefix_hash` (null when no retry fired) so the exact retry input
// is reconstructable post-hoc by content-addressing.

import { createHash } from "node:crypto";

/**
 * Single generic stricter system-prompt prefix prepended on retry when the
 * first synth attempt fails mechanical citation validation. Per-reason
 * variants (naming the specific offending IDs back at the model) are queued
 * for sub-slice 2c-iii; the v0.2.0 retrieval-agent prompt already documents
 * the §5 contract, so a single generic reminder is the right floor today.
 */
export const STRICTER_PROMPT_PREFIX =
  "The previous response failed mechanical citation validation per the §5 contract. " +
  "Re-emit the answer respecting these invariants: every factual claim ends with an " +
  "inline citation of the form [entry_id]; the response ends with a single trailing " +
  "Sources: [<uuid>, ...] block on its own last line; the set of inline-cited UUIDs " +
  "equals the set inside the Sources block; every UUID is a valid v4 drawn ONLY from " +
  "the provided entries; no prose follows the Sources block.";

/**
 * SHA-256 (hex) of {@link STRICTER_PROMPT_PREFIX}, sealed at module load.
 * Audit-row `retry_prefix_hash` carries this value when a retry fired and
 * null otherwise. Parallel to RETRIEVAL_AGENT_PROMPT_HASH in lib/prompts.ts.
 *
 * No byte-roundtrip integrity check is paired with this hash (cf. the
 * `_PROMPT_ROUNDTRIP_HASH` assertion at lib/prompts.ts): the prefix is a
 * TypeScript string literal compiled into the module, not a file-read, so
 * the BOM / non-UTF-8 failure mode that motivated the prompts.ts check is
 * unreachable here. A refactor that swaps a different encoding for the
 * `Buffer.from(..., "utf8")` call would silently change the hash.
 */
export const RETRIEVAL_RETRY_PREFIX_HASH = createHash("sha256")
  .update(Buffer.from(STRICTER_PROMPT_PREFIX, "utf8"))
  .digest("hex");
