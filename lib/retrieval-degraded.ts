// lib/retrieval-degraded.ts — leaf module for the ADR-0012 §3 + ADR-0013 §3
// degraded-reason enum.
//
// Lives standalone (no imports) so it can be consumed by:
//   - lib/retrieval.ts        — the Reranker/Synthesizer interface module
//                               (orchestrator + factories sit here next slice)
//   - lib/query-chat-state.ts — the UI-side reducer / wire vocabulary
//                               (must not transitively pull DB/pool/auth)
//   - the retrieval audit-payload type (whatever module owns it)
//
// Pre-2c-ii, the enum lived in lib/retrieval.ts; importing it from
// query-chat-state created a UI→retrieval edge that would have closed
// a cycle the moment the orchestrator (next slice) imported QueryEvent
// to compose its yielded events. Extracting to this leaf module makes
// both consumers leaf-neighbours and breaks the cycle pre-emptively.

/**
 * The complete degraded-mode reason-code enum across ADR-0012 §3 (synth/
 * rerank fail surfaces, citation-validation-failed) and ADR-0013 §3
 * (embed-down + keyword-fallback surfaces). The orchestrator slice (2c-ii)
 * derives one of these from the (embedOk × rerankOk × synthOk) state
 * matrix; the value travels onto:
 *
 *   - The audit-row `payload.degraded_reason`.
 *   - The terminal `QueryEvent.done.degraded_reason` (optional, drives UI
 *     banner copy).
 *   - The terminal `QueryEvent.chunks_only.degraded_reason` (optional —
 *     distinguishes synth-down rows 2 vs 4 vs 7 for UI).
 *
 * Pre-stream config errors (`embedder_config`, `synth_config`) are NOT in
 * this enum — they're handled on a parallel pre-stream-error path outside
 * the matrix and have their own ad-hoc reason strings on the audit row.
 */
export const DEGRADED_REASON_CODES = [
  // ADR-0012 §3:
  "synth_unavailable",
  "rerank_unavailable",
  "rerank_and_synth_unavailable",
  "citation_validation_failed",
  // ADR-0013 §3 — embed-down → keyword fallback variants:
  "embed_unavailable_keyword_fallback",
  "embed_and_rerank_unavailable_keyword_fallback",
  "embed_and_synth_unavailable_keyword_bare",
  "embed_rerank_synth_unavailable_keyword_bare",
  "no_keyword_match_under_embed_outage",
] as const;
export type DegradedReasonCode = (typeof DEGRADED_REASON_CODES)[number];
