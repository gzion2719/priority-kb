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
//   - #12 degraded mode: the banner is now DYNAMIC — driven by
//     `state.degraded` + `state.degradedReason` populated by the reducer
//     from the terminal `done` and `chunks_only` events. Copy lookup lives
//     in lib/degraded-copy.ts (one entry per DegradedReasonCode). The
//     other surfaces use their own banners: 503 → state.status ===
//     "unavailable" banner (lines below); error event / transport
//     failure → state.status === "error" banner; empty candidates →
//     state.status === "no_content" banner. The `no_content` path does
//     NOT currently carry a degraded_reason on the wire (see
//     docs/BACKLOG.md: "no_content wire event lacks degraded_reason"),
//     so `no_keyword_match_under_embed_outage` is audit-only until that
//     wire-vocab extension lands.
//     TODO(M3 smoke): add a Playwright/RTL test asserting the banner is
//     absent on a healthy `done` and present on `done(degraded:true)` /
//     `chunks_only(degraded_reason:...)`. Page is currently smoke-only.
//   - #13 Kramer brand: chat-banner classes from styles/kramer-brand.css.

import Link from "next/link";
import { useCallback, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

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

const SSE_ENDPOINT = "/api/retrieve";

export default function QueryPage(): React.ReactNode {
  const [state, setState] = useState<QueryState>(initialQueryState);
  const [input, setInput] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    // Abort any in-flight stream before starting a new one.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

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
