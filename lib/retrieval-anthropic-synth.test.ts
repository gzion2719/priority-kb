// lib/retrieval-anthropic-synth.test.ts — Anthropic Sonnet synth adapter tests.
//
// `vi.mock("@anthropic-ai/sdk")` swaps the SDK out for an in-test mock,
// so no live API calls happen (iron rule #8). Every test relies on the
// mock — `clientImpl` injection is the supported API but unused in this
// suite; the mock factory wins via vitest module replacement.

import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mock ──────────────────────────────────────────────────────────────
// Mirror the lib/agents-anthropic.test.ts vi.hoisted pattern so error
// subclasses are instanceof-checkable against the same names the adapter
// imports.

const {
  MockAPIError,
  MockAPIConnectionError,
  MockAPIUserAbortError,
  MockRateLimitError,
  MockInternalServerError,
  MockAuthenticationError,
  MockBadRequestError,
  MockPermissionDeniedError,
  MockAnthropic,
  createSpy,
  responseHolder,
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
  class MockPermissionDeniedError extends MockAPIError {
    constructor() {
      super(403, "forbidden");
      this.name = "PermissionDeniedError";
    }
  }

  const createSpy = vi.fn();
  // Mutable holder so tests can swap the response/throw between cases.
  type ResolveOrThrow = { kind: "resolve"; value: unknown } | { kind: "throw"; err: unknown };
  const responseHolder: { next: ResolveOrThrow } = {
    next: { kind: "resolve", value: { content: [], stop_reason: "end_turn", usage: null } },
  };

  class MockAnthropic {
    apiKey: string;
    messages = {
      create: (...args: unknown[]) => {
        createSpy(...args);
        const n = responseHolder.next;
        return n.kind === "resolve" ? Promise.resolve(n.value) : Promise.reject(n.err);
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
    MockPermissionDeniedError,
    MockAnthropic,
    createSpy,
    responseHolder,
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
  PermissionDeniedError: MockPermissionDeniedError,
}));

// Import AFTER the mock declaration so the adapter binds to the mocks.
import {
  ANTHROPIC_SDK_VERSION,
  ANTHROPIC_SYNTH_MODEL,
  SynthRefusalError,
  SynthTruncatedError,
  createAnthropicSynthesizer,
} from "./retrieval-anthropic-synth";
// Direct import from the defining module — drift-floor identity assertion
// at the "re-export identity" test depends on this binding being distinct.
import { ANTHROPIC_SDK_VERSION as ANTHROPIC_SDK_VERSION_FROM_AGENTS } from "./agents-anthropic";
import { SynthUnavailableError, getSynthesizer, resetSynthesizerForTests } from "./retrieval";

const API_KEY = "sk-ant-test-not-real";

function setResolve(value: unknown): void {
  responseHolder.next = { kind: "resolve", value };
}
function setThrow(err: unknown): void {
  responseHolder.next = { kind: "throw", err };
}

function happyResponse(
  overrides?: Partial<{
    text: string;
    stop_reason: string;
    input_tokens: number | null;
    output_tokens: number | null;
  }>,
) {
  return {
    id: "msg_01",
    content: [{ type: "text", text: overrides?.text ?? "Synth answer body." }],
    stop_reason: overrides?.stop_reason ?? "end_turn",
    usage: {
      input_tokens: overrides?.input_tokens ?? 123,
      output_tokens: overrides?.output_tokens ?? 45,
    },
  };
}

beforeEach(() => {
  createSpy.mockClear();
  responseHolder.next = { kind: "resolve", value: happyResponse() };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Identity + plumbing ───────────────────────────────────────────────────

describe("createAnthropicSynthesizer — identity + plumbing", () => {
  it("exposes ANTHROPIC_SYNTH_MODEL + ANTHROPIC_SDK_VERSION on the Synthesizer surface", () => {
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    expect(s.model).toBe(ANTHROPIC_SYNTH_MODEL);
    expect(s.version).toBe(ANTHROPIC_SDK_VERSION);
  });

  it("pins ANTHROPIC_SYNTH_MODEL to the dateless Sonnet 4.6 id (drift floor)", () => {
    // Per Anthropic docs (verified 2026-05-21): Claude 4.6 generation uses
    // dateless IDs as pinned snapshots. If this constant silently drifts to
    // an evergreen alias or a dated id, audit-row provenance breaks.
    expect(ANTHROPIC_SYNTH_MODEL).toBe("claude-sonnet-4-6");
  });

  it("ANTHROPIC_SDK_VERSION re-export is identity with the defining module's constant", () => {
    // Defense-in-depth: catches a regression that replaces the `export {
    // ANTHROPIC_SDK_VERSION }` re-export with a hand-typed `export const
    // ANTHROPIC_SDK_VERSION = "..."` that drifts from agents-anthropic.
    expect(ANTHROPIC_SDK_VERSION).toBe(ANTHROPIC_SDK_VERSION_FROM_AGENTS);
  });

  it("ANTHROPIC_SDK_VERSION re-export is identity with the defining module's constant", () => {
    // Defense-in-depth: catches a regression that replaces the `export {
    // ANTHROPIC_SDK_VERSION }` re-export with a hand-typed constant that
    // drifts from the agents-anthropic source-of-truth.
    expect(ANTHROPIC_SDK_VERSION).toBe(ANTHROPIC_SDK_VERSION_FROM_AGENTS);
  });

  it("ANTHROPIC_SDK_VERSION matches the package.json pin (parallel drift floor)", () => {
    // Defense-in-depth: the constant is also covered by
    // lib/agents-anthropic.test.ts:192-204, but this adapter now depends on
    // it too — if either consumer loses its assertion, the other still
    // catches drift.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const inDeps = pkg.dependencies?.["@anthropic-ai/sdk"];
    const inDev = pkg.devDependencies?.["@anthropic-ai/sdk"];
    const presence = [inDeps, inDev].filter((v) => v !== undefined);
    expect(presence).toHaveLength(1);
    expect(presence[0]).toBe(ANTHROPIC_SDK_VERSION);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────

describe("createAnthropicSynthesizer — happy path", () => {
  it("returns {answer, tokens_in, tokens_out} from a 200 response", async () => {
    setResolve(
      happyResponse({
        text: "The refund window is 30 days.",
        input_tokens: 200,
        output_tokens: 50,
      }),
    );
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    const result = await s.synthesize("system prompt", ["chunk A", "chunk B"]);
    expect(result).toEqual({
      answer: "The refund window is 30 days.",
      tokens_in: 200,
      tokens_out: 50,
    });
  });

  it("posts EXACTLY {model, max_tokens, system, messages, stream:false} request shape", async () => {
    setResolve(happyResponse());
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await s.synthesize("the system prompt", ["c1", "c2", "c3"]);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const body = createSpy.mock.calls[0]![0] as {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: string; content: string }[];
      stream: boolean;
    };
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toBe("the system prompt");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "c1\n\n---\n\nc2\n\n---\n\nc3" }]);
  });

  it("honors maxTokens override", async () => {
    setResolve(happyResponse());
    const s = createAnthropicSynthesizer({ apiKey: API_KEY, maxTokens: 8192 });
    await s.synthesize("p", ["c"]);
    expect((createSpy.mock.calls[0]![0] as { max_tokens: number }).max_tokens).toBe(8192);
  });

  it("defaults usage tokens to 0 when SDK returns null fields (nullable per SDK types)", async () => {
    // Bypass happyResponse() — its `?? 123` defaults treat null as nullish.
    // Construct the response directly so the nulls survive into the adapter.
    setResolve({
      id: "msg_01",
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: null, output_tokens: null },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    const result = await s.synthesize("p", ["c"]);
    // Negative-assertion: if the `?? 0` defaults were removed, this would
    // produce `tokens_in: null` (TypeScript-narrowed) or `undefined` and
    // break audit-row downstream. Pinning to exactly 0 distinguishes.
    expect(result.tokens_in).toBe(0);
    expect(result.tokens_out).toBe(0);
  });

  it("defaults usage tokens to 0 when SDK omits usage entirely", async () => {
    setResolve({ id: "x", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    const result = await s.synthesize("p", ["c"]);
    expect(result.tokens_in).toBe(0);
    expect(result.tokens_out).toBe(0);
  });

  it("returns the FIRST text content block when multiple blocks are present", async () => {
    setResolve({
      content: [
        { type: "tool_use", id: "t1", name: "foo", input: {} },
        { type: "text", text: "real answer here" },
        { type: "text", text: "second block ignored" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    const result = await s.synthesize("p", ["c"]);
    expect(result.answer).toBe("real answer here");
  });

  it("joins context with the pinned separator (no padding leak)", async () => {
    setResolve(happyResponse());
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await s.synthesize("p", ["a", "b"]);
    const content = (createSpy.mock.calls[0]![0] as { messages: { content: string }[] })
      .messages[0]!.content;
    // EXACT separator pinning — a regression that changed `\n\n---\n\n` to
    // `\n---\n` would shift chunk boundaries the route's stage E relies on
    // (when stage E lands, the structured-block contract uses its own
    // separator, but until then this is the tested invariant).
    expect(content).toBe("a\n\n---\n\nb");
  });
});

// ── Stop-reason discrimination (refusal / max_tokens / empty) ─────────────

describe("createAnthropicSynthesizer — stop_reason branches", () => {
  it("stop_reason='refusal' → throws SynthRefusalError (NOT SynthUnavailableError)", async () => {
    setResolve({
      content: [{ type: "text", text: "I cannot help with that." }],
      stop_reason: "refusal",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    try {
      await s.synthesize("p", ["c"]);
      throw new Error("expected SynthRefusalError, got resolution");
    } catch (err) {
      expect(err).toBeInstanceOf(SynthRefusalError);
      // Negative-assertion: must NOT be SynthUnavailableError, or the route
      // would degrade-mode a policy refusal as a transient outage.
      expect(err).not.toBeInstanceOf(SynthUnavailableError);
      expect((err as Error).name).toBe("SynthRefusalError");
    }
  });

  it("stop_reason='refusal' dominates even if a text block IS present", async () => {
    // A regression that extracted text first and returned would miss the
    // refusal signal entirely. Explicitly assert refusal wins.
    setResolve({
      content: [{ type: "text", text: "apologetic refusal text" }],
      stop_reason: "refusal",
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBeInstanceOf(SynthRefusalError);
  });

  it("stop_reason='max_tokens' with no text → throws SynthTruncatedError", async () => {
    setResolve({
      content: [],
      stop_reason: "max_tokens",
      usage: { input_tokens: 4000, output_tokens: 4096 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    try {
      await s.synthesize("p", ["c"]);
      throw new Error("expected SynthTruncatedError");
    } catch (err) {
      expect(err).toBeInstanceOf(SynthTruncatedError);
      expect(err).not.toBeInstanceOf(SynthUnavailableError);
      expect(err).not.toBeInstanceOf(SynthRefusalError);
    }
  });

  it("stop_reason='stop_sequence' with a text block → returns the text", async () => {
    // stop_sequence is a legitimate non-error stop; if a future regression
    // collapsed it into SynthUnavailableError, audit-row provenance would
    // misrepresent a successful answer as a degraded outage.
    setResolve({
      content: [{ type: "text", text: "stop-seq answer" }],
      stop_reason: "stop_sequence",
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    const result = await s.synthesize("p", ["c"]);
    expect(result.answer).toBe("stop-seq answer");
  });

  it("stop_reason='pause_turn' with no text → throws SynthUnavailableError", async () => {
    // pause_turn occurs on multi-turn server pauses; with no text there is
    // nothing to return. Pin to unavailable so the route's degraded-mode
    // path fires (per ADR-0012 §3) rather than silently returning empty.
    setResolve({
      content: [],
      stop_reason: "pause_turn",
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBeInstanceOf(SynthUnavailableError);
  });

  it("stop_reason='max_tokens' WITH a text block → returns the text (partial answer is still an answer)", async () => {
    // Partial answers at max_tokens are useful — the truncation error is
    // only for the no-text case. Distinguishes the "useless empty" path
    // from the "useful but truncated" path.
    setResolve({
      content: [{ type: "text", text: "Refund window is" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1, output_tokens: 4096 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    const result = await s.synthesize("p", ["c"]);
    expect(result.answer).toBe("Refund window is");
  });

  it("empty content array AND benign stop_reason → throws SynthUnavailableError", async () => {
    setResolve({
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    try {
      await s.synthesize("p", ["c"]);
      throw new Error("expected SynthUnavailableError");
    } catch (err) {
      expect(err).toBeInstanceOf(SynthUnavailableError);
      expect((err as Error).name).toBe("SynthUnavailableError");
    }
  });

  it("only non-text blocks (tool_use only) → throws SynthUnavailableError", async () => {
    setResolve({
      content: [{ type: "tool_use", id: "t1", name: "f", input: {} }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBeInstanceOf(SynthUnavailableError);
  });

  it("text block with empty string → falls through to SynthUnavailableError", async () => {
    setResolve({
      content: [{ type: "text", text: "" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBeInstanceOf(SynthUnavailableError);
  });

  it("multiple text blocks with empty FIRST block → returns the next non-empty text", async () => {
    // A regression that returned `block.text` without the length guard would
    // return "" from the first block and trigger the unavailable path.
    setResolve({
      content: [
        { type: "text", text: "" },
        { type: "text", text: "the real answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    const result = await s.synthesize("p", ["c"]);
    expect(result.answer).toBe("the real answer");
  });
});

// ── Error mapping (transient → unavailable, with cause preservation) ──────

describe("createAnthropicSynthesizer — transient errors → SynthUnavailableError", () => {
  it("APIConnectionError → SynthUnavailableError, preserves cause", async () => {
    const inner = new MockAPIConnectionError("network down");
    setThrow(inner);
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    try {
      await s.synthesize("p", ["c"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SynthUnavailableError);
      // Cause-preservation is load-bearing: the route logs cause.message
      // (mirror lib/agents-anthropic.ts:246 + ADR-0012 §E).
      expect((err as { cause?: unknown }).cause).toBe(inner);
      expect((err as Error).name).toBe("SynthUnavailableError");
    }
  });

  it("RateLimitError (429) → SynthUnavailableError", async () => {
    setThrow(new MockRateLimitError());
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBeInstanceOf(SynthUnavailableError);
  });

  it("InternalServerError (500) → SynthUnavailableError", async () => {
    setThrow(new MockInternalServerError());
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBeInstanceOf(SynthUnavailableError);
  });

  it("APIError with status=503 → SynthUnavailableError (5xx fallback bucket)", async () => {
    setThrow(new MockAPIError(503, "service unavailable"));
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBeInstanceOf(SynthUnavailableError);
  });

  it("APIError with status=529 → SynthUnavailableError (Anthropic overload)", async () => {
    setThrow(new MockAPIError(529, "overloaded"));
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBeInstanceOf(SynthUnavailableError);
  });
});

// ── Error mapping (config / loud rethrow) ─────────────────────────────────

describe("createAnthropicSynthesizer — config errors rethrown loud", () => {
  it("AuthenticationError (401) rethrown unchanged (NOT SynthUnavailableError)", async () => {
    const inner = new MockAuthenticationError();
    setThrow(inner);
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    try {
      await s.synthesize("p", ["c"]);
      throw new Error("expected throw");
    } catch (err) {
      // Negative-assertion per WORKFLOW.md: a future bug mapping 401 to a
      // new "SynthConfigError" would silently fall under .toBeInstanceOf(Error).
      // Pin to identity (`toBe`) — only an unchanged rethrow passes.
      expect(err).toBe(inner);
      expect(err).not.toBeInstanceOf(SynthUnavailableError);
    }
  });

  it("BadRequestError (400) rethrown unchanged", async () => {
    const inner = new MockBadRequestError();
    setThrow(inner);
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBe(inner);
  });

  it("PermissionDeniedError (403) rethrown unchanged", async () => {
    const inner = new MockPermissionDeniedError();
    setThrow(inner);
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBe(inner);
  });

  it("APIError with status=undefined (base-class throw) rethrown unchanged", async () => {
    // The nullable `typeof err.status === 'number'` guard in mapSdkError
    // means a base APIError without a numeric status falls through to
    // rethrow, NOT to the 5xx bucket. Pin this distinction.
    const inner = new MockAPIError(0, "weird base error");
    (inner as { status?: unknown }).status = undefined;
    setThrow(inner);
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBe(inner);
  });

  it("APIError with status=404 (4xx non-transient) rethrown unchanged", async () => {
    const inner = new MockAPIError(404, "not found");
    setThrow(inner);
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    await expect(s.synthesize("p", ["c"])).rejects.toBe(inner);
  });
});

// ── AbortSignal ───────────────────────────────────────────────────────────

describe("createAnthropicSynthesizer — abort", () => {
  it("APIUserAbortError → DOMException('aborted','AbortError')", async () => {
    setThrow(new MockAPIUserAbortError());
    const s = createAnthropicSynthesizer({ apiKey: API_KEY });
    try {
      await s.synthesize("p", ["c"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    }
  });
});

// ── Construction-time guards ──────────────────────────────────────────────

describe("createAnthropicSynthesizer — construction-time guards", () => {
  it("throws RangeError when apiKey is empty string (mirror of factory iron-rule-#1 floor)", () => {
    expect(() => createAnthropicSynthesizer({ apiKey: "" })).toThrow(RangeError);
  });

  it("throws RangeError when apiKey is missing (defensive)", () => {
    expect(() => createAnthropicSynthesizer({ apiKey: undefined as unknown as string })).toThrow(
      RangeError,
    );
  });
});

// ── Factory wire-up via getSynthesizer ────────────────────────────────────

describe("getSynthesizer — SYNTH_PROVIDER=anthropic wiring", () => {
  const ORIGINAL_PROVIDER = process.env.SYNTH_PROVIDER;
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    // Stale-singleton hazard: getSynthesizer caches on globalThis.__synthesizer.
    // Reset before each test so SYNTH_PROVIDER changes actually take effect.
    resetSynthesizerForTests();
  });

  afterEach(() => {
    resetSynthesizerForTests();
    if (ORIGINAL_PROVIDER === undefined) delete process.env.SYNTH_PROVIDER;
    else process.env.SYNTH_PROVIDER = ORIGINAL_PROVIDER;
    if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("SYNTH_PROVIDER='anthropic' + ANTHROPIC_API_KEY set → returns the Anthropic synthesizer (no RangeError)", () => {
    process.env.SYNTH_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-wireup-test";
    const s = getSynthesizer();
    expect(s.model).toBe(ANTHROPIC_SYNTH_MODEL);
    expect(s.version).toBe(ANTHROPIC_SDK_VERSION);
  });

  it("SYNTH_PROVIDER='anthropic' + missing ANTHROPIC_API_KEY → throws RangeError (empty-key constructor guard)", () => {
    process.env.SYNTH_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getSynthesizer()).toThrow(RangeError);
  });

  it("SYNTH_PROVIDER='anthropic' + ANTHROPIC_API_KEY='' → throws RangeError", () => {
    process.env.SYNTH_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "";
    expect(() => getSynthesizer()).toThrow(RangeError);
  });
});

// ── Source-file mechanical floors ─────────────────────────────────────────

describe("createAnthropicSynthesizer — source-file mechanical floors", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "retrieval-anthropic-synth.ts"), "utf8");

  it("source file reads no process.env (env-truth lives at the factory)", () => {
    // Mirrors the voyage-rerank + agents-anthropic floors. The literal in
    // this regex MUST itself not appear elsewhere in the source under test,
    // or the regex would self-trigger.
    expect(src).not.toMatch(/process\.env/);
  });

  it("source file imports no non-Anthropic SDK (iron rule #8)", () => {
    expect(src).not.toMatch(/from\s+["']voyage(ai)?["']/);
    expect(src).not.toMatch(/from\s+["']openai["']/);
    expect(src).not.toMatch(/from\s+["']cohere-ai["']/);
    expect(src).not.toMatch(/from\s+["']@google\/generative-ai["']/);
  });

  it("positive control: process.env regex would fire on a synthetic match", () => {
    // Defends against regex-rot — if the production regex above silently
    // stops matching anything (e.g. someone "tightens" it), this positive
    // control still passes, but the production assertion becomes vacuous.
    // The pair (production + positive) makes the test mechanically honest.
    const synthetic = `const k = ` + `process` + `.env.ANTHROPIC_API_KEY;`;
    expect(synthetic).toMatch(/process\.env/);
  });

  it("positive control: voyageai SDK-import regex would fire on a synthetic match", () => {
    const synthetic = `import { VoyageClient } from "voyageai";`;
    expect(synthetic).toMatch(/from\s+["']voyage(ai)?["']/);
  });

  it("positive control: openai SDK-import regex would fire on a synthetic match", () => {
    const synthetic = `import OpenAI from "openai";`;
    expect(synthetic).toMatch(/from\s+["']openai["']/);
  });

  it("positive control: cohere-ai SDK-import regex would fire on a synthetic match", () => {
    const synthetic = `import { CohereClient } from "cohere-ai";`;
    expect(synthetic).toMatch(/from\s+["']cohere-ai["']/);
  });

  it("positive control: @google/generative-ai SDK-import regex would fire on a synthetic match", () => {
    const synthetic = `import { GoogleGenerativeAI } from "@google/generative-ai";`;
    expect(synthetic).toMatch(/from\s+["']@google\/generative-ai["']/);
  });
});
