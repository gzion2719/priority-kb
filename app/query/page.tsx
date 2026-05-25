"use client";

// app/query/page.tsx — M3 item 2: user-facing query UI.
//
// Drives POST /api/retrieve over SSE. Pure rendering over
// lib/query-chat-state.ts (state) + lib/sse-parse.ts (transport). All
// logic-bearing pieces live in those modules and have unit/integration
// tests; this page is intentionally thin and exercised by manual smoke
// (same precedent as app/admin/ingest/page.tsx for M2a).
//
// Iron-rule notes:
//   - #6 sensitivity: server enforces via withUserOrAdmin + SQL WHERE.
//     The page only sends x-stub-user-role: user (M2a stub-auth dev path;
//     M5 swaps to Entra ID and the header send drops out).
//   - #10 prompt hash: server pins RETRIEVAL_AGENT_PROMPT_HASH on the
//     audit row; the page never handles the hash.
//   - #12 degraded mode: the banner is DYNAMIC — driven by `state.degraded`
//     + `state.degradedReason` populated by the reducer from the terminal
//     `done`, `chunks_only`, AND `no_content` events. Copy lookup lives in
//     lib/degraded-copy.ts (one entry per DegradedReasonCode). The other
//     surfaces use their own banners: 503 → state.status === "unavailable"
//     banner (lines below); error event / transport failure → state.status
//     === "error" banner; empty candidates → state.status === "no_content"
//     banner. When the no_content path carries a degraded_reason (ADR-0013
//     §3 special row: embed-outage + zero-keyword), the degraded banner
//     and the no_content banner stack — they're independent React
//     conditionals and intentionally do not suppress each other (the
//     degraded banner adds outage context, the no_content banner remains
//     the affordance).
//     TODO(M3 smoke): add a Playwright/RTL test asserting the banner is
//     absent on a healthy `done` and present on `done(degraded:true)` /
//     `chunks_only(degraded_reason:...)` / `no_content(degraded_reason:...)`.
//     Page is currently smoke-only.
//   - #13 Kramer brand: chat-banner classes from styles/kramer-brand.css.

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { degradedCopy } from "@/lib/degraded-copy";
import { parseSseStream, SseStreamError } from "@/lib/sse-parse";
import {
  applyEvent,
  initialQueryState,
  markStreamError,
  markUnavailable,
  reset,
  startStream,
  type QueryEvent,
  type QueryState,
} from "@/lib/query-chat-state";
import { decodeQueryParam, encodeQueryParam } from "@/lib/query-url-state";

const SSE_ENDPOINT = "/api/retrieve";

// sessionStorage key for back-nav restoration (BACKLOG:77). Single key
// holds the last submitted-and-completed query + its rendered state, so
// navigating from /query → /entries/[id] → back restores the answer
// without re-firing POST /api/retrieve (which on M3+ live-synth costs a
// Claude + Voyage round-trip per back-nav). URL-?q= carries the query
// for shareability/prefill; sessionStorage carries the rendered state.
//
// Per-origin per-tab scope (sessionStorage default) — no cross-tab
// leakage, dies on tab close. Stored shape: { q: string; state: QueryState }.
// On read we gate on `stored.q === currentQ` so a URL share (q present,
// sessionStorage absent) does NOT auto-replay a stale answer for a
// different question.
//
// Key is suffixed `:v1` so a future QueryState shape change (rename
// chunkSnippets, add a new required field, etc.) can bump to `:v2` and
// silently ignore the now-incompatible legacy payloads instead of
// resurrecting a broken state. Pure key-bump migration — no read-side
// version detection needed.
//
// Iron rule #6 (sensitivity): persisted candidates carry the
// `sensitivity` tier and snippet text that was ALREADY rendered to this
// user in this tab. Persisting for back-nav doesn't expand exposure
// beyond what the same tab already saw. Storage dies on tab close —
// no cross-session leakage. If a user later loses permissions while
// the tab is still open, stale tab still holds the data; this is the
// same tradeoff as any client-side state surviving a permission change
// within a single live session. Accepted.
const QUERY_STATE_STORAGE_KEY = "kbQueryState:v1";

// Terminal statuses where the rendered state is "complete" and worth
// persisting for back-nav. Streaming/idle states are intentionally NOT
// persisted — restoring a partial stream would be misleading. `error`
// and `unavailable` are NOT persisted either: a back-nav restoring a
// transient failure UI is worse than starting fresh.
const TERMINAL_STATUSES: ReadonlySet<QueryState["status"]> = new Set([
  "done",
  "chunks_only",
  "no_content",
] as const);

type PersistedQueryState = { q: string; state: QueryState };

function readPersistedState(currentQ: string): QueryState | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(QUERY_STATE_STORAGE_KEY);
  } catch {
    // sessionStorage can throw in private browsing / disabled storage —
    // fall through to no-restore rather than break the page.
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as PersistedQueryState).q !== "string" ||
    typeof (parsed as PersistedQueryState).state !== "object" ||
    (parsed as PersistedQueryState).state === null
  ) {
    return null;
  }
  const { q, state } = parsed as PersistedQueryState;
  if (q !== currentQ) return null;
  // Structural validator (defense against tampered sessionStorage or a
  // stale-schema payload that survived a code update). The writer only
  // emits TERMINAL_STATUSES with all QueryState fields populated; reject
  // anything else so a corrupted payload renders the empty form rather
  // than crashing the page on `state.candidates.map(...)`. The status
  // check is also the read/write contract pin: `error` and `unavailable`
  // are never written (per TERMINAL_STATUSES) so they would never appear
  // here — checking only TERMINAL_STATUSES membership keeps the two
  // sides aligned.
  if (!TERMINAL_STATUSES.has(state.status)) return null;
  if (
    !Array.isArray(state.candidates) ||
    !Array.isArray(state.citations) ||
    !Array.isArray(state.chunkSnippets) ||
    typeof state.answer !== "string" ||
    typeof state.query !== "string"
  ) {
    return null;
  }
  return state;
}

function clearPersistedState(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(QUERY_STATE_STORAGE_KEY);
  } catch {
    // Same private-browsing tolerance as readPersistedState.
  }
}

function writePersistedState(q: string, state: QueryState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      QUERY_STATE_STORAGE_KEY,
      JSON.stringify({ q, state } satisfies PersistedQueryState),
    );
  } catch {
    // QuotaExceededError on a huge answer; silently drop — the page
    // still works, only back-nav restoration is degraded.
  }
}

// URL ?q=<encoded> mirror via history.replaceState (NOT useSearchParams,
// which on Next 16 demands a Suspense boundary and triggers a router
// cycle). replaceState keeps the URL shareable + browser-back-friendly
// without dragging in the router. Reset = navigate to bare /query.
function replaceUrlQuery(query: string): void {
  if (typeof window === "undefined") return;
  const encoded = encodeQueryParam(query);
  const url = encoded === null ? "/query" : `/query?q=${encoded}`;
  window.history.replaceState(null, "", url);
}

export default function QueryPage(): React.ReactNode {
  const [state, setState] = useState<QueryState>(initialQueryState);
  const [input, setInput] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  // Mount-time restore (BACKLOG:77). Reads URL ?q= for the query and
  // sessionStorage for a matching rendered state. Empty-deps useEffect
  // → runs exactly once on first client mount, NOT on re-render. SSR
  // run is a no-op (window is undefined; the helpers gate on that).
  //
  // Why no auto-submit: a fresh URL-share (?q=X with no matching
  // sessionStorage) prefills input only. Auto-submit would re-fire POST
  // /api/retrieve on every back-nav, which on live-synth costs a Claude
  // round-trip per back — the sessionStorage restore is the no-cost path.
  //
  // Why the eslint-disable: react-hooks/set-state-in-effect is React 19's
  // conservative rule against effect→setState loops. Mount-time hydration
  // from external storage (sessionStorage, window.location) is the
  // canonical legitimate exception — useSyncExternalStore is overkill
  // here (no subscription, value never changes post-mount) and would
  // force a hydration-mismatch snapshot dance that this empty-deps
  // pattern handles cleanly: SSR + first client render return the
  // initial state, the effect runs once post-hydration to apply the
  // restored values. The empty deps array prevents any loop.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const restoredQuery = decodeQueryParam(params.get("q"));
    if (restoredQuery === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInput(restoredQuery);
    const restoredState = readPersistedState(restoredQuery);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (restoredState !== null) setState(restoredState);
  }, []);

  // Persist terminal-state payloads after the stream completes, keyed
  // by the query that produced them. The reducer leaves state.query as
  // the last-submitted text, so we read it from state rather than
  // closing over a stale `input`. Only writes on terminal "complete"
  // statuses — see TERMINAL_STATUSES.
  //
  // Deps are intentionally [state.status, state.query] not [state]:
  // depending on the full `state` would re-schedule this effect on
  // every answer_delta (~dozens per stream) just to early-return on the
  // TERMINAL_STATUSES check. Status only flips at terminals (and to
  // "streaming" at submit), so the dep array narrows the schedule to
  // exactly the meaningful transitions. Reading `state` in the body is
  // safe: lib/query-chat-state.ts applyEvent populates answer +
  // citations + chunkSnippets in the SAME setState call that flips
  // status to a terminal, so by the time this effect fires, the full
  // state is final.
  useEffect(() => {
    if (!TERMINAL_STATUSES.has(state.status)) return;
    if (state.query.length === 0) return;
    writePersistedState(state.query, state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.query]);

  const submit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    // Abort any in-flight stream before starting a new one.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    // Mirror the in-flight query into the URL so a mid-stream tab
    // share / refresh restores at least the prefill (the rendered
    // state restores only after we write sessionStorage on terminal).
    replaceUrlQuery(trimmed);

    setState((s) => startStream(s, trimmed));

    let response: Response;
    try {
      response = await fetch(SSE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-stub-user-role": "user",
        },
        body: JSON.stringify({ query: trimmed }),
        signal: ac.signal,
      });
    } catch (err) {
      if (ac.signal.aborted) return; // user aborted; state unchanged
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => markStreamError(s, `Network error: ${msg}`));
      return;
    }

    // Status branching BEFORE parseSseStream — JSON 400/503 are not SSE.
    if (response.status === 503) {
      setState((s) => markUnavailable(s));
      return;
    }
    if (response.status === 400) {
      let detail = "Invalid request";
      try {
        const body = (await response.json()) as { error?: string };
        detail = body.error ?? detail;
      } catch {
        // Fall through with default detail.
      }
      setState((s) => markStreamError(s, `Rejected: ${detail}`));
      return;
    }
    if (!response.ok) {
      setState((s) => markStreamError(s, `Server error (status ${response.status})`));
      return;
    }

    // Happy path — consume the SSE stream.
    try {
      for await (const ev of parseSseStream(response)) {
        // parseSseStream is typed against AgentEvent (kind: string) but the
        // runtime validator only enforces kind:string — our QueryEvent
        // shape satisfies that. Cast at the boundary.
        const queryEv = ev as unknown as QueryEvent;
        setState((s) => applyEvent(s, queryEv));
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      if (err instanceof SseStreamError) {
        setState((s) => markStreamError(s, `Stream error: ${err.message}`));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => markStreamError(s, `Transport error: ${msg}`));
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, []);

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void submit(input);
    },
    [input, submit],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submit(input);
      }
    },
    [input, submit],
  );

  const onReset = useCallback(() => {
    abortRef.current?.abort();
    setState(reset());
    setInput("");
    // Clear URL + sessionStorage so a subsequent reload lands on a
    // fresh /query page, not the prior state. Symmetric inverse of
    // submit() (URL write) + the terminal-state persist effect (storage
    // write) — both side-channels close together.
    replaceUrlQuery("");
    clearPersistedState();
  }, []);

  const isStreaming = state.status === "streaming";

  return (
    <main
      style={{
        maxWidth: "44rem",
        margin: "0 auto",
        padding: "2rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
      }}
    >
      <header>
        <h1 style={{ margin: 0 }}>Ask the KB</h1>
        <p style={{ color: "var(--kramer-mint)", marginTop: "0.25rem" }}>
          Question in, cited answer out.
        </p>
      </header>

      {/*
        Dynamic degraded-mode banner (iron rule #12). Renders only when the
        terminal `done` or `chunks_only` event surfaced degraded=true with
        a reason code. role="status" (informational), NOT role="alert"
        (interruptive) — the answer/chunks are still shown alongside.
      */}
      {state.degraded === true && state.degradedReason !== undefined && (
        <div
          role="status"
          className="chat-banner warn"
          data-testid="degraded-banner"
          style={{ fontSize: "0.875rem" }}
        >
          <strong style={{ display: "block" }}>{degradedCopy(state.degradedReason).title}</strong>
          <span>{degradedCopy(state.degradedReason).description}</span>
        </div>
      )}

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <textarea
          aria-label="Your question"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="What do you want to know?"
          rows={3}
          disabled={isStreaming}
          style={{
            width: "100%",
            padding: "0.75rem",
            fontFamily: "inherit",
            fontSize: "1rem",
            borderRadius: "0.375rem",
            border: "1px solid #555",
            background: "transparent",
            color: "inherit",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button type="button" onClick={onReset} disabled={isStreaming}>
            Clear
          </button>
          <button type="submit" disabled={isStreaming || input.trim().length === 0}>
            {isStreaming ? "Asking…" : "Ask (⌘/Ctrl + Enter)"}
          </button>
        </div>
      </form>

      {state.status === "unavailable" && (
        <div role="alert" className="chat-banner error">
          Answer service is currently unavailable. Try again in a moment.
        </div>
      )}

      {state.status === "error" && state.error && (
        <div role="alert" className="chat-banner error">
          {state.error}
        </div>
      )}

      {state.status === "no_content" && (
        <div role="status" className="chat-banner info">
          I don&apos;t have a KB entry that answers this. Ask an admin to log a new entry, or
          rephrase your question.
        </div>
      )}

      {/* Answer + Sources rendered whenever the stream produced anything. */}
      {(state.answer.length > 0 || state.candidates.length > 0) && (
        <section
          aria-label="Answer"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid #444",
            borderRadius: "0.5rem",
            padding: "1rem",
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          {state.answer.length > 0 && (
            <div data-testid="answer-text" style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
              {state.answer}
            </div>
          )}

          {state.candidates.length > 0 && (
            <div>
              <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Sources</h2>
              <ul
                style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}
              >
                {state.candidates.map((c) => (
                  <li
                    key={c.entry_id}
                    style={{
                      border: "1px solid #555",
                      borderRadius: "0.375rem",
                    }}
                  >
                    {/*
                      Whole card is the click target — M3 item 5. The
                      detail page enforces iron-rule #6 sensitivity
                      independently (lib/entries.ts), so a card surfaced
                      to a user-role requester may still 404 on click if
                      the candidate set ever races ahead of the role
                      mapping (shouldn't, but the page is the gate).
                    */}
                    <Link
                      href={`/entries/${c.entry_id}`}
                      data-testid="citation-link"
                      style={{
                        display: "block",
                        padding: "0.5rem 0.75rem",
                        color: "inherit",
                        textDecoration: "none",
                      }}
                    >
                      <div
                        style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}
                      >
                        <strong>{c.title}</strong>
                        <span
                          style={{
                            fontSize: "0.75rem",
                            padding: "0.125rem 0.375rem",
                            borderRadius: "999px",
                            border: "1px solid #555",
                          }}
                        >
                          {c.sensitivity}
                        </span>
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "#aaa", marginTop: "0.25rem" }}>
                        <span>category: {c.category}</span>
                        <span style={{ marginLeft: "0.75rem" }}>
                          verified: {c.last_verified_at.slice(0, 10)}
                        </span>
                        <span style={{ marginLeft: "0.75rem", fontFamily: "monospace" }}>
                          {c.entry_id.slice(0, 8)}…
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
