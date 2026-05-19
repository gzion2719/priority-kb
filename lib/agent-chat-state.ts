// lib/agent-chat-state.ts — pure reducer for the admin chat UI.
//
// Holds two parallel projections of the conversation:
//
//   - `wireMessages`: the `AgentMessage[]` shape the route expects on the
//     next POST. Mirrors Anthropic's tagged-union content-block shape so
//     the server's `runAgentTurn` driver (route.ts:220) can reconstruct
//     prior assistant turns verbatim. Tool-result blocks are emitted in
//     a user role per the SDK convention, interleaved between assistant
//     turns in the order route.ts:314–318 produces them.
//
//   - `displayItems`: a flat list of UI-renderable items in conversation
//     order (user bubbles, assistant text bubbles, tool-use chips,
//     tool-result chips, system banners). Drives the chat region; never
//     sent over the wire.
//
// Wire ordering after a tool round-trip is the load-bearing invariant:
// `[..., assistant(text+tool_use), user(tool_result), assistant(next_text)]`
// — *not* `[..., assistant(text+tool_use), assistant(next_text), user(tool_result)]`.
// Anthropic rejects the latter. The reducer enforces this by promoting
// the assistant turn on `done tool_use`, queueing `tool_result` events
// into `pendingToolResultBlocks` while consuming `expectedToolResults`
// (the harvested tool_use IDs), then flushing those result blocks as a
// user message at the first sign of a NEW assistant event
// (`text_delta` / `tool_use_start`) — before the next assistant turn
// starts accumulating. This places the tool_result user-message between
// the two assistant turns, matching route.ts:314–318.
//
// Pure functions only — no React, no fetch, no timers. Page-level state
// management imports these and drives `useReducer` (or `useState` +
// `setState((s) => applyEvent(s, ev))`).

import type { AgentContentBlock, AgentEvent, AgentMessage } from "./agents";

export type ChatStatus =
  | "idle" // No active stream; ready to send.
  | "streaming" // Awaiting agent events on an open SSE connection.
  | "done" // Last turn finalized cleanly (`done end_turn`).
  | "error" // Last turn surfaced an in-stream `error` event or stream error.
  | "unavailable"; // 503 from the route (iron rule #12 degraded mode).

export type DisplayItem =
  | { kind: "user"; text: string; dir: "ltr" | "rtl" }
  | { kind: "assistant_text"; text: string; dir: "ltr" | "rtl" }
  | { kind: "tool_use"; name: string; toolUseId: string; input: unknown }
  | { kind: "tool_result"; name: string; ok: true; output: unknown }
  | { kind: "tool_result_error"; name: string; error: string }
  | { kind: "system"; text: string; severity: "info" | "warn" | "error" };

export type ChatState = {
  wireMessages: AgentMessage[];
  displayItems: DisplayItem[];
  status: ChatStatus;
  error?: string;
  /**
   * In-progress assistant turn's content blocks (text + tool_use), in
   * server emission order. Promoted to `wireMessages` on `done` events.
   */
  pendingAssistantBlocks: AgentContentBlock[];
  /**
   * Tool-result content blocks accumulated since the most recent
   * `done tool_use` promotion. Flushed as a single user-role message
   * either (a) when the next assistant event starts a fresh turn, or
   * (b) at a terminal `done` if no further assistant events arrived.
   */
  pendingToolResultBlocks: Extract<AgentContentBlock, { type: "tool_result" }>[];
  /**
   * FIFO queue (per tool name) of tool_use IDs harvested from the
   * just-promoted assistant turn. Each incoming `tool_result` event
   * consumes the head of its name's queue to recover the matching
   * `tool_use_id` for the wire-shape echo. A `tool_result` with no
   * match surfaces as a system error and is NOT written to the wire.
   */
  expectedToolResults: Map<string, string[]>;
  /** Index into `displayItems` of the current trailing assistant text bubble, if open. */
  openAssistantTextIndex: number | null;
};

export const initialChatState: ChatState = {
  wireMessages: [],
  displayItems: [],
  status: "idle",
  pendingAssistantBlocks: [],
  pendingToolResultBlocks: [],
  expectedToolResults: new Map(),
  openAssistantTextIndex: null,
};

/**
 * Detect text directionality from the first strong-direction character.
 * Hebrew Unicode block is U+0590–U+05FF; Arabic is U+0600–U+06FF and
 * U+0750–U+077F. Everything else is LTR. Cheap heuristic — UAX #9 is
 * the rigorous algorithm but overkill for one-line bubble heads.
 */
export function detectDir(text: string): "ltr" | "rtl" {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x0590 && code <= 0x05ff) return "rtl";
    if (code >= 0x0600 && code <= 0x06ff) return "rtl";
    if (code >= 0x0750 && code <= 0x077f) return "rtl";
    if (code > 0x20 && !(code >= 0x2000 && code <= 0x206f)) return "ltr";
  }
  return "ltr";
}

/**
 * Append a user message and prepare for an outbound POST. Pushes the
 * user wireMessage + display bubble, clears pending buffers, sets
 * status to `streaming`. Caller fires the fetch immediately after.
 */
export function appendUserText(state: ChatState, text: string): ChatState {
  const dir = detectDir(text);
  return {
    ...state,
    wireMessages: [...state.wireMessages, { role: "user", content: text }],
    displayItems: [...state.displayItems, { kind: "user", text, dir }],
    status: "streaming",
    error: undefined,
    pendingAssistantBlocks: [],
    pendingToolResultBlocks: [],
    expectedToolResults: new Map(),
    openAssistantTextIndex: null,
  };
}

/**
 * Mark the stream unavailable (503 from route). Status -> `unavailable`;
 * the user message stays in wireMessages so the user can retry, but the
 * page will offer the direct-form fallback link.
 */
export function markUnavailable(state: ChatState): ChatState {
  return {
    ...state,
    status: "unavailable",
    displayItems: [
      ...state.displayItems,
      {
        kind: "system",
        severity: "warn",
        text: "Agent is unavailable. Use the direct form to submit an entry without the conversational flow.",
      },
    ],
  };
}

/**
 * Mark the stream errored from outside the event loop (network drop,
 * 4xx other than 503, parser SseStreamError). Status -> `error`.
 */
export function markStreamError(state: ChatState, message: string): ChatState {
  return {
    ...state,
    status: "error",
    error: message,
    displayItems: [
      ...state.displayItems,
      { kind: "system", severity: "error", text: `Stream error: ${message}` },
    ],
  };
}

/**
 * Mark `max_turns_exceeded` (HTTP 400 from route before SSE opens, OR an
 * in-stream `done max_turns` event — both route to the same UX state so
 * the page renders the "Start new conversation" affordance uniformly).
 */
export function markMaxTurnsExceeded(state: ChatState): ChatState {
  return {
    ...state,
    status: "error",
    error: "max_turns_exceeded",
    displayItems: [
      ...state.displayItems,
      {
        kind: "system",
        severity: "error",
        text: "Conversation length cap reached (max 20 turns). Start a new conversation to continue.",
      },
    ],
  };
}

/**
 * Cancel an in-progress stream (user clicks Cancel). Status -> `idle`;
 * pending buffers are discarded so the partial assistant turn does NOT
 * land in `wireMessages` — the user can resend without poisoning history.
 */
export function cancel(state: ChatState): ChatState {
  if (state.status !== "streaming") return state;
  return {
    ...state,
    status: "idle",
    pendingAssistantBlocks: [],
    pendingToolResultBlocks: [],
    expectedToolResults: new Map(),
    openAssistantTextIndex: null,
    displayItems: [...state.displayItems, { kind: "system", severity: "info", text: "Cancelled." }],
  };
}

/** Reset to a fresh conversation. Used by the max-turns banner button. */
export function reset(): ChatState {
  return initialChatState;
}

/**
 * Apply one `AgentEvent` from the SSE stream. Pure function; returns a
 * new state. Events outside the streaming phase return the state
 * unchanged — the wire stream is supposed to stop emitting after
 * `done end_turn` / `done max_*`, so post-terminal events would be a
 * protocol error and are silently swallowed rather than mutating UI.
 * An unknown event kind also returns state unchanged (no runtime crash).
 */
export function applyEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.kind) {
    case "text_delta":
      if (state.status !== "streaming") return state;
      return applyTextDelta(state, event.text);
    case "tool_use_start":
      if (state.status !== "streaming") return state;
      return applyToolUseStart(state, event.id, event.name, event.input);
    case "tool_result":
      if (state.status !== "streaming") return state;
      return applyToolResult(state, event);
    case "done":
      return applyDone(state, event.stop_reason);
    case "error":
      return {
        ...state,
        status: "error",
        error: `${event.code}: ${event.message}`,
        displayItems: [
          ...state.displayItems,
          {
            kind: "system",
            severity: "error",
            text: `Agent error: ${event.code}: ${event.message}`,
          },
        ],
      };
    default:
      // Unknown event kind — never mutate state, never crash. Adding a
      // new AgentEvent kind to the union surfaces here as a TS error
      // because the switch is exhaustive over the known cases; the
      // `default` is the runtime safety net for events that slip through
      // the unchecked JSON cast in `sse-parse.ts`.
      return state;
  }
}

/**
 * Flush any pending tool-result blocks as a user-role wire message.
 * Called as the first step of `applyTextDelta` / `applyToolUseStart`
 * whenever the next assistant turn is about to begin AND there are
 * tool-results from the prior turn waiting to be interleaved. Keeps
 * the wire shape correctly ordered: `[..., assistant, user(tool_result), assistant_next]`.
 */
function flushPendingToolResults(state: ChatState): ChatState {
  if (state.pendingToolResultBlocks.length === 0) return state;
  return {
    ...state,
    wireMessages: [...state.wireMessages, { role: "user", content: state.pendingToolResultBlocks }],
    pendingToolResultBlocks: [],
    expectedToolResults: new Map(),
  };
}

function applyTextDelta(state: ChatState, text: string): ChatState {
  // If no assistant blocks are pending, we're starting a fresh assistant
  // turn — flush any prior turn's tool-results into the wire first.
  const base = state.pendingAssistantBlocks.length === 0 ? flushPendingToolResults(state) : state;

  const last = base.pendingAssistantBlocks[base.pendingAssistantBlocks.length - 1];
  const blocksOpen = last !== undefined && last.type === "text";
  const nextBlocks = blocksOpen
    ? base.pendingAssistantBlocks.map((b, i, arr) =>
        i === arr.length - 1 && b.type === "text" ? { ...b, text: b.text + text } : b,
      )
    : [...base.pendingAssistantBlocks, { type: "text" as const, text }];

  let displayItems = base.displayItems;
  let openIdx = base.openAssistantTextIndex;
  if (openIdx !== null && displayItems[openIdx]?.kind === "assistant_text") {
    const item = displayItems[openIdx] as DisplayItem & { kind: "assistant_text" };
    const merged: DisplayItem = {
      kind: "assistant_text",
      text: item.text + text,
      dir: item.dir,
    };
    displayItems = displayItems.map((d, i) => (i === openIdx ? merged : d));
  } else {
    const newItem: DisplayItem = { kind: "assistant_text", text, dir: detectDir(text) };
    displayItems = [...displayItems, newItem];
    openIdx = displayItems.length - 1;
  }
  return {
    ...base,
    pendingAssistantBlocks: nextBlocks,
    displayItems,
    openAssistantTextIndex: openIdx,
  };
}

function applyToolUseStart(
  state: ChatState,
  toolUseId: string,
  name: string,
  input: unknown,
): ChatState {
  // Same fresh-assistant-turn flush as applyTextDelta.
  const base = state.pendingAssistantBlocks.length === 0 ? flushPendingToolResults(state) : state;

  return {
    ...base,
    pendingAssistantBlocks: [
      ...base.pendingAssistantBlocks,
      { type: "tool_use", id: toolUseId, name, input },
    ],
    displayItems: [...base.displayItems, { kind: "tool_use", name, toolUseId, input }],
    openAssistantTextIndex: null,
  };
}

function applyToolResult(
  state: ChatState,
  event: Extract<AgentEvent, { kind: "tool_result" }>,
): ChatState {
  // Match against the harvested expectedToolResults queue from the last
  // `done tool_use`. No match -> surface a system error and DROP the
  // wire write (an empty `tool_use_id` would make the next POST fail
  // server-side; better to fail loud in the UI now).
  const queue = state.expectedToolResults.get(event.name);
  const toolUseId = queue && queue.length > 0 ? queue[0] : undefined;

  if (toolUseId === undefined) {
    return {
      ...state,
      displayItems: [
        ...state.displayItems,
        {
          kind: "system",
          severity: "error",
          text: `Protocol error: tool_result for "${event.name}" without a matching tool_use. Dropped.`,
        },
      ],
    };
  }

  const newExpected = new Map(state.expectedToolResults);
  newExpected.set(event.name, queue!.slice(1));

  const displayItem: DisplayItem =
    event.ok === true
      ? { kind: "tool_result", name: event.name, ok: true, output: event.output }
      : { kind: "tool_result_error", name: event.name, error: event.error };

  const wireBlock: Extract<AgentContentBlock, { type: "tool_result" }> = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(event.ok === true ? event.output : { error: event.error }),
    is_error: event.ok !== true,
  };

  return {
    ...state,
    displayItems: [...state.displayItems, displayItem],
    pendingToolResultBlocks: [...state.pendingToolResultBlocks, wireBlock],
    expectedToolResults: newExpected,
  };
}

function applyDone(
  state: ChatState,
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "max_iterations" | "max_turns",
): ChatState {
  if (stopReason === "tool_use") {
    // Promote the assistant turn that just asked for tools, harvest its
    // tool_use IDs into `expectedToolResults` (FIFO per name) so the
    // upcoming `tool_result` events can be matched to ids. Stream
    // stays `streaming` — the server is about to fire tool_results
    // then loop into the next agent call.
    const expected = new Map<string, string[]>();
    for (const block of state.pendingAssistantBlocks) {
      if (block.type === "tool_use") {
        const arr = expected.get(block.name) ?? [];
        arr.push(block.id);
        expected.set(block.name, arr);
      }
    }
    const nextWire: AgentMessage[] = [...state.wireMessages];
    if (state.pendingAssistantBlocks.length > 0) {
      nextWire.push({ role: "assistant", content: state.pendingAssistantBlocks });
    }
    return {
      ...state,
      wireMessages: nextWire,
      pendingAssistantBlocks: [],
      expectedToolResults: expected,
      openAssistantTextIndex: null,
      status: "streaming",
    };
  }

  if (stopReason === "max_turns") {
    // Route the in-stream max_turns case to the same UX state as the
    // pre-stream HTTP 400 path so the page renders one consistent
    // "Start new conversation" affordance instead of two parallel ones.
    return markMaxTurnsExceeded(promoteTerminalTurn(state));
  }

  const systemNote: DisplayItem | null =
    stopReason === "max_iterations"
      ? {
          kind: "system",
          severity: "warn",
          text: "Conversation hit the tool-iteration cap. Try rephrasing or start a new entry.",
        }
      : stopReason === "max_tokens"
        ? { kind: "system", severity: "warn", text: "Response truncated at the token cap." }
        : null; // end_turn: no system note
  const promoted = promoteTerminalTurn(state);
  const next: ChatState = { ...promoted, status: "done" };
  if (systemNote === null) return next;
  return { ...next, displayItems: [...next.displayItems, systemNote] };
}

/**
 * Finalize the in-progress turn for a terminal `done` event. Flush
 * pending tool-results FIRST (so they land before any final assistant
 * blocks in the wire), then promote any remaining assistant blocks.
 */
function promoteTerminalTurn(state: ChatState): ChatState {
  let next: ChatState = state;
  if (next.pendingToolResultBlocks.length > 0 && next.pendingAssistantBlocks.length === 0) {
    // No further assistant content arrived after the tool round — flush
    // the tool-results as a trailing user message.
    next = flushPendingToolResults(next);
  } else if (next.pendingToolResultBlocks.length > 0) {
    // Defensive: shouldn't happen because applyTextDelta /
    // applyToolUseStart flush before opening a new assistant turn. If
    // we get here, place tool_results BEFORE the assistant blocks to
    // preserve the [assistant, user(tool_result), assistant_next] shape.
    next = flushPendingToolResults(next);
  }
  if (next.pendingAssistantBlocks.length > 0) {
    next = {
      ...next,
      wireMessages: [
        ...next.wireMessages,
        { role: "assistant", content: next.pendingAssistantBlocks },
      ],
      pendingAssistantBlocks: [],
    };
  }
  return {
    ...next,
    expectedToolResults: new Map(),
    openAssistantTextIndex: null,
  };
}
