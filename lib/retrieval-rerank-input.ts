// lib/retrieval-rerank-input.ts — pure helpers for stage-C (rerank) input
// preparation and stage-D (synth) input projection.
//
// Two jobs, both pure / dependency-free / no I/O:
//
//   1. synthesizeKeywordOnlyRepresentative(title, body) — build the
//      "title + first 500 tokens of body" synthetic chunk for entries that
//      survived ADR-0013 RRF fusion but came from the keyword lane only
//      (no best-ANN chunk to draw from). ADR-0013 §2.3 step 4. Uses
//      lib/chunk.ts's chunker so the slice is byte-stable across Node minor
//      versions and matches the rest of the system's tokenization view of
//      the same body — NOT a private re-encode that could drift from the
//      chunker's BPE-split offset math.
//
//   2. joinRerankedToSynthInput(ranking, boundaries, topN) — map the
//      reranker's {index, score} output to lib/retrieval-synth-input's
//      SynthInputChunk[] for buildSynthContext. Selects top-N entries,
//      preserves caller-supplied boundary metadata, and carries the rerank
//      score through as SynthInputChunk.score (which is contractually the
//      Voyage rerank score per the synth-input helper's JSDoc).
//
// Why these two and not the full rerank-input pipeline: the orchestrator
// (sub-slice 2c-ii) owns the DB-bound work (fetching entry rows,
// best-ANN-chunk body slices, joining sensitivity/source_pointer). Pure
// helpers extract the parts that don't need a Pool, keeping the
// orchestrator's I/O surface separable from its tokenizer + projection
// math. This lets the test surface here exercise edge cases (multi-byte
// UTF-8 boundary, exactly-at-500-tokens, oversize body, empty input)
// against the same chunker primitives the ingest path uses.

import { chunk, getRawSlice } from "@/lib/chunk";
import type { SynthInputChunk } from "@/lib/retrieval-synth-input";

/**
 * Boundary type the orchestrator hands to {@link joinRerankedToSynthInput}.
 * Carries every field {@link SynthInputChunk} needs minus the rerank score
 * (filled in from the reranker's output) and minus the chunk slice/title
 * adjustment for keyword-only entries (which is the orchestrator's
 * pre-rerank concern, baked into `body` at the time we build the rerank
 * input). One per entry, in the same order the entries were passed to
 * `Reranker.rerank()` — `ranking.index` indexes into this array.
 *
 * `body` is the EXACT text that was passed to the reranker for this entry
 * — for ANN-path entries that's the best-ANN-chunk content slice; for
 * keyword-only entries it's
 * {@link synthesizeKeywordOnlyRepresentative}'s output. Keeping them
 * identical means the model sees the same text the reranker scored,
 * preserving context-budget honesty (ADR-0012 §D ~3.5K input tokens).
 */
export interface RerankBoundaryEntry {
  entry_id: string;
  title: string;
  /** The slice (or synthetic representative) that was passed to the reranker. */
  body: string;
  category: string;
  tags: string[];
  source_pointer: string | null;
  last_verified_at: string;
  sensitivity: SynthInputChunk["sensitivity"];
}

/**
 * Default token budget for the keyword-only synthetic representative.
 * Matches ADR-0009's `DEFAULT_CHUNK_TOKENS` so the synthetic block sits
 * inside the same context-budget math as a real ANN-chunk match (ADR-0012
 * §D ~500 tokens/chunk × 5 chunks). Overridable for tests; production
 * callers should accept the default.
 */
export const KEYWORD_REPRESENTATIVE_TOKENS = 500;

/**
 * Build the "title + first N tokens of body" synthetic representative for
 * an entry that survived RRF fusion but has no best-ANN-chunk to draw on
 * (ADR-0013 §2.3 step 4). N defaults to {@link KEYWORD_REPRESENTATIVE_TOKENS}.
 *
 * Implementation reuses {@link chunk}/{@link getRawSlice} from lib/chunk.ts
 * — the same primitives the ingest path uses. This guarantees:
 *
 * - **Byte-stability:** the slice's char-offset math goes through
 *   lib/chunk.ts's `encodeWithCharOffsets` fast-path-with-fallback, which
 *   handles multi-byte UTF-8 codepoints split across BPE tokens correctly
 *   (per-token `decode([t])` would drift). A re-implementation here would
 *   either duplicate that logic or introduce a silent off-by-codepoint on
 *   Hebrew/Arabic/CJK bodies.
 *
 * - **Forbidden-range honesty:** the chunker respects ADR-0009 §3 forbidden
 *   ranges (fenced code, inline code, table rows). Splitting a representative
 *   mid-table or mid-code-block would mislead the reranker and the model;
 *   reusing `chunk()` carries the same constraint.
 *
 * Pre-condition: `body` SHOULD already be post-scrub canonical (NFC). The
 * production caller for this helper is the orchestrator hydrating from
 * `entries.body`, which the ingest path (ADR-0009 §5 scrub + NFC) stores
 * canonical. The chunker re-normalizes defensively, so a non-NFC input
 * still produces a stable result — at the cost of one extra normalize
 * pass per call.
 *
 * Output shape: `"# {title}\n{slice}"` — matches the 2c-i route's `context`
 * shape at app/api/retrieve/route.ts:477, so the rerank-input and synth-
 * input continue to look the same to the model in this slice. Sub-slice
 * 2c-ii's orchestrator will pass this same string both into the reranker
 * AND into `SynthInputChunk.body` so the model sees what the reranker
 * scored.
 *
 * Empty body → returns just the title-prefix line (no body content).
 * Throws RangeError on empty title (caller bug — no representative is
 * citable without a title).
 */
export function synthesizeKeywordOnlyRepresentative(
  title: string,
  body: string,
  maxTokens: number = KEYWORD_REPRESENTATIVE_TOKENS,
): string {
  if (typeof title !== "string" || title.length === 0) {
    throw new RangeError("synthesizeKeywordOnlyRepresentative: title must be a non-empty string");
  }
  // Upper bound 4000 = 8× context-budget headroom over the documented 500
  // (ADR-0012 §D). A 32000 ceiling (matching VOYAGE_MAX_INPUT_TOKENS) would
  // permit a 64× oversize representative that silently blows the synth
  // context budget; the matrix doesn't notice and the user sees a degraded
  // model output. Fail-fast at 4000.
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4000) {
    throw new RangeError(
      `synthesizeKeywordOnlyRepresentative: maxTokens must be an integer in [1, 4000]; got ${maxTokens}`,
    );
  }

  const titlePrefix = `# ${title}\n`;

  if (typeof body !== "string" || body.length === 0) {
    return titlePrefix;
  }

  // chunk() normalizes to NFC internally — to avoid the double normalize
  // pass, normalize once here and feed the canonical form to both chunk()
  // and getRawSlice(). For already-NFC inputs (the production case via
  // ingest scrub) `normalize("NFC")` is a no-op pointer comparison.
  const normalized = body.normalize("NFC");

  // Pass `minTrailing: 0` so a small `maxTokens` (e.g. tests) produces a
  // strict slice rather than absorbing the trailing chunk's content past
  // the requested boundary. Production callers use the 500 default where
  // chunk.ts's default `minTrailing: 60` is harmless to the first slice.
  const slices = chunk(normalized, { size: maxTokens, overlap: 0, minTrailing: 0 });
  if (slices.length === 0) {
    // Defensive — chunk() returns [] only on empty normalized body, which
    // we already handled above. Belt-and-suspenders for a future chunker
    // refactor that introduces a new zero-output edge case.
    return titlePrefix;
  }

  const first = slices[0]!;
  const slice = getRawSlice(normalized, first.content_start, first.content_end);
  return titlePrefix + slice;
}

/**
 * Project a reranker's `{ranking, tokens_used}` output onto the
 * orchestrator's pre-rerank {@link RerankBoundaryEntry} array, selecting
 * the top-N entries and returning the {@link SynthInputChunk}[] ready for
 * {@link buildSynthContext}.
 *
 * Score semantics: `ranking[i].score` is the Voyage rerank `relevance_score`
 * for the entry at `boundaries[ranking[i].index]`. {@link SynthInputChunk.score}
 * carries it through verbatim — its consumer (the synth-input renderer at
 * lib/retrieval-synth-input.ts:172) renders it to a fixed-precision string
 * in the model context.
 *
 * Order semantics: the output array is in RANKING ORDER (best first), NOT
 * in boundaries-array order. Synth-input renderer's `index="1"` attribute
 * then reflects the rerank rank, so the model can pick the highest-ranked
 * entry by leading position when it has no other signal.
 *
 * Throws RangeError on:
 * - `topN` outside [1, 1000]
 * - any `ranking[i].index` outside `[0, boundaries.length)`
 * - any `ranking[i].score` non-finite (defense-in-depth — the synth-input
 *   renderer also rejects non-finite scores, but failing here gives a
 *   clearer call-site error)
 * - duplicate `index` values across `ranking[0..topN)` — a reranker must
 *   not return the same boundary twice. Iron rule #3 still holds either
 *   way (entry stays citable), but a dup would render two `<entry>` blocks
 *   pointing at the same entry_id and mis-count "distinct synth-input IDs"
 *   on the audit row. Fail loud rather than dedup silently.
 *
 * Empty `ranking` → returns []. Empty `boundaries` with non-empty `ranking`
 * is a caller bug and surfaces as the index-out-of-range RangeError.
 */
export function joinRerankedToSynthInput(
  ranking: ReadonlyArray<{ index: number; score: number }>,
  boundaries: ReadonlyArray<RerankBoundaryEntry>,
  topN: number,
): SynthInputChunk[] {
  if (!Number.isInteger(topN) || topN < 1 || topN > 1000) {
    throw new RangeError(
      `joinRerankedToSynthInput: topN must be an integer in [1, 1000]; got ${topN}`,
    );
  }

  const out: SynthInputChunk[] = [];
  const seenIndices = new Set<number>();
  const limit = Math.min(topN, ranking.length);
  for (let i = 0; i < limit; i++) {
    const r = ranking[i]!;
    if (!Number.isInteger(r.index) || r.index < 0 || r.index >= boundaries.length) {
      throw new RangeError(
        `joinRerankedToSynthInput: ranking[${i}].index=${r.index} out of range [0, ${boundaries.length})`,
      );
    }
    if (seenIndices.has(r.index)) {
      throw new RangeError(
        `joinRerankedToSynthInput: ranking[${i}].index=${r.index} appears more than once; ` +
          `the reranker must not return the same boundary twice (duplicate would mis-count distinct synth-input IDs)`,
      );
    }
    seenIndices.add(r.index);
    if (!Number.isFinite(r.score)) {
      throw new RangeError(
        `joinRerankedToSynthInput: ranking[${i}].score=${r.score} is not finite`,
      );
    }
    const b = boundaries[r.index]!;
    out.push({
      entry_id: b.entry_id,
      title: b.title,
      body: b.body,
      category: b.category,
      tags: b.tags,
      source_pointer: b.source_pointer,
      last_verified_at: b.last_verified_at,
      sensitivity: b.sensitivity,
      score: r.score,
    });
  }
  return out;
}
