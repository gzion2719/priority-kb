// lib/retrieval-citations.ts — Stage-D citation validator (iron rule #3 floor).
//
// Pure helper implementing the ADR-0012 §5 mechanical validation pipeline
// against a synth-generated answer string, plus the v0.2.0 retrieval-agent
// prompt set-equality contract (see prompts/retrieval-agent.md lines 62-86).
//
// This file is the SOLE mechanical floor for iron rule #3 ("every retrieval
// answer cites the entries it used; no source = no claim") at the synth
// output boundary. The route layer consumes the discriminated-union failure
// shape below to drive retry-once + degraded-mode mapping; this helper
// does NOT retry, does NOT log, does NOT touch I/O. Logging the validation
// outcome onto the request-level audit row is the route layer's job per
// ADR-0012 §8.
//
// UUID provenance: the schema seeds all entries.id values with the Postgres
// gen_random_uuid() default (drizzle/schema.ts uses .defaultRandom() which
// maps to gen_random_uuid() — see drizzle/migrations/0000_baseline.sql).
// gen_random_uuid() returns RFC-4122 v4 UUIDs, so the v4-pinned regex
// below is exactly right for the production corpus; v1/v3/v5/v7 IDs from
// a hypothetical future schema change would correctly fail validation and
// surface as a load-bearing visible breakage rather than silent drift.
//
// Not enforced here (prompt-level discipline, not mechanical):
// - "Every factual claim ends with `[entry_id]`" — the prompt asks the
//   model to inline-cite each claim, but a claim-without-cite is invisible
//   to a regex-based validator. An answer like "It works." with `Sources: []`
//   surfaces as `sources_block_empty`, not as "missing claim citation".
//   The retry-once prompt prefix at the route layer is the redress path.
//
// Out-of-scope (deferred):
// - Retry-once with stricter system-prompt prefix → route layer per §5.
// - LogEvent emission → route layer per §8.
// - Degraded-mode mapping (`citation_validation_failed` reason_code) →
//   route layer per ADR-0012 §3.
// - Quoted-UUID-in-body false-positive: an entry whose body contains the
//   literal text "[<uuid>]" could appear as an inline citation when the
//   synth quotes the entry body verbatim. Tracked in `docs/BACKLOG.md`;
//   production incidence expected near-zero (entries cite other entries
//   by title in practice), and any false-positive surfaces as
//   `inline_sources_mismatch` not as a silent shipping bug.

/**
 * UUID v4 regex with both version-nibble (`4`) and RFC-4122 variant-nibble
 * (`[89ab]`) pinned. Case-insensitive. Matches the stub synth sentinel
 * `STUB_SYNTH_SENTINEL_UUID = "00000000-0000-4000-8000-000000000000"` at
 * lib/retrieval.ts:91 and the gen_random_uuid() production output shape.
 */
export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Sources-block regex pattern, single source-of-truth string used to build
 * both the non-global parser and the /g detector below. Anchored to
 * start-of-line with NO leading whitespace (the prompt at retrieval-agent.md
 * line 73 says "on its own line" — an indented `   Sources: [...]` is a
 * model formatting error and is rejected here rather than tolerated).
 * Trailing whitespace after `]` is permitted. The /m flag is intentional —
 * `$` must match before a `\n` so the post-match anchor check
 * (`endOfBlock` reaches end-of-trimmed-string) can enforce "last line of
 * your response" defensively.
 */
const SOURCES_BLOCK_PATTERN = String.raw`^Sources:[ \t]*\[([^\]]*)\][ \t]*$`;
const SOURCES_BLOCK_REGEX = new RegExp(SOURCES_BLOCK_PATTERN, "m");

/**
 * Global counterpart used to detect the "multiple Sources blocks" failure
 * mode (a hallucinated double-emission would otherwise let `String.match`
 * silently bind to the first hit while the user sees the second at the
 * answer end) AND to strip ALL Sources blocks from the body in
 * {@link extractInlineCitations}.
 */
const SOURCES_BLOCK_REGEX_G = new RegExp(SOURCES_BLOCK_PATTERN, "gm");

/**
 * Inline-citation regex. Captures any 8-4-4-4-12 hex-shape string inside
 * square brackets in the answer body, MINUS the Sources block (which is
 * stripped before this regex runs). v4 version+variant validation is
 * applied as a SECOND pass on the captures — keeping the bracketed shape
 * liberal at extraction time (hex-only, not v4-shape) means a malformed
 * UUID gets the correct `invalid_uuid` discriminant rather than the
 * misleading `inline_sources_mismatch` it would otherwise get.
 */
const INLINE_CITATION_REGEX =
  /\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]/g;

/**
 * The discriminated-union return shape from {@link validateCitations}.
 *
 * Each failure variant carries the offending IDs (where applicable) so the
 * route layer's retry-once prompt builder can name them without re-running
 * the validator. `inline_sources_mismatch` carries BOTH `inline_only` and
 * `sources_only` to surface the directional asymmetry to the model.
 */
export type CitationValidationResult =
  | { ok: true; ids: string[]; body: string }
  | { ok: false; reason: "sources_block_missing" }
  | { ok: false; reason: "multiple_sources_blocks"; count: number }
  | { ok: false; reason: "trailing_prose_after_sources"; trailing: string }
  | { ok: false; reason: "sources_block_empty" }
  | { ok: false; reason: "invalid_uuid"; offending_ids: string[] }
  | { ok: false; reason: "duplicate_id"; offending_ids: string[] }
  | { ok: false; reason: "hallucinated_id"; offending_ids: string[] }
  | {
      ok: false;
      reason: "inline_sources_mismatch";
      inline_only: string[];
      sources_only: string[];
    };

/**
 * Normalize line endings to LF. Robustness floor against `\r\n` from any
 * upstream provider (Anthropic SDK normalizes to LF, but a future direct-
 * fetch route or a non-Anthropic synth could re-introduce CRLF; cheap
 * to handle uniformly).
 */
function normalize(answer: string): string {
  return answer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Apply {@link SOURCES_BLOCK_REGEX} and return parse output.
 *
 * Returns `null` when no Sources block is found. Otherwise returns the
 * raw match (for body-stripping), the captured bracket-contents string,
 * and the match's start/end indices in the (normalized) answer.
 *
 * Does NOT validate empty/dup/UUID/membership — those run in
 * {@link validateCitations}'s pipeline. This function is exported for
 * route-layer reuse (e.g. logging the raw Sources line on a retry).
 */
export function parseSourcesBlock(answer: string): {
  ids: string[];
  rawMatch: string;
  matchStart: number;
  matchEnd: number;
} | null {
  const normalized = normalize(answer);
  const m = SOURCES_BLOCK_REGEX.exec(normalized);
  if (!m) return null;
  const inner = m[1] ?? "";
  // Split + trim each id; an all-whitespace inner ("Sources: [   ]") yields
  // a single empty id which the caller treats as `sources_block_empty`.
  const ids = inner.trim().length === 0 ? [] : inner.split(",").map((s) => s.trim());
  return {
    ids,
    rawMatch: m[0],
    matchStart: m.index,
    matchEnd: m.index + m[0].length,
  };
}

/**
 * Find all inline `[uuid]` markers in the answer body. The Sources block
 * is stripped first so its IDs aren't double-counted as inline citations.
 *
 * Returns IDs in occurrence order with duplicates preserved — inline
 * duplicates are legal per prompt v0.2.0 (a single claim may re-cite the
 * same entry on multiple sentences). Set-equality with the Sources block
 * is computed against the deduplicated set by {@link validateCitations}.
 *
 * Captures are NOT v4-validated here; the validator's `invalid_uuid` check
 * runs against the merged ID set so a single malformed UUID surfaces with
 * the correct discriminant.
 */
export function extractInlineCitations(answer: string): string[] {
  const normalized = normalize(answer);
  // Strip ALL Sources blocks (a hallucinated double-emission has its
  // multi-block discriminant in `validateCitations`; this helper, when
  // called standalone, still needs to avoid counting UUIDs inside ANY
  // Sources block as inline citations).
  const body = normalized.replace(SOURCES_BLOCK_REGEX_G, "");
  const out: string[] = [];
  for (const m of body.matchAll(INLINE_CITATION_REGEX)) {
    out.push(m[1]!);
  }
  return out;
}

/**
 * Apply the §5 + v0.2.0 validation pipeline against `answer` given the
 * `rerankedIds[]` candidate set. Steps, in order:
 *
 *   1. Parse Sources block — missing → `sources_block_missing`.
 *   2. Count Sources blocks — multiple → `multiple_sources_blocks`.
 *   3. Trailing-prose check — content after Sources block →
 *      `trailing_prose_after_sources`.
 *   4. Empty? — `sources_block_empty` (also covers `Sources: [ ]`).
 *   5. UUID v4 validation on Sources IDs ∪ inline IDs — bad → `invalid_uuid`.
 *      Union check ensures a malformed inline citation surfaces with the
 *      correct discriminant rather than the misleading `inline_sources_mismatch`
 *      it would otherwise produce in step 7.
 *   6. Duplicate IDs within Sources block — `duplicate_id`.
 *   7. Hallucinated IDs (Sources contains ID not in `rerankedIds`) →
 *      `hallucinated_id`.
 *   8. Set-equality between dedup(inline) and Sources — `inline_sources_mismatch`.
 *
 * On success: returns ok with the dedup-but-input-order Sources `ids[]`
 * (the authoritative citation list per prompt line 77) and `body` = answer
 * with Sources block stripped and trailing whitespace trimmed.
 *
 * `rerankedIds` is wrapped in a `Set` internally for O(1) containment, so
 * the route layer may pass duplicates without correctness impact (though
 * it should not).
 */
export function validateCitations(answer: string, rerankedIds: string[]): CitationValidationResult {
  const normalized = normalize(answer);

  // Step 1: parse
  const parsed = parseSourcesBlock(normalized);
  if (!parsed) return { ok: false, reason: "sources_block_missing" };

  // Step 2: multiple Sources blocks
  const allMatches = Array.from(normalized.matchAll(SOURCES_BLOCK_REGEX_G));
  if (allMatches.length > 1) {
    return { ok: false, reason: "multiple_sources_blocks", count: allMatches.length };
  }

  // Step 3: trailing-prose check — what comes after the Sources block must
  // be whitespace only. `matchEnd` is the index just past `]` + any trailing
  // tabs/spaces consumed by the regex; remaining content can be newlines
  // and whitespace only.
  const trailing = normalized.slice(parsed.matchEnd);
  if (trailing.trim().length > 0) {
    return { ok: false, reason: "trailing_prose_after_sources", trailing };
  }

  // Step 4: empty? Only the truly-empty cases (`Sources: []` or
  // `Sources: [   ]`) collapse to `sources_block_empty`. A malformed list
  // like `Sources: [,A]` produces one empty-string element which falls
  // through to step 5 and surfaces as `invalid_uuid` — the more accurate
  // discriminant for "the list is malformed", with the empty offending id
  // visible in the failure payload.
  if (parsed.ids.length === 0) {
    return { ok: false, reason: "sources_block_empty" };
  }

  // Inline citations (Sources blocks stripped internally by the helper).
  const inlineRaw = extractInlineCitations(normalized);
  const inlineSet = new Set(inlineRaw);

  // Step 5: UUID v4 check across union of Sources + inline IDs.
  const union = new Set<string>([...parsed.ids, ...inlineRaw]);
  const badUuids: string[] = [];
  for (const id of union) {
    if (!UUID_V4_REGEX.test(id)) badUuids.push(id);
  }
  if (badUuids.length > 0) {
    return { ok: false, reason: "invalid_uuid", offending_ids: badUuids };
  }

  // Step 6: duplicates in Sources block.
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const id of parsed.ids) {
    if (seen.has(id)) dups.push(id);
    else seen.add(id);
  }
  if (dups.length > 0) {
    return { ok: false, reason: "duplicate_id", offending_ids: dups };
  }

  // Step 7: hallucinated IDs (in Sources but not in rerankedIds).
  const rerankedSet = new Set(rerankedIds);
  const hallucinated = parsed.ids.filter((id) => !rerankedSet.has(id));
  if (hallucinated.length > 0) {
    return { ok: false, reason: "hallucinated_id", offending_ids: hallucinated };
  }

  // Step 8: set-equality between dedup(inline) and Sources.
  const sourcesSet = new Set(parsed.ids);
  const inlineOnly = [...inlineSet].filter((id) => !sourcesSet.has(id));
  const sourcesOnly = [...sourcesSet].filter((id) => !inlineSet.has(id));
  if (inlineOnly.length > 0 || sourcesOnly.length > 0) {
    return {
      ok: false,
      reason: "inline_sources_mismatch",
      inline_only: inlineOnly,
      sources_only: sourcesOnly,
    };
  }

  // Build cleaned body: strip Sources block + trailing whitespace.
  const body = normalized.slice(0, parsed.matchStart).replace(/\s+$/, "");

  return { ok: true, ids: parsed.ids, body };
}
