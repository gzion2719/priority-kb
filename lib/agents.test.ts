import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentUnavailableError,
  STUB_AGENT_MODEL,
  STUB_AGENT_VERSION,
  createStubAgent,
  getAgent,
  resetAgentForTests,
  type AgentClient,
  type AgentEvent,
  type AgentStreamInput,
} from "./agents";

// Mock the sibling adapter module so this test file never loads the real
// SDK (iron rule #8). The mock returns a sentinel AgentClient that lets
// the factory-wiring assertions verify (a) the branch was taken and (b)
// the apiKey was forwarded.
vi.mock("./agents-anthropic", () => {
  const sentinel: AgentClient = {
    model: "mocked-anthropic-model",
    model_version: "mocked-sdk-version",
    streamMessages: async function* () {},
  };
  return {
    createAnthropicAgent: vi.fn((opts: { apiKey: string }) => {
      // Return a per-call object so tests can distinguish identity.
      return { ...sentinel, _apiKey: opts.apiKey } as AgentClient;
    }),
  };
});

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

afterEach(() => {
  resetAgentForTests();
  delete process.env.AGENT_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("createStubAgent — deterministic scripted stub for #8-compliant tests", () => {
  it("exposes model + model_version as readonly contract properties", () => {
    const a = createStubAgent([]);
    expect(a.model).toBe(STUB_AGENT_MODEL);
    expect(a.model_version).toBe(STUB_AGENT_VERSION);
  });

  it("empty script yields zero events (async iteration completes immediately)", async () => {
    const a = createStubAgent([]);
    const events = await collect(a.streamMessages(makeInput()));
    expect(events).toEqual([]);
  });

  it("yields scripted events in exactly the order they were passed — a dropped or permuted event would fail this assertion", async () => {
    const script: AgentEvent[] = [
      { kind: "text_delta", text: "hello " },
      { kind: "text_delta", text: "world" },
      { kind: "tool_use_start", id: "toolu_test_1", name: "submit_entry", input: { title: "x" } },
      { kind: "tool_result", name: "submit_entry", ok: true, output: { id: "y" } },
      { kind: "done", stop_reason: "end_turn" },
    ];
    const a = createStubAgent(script);
    const events = await collect(a.streamMessages(makeInput()));
    expect(events).toEqual(script);
  });

  it("pre-aborted signal with empty script: first .next() rejects — isolates the pre-loop abort check", async () => {
    // Empty script + pre-aborted signal: the per-event check inside the
    // for-loop never runs (no iterations). Only the pre-loop check can
    // catch the aborted signal here. If that check were removed, the
    // generator would return done:true and .next() would resolve, not
    // reject — proving the pre-loop check is independently wired.
    const ac = new AbortController();
    ac.abort();
    const a = createStubAgent([]);
    const iter = a.streamMessages(makeInput({ signal: ac.signal }))[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("mid-stream abort: consume one event, abort, next .next() rejects — isolates the per-event abort check", async () => {
    // Yield event 0 normally (signal not yet aborted), then abort. The
    // per-event check inside the for-loop must fire before yielding
    // event 1. If that check were removed, the generator would yield
    // event 1 and .next() would resolve — proving the per-event check
    // is independently wired.
    const script: AgentEvent[] = [
      { kind: "text_delta", text: "yields-then-stops" },
      { kind: "text_delta", text: "should-not-yield" },
      { kind: "text_delta", text: "should-not-yield" },
    ];
    const ac = new AbortController();
    const a = createStubAgent(script);
    const iter = a.streamMessages(makeInput({ signal: ac.signal }))[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(script[0]);
    ac.abort();
    await expect(iter.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ignores system_prompt / messages / tools / max_tool_iterations / deadline_ms (stub yields only the script)", async () => {
    const script: AgentEvent[] = [{ kind: "done", stop_reason: "end_turn" }];
    const a = createStubAgent(script);
    const events = await collect(
      a.streamMessages(
        makeInput({
          system_prompt: "any-prompt",
          messages: [{ role: "user", content: "any" }],
          tools: [{ name: "submit_entry", description: "x", input_schema: {} }],
          max_tool_iterations: 1,
          deadline_ms: 1,
        }),
      ),
    );
    expect(events).toEqual(script);
  });
});

describe("getAgent — env-driven factory", () => {
  it("returns a stub when AGENT_PROVIDER is unset", () => {
    expect(getAgent().model).toBe(STUB_AGENT_MODEL);
  });

  it("returns a stub when AGENT_PROVIDER=stub", () => {
    process.env.AGENT_PROVIDER = "stub";
    expect(getAgent().model).toBe(STUB_AGENT_MODEL);
  });

  it("throws RangeError when AGENT_PROVIDER=anthropic and ANTHROPIC_API_KEY is missing — iron rule #1 floor, misconfig is loud", () => {
    process.env.AGENT_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getAgent()).toThrow(RangeError);
    expect(() => getAgent()).toThrow(/missing ANTHROPIC_API_KEY/);
  });

  it("AGENT_PROVIDER=anthropic with key present resolves the real adapter (step 3b wiring)", async () => {
    process.env.AGENT_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
    const agent = getAgent();
    expect(agent.model).toBe("mocked-anthropic-model");
    expect(agent.model_version).toBe("mocked-sdk-version");
    const adapter = await import("./agents-anthropic");
    expect(adapter.createAnthropicAgent).toHaveBeenCalledWith({ apiKey: "sk-ant-test-not-real" });
  });

  it("throws RangeError for an unknown provider — fail-loud, no silent fallback", () => {
    process.env.AGENT_PROVIDER = "openai";
    expect(() => getAgent()).toThrow(RangeError);
    expect(() => getAgent()).toThrow(/unknown AGENT_PROVIDER/);
  });

  it("caches the agent across calls (singleton)", () => {
    const a = getAgent();
    const b = getAgent();
    expect(a).toBe(b);
  });

  it("resetAgentForTests() re-evaluates the provider on next call — a no-op reset would fail this test", () => {
    process.env.AGENT_PROVIDER = "stub";
    const first = getAgent();
    resetAgentForTests();
    process.env.AGENT_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
    const second = getAgent();
    expect(second.model).toBe("mocked-anthropic-model");
    resetAgentForTests();
    delete process.env.AGENT_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    const third = getAgent();
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });
});

describe("AgentUnavailableError", () => {
  it("is an instanceof Error with a stable name", () => {
    const err = new AgentUnavailableError("anthropic 503");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AgentUnavailableError");
  });

  it("preserves a cause for route-side logging (ADR-0010 §5 verbatim constructor — manual cause attachment)", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new AgentUnavailableError("upstream down", { cause });
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });
});

describe("non-negotiable #8 — no live API client imports in lib/agents.ts", () => {
  it("source file imports no anthropic / voyage / openai client modules (two-layer scan: from-clauses + coarse literals)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "agents.ts"), "utf8");
    // Layer 1: static `from "..."` import clauses — catches normal ESM imports.
    expect(src).not.toMatch(/from\s+["']voyage(ai)?["']/);
    expect(src).not.toMatch(/from\s+["']@anthropic[/-]/);
    expect(src).not.toMatch(/from\s+["']openai["']/);
    // Layer 2: coarse literal scan — catches dynamic imports, type-only
    // imports, and stray references the regex above misses. Elevates the
    // floor from "intentional import" to "no reference at all".
    expect(src).not.toMatch(/voyageai/);
    expect(src).not.toMatch(/@anthropic-ai/);
  });
});
