// lib/degraded-copy.ts — user-facing copy for each DegradedReasonCode.
//
// Consumed by app/query/page.tsx to render the iron-rule-#12 degraded-mode
// banner with reason-specific copy. Kept as a pure leaf module (no React,
// no fetch, no DOM) so it can be unit-tested without a renderer.
//
// Coverage note: `no_keyword_match_under_embed_outage` is included in the
// enum + copy table for completeness, but it is currently UNREACHABLE from
// the UI banner because the orchestrator emits a wire `{kind:"no_content"}`
// event for that case, and the no_content event shape does not carry a
// degraded_reason field. The audit row DOES carry it. Extending the wire
// vocab (`{kind:"no_content", degraded_reason?}` + route emit + reducer
// carry) is queued in docs/BACKLOG.md and will activate this copy entry
// without a code change here.
//
// Exhaustiveness floor: the final `code satisfies never` in the switch
// converts a future addition to `DEGRADED_REASON_CODES` into a compile
// error in this file. The companion unit test enumerates the enum at
// runtime and asserts shape on every value — belt-and-braces.

import type { DegradedReasonCode } from "@/lib/retrieval-degraded";

export type DegradedCopy = {
  /** Short headline shown as the banner's primary line. */
  title: string;
  /** One-sentence explanation shown beneath the title. */
  description: string;
};

/**
 * Returns user-facing copy for a given DegradedReasonCode. Throws on
 * `undefined` so a caller that reaches this without `state.degraded ===
 * true` fails loudly in development — the only correct call site
 * (app/query/page.tsx) gates on `state.degraded === true` AND the reducer
 * invariantly sets both `degraded` and `degradedReason` together
 * (lib/query-chat-state.ts:200-201, 215-216), so `undefined` here is a
 * reducer regression, not a runtime expectation.
 */
export function degradedCopy(code: DegradedReasonCode | undefined): DegradedCopy {
  if (code === undefined) {
    throw new Error(
      "degradedCopy: called with undefined code. " +
        "Only call when state.degraded === true; the reducer pairs " +
        "degraded + degradedReason on every assignment.",
    );
  }
  switch (code) {
    case "synth_unavailable":
      return {
        title: "Answer synthesis unavailable",
        description:
          "Couldn't synthesize an answer right now. Showing source chunks so you can read the relevant passages directly.",
      };
    case "rerank_unavailable":
      return {
        title: "Reranking unavailable",
        description:
          "Results aren't reranked for relevance; ordering reflects raw retrieval scores. Top hits should still be useful.",
      };
    case "rerank_and_synth_unavailable":
      return {
        title: "Reranking and synthesis unavailable",
        description:
          "Showing source chunks ordered by raw retrieval scores. The answer isn't synthesized and ordering isn't reranked.",
      };
    case "citation_validation_failed":
      return {
        title: "Answer validation retry exhausted",
        description:
          "The synthesized answer's citations didn't match the retrieved sources after a retry. Showing source chunks instead.",
      };
    case "embed_unavailable_keyword_fallback":
      return {
        title: "Keyword-only search",
        description:
          "Semantic search is unavailable; results are from keyword match only. Try simpler or more specific terms if results look narrow.",
      };
    case "embed_and_rerank_unavailable_keyword_fallback":
      return {
        title: "Keyword-only search (no reranking)",
        description:
          "Semantic search and reranking are both unavailable; results are from keyword match in raw retrieval order.",
      };
    case "embed_and_synth_unavailable_keyword_bare":
      return {
        title: "Keyword chunks only",
        description:
          "Semantic search and answer synthesis are both unavailable. Showing keyword-matched source chunks directly.",
      };
    case "embed_rerank_synth_unavailable_keyword_bare":
      return {
        title: "Keyword chunks only (no reranking)",
        description:
          "Semantic search, reranking, and synthesis are all unavailable. Showing keyword-matched chunks in raw retrieval order.",
      };
    case "no_keyword_match_under_embed_outage":
      // Currently unreachable from the UI — see file-header coverage note.
      return {
        title: "Search degraded — no matches",
        description:
          "Semantic search is unavailable and keyword match returned no results. Try different terms, or wait a moment and retry.",
      };
    default:
      // Exhaustiveness floor — a future addition to DEGRADED_REASON_CODES
      // that isn't handled above becomes a compile error here.
      code satisfies never;
      throw new Error(`degradedCopy: unhandled reason code: ${String(code)}`);
  }
}
