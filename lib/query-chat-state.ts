// lib/query-chat-state.ts — pure reducer for the user-facing query UI.
//
// Mirrors the lib/agent-chat-state.ts pattern but stripped of admin
// tool-use loop complexity: the retrieval surface is single-turn,
// single-stream. The route's event vocabulary is:
//
//   {kind:"candidates",   entries: QueryCandidate[]}         // sent first if any matched
//   {kind:"answer_delta", text:    string}                   // 1+ deltas; stub synth emits exactly 1
//   {kind:"done",         citation_ids, degraded?, degraded_reason?}  // terminal happy path
//   {kind:"chunks_only",  entries: QueryChunkSnippet[]}      // terminal: synth-down rows (ADR-0012 §3)
//   {kind:"no_content",   degraded_reason?}                  // terminal: empty candidate set (reason set on embed-outage row, ADR-0013 §3)
//   {kind:"error",        code: "internal"|"db"|"synth_unavailable"|"citation_validation_failed"}  // terminal failure
//
// Plus client-side terminal transitions for SSE-transport failure:
//   - markStreamError(err)  — parse/fetch failure (no in-stream {kind:"error"} event)
//   - markUnavailable()     — 503 response from the route (iron rule #12)
//
// Statuses:
//   idle         — no active stream; ready to submit.
//   streaming    — SSE connection open; deltas arriving.
//   done         — last turn finalized cleanly via {kind:"done"}.
//   chunks_only  — last turn finalized via {kind:"chunks_only"}; UI renders
//                  ranked chunk snippets with citations but no synthesized
//                  answer. ADR-0012 §3 rows 2/4/7 (synth unavailable).
//   no_content   — last turn returned {kind:"no_content"}; UI shows the
//                  "I don't have a KB entry that answers this" affordance.
//   error        — terminal failure (in-stream error event OR transport error).
//   unavailable  — route returned 503; UI shows the iron-rule-#12 banner.
//
// Pure functions only — no React, no fetch, no timers. The page calls
// setState((s) => applyEvent(s, ev)) inside the SSE consumer loop and
// setState((s) => markX(s, ...)) at terminal client-side transitions.

// Import from the leaf module — NOT @/lib/retrieval — so a future
// orchestrator that imports QueryEvent from this file doesn't close a
// circular dependency through retrieval.ts. See lib/retrieval-degraded.ts.
import type { DegradedReasonCode } from "@/lib/retrieval-degraded";

export type QueryStatus =
  | "idle"
  | "streaming"
  | "done"
  | "chunks_only"
  | "no_content"
  | "error"
  | "unavailable";

export type QueryCandidate = {
  entry_id: string;
  title: string;
  category: string;
  sensitivity: "public" | "internal" | "restricted";
  last_verified_at: string; // ISO timestamp
  /**
   * Body excerpt for the citation hover preview (M4 #6). Server-projected
   * from the SAME `boundaries[].body` the reranker/synth sees for this
   * entry (lib/retrieval-pipeline.ts) — ANN-best-chunk slice on the
   * embed-OK path, or `synthesizeKeywordOnlyRepresentative` on the
   * keyword-only path with the `# ${title}\n` prefix stripped. Capped at
   * `CANDIDATE_SNIPPET_MAX_CHARS` (240) chars via `safeSnippetSlice`
   * which backs off Unicode combining sequences + UTF-16 surrogate pairs.
   *
   * Required (not optional) — three new fields below are informational
   * projections the server always has, so optional would force the
   * client into needless undefined-handling. Wire deviation from the
   * `degraded_reason` optional precedent is deliberate: there is no
   * out-of-repo emitter and no rolling-window deploy. Type-errors on
   * test fixtures are the desired surface-completeness signal per
   * Reconciliation-grep-completeness sub-rule.
   *
   * On the `chunks_only` terminal path the page MUST prefer the
   * per-rank `chunkSnippets[].snippet` (post-rerank, possibly different
   * order) over this pre-rerank `body_snippet` so the snippet shown
   * matches the chunk that survived rerank. See app/query/page.tsx
   * hover-render comment.
   *
   * Iron-rule #6: same data plane as the post-WHERE-filtered entry
   * rows. The row already passed the sensitivity gate at the SQL layer
   * (lib/retrieval-ann.ts + lib/retrieval-keyword.ts); projecting body
   * content onto the wire is consistent with `chunks_only`'s existing
   * `snippet` field.
   */
  body_snippet: string;
  /**
   * Entry tags verbatim from `entries.tags`. No per-field sensitivity
   * policy — non-negotiables #6/#7 treat the entry row as the unit.
   * Empty array when the entry has no tags.
   */
  tags: string[];
  /**
   * Entry source pointer (ticket #, doc link, conversation reference)
   * verbatim from `entries.source_pointer`. Rendered as plain text in
   * the hover preview — not linkified in v1, to avoid click-to-leak /
   * SSRF surfaces if a future entry's source field contains a URL with
   * a token. Linkification with allowlist queued in BACKLOG.
   */
  source_pointer: string;
};

/**
 * A chunk-snippet entry surfaced when synth is unavailable but candidates
 * have content (ADR-0012 §3 rows 2/4/7 — synth fails, rerank-or-fused
 * chunks survive). The `snippet` is the same text the synth would have
 * received in its context block — for ANN-path entries it's the best
 * chunk's body slice; for keyword-only entries (ADR-0013 §2.3 step 4) it's
 * the synthetic "title + first 500 tokens" representative. The UI renders
 * citations from these directly, satisfying iron rule #3 without synthesis.
 */
export type QueryChunkSnippet = {
  entry_id: string;
  title: string;
  category: string;
  sensitivity: "public" | "internal" | "restricted";
  last_verified_at: string;
  snippet: string;
};

/** Event vocabulary the route sends over SSE; mirrored in app/api/retrieve/route.ts. */
export type QueryEvent =
  | { kind: "candidates"; entries: QueryCandidate[] }
  | { kind: "answer_delta"; text: string }
  | {
      kind: "done";
      citation_ids: string[];
      /**
       * Sub-slice 2c-ii additions: the orchestrator surfaces the degraded
       * mode + reason on the terminal `done` event so the UI can render the
       * iron-rule-#12 banner without a side-channel. Optional so legacy 2c-i
       * route emissions (always row 8 by construction, but no client-readable
       * signal) remain backwards-compatible — a client reading only
       * `citation_ids` ignores them.
       */
      degraded?: boolean;
      degraded_reason?: DegradedReasonCode;
    }
  | {
      kind: "chunks_only";
      entries: QueryChunkSnippet[];
      /**
       * Forward-compat (added in 2c-ii foundation slice): the orchestrator
       * MAY surface the specific synth-down reason (rows 2/4/7 — synth_
       * unavailable vs rerank_and_synth_unavailable vs embed_and_synth_
       * unavailable_keyword_bare) so the UI can render distinct copy. Optional
       * so emitters that don't carry it remain wire-compatible; absence ===
       * "synth-down, reason unspecified".
       */
      degraded_reason?: DegradedReasonCode;
    }
  | {
      kind: "no_content";
      /**
       * Set on the ADR-0013 §3 special row (`!embedOk && !fusedNonEmpty` —
       * embed lane failed AND keyword lane returned zero) to surface
       * `no_keyword_match_under_embed_outage` to the UI banner. Optional so
       * the structural-no-content case (embed-OK, both lanes empty for
       * content reasons — no matching entries OR all matches filtered by
       * SQL sensitivity WHERE) remains bare and back-compat.
       *
       * Wire shape mirrors `chunks_only`: reason-only on the wire, the
       * reducer synthesizes `degraded:true` when present. Matches
       * `chunks_only` policy so the reducer pairs `degraded + degradedReason`
       * uniformly (lib/degraded-copy.ts:39-46 contract).
       */
      degraded_reason?: DegradedReasonCode;
    }
  | {
      kind: "error";
      code: "internal" | "db" | "synth_unavailable" | "citation_validation_failed";
    };

export type QueryState = {
  status: QueryStatus;
  /** The last-submitted query string; preserved across the stream for UI display. */
  query: string;
  /** Candidates as delivered by the route's candidates event (top-N). */
  candidates: QueryCandidate[];
  /** Accumulated answer text (concatenated answer_delta values). */
  answer: string;
  /** Citation IDs from the terminal done event; non-empty only after done. */
  citations: string[];
  /**
   * Chunk snippets from a terminal {kind:"chunks_only"} event; non-empty
   * only when status === "chunks_only". Carries the same shape the synth
   * would have received, so the UI can render citations + body excerpts
   * without a synthesized answer.
   *
   * Absence convention: ALWAYS PRESENT, defaulting to `[]`. Mirrors
   * `candidates`/`citations` which use the same "empty-array sentinel for
   * not-yet-set" convention so the UI can render-by-length without
   * branching on undefined. Contrast with `degraded`/`degradedReason`
   * below, which use "absent === not-yet-set" so render code can
   * distinguish "we know it's healthy" from "we have no signal yet."
   */
  chunkSnippets: QueryChunkSnippet[];
  /**
   * Set on the terminal `done` event when the orchestrator emits a
   * degraded-mode flag (ADR-0012 §3 + ADR-0013 §3). UI uses this to render
   * the iron-rule-#12 banner. Absent on healthy `done`; absent on terminal
   * states other than `done` (chunks_only / unavailable carry degraded
   * semantics implicitly).
   */
  degraded?: boolean;
  degradedReason?: DegradedReasonCode;
  /** Terminal error message (from {kind:"error"} OR transport failure). */
  error?: string;
};

export const initialQueryState: QueryState = {
  status: "idle",
  query: "",
  candidates: [],
  answer: "",
  citations: [],
  chunkSnippets: [],
};

/**
 * Records the in-flight query and resets accumulators. Called BEFORE the
 * fetch is issued so the UI can render the user's submitted text
 * immediately. Idempotent on same-state re-entry. Prior state is fully
 * discarded — a new submission is independent of any terminal state from
 * the previous one, so the `state` parameter is reserved for shape
 * symmetry with applyEvent/markX but intentionally unused.
 */
export function startStream(_state: QueryState, query: string): QueryState {
  return {
    status: "streaming",
    query,
    candidates: [],
    answer: "",
    citations: [],
    chunkSnippets: [],
  };
}

/**
 * Applies one SSE event to the state. Pure; never throws on unknown
 * event types (forward-compatible — slice 3 may extend the vocabulary,
 * and a slice-1 page reading a slice-3 stream should not crash).
 */
export function applyEvent(state: QueryState, event: QueryEvent): QueryState {
  switch (event.kind) {
    case "candidates":
      // Candidates always precede answer_delta in the wire ordering; if
      // we see candidates while not streaming, that's an out-of-order
      // server bug — silently overwrite rather than throw, since the
      // reducer is downstream of the transport (page handles the throw).
      return { ...state, candidates: event.entries };

    case "answer_delta":
      return { ...state, answer: state.answer + event.text };

    case "done":
      return {
        ...state,
        status: "done",
        citations: event.citation_ids,
        // Only set when the route surfaces a degraded mode on `done`. Stays
        // absent on healthy `done` so legacy consumers see no shape change.
        ...(event.degraded !== undefined ? { degraded: event.degraded } : {}),
        ...(event.degraded_reason !== undefined ? { degradedReason: event.degraded_reason } : {}),
      };

    case "chunks_only":
      // Partial `answer` accumulated before this terminal is preserved on
      // state (UI may want to show "partial: …" alongside the chunk
      // snippets). The orchestrator's contract is that it emits
      // chunks_only INSTEAD of answer_delta when synth is unavailable, so
      // in practice `state.answer === ""` here — but the reducer does not
      // wipe it defensively.
      return {
        ...state,
        status: "chunks_only",
        chunkSnippets: event.entries,
        ...(event.degraded_reason !== undefined
          ? { degradedReason: event.degraded_reason, degraded: true }
          : {}),
      };

    case "no_content":
      // Mirrors `chunks_only` (above): when the wire carries a
      // degraded_reason, synthesize `degraded:true` alongside so the UI
      // banner's invariant (`degraded === true && degradedReason !==
      // undefined` — app/query/page.tsx:179) holds and the
      // lib/degraded-copy.ts:39-46 contract ("never called with undefined
      // when degraded:true") is preserved.
      return {
        ...state,
        status: "no_content",
        ...(event.degraded_reason !== undefined
          ? { degradedReason: event.degraded_reason, degraded: true }
          : {}),
      };

    case "error":
      return { ...state, status: "error", error: errorMessageForCode(event.code) };

    default:
      // Forward-compatible: a slice 3 future event vocabulary (e.g.,
      // {kind:"breaker_state"}) reaches a slice-1 page reading a slice-3
      // stream. Returning state unchanged avoids `setState(undefined)`
      // which would corrupt the React component. TS's discriminated
      // switch makes this branch unreachable from typed callers; the
      // guard is for untyped wire input only.
      return state;
  }
}

/**
 * Terminal: client observed a 503 from the route. Mirrors the iron-rule-#12
 * convention from app/admin/ingest/page.tsx — UI shows a degraded banner
 * pointing at the keyword-only fallback.
 */
export function markUnavailable(state: QueryState): QueryState {
  return { ...state, status: "unavailable" };
}

/**
 * Terminal: SSE parse or fetch failure (no in-stream {kind:"error"} event
 * arrived because the connection itself broke). Distinguished from
 * applyEvent({kind:"error"}) — that one is a server-emitted in-stream
 * failure; this one is transport-level.
 */
export function markStreamError(state: QueryState, message: string): QueryState {
  return { ...state, status: "error", error: message };
}

/**
 * Resets to idle. Called when the user starts a fresh question after a
 * terminal state (done/error/no_content/unavailable). Preserves nothing
 * — the new query is independent.
 */
export function reset(): QueryState {
  return initialQueryState;
}

function errorMessageForCode(
  code: "internal" | "db" | "synth_unavailable" | "citation_validation_failed",
): string {
  switch (code) {
    case "db":
      return "Database error — try again in a moment.";
    case "synth_unavailable":
      return "Answer service unavailable — try again later.";
    case "citation_validation_failed":
      // The synth produced an answer the route could not mechanically
      // verify against the retrieved entries (per ADR-0012 §5 + iron rule
      // #3). User-facing copy is intentionally generic; the audit row
      // carries the failure discriminant for forensic replay.
      return "Could not verify citations on the generated answer — try again.";
    case "internal":
      return "Something went wrong on our side.";
  }
}
