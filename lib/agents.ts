// lib/agents.ts — agent abstraction (ADR-0010 impl step 1; no real adapter yet).
//
// The interface every agent adapter must satisfy. Step 1 ships only the
// deterministic scripted stub for tests; step 3 wires the real Anthropic
// adapter behind the same interface (ADR-0010 §5).
//
// Design notes (mirrors lib/embedding.ts):
// - `streamMessages` is the primary surface — returns an
//   `AsyncIterable<AgentEvent>` so the step-3 SSE route's tool-use loop
//   driver iterates with `for await`. The real Anthropic SDK exposes a
//   streaming async iterator; the stub's `async function*` produces the
//   same shape so step 3's adapter is a drop-in.
// - `AgentEvent` is the wire-shape between adapter and route. The
//   discriminated union is exhaustive (text_delta / tool_use_start /
//   tool_result ok+err / done / error) so the route handler can
//   exhaustively switch. ADR-0010 §1 notes the adapter swallows
//   Anthropic's `stop_sequence` value and emits `end_turn` on its behalf —
//   `stop_reason` narrows to the five values the route actually receives.
// - `AgentUnavailableError` is the only typed error for transient outage;
//   step 3's SSE route uses `instanceof` to convert to HTTP 503 with
//   `{error: "agent_unavailable"}` per iron rule #12 (ADR-0010 §7).
//   Constructor follows ADR §5 verbatim (manual cause attachment) rather
//   than EmbeddingUnavailableError's native `super(message, options)` —
//   identical observable behavior, ADR-exact shape.
// - Iron rule #1 floor: `getAgent()` reads `process.env.ANTHROPIC_API_KEY`
//   on the `"anthropic"` branch and throws `RangeError` if absent.
//   Misconfig surfaces at the factory, not as transient
//   `AgentUnavailableError` that would mask it as a degraded-mode outage
//   (ADR-0010 §8 row #1).
// - Mechanical floor for iron rule #8 (no live APIs in tests): this module
//   imports no Anthropic / Voyage / OpenAI client. The companion test
//   reads the source file and rejects any such reference, mirroring
//   lib/embedding.test.ts:161-175.

/**
 * Streaming event emitted by an agent during a turn.
 *
 * `tool_use_start.input` is the FINALIZED tool-use JSON object — the
 * adapter buffers `input_json_delta` events until `content_block_stop`
 * before emitting (ADR-0010 §1). `done.stop_reason` is the
 * route-synthesized union: Anthropic's native values minus `stop_sequence`
 * (swallowed; emitted as `end_turn`) plus the two route-synthesized caps
 * (`max_iterations`, `max_turns`).
 */
export type AgentEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use_start"; name: string; input: unknown }
  | { kind: "tool_result"; name: string; ok: true; output: unknown }
  | { kind: "tool_result"; name: string; ok: false; error: string }
  | {
      kind: "done";
      stop_reason: "end_turn" | "tool_use" | "max_tokens" | "max_iterations" | "max_turns";
    }
  | { kind: "error"; code: string; message: string };

/**
 * Anthropic-SDK-wire-shape content block. ADR-0010 §5 leaves the
 * `AgentMessage` shape unspecified; we adopt the SDK's tagged-union wire
 * shape directly so the step-3 adapter passes messages through without
 * transformation.
 */
export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export type AgentMessage = {
  role: "user" | "assistant";
  content: string | AgentContentBlock[];
};

/**
 * Structural tool-definition shape. Step 2's `lib/agents-tools.ts` exports
 * the canonical `AgentToolDefinition` as a narrower discriminated union
 * for the three M2a tools — that union satisfies this structural shape.
 * The structural placeholder here is named `AgentToolDefinitionShape` to
 * avoid the same-name-different-shape footgun across the two files.
 */
export type AgentToolDefinitionShape = {
  name: string;
  description: string;
  input_schema: unknown;
};

export type AgentStreamInput = {
  system_prompt: string;
  messages: AgentMessage[];
  /**
   * `readonly` so step 2's `AGENT_TOOLS` registry (a deeply-frozen `as const`
   * literal) is assignable here without losing variance. Mutable array
   * literals from tests still satisfy this slot — readonly is the safe
   * direction for input-only data the agent must not mutate.
   */
  tools: readonly AgentToolDefinitionShape[];
  max_tool_iterations: number;
  deadline_ms: number;
  signal: AbortSignal;
};

/**
 * The contract every agent adapter satisfies. Step-1 stub +
 * step-3 Anthropic adapter both implement this interface.
 */
export interface AgentClient {
  readonly model: string;
  readonly model_version: string;
  streamMessages(input: AgentStreamInput): AsyncIterable<AgentEvent>;
}

/**
 * Thrown when an agent is unreachable for transient reasons (Anthropic
 * 5xx, rate-limit, network down). The step-3 SSE route catches this and
 * returns HTTP 503 `{error: "agent_unavailable"}` per iron rule #12.
 * Config errors (missing key, unknown provider) throw plain `RangeError`
 * so they cannot be silently degraded — see `getAgent()`.
 *
 * Constructor pattern follows ADR-0010 §5 verbatim — manual `cause`
 * attachment rather than native `super(message, options)`. Identical
 * observable behavior; ADR-faithful shape.
 */
export class AgentUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AgentUnavailableError";
    if (options?.cause) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export const STUB_AGENT_MODEL = "stub-agent";
export const STUB_AGENT_VERSION = "v1";

/**
 * Deterministic scripted stub agent for tests + dev. Yields the events
 * from `script` in order via an async generator (fresh iterator per
 * `streamMessages` call). Honors `input.signal`: rejects the very first
 * `.next()` with `DOMException("aborted", "AbortError")` when the signal
 * is already aborted at iteration start, and rejects mid-iteration when
 * the signal aborts between yields.
 *
 * The stub does not inspect `system_prompt`, `messages`, `tools`,
 * `max_tool_iterations`, or `deadline_ms` — those are passed-through
 * parameters for the step-3 adapter, not the stub's concern.
 */
export function createStubAgent(script: ReadonlyArray<AgentEvent>): AgentClient {
  return {
    model: STUB_AGENT_MODEL,
    model_version: STUB_AGENT_VERSION,
    async *streamMessages(input: AgentStreamInput): AsyncGenerator<AgentEvent, void, undefined> {
      if (input.signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      for (const event of script) {
        if (input.signal.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        yield event;
      }
    },
  };
}

declare global {
  var __agent: AgentClient | undefined;
}

/**
 * Env-driven agent factory. Reads `process.env.AGENT_PROVIDER`:
 * - unset or `"stub"` → deterministic scripted stub with an empty script.
 * - `"anthropic"` → reads `process.env.ANTHROPIC_API_KEY`. Missing key
 *   throws `RangeError "missing ANTHROPIC_API_KEY"` (iron rule #1 floor:
 *   misconfig is loud, not silently degraded). Key present throws
 *   `RangeError` naming "ADR-0010 impl step 3" — step 3 replaces this
 *   branch with the real adapter.
 * - any other value → throws `RangeError` (fail-loud, no silent fallback).
 *
 * Cached on `globalThis.__agent` after first call. Use
 * `resetAgentForTests()` between tests that need a fresh resolution.
 */
export function getAgent(): AgentClient {
  if (!globalThis.__agent) {
    const provider = process.env.AGENT_PROVIDER ?? "stub";
    if (provider === "stub") {
      globalThis.__agent = createStubAgent([]);
    } else if (provider === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new RangeError(
          `missing ANTHROPIC_API_KEY — required when AGENT_PROVIDER=anthropic (iron rule #1)`,
        );
      }
      throw new RangeError(
        `AGENT_PROVIDER=anthropic adapter lands in ADR-0010 impl step 3; not wired yet`,
      );
    } else {
      throw new RangeError(
        `unknown AGENT_PROVIDER=${provider}; expected "stub" or (post-step-3) "anthropic"`,
      );
    }
  }
  return globalThis.__agent;
}

/** Clears the singleton cache. Test-only. Mirrors `lib/embedding.ts`'s reset story. */
export function resetAgentForTests(): void {
  globalThis.__agent = undefined;
}
