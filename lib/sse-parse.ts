// lib/sse-parse.ts — Server-Sent Events stream parser for the admin chat UI.
//
// Consumes a `Response` from POST /api/agent/ingest (ADR-0010 §1) and
// yields parsed `AgentEvent` objects. The route emits one event per SSE
// record framed as `data: <JSON>\n\n` with `: keepalive\n\n` comment
// lines between events on idle (route.ts:393).
//
// Spec-faithful enough for the route's actual wire shape plus the
// defensive cases a CDN might inject:
//   - Multi-`data:` lines per event: WHATWG §9.2.6 says multiple `data:`
//     fields in one event are concatenated with `\n`. The route doesn't
//     emit this today, but a future SDK adapter or a JSON line longer
//     than a proxy's MTU might.
//   - Comment lines starting with `:` are ignored (keepalive frames).
//   - Lines without a recognized field are ignored.
//   - Event boundary is a blank line (CR, LF, or CRLF). A CR that lands
//     at the very end of a chunk is held back so the LF in the next
//     chunk doesn't get mistaken for a separate empty-line boundary.
//   - Partial chunks across reads: bytes are decoded with a streaming
//     `TextDecoder` and an internal line buffer holds the in-progress
//     line until a terminator arrives.
//
// Runtime validation: each parsed event must be a non-null object with a
// `kind: string` field before it's yielded as `AgentEvent`. Anything
// else throws `SseStreamError` so the consumer's reducer can transition
// to `error` rather than receive a `setState((s) => undefined)` payload.

import type { AgentEvent } from "./agents";

/**
 * Thrown on stream-level failures: null body, malformed JSON in a
 * `data:` field, or an event payload that is not a plausible
 * `AgentEvent` shape. Manual `cause` attachment matches the ADR-0010 §5
 * pattern used by `AgentUnavailableError` — keep both errors shaped
 * identically so consumers can pattern-match on `name` consistently.
 */
export class SseStreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SseStreamError";
    if (options?.cause) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Parses an SSE response body into an async iterable of `AgentEvent`.
 *
 * Throws `SseStreamError` synchronously if `response.body` is null (the
 * route always returns a body; null here means the consumer was handed
 * the wrong response or the runtime stripped the body). Per-event JSON
 * parse failures throw inside the iterator and are observable via the
 * consumer's `for await` loop — they are not silently dropped because a
 * single malformed event likely indicates a protocol mismatch worth
 * surfacing to the reducer.
 */
export function parseSseStream(response: Response): AsyncIterable<AgentEvent> {
  if (response.body === null) {
    throw new SseStreamError("response body is null");
  }
  const reader = response.body.getReader();
  return iterateEvents(reader);
}

async function* iterateEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<AgentEvent, void, void> {
  const decoder = new TextDecoder("utf-8");
  let lineBuf = "";
  let dataLines: string[] = [];

  const flushEvent = (): AgentEvent | undefined => {
    if (dataLines.length === 0) return undefined;
    const payload = dataLines.join("\n");
    dataLines = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (cause) {
      throw new SseStreamError(`malformed SSE event JSON: ${payload}`, { cause });
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new SseStreamError(`SSE event payload is not an object: ${payload}`);
    }
    if (typeof (parsed as { kind?: unknown }).kind !== "string") {
      throw new SseStreamError(`SSE event missing string \`kind\` field: ${payload}`);
    }
    return parsed as AgentEvent;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      // If the buffer ends with a lone CR, the next chunk may bring an LF
      // that pairs with it (CRLF). Hold the CR back so we don't consume
      // it as a standalone terminator and then double-count the LF.
      const heldCr = lineBuf.endsWith("\r");
      const scanBuf = heldCr ? lineBuf.slice(0, -1) : lineBuf;
      let consumedUpTo = 0;
      let nl: number;
      while ((nl = nextLineEnd(scanBuf, consumedUpTo)) >= 0) {
        const line = scanBuf.slice(consumedUpTo, nl);
        const skip = scanBuf[nl] === "\r" && scanBuf[nl + 1] === "\n" ? 2 : 1;
        consumedUpTo = nl + skip;
        if (line === "") {
          const ev = flushEvent();
          if (ev !== undefined) yield ev;
          continue;
        }
        if (line.startsWith(":")) {
          // Comment line (keepalive). Ignore.
          continue;
        }
        if (line.startsWith("data:")) {
          // Per spec, a single leading space after the colon is stripped.
          const fieldValue = line[5] === " " ? line.slice(6) : line.slice(5);
          dataLines.push(fieldValue);
          continue;
        }
        // Other recognized SSE fields (event:, id:, retry:) are not used
        // by this route. Unknown lines are ignored per spec.
      }
      // Anything past `consumedUpTo` (and the optionally-held CR) stays
      // for the next chunk.
      lineBuf = scanBuf.slice(consumedUpTo) + (heldCr ? "\r" : "");
    }
    // Trailing partial event without a terminator is dropped per the
    // module docstring — the route always frames with `\n\n`.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released.
    }
  }
}

/**
 * Returns the index of the next line terminator in `s` at or after
 * `start`, or -1 if none. Recognizes LF, CR, and CRLF (CRLF is reported
 * at the CR index).
 */
function nextLineEnd(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 13) return i;
  }
  return -1;
}
