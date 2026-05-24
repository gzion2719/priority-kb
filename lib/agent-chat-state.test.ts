// lib/agent-chat-state.test.ts — pure reducer tests.

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./agents";
import {
  applyEvent,
  appendUserText,
  cancel,
  detectDir,
  initialChatState,
  markMaxTurnsExceeded,
  markStreamError,
  markUnavailable,
} from "./agent-chat-state";

describe("detectDir", () => {
  it("returns rtl on Hebrew first strong-direction char", () => {
    expect(detectDir("שלום world")).toBe("rtl");
  });
  it("returns ltr on English first strong-direction char", () => {
    expect(detectDir("hello שלום")).toBe("ltr");
  });
  it("returns rtl on Arabic first strong-direction char", () => {
    expect(detectDir("مرحبا")).toBe("rtl");
  });
  it("skips ASCII punctuation/space and finds the first strong char", () => {
    expect(detectDir("  שלום")).toBe("rtl");
  });
  it("defaults to ltr on text with no strong-direction chars", () => {
    expect(detectDir("  ")).toBe("ltr");
  });
});

describe("appendUserText", () => {
  it("pushes user wireMessage + user displayItem + sets status=streaming", () => {
    const s = appendUserText(initialChatState, "hi");
    expect(s.wireMessages).toEqual([{ role: "user", content: "hi" }]);
    expect(s.displayItems).toEqual([{ kind: "user", text: "hi", dir: "ltr" }]);
    expect(s.status).toBe("streaming");
  });
  it("tags Hebrew user input as rtl", () => {
    const s = appendUserText(initialChatState, "שלום");
    expect(s.displayItems[0]).toMatchObject({ kind: "user", dir: "rtl" });
  });
});

describe("applyEvent — text_delta", () => {
  it("opens a new assistant text bubble on the first delta", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "He" });
    expect(s.displayItems[1]).toEqual({ kind: "assistant_text", text: "He", dir: "ltr" });
    expect(s.pendingAssistantBlocks).toEqual([{ type: "text", text: "He" }]);
    expect(s.openAssistantTextIndex).toBe(1);
  });
  it("accumulates subsequent deltas into the open bubble (one block, one displayItem)", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "He" });
    s = applyEvent(s, { kind: "text_delta", text: "llo" });
    expect(s.displayItems).toHaveLength(2);
    expect(s.displayItems[1]).toMatchObject({ kind: "assistant_text", text: "Hello" });
    expect(s.pendingAssistantBlocks).toEqual([{ type: "text", text: "Hello" }]);
  });
  it("text after tool_use_start opens a NEW assistant text block (mirrors server flushText)", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "before" });
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_1",
      name: "list_categories",
      input: {},
    });
    s = applyEvent(s, { kind: "text_delta", text: "after" });
    expect(s.pendingAssistantBlocks).toEqual([
      { type: "text", text: "before" },
      { type: "tool_use", id: "toolu_1", name: "list_categories", input: {} },
      { type: "text", text: "after" },
    ]);
    expect(s.displayItems.map((d) => d.kind)).toEqual([
      "user",
      "assistant_text",
      "tool_use",
      "assistant_text",
    ]);
  });
  it("is a no-op after a terminal done (event arriving post-end_turn is dropped)", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "answer" });
    s = applyEvent(s, { kind: "done", stop_reason: "end_turn" });
    const before = s;
    s = applyEvent(s, { kind: "text_delta", text: "late" });
    expect(s).toBe(before); // identity — no state mutation
  });
});

describe("applyEvent — tool_use_start", () => {
  it("flushes the open text block and pushes a tool_use chip", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "txt" });
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_A",
      name: "search_kb",
      input: { query: "foo" },
    });
    expect(s.openAssistantTextIndex).toBeNull();
    expect(s.pendingAssistantBlocks).toEqual([
      { type: "text", text: "txt" },
      { type: "tool_use", id: "toolu_A", name: "search_kb", input: { query: "foo" } },
    ]);
    expect(s.displayItems[s.displayItems.length - 1]).toMatchObject({
      kind: "tool_use",
      name: "search_kb",
      toolUseId: "toolu_A",
    });
  });
});

describe("applyEvent — tool_result", () => {
  it("after a done tool_use, the matching tool_result records the id from expectedToolResults", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_X",
      name: "list_categories",
      input: {},
    });
    s = applyEvent(s, { kind: "done", stop_reason: "tool_use" });
    expect(s.status).toBe("streaming");
    s = applyEvent(s, {
      kind: "tool_result",
      name: "list_categories",
      ok: true,
      output: { categories: ["bugs"] },
    });
    expect(s.displayItems.at(-1)).toEqual({
      kind: "tool_result",
      name: "list_categories",
      ok: true,
      output: { categories: ["bugs"] },
    });
    expect(s.pendingToolResultBlocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_X",
        content: JSON.stringify({ categories: ["bugs"] }),
        is_error: false,
      },
    ]);
  });
  it("ok=false tool_result records is_error=true and {error: ...} as content", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_Y",
      name: "submit_entry",
      input: {},
    });
    s = applyEvent(s, { kind: "done", stop_reason: "tool_use" });
    s = applyEvent(s, {
      kind: "tool_result",
      name: "submit_entry",
      ok: false,
      error: "invalid_input",
    });
    expect(s.displayItems.at(-1)).toEqual({
      kind: "tool_result_error",
      name: "submit_entry",
      error: "invalid_input",
    });
    expect(s.pendingToolResultBlocks[0]).toMatchObject({
      tool_use_id: "toolu_Y",
      is_error: true,
    });
  });
  it("tool_result without a matching tool_use surfaces a protocol-error system message and drops the wire write (B3)", () => {
    let s = appendUserText(initialChatState, "hi");
    // No tool_use, no done tool_use — just a stray tool_result.
    s = applyEvent(s, {
      kind: "tool_result",
      name: "search_kb",
      ok: true,
      output: { candidates: [] },
    });
    expect(s.pendingToolResultBlocks).toEqual([]);
    expect(s.displayItems.at(-1)).toMatchObject({
      kind: "system",
      severity: "error",
    });
    expect((s.displayItems.at(-1) as { text: string }).text).toMatch(/protocol error/i);
  });
});

describe("applyEvent — done", () => {
  it("end_turn (single assistant turn, no tools) promotes blocks to wireMessages and sets status=done", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "answer" });
    s = applyEvent(s, { kind: "done", stop_reason: "end_turn" });
    expect(s.status).toBe("done");
    expect(s.wireMessages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
    expect(s.pendingAssistantBlocks).toEqual([]);
  });
  it("tool round trip writes [user, assistant(text+tool_use), user(tool_result), assistant(text)] — load-bearing wire order (B1)", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "thinking..." });
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_1",
      name: "list_categories",
      input: {},
    });
    // Server's actual sequence has done tool_use BETWEEN tool_use_start
    // and tool_result. The earlier reducer version omitted this and
    // produced [user, assistant1, assistant2, user(tool_result)] — wrong order.
    s = applyEvent(s, { kind: "done", stop_reason: "tool_use" });
    s = applyEvent(s, {
      kind: "tool_result",
      name: "list_categories",
      ok: true,
      output: { categories: ["a"] },
    });
    // Next assistant turn begins — this is the moment pendingToolResultBlocks
    // must flush BEFORE the new assistant blocks are accumulated.
    s = applyEvent(s, { kind: "text_delta", text: "ok done" });
    s = applyEvent(s, { kind: "done", stop_reason: "end_turn" });
    expect(s.wireMessages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking..." },
          { type: "tool_use", id: "toolu_1", name: "list_categories", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: JSON.stringify({ categories: ["a"] }),
            is_error: false,
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok done" }] },
    ]);
  });
  it("tool round trip with NO trailing assistant text still places tool_result before end_turn promotion", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_2",
      name: "list_categories",
      input: {},
    });
    s = applyEvent(s, { kind: "done", stop_reason: "tool_use" });
    s = applyEvent(s, {
      kind: "tool_result",
      name: "list_categories",
      ok: true,
      output: { categories: [] },
    });
    s = applyEvent(s, { kind: "done", stop_reason: "end_turn" });
    expect(s.wireMessages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_2", name: "list_categories", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: JSON.stringify({ categories: [] }),
            is_error: false,
          },
        ],
      },
    ]);
  });
  it("two parallel tool_use blocks in one turn flush both tool_results in order", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_A",
      name: "list_categories",
      input: {},
    });
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_B",
      name: "search_kb",
      input: { query: "x" },
    });
    s = applyEvent(s, { kind: "done", stop_reason: "tool_use" });
    s = applyEvent(s, {
      kind: "tool_result",
      name: "list_categories",
      ok: true,
      output: { categories: ["a"] },
    });
    s = applyEvent(s, {
      kind: "tool_result",
      name: "search_kb",
      ok: true,
      output: { candidates: [] },
    });
    s = applyEvent(s, { kind: "done", stop_reason: "end_turn" });
    const lastUser = s.wireMessages.at(-1)!;
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_A",
        content: JSON.stringify({ categories: ["a"] }),
        is_error: false,
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_B",
        content: JSON.stringify({ candidates: [] }),
        is_error: false,
      },
    ]);
  });
  it("tool_use stop_reason keeps status=streaming (server will loop)", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "x" });
    s = applyEvent(s, { kind: "done", stop_reason: "tool_use" });
    expect(s.status).toBe("streaming");
  });
  it("max_iterations renders a system warning and sets status=done", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "done", stop_reason: "max_iterations" });
    expect(s.status).toBe("done");
    expect((s.displayItems.at(-1) as { text: string }).text).toMatch(/tool-iteration cap/i);
  });
  it("max_turns routes through markMaxTurnsExceeded (status=error, error=max_turns_exceeded — M7)", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "done", stop_reason: "max_turns" });
    expect(s.status).toBe("error");
    expect(s.error).toBe("max_turns_exceeded");
  });
  it("max_tokens renders a system warning and sets status=done", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "done", stop_reason: "max_tokens" });
    expect((s.displayItems.at(-1) as { text: string }).text).toMatch(/truncated/i);
  });

  // ── refusal stop_reason (ADR-0010 §1 Amendment 2026-05-28; BACKLOG:28) ──
  it("refusal terminal → status=done (NOT status=error) — clean terminal, not internal error", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "done", stop_reason: "refusal" });
    expect(s.status).toBe("done");
    // Negative-assertion: refusal must NOT route through the error branch
    // (which would land here as status:"error" with `s.error` set). The
    // distinguishing property is the absence of an `error` field combined
    // with a warn-severity (not error-severity) trailing bubble.
    expect(s.error).toBeUndefined();
  });

  it("refusal terminal → warn-severity bubble with 'declined to answer' copy (sibling to max_iterations/max_tokens)", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "done", stop_reason: "refusal" });
    const last = s.displayItems.at(-1) as { kind: string; severity: string; text: string };
    expect(last.kind).toBe("system");
    expect(last.severity).toBe("warn");
    expect(last.text).toMatch(/declined/i);
  });

  it("refusal after partial assistant text → partial text is promoted to wireMessages (matches end_turn)", () => {
    // Anthropic can stream text deltas and then refuse via message_delta.
    // The reducer should promote the partial assistant blocks to
    // wireMessages on the terminal (same shape as end_turn) so the UI
    // shows what the model said before declining.
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "Sorry, I can't " });
    s = applyEvent(s, { kind: "text_delta", text: "help with that." });
    s = applyEvent(s, { kind: "done", stop_reason: "refusal" });
    // Wire: user + assistant(text) — the partial assistant turn is
    // preserved, not dropped.
    expect(s.wireMessages.length).toBe(2);
    expect(s.wireMessages[1].role).toBe("assistant");
    const content = s.wireMessages[1].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([{ type: "text", text: "Sorry, I can't help with that." }]);
    // pendingAssistantBlocks must be cleared post-promotion.
    expect(s.pendingAssistantBlocks).toEqual([]);
    expect(s.status).toBe("done");
  });

  it("refusal does not re-enter streaming (terminal isolation from tool_use)", () => {
    // tool_use keeps the stream open (server loops); every other stop_reason
    // including refusal must terminate. Pin the distinction so a future
    // refactor that lumps refusal into the loop branch fails loudly.
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "done", stop_reason: "refusal" });
    expect(s.status).not.toBe("streaming");
    expect(s.status).toBe("done");
  });
});

describe("applyEvent — error and unknown kinds", () => {
  it("sets status=error and records the code+message", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "error", code: "deadline_exceeded", message: "timed out" });
    expect(s.status).toBe("error");
    expect(s.error).toBe("deadline_exceeded: timed out");
  });
  it("unknown event kind returns state unchanged — no setState(undefined) (B2)", () => {
    const s = appendUserText(initialChatState, "hi");
    // Cast through unknown to simulate an event slipping past the wire
    // shape check (sse-parse rejects these at parse time, but the
    // reducer is the runtime safety net).
    const bogus = { kind: "future_kind", payload: 42 } as unknown as AgentEvent;
    const next = applyEvent(s, bogus);
    expect(next).toBe(s);
  });
});

describe("markUnavailable / markStreamError / markMaxTurnsExceeded", () => {
  it("markUnavailable sets status=unavailable and adds a warn banner", () => {
    const s0 = appendUserText(initialChatState, "hi");
    const s = markUnavailable(s0);
    expect(s.status).toBe("unavailable");
    expect(s.displayItems.at(-1)).toMatchObject({ kind: "system", severity: "warn" });
  });
  it("markStreamError sets status=error with message", () => {
    const s0 = appendUserText(initialChatState, "hi");
    const s = markStreamError(s0, "ECONNRESET");
    expect(s.status).toBe("error");
    expect(s.error).toBe("ECONNRESET");
  });
  it("markMaxTurnsExceeded sets status=error with max_turns_exceeded code", () => {
    const s0 = appendUserText(initialChatState, "hi");
    const s = markMaxTurnsExceeded(s0);
    expect(s.status).toBe("error");
    expect(s.error).toBe("max_turns_exceeded");
    expect((s.displayItems.at(-1) as { text: string }).text).toMatch(/length cap/i);
  });
});

describe("cancel", () => {
  it("from streaming -> idle, discards pending blocks and tool results (does NOT poison wireMessages)", () => {
    let s = appendUserText(initialChatState, "hi");
    s = applyEvent(s, { kind: "text_delta", text: "partial" });
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_1",
      name: "list_categories",
      input: {},
    });
    s = cancel(s);
    expect(s.status).toBe("idle");
    expect(s.pendingAssistantBlocks).toEqual([]);
    expect(s.pendingToolResultBlocks).toEqual([]);
    expect(s.wireMessages).toEqual([{ role: "user", content: "hi" }]);
    expect(s.displayItems.at(-1)).toMatchObject({ kind: "system", severity: "info" });
  });
  it("no-op when not streaming", () => {
    const s = cancel(initialChatState);
    expect(s).toEqual(initialChatState);
  });
});

describe("multi-turn wireMessages history", () => {
  it("turn 1 + tool round trip + turn 2 user message: history preserved with correct ordering", () => {
    let s = appendUserText(initialChatState, "first");
    s = applyEvent(s, { kind: "text_delta", text: "thinking" });
    s = applyEvent(s, {
      kind: "tool_use_start",
      id: "toolu_1",
      name: "list_categories",
      input: {},
    });
    s = applyEvent(s, { kind: "done", stop_reason: "tool_use" });
    s = applyEvent(s, {
      kind: "tool_result",
      name: "list_categories",
      ok: true,
      output: { categories: [] },
    });
    s = applyEvent(s, { kind: "text_delta", text: "reply1" });
    s = applyEvent(s, { kind: "done", stop_reason: "end_turn" });
    s = appendUserText(s, "second");
    expect(s.wireMessages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(s.status).toBe("streaming");
  });
});
