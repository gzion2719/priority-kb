// app/api/agent/ingest/route.test.ts — ADR-0010 step 3a unit suite.
//
// All tests use the deterministic `createStubAgent` (or a one-off custom
// AgentClient for timing-sensitive cases). Non-negotiable #8: no live
// Anthropic / Voyage calls. The source-file-no-direct-createEntry test
// is the mechanical floor for ADR-0010 §2.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentClient,
  type AgentEvent,
  type AgentMessage,
  AgentUnavailableError,
  STUB_AGENT_MODEL,
  STUB_AGENT_VERSION,
} from "@/lib/agents";
import { resetLogSink, setLogSink } from "@/lib/log";

// ── Sink capture so we can assert on LogEvent output ──────────────────────

const logLines: string[] = [];
beforeAll(() => setLogSink((line) => logLines.push(line)));
afterAll(() => resetLogSink());

// ── Mocks: agent, db, embedder, ingest ─────────────────────────────────────

let agentForNextCall: AgentClient | null = null;
let agentThrows: Error | null = null;

vi.mock("@/lib/agents", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agents")>("@/lib/agents");
  return {
    ...actual,
    getAgent: vi.fn(() => {
      if (agentThrows) throw agentThrows;
      if (!agentForNextCall) {
        // Default: empty stub so accidental tests still resolve cleanly.
        return actual.createStubAgent([{ kind: "done", stop_reason: "end_turn" }]);
      }
      return agentForNextCall;
    }),
  };
});

const submitEntryFromAgentMock = vi.fn();
vi.mock("@/lib/ingest", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ingest")>("@/lib/ingest");
  return {
    ...actual,
    submitEntryFromAgent: (...args: unknown[]) => submitEntryFromAgentMock(...args),
  };
});

const selectDistinctMock = vi.fn();
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    selectDistinct: (...args: unknown[]) => selectDistinctMock(...args),
  })),
}));

vi.mock("@/lib/embedding", () => ({
  getEmbedder: vi.fn(() => ({ model: "stub", version: "v1" })),
}));

import { POST } from "@/app/api/agent/ingest/route";

// ── Helpers ────────────────────────────────────────────────────────────────

function adminReq(body: unknown, opts?: { signal?: AbortSignal }): Request {
  return new Request("http://x/api/agent/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "admin",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: opts?.signal,
  });
}

function userReq(body: unknown): Request {
  return new Request("http://x/api/agent/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "user",
    },
    body: JSON.stringify(body),
  });
}

async function readSse(res: Response): Promise<{
  rawBody: string;
  events: AgentEvent[];
  keepaliveCount: number;
}> {
  const text = await res.text();
  const events: AgentEvent[] = [];
  let keepaliveCount = 0;
  for (const block of text.split("\n\n")) {
    if (!block) continue;
    if (block.startsWith(": keepalive")) {
      keepaliveCount += 1;
      continue;
    }
    const line = block.startsWith("data: ") ? block.slice(6) : block;
    try {
      events.push(JSON.parse(line) as AgentEvent);
    } catch {
      // ignore non-JSON lines
    }
  }
  return { rawBody: text, events, keepaliveCount };
}

function makeBaseMessages(n = 1): AgentMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `m${i}`,
  }));
}

/**
 * Stub agent that records every `streamMessages` invocation's input into
 * `calls[]` and yields the configured `scripts[i]` on the i-th call.
 */
function makeRecordingAgent(scripts: AgentEvent[][]): {
  agent: AgentClient;
  calls: Array<{ messages: AgentMessage[]; signal: AbortSignal }>;
} {
  const calls: Array<{ messages: AgentMessage[]; signal: AbortSignal }> = [];
  let i = 0;
  const agent: AgentClient = {
    model: STUB_AGENT_MODEL,
    model_version: STUB_AGENT_VERSION,
    async *streamMessages(input) {
      calls.push({ messages: [...input.messages], signal: input.signal });
      const script = scripts[i] ?? [{ kind: "done", stop_reason: "end_turn" }];
      i += 1;
      for (const ev of script) {
        if (input.signal.aborted) throw new DOMException("aborted", "AbortError");
        yield ev;
      }
    },
  };
  return { agent, calls };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  agentForNextCall = null;
  agentThrows = null;
  logLines.length = 0;
  submitEntryFromAgentMock.mockReset();
  selectDistinctMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/agent/ingest — auth (withAdmin)", () => {
  it("non-admin (user role) → 403 forbidden, no SSE", async () => {
    const res = await POST(userReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("POST /api/agent/ingest — request validation", () => {
  it("400 invalid_json on malformed JSON", async () => {
    const res = await POST(adminReq("{nope") as never, {} as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues[0].code).toBe("invalid_json");
  });

  it("400 invalid_request when messages is missing", async () => {
    const res = await POST(adminReq({ wrong: 1 }) as never, {} as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
  });
});

describe("POST /api/agent/ingest — pre-stream caps (§3)", () => {
  it("messages.length === 41 → 400 max_turns_exceeded BEFORE SSE opens (asserts JSON, not SSE)", async () => {
    const res = await POST(adminReq({ messages: makeBaseMessages(41) }) as never, {} as never);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("event-stream");
    const json = await res.json();
    expect(json.error).toBe("max_turns_exceeded");
  });

  it("messages.length === 40 → SSE stream opens (boundary-pass distinguishes > from >=)", async () => {
    // Negative-assertion vs the off-by-one: if the cap were `>=` instead
    // of `>`, length 40 would 400 here. Asserting the SSE response
    // distinguishes "cap fires on 41+" from "cap fires on 40+".
    const { agent } = makeRecordingAgent([[{ kind: "done", stop_reason: "end_turn" }]]);
    agentForNextCall = agent;
    const res = await POST(adminReq({ messages: makeBaseMessages(40) }) as never, {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("event-stream");
    await res.text(); // drain the stream
  });
});

describe("POST /api/agent/ingest — degraded mode (§7)", () => {
  it("AgentUnavailableError from getAgent → 503 agent_unavailable JSON, no SSE", async () => {
    agentThrows = new AgentUnavailableError("upstream 5xx");
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("event-stream");
    const json = await res.json();
    expect(json.error).toBe("agent_unavailable");
  });
});

describe("POST /api/agent/ingest — happy path (§1 SSE framing)", () => {
  it("text-only turn: streams text_delta + done(end_turn) as SSE bytes; sets correct headers", async () => {
    const { agent } = makeRecordingAgent([
      [
        { kind: "text_delta", text: "hello " },
        { kind: "text_delta", text: "admin" },
        { kind: "done", stop_reason: "end_turn" },
      ],
    ]);
    agentForNextCall = agent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const { events, rawBody } = await readSse(res);
    expect(events).toEqual([
      { kind: "text_delta", text: "hello " },
      { kind: "text_delta", text: "admin" },
      { kind: "done", stop_reason: "end_turn" },
    ]);
    // Wire-framing: each event ends in \n\n.
    expect(rawBody).toContain("data: ");
    expect(rawBody.endsWith("\n\n")).toBe(true);
  });
});

describe("POST /api/agent/ingest — tool-use round trip", () => {
  it("list_categories: dispatches DB call, emits tool_result, loops to next iteration", async () => {
    selectDistinctMock.mockReturnValue({
      from: () => ({
        orderBy: () => Promise.resolve([{ category: "billing" }, { category: "shipping" }]),
      }),
    });
    const { agent, calls } = makeRecordingAgent([
      [
        { kind: "tool_use_start", id: "toolu_lc_1", name: "list_categories", input: {} },
        { kind: "done", stop_reason: "tool_use" },
      ],
      [
        { kind: "text_delta", text: "Found two." },
        { kind: "done", stop_reason: "end_turn" },
      ],
    ]);
    agentForNextCall = agent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    const { events } = await readSse(res);
    const toolResult = events.find((e) => e.kind === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.kind === "tool_result" && toolResult.ok === true) {
      expect(toolResult.output).toEqual({ categories: ["billing", "shipping"] });
    } else {
      throw new Error(`expected tool_result.ok, got ${JSON.stringify(toolResult)}`);
    }
    // Two streamMessages calls (iteration 1 + iteration 2).
    expect(calls.length).toBe(2);
    // The second call's messages must include the tool_use id (toolu_lc_1)
    // in the assistant block + the matching tool_result block.
    const secondCallContent = JSON.stringify(calls[1].messages);
    expect(secondCallContent).toContain("toolu_lc_1");
  });

  it("search_kb (M2a stub): emits ok:true with retrieval_unavailable_m2a note (§6 stub shape)", async () => {
    const { agent } = makeRecordingAgent([
      [
        { kind: "tool_use_start", id: "toolu_sk_1", name: "search_kb", input: { query: "po" } },
        { kind: "done", stop_reason: "tool_use" },
      ],
      [{ kind: "done", stop_reason: "end_turn" }],
    ]);
    agentForNextCall = agent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    const { events } = await readSse(res);
    const tr = events.find((e) => e.kind === "tool_result");
    if (tr && tr.kind === "tool_result" && tr.ok === true) {
      expect(tr.output).toEqual({ candidates: [], note: "retrieval_unavailable_m2a" });
    } else {
      throw new Error(`expected ok tool_result, got ${JSON.stringify(tr)}`);
    }
  });
});

describe("POST /api/agent/ingest — submit_entry dispatch", () => {
  const validIngest = {
    title: "PO Receipt — Validation Errors",
    category: "validation",
    tags: ["po"],
    body: "Quantity must be greater than zero.",
    source_pointer: "ticket://4242",
    last_verified_at: "2026-05-18T10:00:00Z",
    sensitivity: "internal",
  };

  it("parse failure → tool_result.ok:false with issue codes; loop continues", async () => {
    const { agent } = makeRecordingAgent([
      [
        {
          kind: "tool_use_start",
          id: "toolu_se_1",
          name: "submit_entry",
          input: { title: "", category: "" }, // invalid
        },
        { kind: "done", stop_reason: "tool_use" },
      ],
      [{ kind: "done", stop_reason: "end_turn" }],
    ]);
    agentForNextCall = agent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    const { events } = await readSse(res);
    const tr = events.find((e) => e.kind === "tool_result");
    if (tr && tr.kind === "tool_result" && tr.ok === false) {
      const parsed = JSON.parse(tr.error);
      expect(parsed.code).toBe("invalid_input");
      expect(parsed.issues).toBeInstanceOf(Array);
    } else {
      throw new Error(`expected ok:false tool_result, got ${JSON.stringify(tr)}`);
    }
    expect(submitEntryFromAgentMock).not.toHaveBeenCalled();
  });

  it("success → calls submitEntryFromAgent (NOT createEntry directly); tool_result.ok:true echoes IngestResult", async () => {
    submitEntryFromAgentMock.mockResolvedValueOnce({
      id: "entry-1",
      version_no: 1,
      chunk_count: 2,
    });
    const { agent } = makeRecordingAgent([
      [
        {
          kind: "tool_use_start",
          id: "toolu_se_ok",
          name: "submit_entry",
          input: validIngest,
        },
        { kind: "done", stop_reason: "tool_use" },
      ],
      [{ kind: "done", stop_reason: "end_turn" }],
    ]);
    agentForNextCall = agent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    const { events } = await readSse(res);
    const tr = events.find((e) => e.kind === "tool_result");
    if (tr && tr.kind === "tool_result" && tr.ok === true) {
      expect(tr.output).toEqual({ id: "entry-1", version_no: 1, chunk_count: 2 });
    } else {
      throw new Error(`unexpected ${JSON.stringify(tr)}`);
    }
    expect(submitEntryFromAgentMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/agent/ingest — tool dispatch error handling", () => {
  it("generic throw inside dispatch → tool_result.ok:false 'tool_dispatch_failed'; loop continues", async () => {
    selectDistinctMock.mockImplementation(() => {
      throw new Error("db connection refused");
    });
    const { agent } = makeRecordingAgent([
      [
        { kind: "tool_use_start", id: "toolu_lc_err", name: "list_categories", input: {} },
        { kind: "done", stop_reason: "tool_use" },
      ],
      [{ kind: "done", stop_reason: "end_turn" }],
    ]);
    agentForNextCall = agent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    const { events } = await readSse(res);
    const tr = events.find((e) => e.kind === "tool_result");
    if (tr && tr.kind === "tool_result" && tr.ok === false) {
      expect(tr.error).toBe("tool_dispatch_failed");
    } else {
      throw new Error(`expected tool_dispatch_failed, got ${JSON.stringify(tr)}`);
    }
    // Loop continued — second streamMessages call happened and stream
    // closed normally.
    expect(events[events.length - 1]).toEqual({ kind: "done", stop_reason: "end_turn" });
  });
});

describe("POST /api/agent/ingest — caps and limits", () => {
  it("max_iterations cap fires when stub keeps returning done(tool_use)", async () => {
    // Override cap to 2 for fast assertion.
    vi.stubEnv("AGENT_MAX_TOOL_ITERATIONS", "2");
    selectDistinctMock.mockReturnValue({
      from: () => ({ orderBy: () => Promise.resolve([{ category: "x" }]) }),
    });
    // Stub returns tool_use every iteration; only the cap stops the loop.
    const repeatedScript: AgentEvent[] = [
      { kind: "tool_use_start", id: "toolu_loop", name: "list_categories", input: {} },
      { kind: "done", stop_reason: "tool_use" },
    ];
    const { agent } = makeRecordingAgent([
      repeatedScript,
      repeatedScript,
      // Third call would happen if cap=2 didn't fire pre-call.
      repeatedScript,
    ]);
    agentForNextCall = agent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    const { events } = await readSse(res);
    const last = events[events.length - 1];
    expect(last).toEqual({ kind: "done", stop_reason: "max_iterations" });
    // Negative-assertion: if the cap were higher, more tool_result events
    // would appear. Exactly 2 tool_result events distinguishes "cap=2 fires
    // on iteration 3 entry" from "cap was off and stub script ran out".
    const toolResultCount = events.filter((e) => e.kind === "tool_result").length;
    expect(toolResultCount).toBe(2);
  });
});

describe("POST /api/agent/ingest — abort + deadline", () => {
  it("deadline_exceeded: env override makes deadline fire before slow stub completes", async () => {
    vi.stubEnv("AGENT_REQUEST_DEADLINE_MS", "30");
    // Slow custom agent — never yields; signal aborts mid-stream.
    const slowAgent: AgentClient = {
      model: STUB_AGENT_MODEL,
      model_version: STUB_AGENT_VERSION,
      async *streamMessages(input) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new DOMException("aborted", "AbortError"));
          if (input.signal.aborted) onAbort();
          input.signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
    agentForNextCall = slowAgent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    const { events } = await readSse(res);
    const errEv = events.find((e) => e.kind === "error");
    if (errEv && errEv.kind === "error") {
      expect(errEv.code).toBe("deadline_exceeded");
    } else {
      throw new Error(`expected error event, got ${JSON.stringify(events)}`);
    }
  });

  it("client abort: req.signal aborted → propagates to stub → stream emits aborted error event (3-hop)", async () => {
    const ac = new AbortController();
    const slowAgent: AgentClient = {
      model: STUB_AGENT_MODEL,
      model_version: STUB_AGENT_VERSION,
      async *streamMessages(input) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new DOMException("aborted", "AbortError"));
          if (input.signal.aborted) onAbort();
          input.signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
    agentForNextCall = slowAgent;
    // Abort soon after dispatch.
    setTimeout(() => ac.abort(), 20);
    const res = await POST(
      adminReq({ messages: makeBaseMessages(1) }, { signal: ac.signal }) as never,
      {} as never,
    );
    const { events } = await readSse(res);
    const errEv = events.find((e) => e.kind === "error");
    if (errEv && errEv.kind === "error") {
      // Hop 1: req.signal aborted.   Hop 2: composed signal propagated to stub.
      // Hop 3: stub threw AbortError → driver catch → SSE error event emitted.
      expect(errEv.code).toBe("aborted");
    } else {
      throw new Error(`expected aborted error event, got ${JSON.stringify(events)}`);
    }
  });
});

describe("POST /api/agent/ingest — keepalive", () => {
  it("emits `: keepalive\\n\\n` comment line when stream silent past keepalive interval", async () => {
    vi.stubEnv("AGENT_KEEPALIVE_MS", "15");
    vi.stubEnv("AGENT_REQUEST_DEADLINE_MS", "100");
    // Custom slow-yielding agent: holds for 60ms, then yields done(end_turn).
    const slowYieldAgent: AgentClient = {
      model: STUB_AGENT_MODEL,
      model_version: STUB_AGENT_VERSION,
      async *streamMessages(input) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 60);
          input.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        yield { kind: "done", stop_reason: "end_turn" };
      },
    };
    agentForNextCall = slowYieldAgent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    const { keepaliveCount } = await readSse(res);
    // Negative-assertion: if the keepalive interval were never set, count
    // would be 0. ≥1 distinguishes "interval fires at least once during
    // 60ms of silence with 15ms keepalive" from "no keepalive wired".
    expect(keepaliveCount).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /api/agent/ingest — interleaved blocks (§1 ordered content)", () => {
  it("reconstructs assistant content as ordered [text, tool_use, text, tool_use] for next-turn messages", async () => {
    selectDistinctMock.mockReturnValue({
      from: () => ({ orderBy: () => Promise.resolve([{ category: "a" }]) }),
    });
    const { agent, calls } = makeRecordingAgent([
      [
        { kind: "text_delta", text: "Hi. " },
        { kind: "tool_use_start", id: "tu_a", name: "list_categories", input: {} },
        { kind: "text_delta", text: "Also checking. " },
        { kind: "tool_use_start", id: "tu_b", name: "search_kb", input: { query: "q" } },
        { kind: "done", stop_reason: "tool_use" },
      ],
      [{ kind: "done", stop_reason: "end_turn" }],
    ]);
    agentForNextCall = agent;
    const interleavedRes = await POST(
      adminReq({ messages: makeBaseMessages(1) }) as never,
      {} as never,
    );
    await readSse(interleavedRes);
    // Inspect what messages were passed to the SECOND agent call —
    // includes the assistant's accumulated content from the first call.
    const secondCall = calls[1];
    const assistantMsg = secondCall.messages.find((m) => m.role === "assistant");
    if (!assistantMsg || typeof assistantMsg.content === "string") {
      throw new Error("expected assistant message with array content");
    }
    // Negative-assertion: if all text were lumped before the tool_uses,
    // the order would be [text("Hi. Also checking. "), tool_use(tu_a),
    // tool_use(tu_b)] — 3 blocks, not 4. Asserting 4 ordered blocks
    // distinguishes interleaved reconstruction from naive lumping.
    expect(assistantMsg.content).toHaveLength(4);
    expect(assistantMsg.content[0]).toMatchObject({ type: "text", text: "Hi. " });
    expect(assistantMsg.content[1]).toMatchObject({ type: "tool_use", id: "tu_a" });
    expect(assistantMsg.content[2]).toMatchObject({ type: "text", text: "Also checking. " });
    expect(assistantMsg.content[3]).toMatchObject({ type: "tool_use", id: "tu_b" });
  });
});

describe("POST /api/agent/ingest — LogEvent emission (ADR-0005)", () => {
  it("happy path: logs one claude line with streaming:true, prompt_hash, tool_iterations:0, status:'ok'", async () => {
    const { agent } = makeRecordingAgent([
      [
        { kind: "text_delta", text: "hi" },
        { kind: "done", stop_reason: "end_turn" },
      ],
    ]);
    agentForNextCall = agent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    await readSse(res);
    const claudeLines = logLines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => !!r && r.kind === "claude");
    expect(claudeLines).toHaveLength(1);
    const log = claudeLines[0];
    expect(log.streaming).toBe(true);
    expect(log.tool_iterations).toBe(0);
    expect(log.status).toBe("ok");
    expect(typeof log.prompt_hash).toBe("string");
    expect(log.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("error path: deadline → logs status:'error' with redacted error string", async () => {
    vi.stubEnv("AGENT_REQUEST_DEADLINE_MS", "20");
    const slowAgent: AgentClient = {
      model: STUB_AGENT_MODEL,
      model_version: STUB_AGENT_VERSION,
      async *streamMessages(input) {
        await new Promise<void>((resolve, reject) => {
          input.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      },
    };
    agentForNextCall = slowAgent;
    const res = await POST(adminReq({ messages: makeBaseMessages(1) }) as never, {} as never);
    await readSse(res);
    const claudeLines = logLines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => !!r && r.kind === "claude");
    expect(claudeLines.length).toBeGreaterThanOrEqual(1);
    const log = claudeLines[claudeLines.length - 1];
    expect(log.status).toBe("error");
  });
});

describe("POST /api/agent/ingest — source-file mechanical floor (§2)", () => {
  it("route.ts must NOT call createEntry directly — submit_entry path goes through submitEntryFromAgent (mirrors lib/embedding.test.ts:161-175)", async () => {
    const routePath = fileURLToPath(
      new URL("../../../../app/api/agent/ingest/route.ts", import.meta.url),
    );
    const src = readFileSync(routePath, "utf8");
    // Strip line comments and block comments so a phrase in a JSDoc
    // explaining why we DON'T call createEntry doesn't trip the assertion.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // Token-level scan: reject any `createEntry(` invocation. Negative-
    // assertion: if a future maintainer pasted `createEntry({ ..., source:
    // { kind:"agent" } })` here, this would fire — exactly the ADR-0010
    // §2 regression the rule prevents.
    expect(stripped).not.toMatch(/\bcreateEntry\s*\(/);
    expect(stripped).toMatch(/submitEntryFromAgent\s*\(/);
  });
});
