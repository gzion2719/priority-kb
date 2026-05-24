// lib/agents-anthropic.ts — ADR-0010 impl step 3b real adapter.
//
// Translates Anthropic SDK's RawMessageStreamEvent into the wire-shaped
// AgentEvent union exported from lib/agents.ts. The factory in lib/agents.ts
// statically imports this module on the AGENT_PROVIDER="anthropic" branch;
// lib/agents.ts itself imports nothing from @anthropic-ai/sdk (preserves
// the source-file-no-import mechanical floor at lib/agents.test.ts:186-199).
//
// Event-translation contract (ADR-0010 §1):
// - text_delta inside content_block_delta → AgentEvent text_delta (passthrough)
// - input_json_delta accumulates per content-block index; the tool_use_start
//   AgentEvent emits ONLY at content_block_stop with the finalized JSON
// - stop_sequence → end_turn (we set no stop sequences; ADR-0010 §1)
// - pause_turn → end_turn (rare; not in our AgentEvent union; silent fold)
// - refusal → AgentEvent done(refusal) — distinct terminal so the route's
//   per-turn LogEventClaude carries stop_reason:"refusal" (ADR-0010 §1
//   Amendment 2026-05-28; closes BACKLOG:28). Prior shape emitted a
//   synthesized error("refusal") + done(end_turn); the error event was
//   dropped because the new done variant carries the same information
//   on the terminal event the reducer already handles.
// - APIUserAbortError → DOMException("aborted","AbortError") to match the
//   stub agent's abort contract (lib/agents.ts:160-166) — callers that
//   `instanceof DOMException` work across both adapters
// - APIConnectionError | RateLimitError | InternalServerError | APIError(≥500)
//   → AgentUnavailableError → route 503 (iron rule #12)
// - 4xx (Authentication/BadRequest/Permission/NotFound/Conflict/Unprocessable)
//   rethrow unchanged → route 500 (loud config error, iron rule #1)

import Anthropic, {
  APIError,
  APIConnectionError,
  APIUserAbortError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type {
  MessageParam,
  RawMessageStreamEvent,
  StopReason,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

import {
  AgentUnavailableError,
  type AgentClient,
  type AgentContentBlock,
  type AgentEvent,
  type AgentMessage,
  type AgentStreamInput,
  type AgentToolDefinitionShape,
} from "./agents";

/**
 * Model id pinned per ADR-0010 §5 + docs/AGENTS.md. Revisit at M5 hosting cut
 * (BACKLOG: "Model id review at M5 hosting cut").
 */
export const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

/**
 * Anthropic SDK version. Must match the exact-version pin in package.json
 * (ADR-0010 §5). Surfaced via `AgentClient.model_version` for LogEvent
 * attribution. Drift is caught by the synced-pin test in agents-anthropic.test.ts.
 */
export const ANTHROPIC_SDK_VERSION = "0.97.1";

/**
 * Default `max_tokens` for an assistant turn. ADR-0010 doesn't pin a value;
 * 4096 fits a structured ingestion-agent turn comfortably. Revisit if
 * entries get truncated (BACKLOG: "Adapter max_tokens revisit").
 */
const DEFAULT_MAX_TOKENS = 4096;

export type CreateAnthropicAgentOptions = {
  apiKey: string;
  /** Override for `max_tokens` per request. Defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
};

/**
 * Build the Anthropic AgentClient adapter. Caller provides the API key
 * explicitly so this module never reads `process.env` — keeps the factory
 * boundary at lib/agents.ts the single source of env truth.
 */
export function createAnthropicAgent(options: CreateAnthropicAgentOptions): AgentClient {
  const client = new Anthropic({ apiKey: options.apiKey });
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    model: ANTHROPIC_MODEL,
    model_version: ANTHROPIC_SDK_VERSION,
    streamMessages(input: AgentStreamInput): AsyncIterable<AgentEvent> {
      return streamFromAnthropic(client, maxTokens, input);
    },
  };
}

/**
 * Structural message conversion. AgentMessage / AgentContentBlock mirror
 * Anthropic's wire shape (ADR-0010 §5 — adopted directly to avoid a
 * transformation layer), but our `AgentContentBlock.tool_result.content`
 * is `string`-only by design (no content-block array form). The per-block
 * mapping below makes that narrower-than-SDK invariant compile-checked:
 * the `toAnthropicBlock` return-type annotation forbids any block param
 * type we haven't whitelisted, so a future broadening of either
 * AgentContentBlock or the SDK's union surfaces here as a TS error.
 *
 * Exported via `__testHelpers` for `lib/agents-anthropic.test.ts` to pin
 * the shape (BACKLOG: "Adapter: tighten toAnthropicMessages type boundary").
 */
function toAnthropicMessages(messages: AgentMessage[]): MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : m.content.map(toAnthropicBlock),
  }));
}

function toAnthropicBlock(
  b: AgentContentBlock,
): TextBlockParam | ToolUseBlockParam | ToolResultBlockParam {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: b.content,
        is_error: b.is_error,
      };
  }
}

/**
 * Test-only export of the otherwise-private message converter so
 * `lib/agents-anthropic.test.ts` can pin the per-block mapping shape
 * without going through a full `streamMessages` call. Not re-exported
 * from the public surface (see `lib/agents.ts`).
 */
export const __testHelpers = { toAnthropicMessages };

function toAnthropicTools(tools: readonly AgentToolDefinitionShape[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Tool.InputSchema,
  }));
}

async function* streamFromAnthropic(
  client: Anthropic,
  maxTokens: number,
  input: AgentStreamInput,
): AsyncGenerator<AgentEvent, void, void> {
  let stream: AsyncIterable<RawMessageStreamEvent>;
  try {
    stream = await client.messages.create(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system: input.system_prompt,
        messages: toAnthropicMessages(input.messages),
        tools: toAnthropicTools(input.tools),
        tool_choice: { type: "auto" },
        stream: true,
      },
      { signal: input.signal },
    );
  } catch (err) {
    throw mapSdkError(err);
  }

  // Per-content-block-index buffer for tool_use input_json_delta accumulation.
  // Keyed by `index` because Anthropic interleaves block events across indices
  // (ADR-0010 §1 — buffered until content_block_stop).
  const toolBuffers = new Map<number, { id: string; name: string; jsonBuf: string }>();
  let capturedStopReason: StopReason | null = null;

  try {
    for await (const ev of stream) {
      switch (ev.type) {
        case "message_start": {
          // Usage stats land via LogEvent at the route layer; no translation here.
          break;
        }
        case "content_block_start": {
          if (ev.content_block.type === "tool_use") {
            toolBuffers.set(ev.index, {
              id: ev.content_block.id,
              name: ev.content_block.name,
              jsonBuf: "",
            });
          }
          break;
        }
        case "content_block_delta": {
          if (ev.delta.type === "text_delta") {
            yield { kind: "text_delta", text: ev.delta.text };
          } else if (ev.delta.type === "input_json_delta") {
            const buf = toolBuffers.get(ev.index);
            if (buf) buf.jsonBuf += ev.delta.partial_json;
          }
          // Silently ignored delta subtypes: citations_delta, thinking_delta,
          // signature_delta. None are enabled in our request shape (no
          // `thinking:{type:"enabled"}`, no citations, no signed deltas). If
          // that changes, surface them here as new AgentEvent variants.
          break;
        }
        case "content_block_stop": {
          const buf = toolBuffers.get(ev.index);
          if (buf) {
            toolBuffers.delete(ev.index);
            const parsed = buf.jsonBuf === "" ? {} : (JSON.parse(buf.jsonBuf) as unknown);
            yield { kind: "tool_use_start", id: buf.id, name: buf.name, input: parsed };
          }
          break;
        }
        case "message_delta": {
          capturedStopReason = ev.delta.stop_reason;
          break;
        }
        case "message_stop": {
          // Truncation guard: if the stream ends with tool_use blocks still
          // unclosed (network blip mid-content, server abort after start
          // before stop), the loop driver would never see a tool_use_start
          // for that block and would be left holding a `stop_reason:"tool_use"`
          // with no tool to dispatch. Surface explicitly.
          if (toolBuffers.size > 0) {
            yield {
              kind: "error",
              code: "truncated_tool_use",
              message: `stream ended with ${toolBuffers.size} unfinished tool_use block(s)`,
            };
            toolBuffers.clear();
          }
          yield { kind: "done", stop_reason: translateStopReason(capturedStopReason) };
          return;
        }
      }
    }
  } catch (err) {
    throw mapSdkError(err);
  }
}

type DoneStopReason = (AgentEvent & { kind: "done" })["stop_reason"];

function translateStopReason(r: StopReason | null): DoneStopReason {
  switch (r) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return r;
    case "stop_sequence":
    case "pause_turn":
    case null:
      return "end_turn";
    default: {
      // Exhaustiveness pin: if the Anthropic SDK adds a new StopReason
      // value, the `never`-typed assignment errors at compile time and
      // forces this switch to be extended (matches the satisfies-never
      // precedent in lib/degraded-copy.ts). Runtime fallback to
      // "end_turn" preserves safety if the SDK ships a value our types
      // don't yet know about.
      const _exhaustive: never = r;
      void _exhaustive;
      return "end_turn";
    }
  }
}

/**
 * Map an SDK-thrown error into either a typed `AgentUnavailableError`
 * (transient — route returns 503), a `DOMException("AbortError")` (matches
 * the stub agent's abort contract), or rethrows unchanged (4xx config
 * errors must surface loud — iron rule #1).
 */
function mapSdkError(err: unknown): unknown {
  if (err instanceof APIUserAbortError) {
    return new DOMException("aborted", "AbortError");
  }
  if (
    err instanceof APIConnectionError ||
    err instanceof RateLimitError ||
    err instanceof InternalServerError
  ) {
    return new AgentUnavailableError(err.message, { cause: err });
  }
  if (err instanceof APIError && typeof err.status === "number" && err.status >= 500) {
    return new AgentUnavailableError(err.message, { cause: err });
  }
  return err;
}
