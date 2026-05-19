// lib/sse-parse.test.ts — unit tests for the SSE parser.
//
// All cases construct a synthetic `Response` from a `ReadableStream<Uint8Array>`
// and consume `parseSseStream(response)` end-to-end. The parser is pure
// (no DOM, no network) so vitest's node environment is sufficient.

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./agents";
import { parseSseStream, SseStreamError } from "./sse-parse";

const enc = new TextEncoder();

function streamFromChunks(chunks: string[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(stream);
}

async function collect(response: Response): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of parseSseStream(response)) {
    events.push(ev);
  }
  return events;
}

describe("parseSseStream", () => {
  it("parses a single event in one chunk", async () => {
    const res = streamFromChunks([
      `data: ${JSON.stringify({ kind: "text_delta", text: "hi" })}\n\n`,
    ]);
    expect(await collect(res)).toEqual([{ kind: "text_delta", text: "hi" }]);
  });

  it("parses multiple events delivered in one chunk", async () => {
    const a = JSON.stringify({ kind: "text_delta", text: "a" });
    const b = JSON.stringify({ kind: "done", stop_reason: "end_turn" });
    const res = streamFromChunks([`data: ${a}\n\ndata: ${b}\n\n`]);
    expect(await collect(res)).toEqual([
      { kind: "text_delta", text: "a" },
      { kind: "done", stop_reason: "end_turn" },
    ]);
  });

  it("reassembles an event split across two reads", async () => {
    const payload = JSON.stringify({ kind: "text_delta", text: "split" });
    const cut = Math.floor(payload.length / 2);
    const chunkA = `data: ${payload.slice(0, cut)}`;
    const chunkB = `${payload.slice(cut)}\n\n`;
    const res = streamFromChunks([chunkA, chunkB]);
    expect(await collect(res)).toEqual([{ kind: "text_delta", text: "split" }]);
  });

  it("ignores `: keepalive` comment lines between events", async () => {
    const a = JSON.stringify({ kind: "text_delta", text: "before" });
    const b = JSON.stringify({ kind: "text_delta", text: "after" });
    const res = streamFromChunks([`data: ${a}\n\n: keepalive\n\ndata: ${b}\n\n`]);
    expect(await collect(res)).toEqual([
      { kind: "text_delta", text: "before" },
      { kind: "text_delta", text: "after" },
    ]);
  });

  it("concatenates multi-line `data:` fields with `\\n` per WHATWG SSE §9.2.6", async () => {
    // Per spec, two `data:` fields in one event concatenate with `\n`
    // between them. We split a JSON object across two data: lines such
    // that the inserted `\n` lands inside JSON whitespace (between the
    // `{` and the first key) — the result parses identically.
    // Pre-concat:  `data: {`  +  `data: "kind":"text_delta","text":"ok"}`
    // Post-concat: `{\n"kind":"text_delta","text":"ok"}` → valid JSON.
    const sse = `data: {\ndata: "kind":"text_delta","text":"ok"}\n\n`;
    const res = streamFromChunks([sse]);
    expect(await collect(res)).toEqual([{ kind: "text_delta", text: "ok" }]);
  });

  it("normalizes CRLF and bare CR line terminators", async () => {
    const a = JSON.stringify({ kind: "text_delta", text: "crlf" });
    const res = streamFromChunks([`data: ${a}\r\n\r\n`]);
    expect(await collect(res)).toEqual([{ kind: "text_delta", text: "crlf" }]);
  });

  it("handles a CRLF that lands across two reads without spurious empty-line flush (M3)", async () => {
    // The CR ends chunk A; the LF starts chunk B. The parser must hold
    // the CR back until the LF arrives, otherwise the LF in chunk B
    // would be processed as a standalone terminator producing a bogus
    // event boundary.
    const a = JSON.stringify({ kind: "text_delta", text: "split-crlf" });
    const chunkA = `data: ${a}\r`;
    const chunkB = `\n\r\n`;
    const res = streamFromChunks([chunkA, chunkB]);
    expect(await collect(res)).toEqual([{ kind: "text_delta", text: "split-crlf" }]);
  });

  it("throws SseStreamError when the JSON payload is not an object (runtime shape guard M6)", async () => {
    // A bare-string or bare-number JSON literal parses cleanly but is
    // not a plausible AgentEvent — the parser rejects it instead of
    // forwarding state-poisoning data to the reducer.
    const res = streamFromChunks([`data: "just-a-string"\n\n`]);
    await expect(collect(res)).rejects.toBeInstanceOf(SseStreamError);
  });

  it("throws SseStreamError when the JSON payload lacks a string `kind` field", async () => {
    const res = streamFromChunks([`data: ${JSON.stringify({ foo: 1 })}\n\n`]);
    await expect(collect(res)).rejects.toBeInstanceOf(SseStreamError);
  });

  it("ignores unknown SSE fields", async () => {
    const a = JSON.stringify({ kind: "text_delta", text: "ok" });
    const res = streamFromChunks([`event: agent\nid: 1\ndata: ${a}\n\n`]);
    expect(await collect(res)).toEqual([{ kind: "text_delta", text: "ok" }]);
  });

  it("throws SseStreamError on malformed JSON in a data: line", async () => {
    const res = streamFromChunks([`data: not-json{\n\n`]);
    await expect(collect(res)).rejects.toBeInstanceOf(SseStreamError);
  });

  it("throws SseStreamError synchronously when response.body is null", () => {
    // Response("") still produces a stream; force a body-less response
    // by constructing via the Response API with a null body.
    const res = new Response(null, { status: 204 });
    expect(() => parseSseStream(res)).toThrow(SseStreamError);
  });

  it("drops a trailing partial event without a terminator", async () => {
    const a = JSON.stringify({ kind: "text_delta", text: "kept" });
    // Second event has no trailing blank line — it should be dropped.
    const b = JSON.stringify({ kind: "text_delta", text: "dropped" });
    const res = streamFromChunks([`data: ${a}\n\ndata: ${b}`]);
    expect(await collect(res)).toEqual([{ kind: "text_delta", text: "kept" }]);
  });

  it("strips the single optional leading space after `data:`", async () => {
    // Spec allows `data:foo` (no space) and `data: foo` (one space)
    // — both produce the field value `foo`.
    const a = JSON.stringify({ kind: "text_delta", text: "nospace" });
    const res = streamFromChunks([`data:${a}\n\n`]);
    expect(await collect(res)).toEqual([{ kind: "text_delta", text: "nospace" }]);
  });
});
