// lib/query-chat-state.ts — pure reducer for the user-facing query UI.
//
// Mirrors the lib/agent-chat-state.ts pattern but stripped of admin
// tool-use loop complexity: the retrieval surface is single-turn,
// single-stream. The route's event vocabulary is:
//
//   {kind:"candidates",   entries: QueryCandidate[]}         // sent first if any matched
//   {kind:"answer_delta", text:    string}                   // 1+ deltas; stub synth emits exactly 1
//   {kind:"done",         citation_ids: string[]}            // terminal happy path
//   {kind:"no_content"}                                      // terminal: empty candidate set
//   {kind:"error",        code: "internal"|"db"|"synth_unavailable"}  // terminal failure
//
// Plus client-side terminal transitions for SSE-transport failure:
//   - markStreamError(err)  — parse/fetch failure (no in-stream {kind:"error"} event)
//   - markUnavailable()     — 503 response from the route (iron rule #12)
//
// Statuses:
//   idle        — no active stream; ready to submit.
//   streaming   — SSE connection open; deltas arriving.
//   done        — last turn finalized cleanly via {kind:"done"}.
//   no_content  — last turn returned {kind:"no_content"}; UI shows the
//                 "I don't have a KB entry that answers this" affordance.
//   error       — terminal failure (in-stream error event OR transport error).
//   unavailable — route returned 503; UI shows the iron-rule-#12 banner.
//
// Pure functions only — no React, no fetch, no timers. The page calls
// setState((s) => applyEvent(s, ev)) inside the SSE consumer loop and
// setState((s) => markX(s, ...)) at terminal client-side transitions.

export type QueryStatus = "idle" | "streaming" | "done" | "no_content" | "error" | "unavailable";

export type QueryCandidate = {
  entry_id: string;
  title: string;
  category: string;
  sensitivity: "public" | "internal" | "restricted";
  last_verified_at: string; // ISO timestamp
};

/** Event vocabulary the route sends over SSE; mirrored in app/api/retrieve/route.ts. */
export type QueryEvent =
  | { kind: "candidates"; entries: QueryCandidate[] }
  | { kind: "answer_delta"; text: string }
  | { kind: "done"; citation_ids: string[] }
  | { kind: "no_content" }
  | { kind: "error"; code: "internal" | "db" | "synth_unavailable" };

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
  /** Terminal error message (from {kind:"error"} OR transport failure). */
  error?: string;
};

export const initialQueryState: QueryState = {
  status: "idle",
  query: "",
  candidates: [],
  answer: "",
  citations: [],
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
      return { ...state, status: "done", citations: event.citation_ids };

    case "no_content":
      return { ...state, status: "no_content" };

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

function errorMessageForCode(code: "internal" | "db" | "synth_unavailable"): string {
  switch (code) {
    case "db":
      return "Database error — try again in a moment.";
    case "synth_unavailable":
      return "Answer service unavailable — try again later.";
    case "internal":
      return "Something went wrong on our side.";
  }
}
