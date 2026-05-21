// lib/retrieval-anthropic-synth.ts — Anthropic Sonnet synthesizer adapter (M3 item 3 stage D).
//
// Implements the `Synthesizer` interface from `./retrieval` via the
// `@anthropic-ai/sdk` non-streaming `messages.create({stream:false})` path.
// The factory in `./retrieval` statically imports this module on the
// `SYNTH_PROVIDER=anthropic` branch; `./retrieval` itself imports no SDK and
// contains no `claude-sonnet` literal (mechanical floor on the no-SDK side
// already in lib/retrieval.test.ts; the model-id pin is asserted by this
// file's companion test).
//
// Why the SDK, not direct fetch (resolved at stage-C close, see CHATLOG
// 2026-05-21 "Stage-C reconstruction + stage-D handoff prep"):
// - SDK is already in deps at the version pinned by lib/agents-anthropic.ts
//   (drift-floor test at lib/agents-anthropic.test.ts:192-204 + this file's
//   companion test).
// - Native error-class taxonomy (APIConnectionError / RateLimitError /
//   InternalServerError / APIUserAbortError) maps cleanly to ADR-0012 §3
//   degraded-mode rows.
// - StopReason discrimination (refusal / max_tokens / end_turn) is provided
//   directly; no string-matching against response bodies.
//
// Stage D scope (deliberately narrow):
// - This adapter is contract-blind to ADR-0012 §D's structured-block input
//   shape (the `{entry_id, title, body, category, tags, source_pointer,
//   last_verified_at, sensitivity, score}` per-chunk JSON-tool-style block).
//   That assembly lives at the route layer (stage E) and lands with the
//   retrieval-agent prompt v0.2.0 bump. The `Synthesizer.synthesize(prompt,
//   context: string[])` interface at lib/retrieval.ts is unchanged.
// - Prompt-hash attribution is route-layer per ADR-0012 §E — adapter is
//   hash-agnostic.
// - Streaming is out of scope; ADR-0012 §D pins synth as non-streaming so
//   the citation-validation retry-once policy can inspect the full answer
//   before deciding to retry.
// - No live ANTHROPIC_API_KEY needed for this PR; all tests inject a stub
//   Anthropic client. Live flip lands with the route slice.
//
// Model id rationale: per Anthropic's models doc
// (https://platform.claude.com/docs/en/docs/about-claude/models — verified
// 2026-05-21): "Starting with the Claude 4.6 generation, model IDs use a
// dateless format that is also a pinned snapshot, not an evergreen pointer."
// So `claude-sonnet-4-6` IS the pinned snapshot, in contrast to the dated
// `claude-haiku-4-5-20251001` used by the older sibling agents adapter.
//
// Error mapping (sibling-shape with lib/agents-anthropic.ts:237-252; adds the
// non-streaming-specific 200-OK paths — refusal, max_tokens truncation,
// empty content):
// - APIConnectionError | RateLimitError | InternalServerError | APIError(≥500)
//                              → SynthUnavailableError (transient; route
//                                catches via instanceof for ADR-0012 §3
//                                synth-down degraded row).
// - APIUserAbortError          → DOMException("aborted","AbortError").
// - Other 4xx (Authentication / BadRequest / Permission / NotFound /
//   Conflict / Unprocessable)  → rethrown unchanged (iron rule #1, loud
//                                config error).
// - stop_reason === "refusal"  → loud SynthRefusalError. NOT transient — a
//                                refusal is a 200-OK policy decision and
//                                must not feed degraded-mode retry.
// - stop_reason === "max_tokens" with no text block → loud
//                                SynthTruncatedError. NOT transient — the
//                                request exceeded max_tokens, raising the
//                                limit is the fix, not retry.
// - Empty `content` array      → SynthUnavailableError ("model returned no
//                                content"). Distinct from refusal + max_tokens
//                                so the route's audit row carries the right
//                                discriminator.
// - Missing usage fields       → defaulted to 0; SDK types declare
//                                `input_tokens` / `output_tokens` as
//                                nullable, and empty-content / error-recovery
//                                paths can ship without usage.
//
// Empty-apiKey divergence from lib/agents-anthropic.ts: the agents adapter
// lets `new Anthropic({apiKey:""})` succeed and surfaces the failure as a
// runtime 401 AuthenticationError; this synth adapter rejects an empty key
// at construction. Reason: the factory at lib/retrieval.ts may pass an empty
// string fallback when the env var is unset, so an empty value here
// represents an unconfigured environment — surfacing it as a loud RangeError
// at factory boot (iron rule #1) beats waiting for a confusing 401 on the
// first user query. The voyage-rerank sibling enforces the same guard
// (lib/retrieval-voyage-rerank.ts:107-109).

import Anthropic, {
  APIError,
  APIConnectionError,
  APIUserAbortError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { ContentBlock, Message, StopReason } from "@anthropic-ai/sdk/resources/messages";

import { SynthUnavailableError, type SynthResult, type Synthesizer } from "./retrieval";
// Re-use the pinned SDK-version constant. The existing drift-floor test at
// lib/agents-anthropic.test.ts:192-204 covers it; this file's companion
// test adds a parallel direct assertion (defense-in-depth — the constant
// is now load-bearing for two adapters).
import { ANTHROPIC_SDK_VERSION } from "./agents-anthropic";

/**
 * Sonnet 4.6 model id. Dateless format IS the pinned snapshot for the 4.6
 * generation per Anthropic's docs (see file header). The drift-floor test
 * in the companion test file pins this constant against the doc-stated id.
 */
export const ANTHROPIC_SYNTH_MODEL = "claude-sonnet-4-6";

/** Re-exported for downstream attribution / drift-floor coverage. */
export { ANTHROPIC_SDK_VERSION };

/**
 * Default `max_tokens` for a synth turn. ADR-0012 §D doesn't pin a value;
 * 4096 fits a 5-chunk-cited answer comfortably. Larger answers should hit
 * the SynthTruncatedError branch and raise it via config, not silently
 * truncate.
 */
const DEFAULT_MAX_TOKENS = 4096;

/** Per-chunk separator when joining the `context: string[]` into a single
 *  user message. The route layer (stage E) is responsible for the §D
 *  structured-block contract; this separator only matters in stage-D unit
 *  tests, which exercise the adapter directly against stub context. */
const CONTEXT_SEPARATOR = "\n\n---\n\n";

export type CreateAnthropicSynthesizerOptions = {
  apiKey: string;
  /** Override for `max_tokens` per request. Defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** Inject an Anthropic client for tests. Defaults to a real `new Anthropic({apiKey})`. */
  clientImpl?: Pick<Anthropic, "messages">;
};

/**
 * Refusal raised when the model returned a 200-OK response with
 * `stop_reason === "refusal"`. NOT a subclass of `SynthUnavailableError` —
 * refusals are not transient and must not feed degraded-mode retry.
 * Surface as a loud error so the route can log + return a clear 4xx-shaped
 * failure to the caller.
 */
export class SynthRefusalError extends Error {
  /** Response discriminator (`id` + `stop_reason`) preserved so the route
   *  audit row can log which model decision the refusal came from without
   *  re-issuing the request. Stored on `.cause` to mirror the SDK-error
   *  cause-preservation pattern. */
  constructor(message = "model refused to respond", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SynthRefusalError";
  }
}

/**
 * Raised when the response hit `max_tokens` before producing any text block.
 * Distinct from `SynthUnavailableError` (not transient) and from
 * `SynthRefusalError` (not a policy decision). The fix is to raise
 * `max_tokens`, not to retry.
 */
export class SynthTruncatedError extends Error {
  /** Response discriminator preserved on `.cause` (see SynthRefusalError). */
  constructor(
    message = "model output truncated at max_tokens before any text",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SynthTruncatedError";
  }
}

/**
 * Build the Anthropic Sonnet `Synthesizer` adapter. Caller injects the API
 * key explicitly so this module never reads the process environment — the
 * factory at lib/retrieval.ts is the single source of env truth (mirrors
 * the lib/agents.ts → lib/agents-anthropic.ts split). The source-file scan
 * in the companion test asserts no env-namespace literal in this file.
 */
export function createAnthropicSynthesizer(
  options: CreateAnthropicSynthesizerOptions,
): Synthesizer {
  const apiKey = options.apiKey;
  // Iron-rule-#1 mirror: factory at lib/retrieval.ts already throws on
  // missing env, but a direct caller could bypass — guard here too so the
  // "ghost adapter with empty Bearer header" failure mode surfaces at
  // construction. Mirrors lib/retrieval-voyage-rerank.ts:107-109.
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new RangeError("createAnthropicSynthesizer: apiKey must be a non-empty string");
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const client: Pick<Anthropic, "messages"> = options.clientImpl ?? new Anthropic({ apiKey });

  return {
    model: ANTHROPIC_SYNTH_MODEL,
    version: ANTHROPIC_SDK_VERSION,
    async synthesize(prompt: string, context: string[]): Promise<SynthResult> {
      const userContent = context.join(CONTEXT_SEPARATOR);

      let response: Message;
      try {
        response = await client.messages.create({
          model: ANTHROPIC_SYNTH_MODEL,
          max_tokens: maxTokens,
          system: prompt,
          messages: [{ role: "user", content: userContent }],
          stream: false,
        });
      } catch (err) {
        throw mapSdkError(err);
      }

      // 200-OK branches. Order matters:
      //   1. refusal — emit SynthRefusalError even if the model also emitted
      //      a text block (refusal blocks are sometimes accompanied by
      //      apologetic text; the policy outcome dominates).
      //   2. extract text — first text content block.
      //   3. no text AND stop_reason=max_tokens → SynthTruncatedError.
      //   4. no text otherwise → SynthUnavailableError.
      const stopReason: StopReason | null = response.stop_reason;
      if (stopReason === "refusal") {
        throw new SynthRefusalError("model refused to respond", {
          cause: { id: response.id, stop_reason: stopReason },
        });
      }

      const answer = extractFirstText(response.content);
      if (answer !== null) {
        return {
          answer,
          // Usage fields are SDK-nullable per types; default to 0 on the
          // error-recovery / no-usage paths. Production telemetry can
          // discriminate via the model name; we do NOT treat 0 as a stub
          // sentinel (cf. lib/retrieval.ts header).
          tokens_in: response.usage?.input_tokens ?? 0,
          tokens_out: response.usage?.output_tokens ?? 0,
        };
      }

      if (stopReason === "max_tokens") {
        throw new SynthTruncatedError("model output truncated at max_tokens before any text", {
          cause: { id: response.id, stop_reason: stopReason },
        });
      }
      throw new SynthUnavailableError("model returned no text content", {
        cause: { id: response.id, stop_reason: stopReason },
      });
    },
  };
}

/**
 * Return the text of the first text-typed content block, or `null` if none
 * exists. Other block types (tool_use / thinking / etc.) are not enabled in
 * our request shape — if they appear, fold to `null` and let the caller
 * branch on stop_reason.
 */
function extractFirstText(content: readonly ContentBlock[] | undefined): string | null {
  if (!content || content.length === 0) return null;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      return block.text;
    }
  }
  return null;
}

/**
 * Map an SDK-thrown error into either a typed `SynthUnavailableError`
 * (transient — route returns degraded synth-down row), a
 * `DOMException("AbortError")` (matches the agents-anthropic abort
 * contract), or rethrows unchanged (4xx config errors must surface loud —
 * iron rule #1). Mirrors lib/agents-anthropic.ts:237-252; nullable
 * `err.status` guard copied verbatim.
 *
 * `APIConnectionTimeoutError` is a subclass of `APIConnectionError` and is
 * covered by the same `instanceof` branch.
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
    return new SynthUnavailableError(err.message, { cause: err });
  }
  if (err instanceof APIError && typeof err.status === "number" && err.status >= 500) {
    return new SynthUnavailableError(err.message, { cause: err });
  }
  return err;
}
