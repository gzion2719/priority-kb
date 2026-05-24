// lib/agents-anthropic.test.ts — ADR-0010 impl step 3b.
//
// Mocks @anthropic-ai/sdk and asserts the adapter's RawMessageStreamEvent →
// AgentEvent translation. Iron rule #8 compliance: no live API calls; the
// fake `Anthropic` class returns canned event sequences.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mock ──────────────────────────────────────────────────────────────
//
// `vi.mock` is hoisted to the top of the file before any top-level `const`
// runs; we use `vi.hoisted` to lift the mock classes + spy + stream factory
// into the same hoisting tier so the factory can reference them safely.
// Error subclasses must be `instanceof`-checkable against the same exported
// names the adapter imports — they double as the mocked module's exports
// AND the prototypes the tests throw.

const {
  MockAPIError,
  MockAPIConnectionError,
  MockAPIUserAbortError,
  MockRateLimitError,
  MockInternalServerError,
  MockAuthenticationError,
  MockBadRequestError,
  MockAnthropic,
  createSpy,
  streamHolder,
} = vi.hoisted(() => {
  class MockAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "APIError";
    }
  }
  class MockAPIConnectionError extends MockAPIError {
    constructor(message = "connection failed") {
      super(0, message);
      this.name = "APIConnectionError";
    }
  }
  class MockAPIUserAbortError extends MockAPIError {
    constructor(message = "aborted") {
      super(0, message);
      this.name = "APIUserAbortError";
    }
  }
  class MockRateLimitError extends MockAPIError {
    constructor() {
      super(429, "rate limited");
      this.name = "RateLimitError";
    }
  }
  class MockInternalServerError extends MockAPIError {
    constructor() {
      super(500, "internal");
      this.name = "InternalServerError";
    }
  }
  class MockAuthenticationError extends MockAPIError {
    constructor() {
      super(401, "bad key");
      this.name = "AuthenticationError";
    }
  }
  class MockBadRequestError extends MockAPIError {
    constructor() {
      super(400, "bad request");
      this.name = "BadRequestError";
    }
  }

  const createSpy = vi.fn();
  // Mutable holder so tests can swap the stream factory between cases.
  const streamHolder: { factory: () => AsyncIterable<unknown> } = {
    factory: async function* () {},
  };

  class MockAnthropic {
    apiKey: string;
    messages = {
      create: (...args: unknown[]) => {
        createSpy(...args);
        return Promise.resolve(streamHolder.factory());
      },
    };
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
    }
  }

  return {
    MockAPIError,
    MockAPIConnectionError,
    MockAPIUserAbortError,
    MockRateLimitError,
    MockInternalServerError,
    MockAuthenticationError,
    MockBadRequestError,
    MockAnthropic,
    createSpy,
    streamHolder,
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: MockAnthropic,
  APIError: MockAPIError,
  APIConnectionError: MockAPIConnectionError,
  APIUserAbortError: MockAPIUserAbortError,
  RateLimitError: MockRateLimitError,
  InternalServerError: MockInternalServerError,
  AuthenticationError: MockAuthenticationError,
  BadRequestError: MockBadRequestError,
}));

// Import AFTER the mock declaration so the adapter binds to the mocks.
import {
  ANTHROPIC_MODEL,
  ANTHROPIC_SDK_VERSION,
  createAnthropicAgent,
  __testHelpers,
} from "./agents-anthropic";
import {
  AgentUnavailableError,
  type AgentEvent,
  type AgentMessage,
  type AgentStreamInput,
} from "./agents";

function makeInput(overrides?: Partial<AgentStreamInput>): AgentStreamInput {
  const ac = new AbortController();
  return {
    system_prompt: "test-prompt",
    messages: [],
    tools: [],
    max_tool_iterations: 8,
    deadline_ms: 60_000,
    signal: ac.signal,
    ...overrides,
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

function setStream(events: unknown[]): void {
  streamHolder.factory = () =>
    (async function* () {
      for (const ev of events) yield ev;
    })();
}

function setStreamThatThrows(err: unknown): void {
  streamHolder.factory = () =>
    (async function* () {
      throw err;
    })();
}

beforeEach(() => {
  createSpy.mockClear();
  streamHolder.factory = async function* () {};
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Construction + identity ───────────────────────────────────────────────

describe("createAnthropicAgent — identity + plumbing", () => {
  it("exposes ANTHROPIC_MODEL + ANTHROPIC_SDK_VERSION on the AgentClient surface", () => {
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    expect(a.model).toBe(ANTHROPIC_MODEL);
    expect(a.model_version).toBe(ANTHROPIC_SDK_VERSION);
  });

  it("forwards input.signal to messages.create({signal}) — abort plumbing assertion", async () => {
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const ac = new AbortController();
    setStream([
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]);
    await collect(a.streamMessages(makeInput({ signal: ac.signal })));
    expect(createSpy).toHaveBeenCalledTimes(1);
    const [body, opts] = createSpy.mock.calls[0] as [{ stream: boolean }, { signal: AbortSignal }];
    expect(body.stream).toBe(true);
    expect(opts.signal).toBe(ac.signal);
  });

  it("ANTHROPIC_SDK_VERSION matches the package.json pin AND the SDK is listed in exactly one of deps/devDeps (drift floor)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const inDeps = pkg.dependencies?.["@anthropic-ai/sdk"];
    const inDev = pkg.devDependencies?.["@anthropic-ai/sdk"];
    // Exactly one of the two — a dual listing with mismatched pins would
    // pass a naive `??` fallback while shipping a divergent version.
    const presence = [inDeps, inDev].filter((v) => v !== undefined);
    expect(presence).toHaveLength(1);
    expect(presence[0]).toBe(ANTHROPIC_SDK_VERSION);
  });
});

// ── Event translation ─────────────────────────────────────────────────────

describe("streamMessages — event translation", () => {
  it("text_delta inside content_block_delta → AgentEvent text_delta", async () => {
    setStream([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world" },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const events = await collect(a.streamMessages(makeInput()));
    expect(events).toEqual<AgentEvent[]>([
      { kind: "text_delta", text: "hello " },
      { kind: "text_delta", text: "world" },
      { kind: "done", stop_reason: "end_turn" },
    ]);
  });

  it("input_json_delta buffers across deltas and emits tool_use_start ONLY at content_block_stop with parsed object", async () => {
    // Sentinel: a text_delta on a parallel content-block index is injected
    // BETWEEN the two input_json_delta chunks. A regression that emitted
    // tool_use_start at content_block_start (with input:{}) — or at any
    // input_json_delta — would produce a different ordering. The assertion
    // proves tool_use_start lands AFTER the sentinel text_delta, i.e. at
    // content_block_stop, with the FULLY-accumulated JSON parsed.
    setStream([
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_01abc", name: "submit_entry" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"title":"a' },
      },
      // Sentinel between the two input_json_delta chunks.
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "SENTINEL" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'lpha","x":1}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const events = await collect(a.streamMessages(makeInput()));
    expect(events).toEqual<AgentEvent[]>([
      { kind: "text_delta", text: "SENTINEL" },
      {
        kind: "tool_use_start",
        id: "toolu_01abc",
        name: "submit_entry",
        input: { title: "alpha", x: 1 },
      },
      { kind: "done", stop_reason: "tool_use" },
    ]);
  });

  it("interleaved text → tool_use → text yields events in the exact stream order", async () => {
    setStream([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "thinking… " },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_inter", name: "list_categories" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "got it" },
      },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const events = await collect(a.streamMessages(makeInput()));
    expect(events).toEqual<AgentEvent[]>([
      { kind: "text_delta", text: "thinking… " },
      { kind: "tool_use_start", id: "toolu_inter", name: "list_categories", input: {} },
      { kind: "text_delta", text: "got it" },
      { kind: "done", stop_reason: "tool_use" },
    ]);
  });

  it("empty-input tool with one partial_json:'' delta → input:{}", async () => {
    setStream([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_empty1", name: "list_categories" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const events = await collect(a.streamMessages(makeInput()));
    expect(events[0]).toEqual({
      kind: "tool_use_start",
      id: "toolu_empty1",
      name: "list_categories",
      input: {},
    });
  });

  it("truncated tool_use (content_block_start without content_block_stop) → error('truncated_tool_use') then done", async () => {
    // Network blip or server abort between content_block_start and the
    // matching content_block_stop. Without the flush guard, the loop driver
    // would see stop_reason:"tool_use" with zero tool_use_start events and
    // hang waiting for tool input that never arrives.
    setStream([
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_truncated", name: "submit_entry" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"title":"par' },
      },
      // No content_block_stop for index 1 — the stream ends mid-block.
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const events = await collect(a.streamMessages(makeInput()));
    expect(events).toEqual<AgentEvent[]>([
      {
        kind: "error",
        code: "truncated_tool_use",
        message: "stream ended with 1 unfinished tool_use block(s)",
      },
      { kind: "done", stop_reason: "tool_use" },
    ]);
  });

  it("empty-input tool with zero input_json_delta events → input:{}", async () => {
    setStream([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_empty0", name: "list_categories" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const events = await collect(a.streamMessages(makeInput()));
    expect(events[0]).toEqual({
      kind: "tool_use_start",
      id: "toolu_empty0",
      name: "list_categories",
      input: {},
    });
  });
});

// ── stop_reason mapping ───────────────────────────────────────────────────

describe("translateStopReason — ADR-0010 §1", () => {
  it.each([
    ["end_turn", "end_turn"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "end_turn"],
    ["pause_turn", "end_turn"],
  ])("%s → %s", async (from, expected) => {
    setStream([{ type: "message_delta", delta: { stop_reason: from } }, { type: "message_stop" }]);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const events = await collect(a.streamMessages(makeInput()));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "done", stop_reason: expected });
  });

  it("null stop_reason defaults to end_turn", async () => {
    setStream([{ type: "message_delta", delta: { stop_reason: null } }, { type: "message_stop" }]);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const events = await collect(a.streamMessages(makeInput()));
    expect(events).toEqual([{ kind: "done", stop_reason: "end_turn" }]);
  });

  it("refusal → error('refusal') THEN done('end_turn') — distinct surface for the route", async () => {
    setStream([
      { type: "message_delta", delta: { stop_reason: "refusal" } },
      { type: "message_stop" },
    ]);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    const events = await collect(a.streamMessages(makeInput()));
    expect(events).toEqual<AgentEvent[]>([
      { kind: "error", code: "refusal", message: "model refused to respond" },
      { kind: "done", stop_reason: "end_turn" },
    ]);
  });
});

// ── Error mapping ─────────────────────────────────────────────────────────

describe("error mapping — iron rules #1 + #12 surface", () => {
  it("APIConnectionError thrown by SDK → AgentUnavailableError (transient, route 503)", async () => {
    setStreamThatThrows(new MockAPIConnectionError("ECONNREFUSED"));
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    await expect(collect(a.streamMessages(makeInput()))).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
  });

  it("RateLimitError → AgentUnavailableError", async () => {
    setStreamThatThrows(new MockRateLimitError());
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    await expect(collect(a.streamMessages(makeInput()))).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
  });

  it("InternalServerError → AgentUnavailableError", async () => {
    setStreamThatThrows(new MockInternalServerError());
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    await expect(collect(a.streamMessages(makeInput()))).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
  });

  it("generic APIError(status>=500) → AgentUnavailableError", async () => {
    setStreamThatThrows(new MockAPIError(502, "bad gateway"));
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    await expect(collect(a.streamMessages(makeInput()))).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
  });

  // Parametrized: each 4xx error class must rethrow UNCHANGED. A regression
  // that broadened the catch to all APIError subclasses would map these to
  // AgentUnavailableError, silently degrading a config error to "transient
  // outage" — iron rule #1 demands loud misconfig.
  it.each([
    ["AuthenticationError(401)", () => new MockAuthenticationError()],
    ["BadRequestError(400)", () => new MockBadRequestError()],
    ["APIError(403) — PermissionDenied shape", () => new MockAPIError(403, "forbidden")],
    ["APIError(404) — NotFound shape", () => new MockAPIError(404, "not found")],
    ["APIError(409) — Conflict shape", () => new MockAPIError(409, "conflict")],
    ["APIError(422) — UnprocessableEntity shape", () => new MockAPIError(422, "unprocessable")],
  ])("%s rethrows the original error unchanged (4xx config error)", async (_, mk) => {
    const original = mk();
    setStreamThatThrows(original);
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    await expect(collect(a.streamMessages(makeInput()))).rejects.toBe(original);
  });

  it("APIUserAbortError → DOMException('aborted','AbortError') — matches stub agent contract", async () => {
    setStreamThatThrows(new MockAPIUserAbortError());
    const a = createAnthropicAgent({ apiKey: "sk-ant-test" });
    await expect(collect(a.streamMessages(makeInput()))).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

// ── Source-file-no-live-import floor (iron rule #8 mirror) ────────────────

describe("toAnthropicMessages — structural conversion (BACKLOG: type-boundary tightening)", () => {
  const { toAnthropicMessages } = __testHelpers;

  it("round-trips text content (string form) unchanged", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    expect(toAnthropicMessages(msgs)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
  });

  it("round-trips all three block types (text + tool_use + tool_result) per-block", () => {
    const msgs: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling search" },
          { type: "tool_use", id: "tu_1", name: "search_kb", input: { q: "invoice" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "no matches" }],
      },
    ];
    expect(toAnthropicMessages(msgs)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling search" },
          { type: "tool_use", id: "tu_1", name: "search_kb", input: { q: "invoice" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "no matches", is_error: undefined },
        ],
      },
    ]);
  });

  it("preserves tool_result.is_error when explicitly true", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_err", content: "boom", is_error: true }],
      },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out[0]?.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_err", content: "boom", is_error: true },
    ]);
  });

  // Negative-assertion: the load-bearing invariant of this refactor is that
  // tool_result.content stays `string` — never the SDK's `Array<...>` form.
  // The type-system pins this at compile time (toAnthropicBlock's return-type
  // annotation forbids any other block param shape). This runtime assertion
  // catches a regression where someone replaces the per-block map with an
  // identity-cast and the SDK's array form silently slips through.
  it("emits string content for tool_result (NOT the SDK's array form)", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "plain string" }],
      },
    ];
    const out = toAnthropicMessages(msgs);
    const block = (out[0]?.content as Array<{ type: string; content: unknown }>)[0];
    expect(typeof block?.content).toBe("string");
    expect(Array.isArray(block?.content)).toBe(false);
  });
});

describe("source file imports the SDK (counter-floor to lib/agents.ts)", () => {
  it("lib/agents-anthropic.ts DOES import @anthropic-ai/sdk — this is where the SDK lives", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "agents-anthropic.ts"), "utf8");
    // Adapter is the one file allowed to reference the SDK. If this assertion
    // ever fails, someone moved the SDK ref out of the adapter — either
    // intentional (file rename) or accidental (the import was deleted). Both
    // need explicit review.
    expect(src).toMatch(/from\s+["']@anthropic-ai\/sdk["']/);
  });
});
