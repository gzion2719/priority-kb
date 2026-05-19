"use client";

// app/admin/ingest/page.tsx — ADR-0010 step 4: admin Ingestion Agent chat UI.
//
// Drives `POST /api/agent/ingest` (route.ts) over SSE. Pure rendering layer
// over `lib/agent-chat-state.ts` (state) + `lib/sse-parse.ts` (transport).
// Logic-bearing pieces live in those modules and have unit tests; this file
// is intentionally thin and exercised by manual smoke (see ROADMAP M2a).
//
// Iron-rule notes:
//   - #4 admin-only: server route enforces `withAdmin`. The page sends
//     `x-stub-user-role: admin` for the M2a stub-auth dev path. M5 swaps to
//     Microsoft Entra ID with real session cookies; the header send drops out
//     then. See ADR-0010 Consequences "CSRF posture for the SSE route (M5)".
//   - #10 prompt hash: server pins `INGESTION_AGENT_PROMPT_HASH` onto the
//     audit row at `submit_entry` dispatch — the page never handles the hash.
//   - #12 degraded mode: 503 → status=unavailable + banner with a link to
//     `/admin/ingest/direct` (HTML-form fallback per ADR-0010 §7).
//   - #13 Kramer brand: bubble + chip + banner classes live in
//     `styles/kramer-brand.css` ("Chat surface" section). GT Eesti family
//     is inherited from the root layout.

import { useCallback, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type { AgentMessage } from "@/lib/agents";
import {
  applyEvent,
  appendUserText,
  cancel as cancelStream,
  initialChatState,
  markMaxTurnsExceeded,
  markStreamError,
  markUnavailable,
  reset,
  type ChatState,
  type DisplayItem,
} from "@/lib/agent-chat-state";
import { SseStreamError, parseSseStream } from "@/lib/sse-parse";

const SSE_ENDPOINT = "/api/agent/ingest";

export default function AdminIngestChatPage(): React.ReactNode {
  const [state, setState] = useState<ChatState>(initialChatState);
  const [input, setInput] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (text: string, baseState: ChatState) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    const userTurn = appendUserText(baseState, trimmed);
    setState(userTurn);
    setInput("");

    const controller = new AbortController();
    abortRef.current = controller;

    let response: Response;
    try {
      response = await fetch(SSE_ENDPOINT, {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-stub-user-role": "admin",
        },
        body: JSON.stringify({ messages: userTurn.wireMessages satisfies AgentMessage[] }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return; // user cancelled
      setState((s) => markStreamError(s, err instanceof Error ? err.message : String(err)));
      return;
    }

    if (response.status === 503) {
      setState((s) => markUnavailable(s));
      return;
    }
    if (response.status === 400) {
      let body: { error?: string } = {};
      try {
        body = (await response.json()) as { error?: string };
      } catch {
        // fallthrough
      }
      if (body.error === "max_turns_exceeded") {
        setState((s) => markMaxTurnsExceeded(s));
        return;
      }
      setState((s) => markStreamError(s, `400 ${body.error ?? "bad_request"}`));
      return;
    }
    if (!response.ok) {
      setState((s) => markStreamError(s, `${response.status} ${response.statusText}`));
      return;
    }

    try {
      for await (const event of parseSseStream(response)) {
        // Guard against (a) explicit cancel via this controller, and (b) a
        // newer send having replaced abortRef (Send-A → Cancel → Send-B
        // race where Send-A's already-queued events would otherwise mutate
        // Send-B's state).
        if (controller.signal.aborted) return;
        if (abortRef.current !== controller) return;
        setState((s) => applyEvent(s, event));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (abortRef.current !== controller) return;
      const message =
        err instanceof SseStreamError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setState((s) => markStreamError(s, message));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, []);

  const onSubmit = useCallback(
    (ev: FormEvent<HTMLFormElement>) => {
      ev.preventDefault();
      if (state.status === "streaming") return;
      if (state.status === "unavailable") return;
      void sendMessage(input, state);
    },
    [input, sendMessage, state],
  );

  const onKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter submits; Shift+Enter inserts a newline (standard chat UX).
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        if (state.status === "streaming" || state.status === "unavailable") return;
        void sendMessage(input, state);
      }
    },
    [input, sendMessage, state],
  );

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => cancelStream(s));
  }, []);

  const onStartNew = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(reset());
    setInput("");
  }, []);

  const isStreaming = state.status === "streaming";
  const isUnavailable = state.status === "unavailable";
  const isMaxTurns = state.status === "error" && state.error === "max_turns_exceeded";

  return (
    <main className="chat-shell">
      <header>
        <h1>Ingestion Agent</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>
          Admin-only chat for logging Priority knowledge entries.
        </p>
      </header>

      {isUnavailable ? (
        <div className="chat-banner warn" role="status">
          Agent is unavailable. <a href="/admin/ingest/direct">Use the direct form</a> to submit an
          entry without the conversational flow.
        </div>
      ) : null}

      {isMaxTurns ? (
        <div className="chat-banner error" role="status">
          Conversation length cap reached (max 20 turns).{" "}
          <button type="button" className="btn cta" onClick={onStartNew}>
            Start new conversation
          </button>
        </div>
      ) : null}

      <section className="chat-region" aria-live="polite" aria-busy={isStreaming}>
        {state.displayItems.length === 0 ? (
          <p style={{ opacity: 0.6, margin: 0 }}>
            Start by describing the knowledge entry you want to record. The agent will ask follow-up
            questions for each required field.
          </p>
        ) : (
          state.displayItems.map((item, i) => <ChatItem key={i} item={item} />)
        )}
      </section>

      <form className="chat-input-row" onSubmit={onSubmit}>
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe the entry... (Enter to send, Shift+Enter for newline)"
          disabled={isStreaming || isUnavailable}
          aria-label="Message to the Ingestion Agent"
          dir="auto"
        />
        {isStreaming ? (
          <button type="button" className="btn alert" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button
            type="submit"
            className="btn cta"
            disabled={input.trim().length === 0 || isUnavailable}
          >
            Send
          </button>
        )}
      </form>
    </main>
  );
}

function ChatItem({ item }: { item: DisplayItem }): React.ReactNode {
  switch (item.kind) {
    case "user":
      return (
        <div className="chat-msg chat-msg-user" dir={item.dir}>
          {item.text}
        </div>
      );
    case "assistant_text":
      return (
        <div className="chat-msg chat-msg-assistant" dir={item.dir}>
          {item.text}
        </div>
      );
    case "tool_use":
      return (
        <div className="chat-tool-chip" title={`tool_use_id: ${item.toolUseId}`}>
          → {item.name}({summarizeInput(item.input)})
        </div>
      );
    case "tool_result":
      return (
        <div className="chat-tool-chip" title={item.name}>
          ← {item.name} ok
        </div>
      );
    case "tool_result_error":
      return (
        <div className="chat-tool-chip error" title={item.name}>
          ← {item.name} error: {item.error}
        </div>
      );
    case "system":
      return (
        <div className="chat-msg chat-msg-system" data-severity={item.severity}>
          {item.text}
        </div>
      );
  }
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  try {
    const json = JSON.stringify(input);
    if (json.length <= 60) return json;
    return `${json.slice(0, 57)}...`;
  } catch {
    return "[unserializable]";
  }
}
