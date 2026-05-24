import { describe, expect, it } from "vitest";

import {
  applyEvent,
  initialQueryState,
  markStreamError,
  markUnavailable,
  reset,
  startStream,
  type QueryCandidate,
  type QueryChunkSnippet,
  type QueryEvent,
  type QueryState,
} from "@/lib/query-chat-state";

const seedCandidate = (id: string, title: string): QueryCandidate => ({
  entry_id: id,
  title,
  category: "howto",
  sensitivity: "public",
  last_verified_at: "2026-01-01T00:00:00Z",
});

const seedSnippet = (id: string, title: string, snippet: string): QueryChunkSnippet => ({
  entry_id: id,
  title,
  category: "howto",
  sensitivity: "public",
  last_verified_at: "2026-01-01T00:00:00Z",
  snippet,
});

describe("query-chat-state — initial state", () => {
  it("starts idle with empty accumulators", () => {
    expect(initialQueryState).toEqual({
      status: "idle",
      query: "",
      candidates: [],
      answer: "",
      citations: [],
      chunkSnippets: [],
    });
  });

  it("has no degraded fields set at idle (absent, not false/undefined-by-coincidence)", () => {
    // Negative-assertion: a regression that defaulted degraded:false at
    // idle would make the UI banner code believe a healthy reset means
    // "explicitly non-degraded" rather than "no data yet." Pin the
    // "absent" semantics.
    expect("degraded" in initialQueryState).toBe(false);
    expect("degradedReason" in initialQueryState).toBe(false);
  });
});

describe("startStream — records query and resets accumulators", () => {
  it("transitions idle → streaming and pins the query", () => {
    const next = startStream(initialQueryState, "what is FormStart");
    expect(next.status).toBe("streaming");
    expect(next.query).toBe("what is FormStart");
    expect(next.candidates).toEqual([]);
    expect(next.answer).toBe("");
    expect(next.citations).toEqual([]);
  });

  it("resets stale answer/candidates when restarting on a done state", () => {
    const stale: QueryState = {
      status: "done",
      query: "prev",
      candidates: [seedCandidate("aaaaaaaa-0000-4000-8000-000000000001", "prev title")],
      answer: "old answer",
      citations: ["aaaaaaaa-0000-4000-8000-000000000001"],
      chunkSnippets: [
        seedSnippet("aaaaaaaa-0000-4000-8000-000000000001", "prev title", "stale snippet"),
      ],
    };
    const next = startStream(stale, "new query");
    expect(next.status).toBe("streaming");
    expect(next.candidates).toEqual([]);
    expect(next.answer).toBe("");
    expect(next.citations).toEqual([]);
    expect(next.chunkSnippets).toEqual([]);
  });
});

describe("applyEvent — full happy-path event sequence", () => {
  it("candidates → answer_delta (×2) → done lands in done with concatenated answer", () => {
    let s = startStream(initialQueryState, "q");

    s = applyEvent(s, {
      kind: "candidates",
      entries: [
        seedCandidate("aaaaaaaa-0000-4000-8000-000000000001", "one"),
        seedCandidate("bbbbbbbb-0000-4000-8000-000000000002", "two"),
      ],
    });
    expect(s.candidates).toHaveLength(2);
    expect(s.status).toBe("streaming"); // candidates is not terminal

    s = applyEvent(s, { kind: "answer_delta", text: "Hello " });
    s = applyEvent(s, { kind: "answer_delta", text: "world." });
    expect(s.answer).toBe("Hello world.");
    expect(s.status).toBe("streaming");

    s = applyEvent(s, {
      kind: "done",
      citation_ids: ["aaaaaaaa-0000-4000-8000-000000000001"],
    });
    expect(s.status).toBe("done");
    expect(s.citations).toEqual(["aaaaaaaa-0000-4000-8000-000000000001"]);
    // Candidates and answer preserved at terminal:
    expect(s.candidates).toHaveLength(2);
    expect(s.answer).toBe("Hello world.");
  });
});

describe("applyEvent — done event with degraded fields (sub-slice 2c-ii additions)", () => {
  it("done without degraded fields preserves legacy 2c-i shape (no degraded on state)", () => {
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, {
      kind: "done",
      citation_ids: ["aaaaaaaa-0000-4000-8000-000000000001"],
    });
    expect(s.status).toBe("done");
    expect(s.citations).toEqual(["aaaaaaaa-0000-4000-8000-000000000001"]);
    // Negative-assertion: a regression that defaulted degraded:false on
    // the done event would make the UI banner code think every healthy
    // answer is "explicitly non-degraded." Pin the absence semantics.
    expect("degraded" in s).toBe(false);
    expect("degradedReason" in s).toBe(false);
  });

  it("done with degraded:true + degraded_reason surfaces both on state", () => {
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, {
      kind: "done",
      citation_ids: ["aaaaaaaa-0000-4000-8000-000000000001"],
      degraded: true,
      degraded_reason: "embed_unavailable_keyword_fallback",
    });
    expect(s.status).toBe("done");
    expect(s.degraded).toBe(true);
    expect(s.degradedReason).toBe("embed_unavailable_keyword_fallback");
  });

  it("done with degraded:false still surfaces (orchestrator may emit it explicitly)", () => {
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, {
      kind: "done",
      citation_ids: ["aaaaaaaa-0000-4000-8000-000000000001"],
      degraded: false,
    });
    expect(s.degraded).toBe(false);
    expect(s.degradedReason).toBeUndefined();
  });
});

describe("applyEvent — terminal chunks_only path (ADR-0012 §3 synth-down rows)", () => {
  it("chunks_only lands in chunks_only status with the snippets visible", () => {
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, { kind: "candidates", entries: [seedCandidate("aa", "candidate-only")] });
    s = applyEvent(s, {
      kind: "chunks_only",
      entries: [
        seedSnippet(
          "aaaaaaaa-0000-4000-8000-000000000001",
          "one",
          "First entry's chunk body excerpt.",
        ),
        seedSnippet(
          "bbbbbbbb-0000-4000-8000-000000000002",
          "two",
          "Second entry's chunk body excerpt.",
        ),
      ],
    });
    expect(s.status).toBe("chunks_only");
    expect(s.chunkSnippets).toHaveLength(2);
    expect(s.chunkSnippets[0]?.snippet).toMatch(/First entry/);
    // Pre-stream candidates preserved so the UI can correlate.
    expect(s.candidates).toHaveLength(1);
    // No synthesized answer arrived → answer stays empty.
    expect(s.answer).toBe("");
    expect(s.citations).toEqual([]);
  });

  it("chunks_only emitted with empty entries is a degenerate but legal terminal", () => {
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, { kind: "chunks_only", entries: [] });
    expect(s.status).toBe("chunks_only");
    expect(s.chunkSnippets).toEqual([]);
  });

  it("chunks_only with degraded_reason surfaces both degraded:true and degradedReason on state", () => {
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, {
      kind: "chunks_only",
      entries: [seedSnippet("aaaaaaaa-0000-4000-8000-000000000001", "one", "snippet content")],
      degraded_reason: "rerank_and_synth_unavailable",
    });
    expect(s.status).toBe("chunks_only");
    expect(s.degraded).toBe(true);
    expect(s.degradedReason).toBe("rerank_and_synth_unavailable");
  });

  it("chunks_only without degraded_reason leaves degraded fields ABSENT (neg-assertion)", () => {
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, { kind: "chunks_only", entries: [] });
    // Synth-down without orchestrator-supplied reason → no implicit
    // `degraded:true`. The status === "chunks_only" carries the degraded
    // semantics; explicit `degraded` is opt-in via degraded_reason.
    expect("degraded" in s).toBe(false);
    expect("degradedReason" in s).toBe(false);
  });

  it("preserves a partially-accumulated answer through chunks_only (orchestrator emits exclusively)", () => {
    // The orchestrator's contract is "chunks_only INSTEAD of answer_delta"
    // on synth-down, so in practice answer === "" here. The reducer does
    // NOT wipe defensively — this test pins that behavior so a future
    // change to wipe semantics would surface as a regression.
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, { kind: "answer_delta", text: "partial " });
    s = applyEvent(s, { kind: "chunks_only", entries: [] });
    expect(s.status).toBe("chunks_only");
    expect(s.answer).toBe("partial ");
  });
});

describe("applyEvent — terminal no_content path", () => {
  it("bare no_content lands without candidates, answer, or degraded flags", () => {
    let s = startStream(initialQueryState, "q with no match");
    s = applyEvent(s, { kind: "no_content" });
    expect(s.status).toBe("no_content");
    expect(s.candidates).toEqual([]);
    expect(s.answer).toBe("");
    expect(s.citations).toEqual([]);
    expect(s.error).toBeUndefined();
    // Back-compat: a bare no_content (structural empty — embed-OK content
    // gap OR SQL-WHERE-filtered) MUST NOT synthesize degraded flags. A
    // regression that always set them would make the UI render a misleading
    // "outage" banner on a healthy empty result. Pin the absence.
    expect("degraded" in s).toBe(false);
    expect("degradedReason" in s).toBe(false);
  });

  it("no_content with degraded_reason synthesizes degraded:true and carries the reason", () => {
    // ADR-0013 §3 special row: embed-fail + zero-keyword. The wire shape
    // carries reason-only (mirrors chunks_only); the reducer synthesizes
    // `degraded:true` so the UI banner gate
    // (`state.degraded === true && state.degradedReason !== undefined`,
    // app/query/page.tsx:179) is satisfied with one wire field.
    let s = startStream(initialQueryState, "q under embed outage");
    s = applyEvent(s, {
      kind: "no_content",
      degraded_reason: "no_keyword_match_under_embed_outage",
    });
    expect(s.status).toBe("no_content");
    expect(s.degraded).toBe(true);
    expect(s.degradedReason).toBe("no_keyword_match_under_embed_outage");
    // Non-degraded fields unchanged.
    expect(s.candidates).toEqual([]);
    expect(s.answer).toBe("");
    expect(s.citations).toEqual([]);
    expect(s.error).toBeUndefined();
  });
});

describe("applyEvent — terminal error event from server", () => {
  it.each([
    { code: "db" as const, expectedMatch: /Database error/i },
    { code: "synth_unavailable" as const, expectedMatch: /unavailable/i },
    { code: "internal" as const, expectedMatch: /something went wrong/i },
  ])("error code=$code sets status=error with a coded message", ({ code, expectedMatch }) => {
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, { kind: "error", code });
    expect(s.status).toBe("error");
    expect(s.error).toMatch(expectedMatch);
  });

  it("emits DISTINCT error messages per code (negative-assertion: not a generic shared string)", () => {
    // A regression that returned the same message for all codes would
    // hide which path failed in UI logs / screenshots. This test pins
    // distinguishability per ADR-0005 log-event-schema spirit.
    const s = startStream(initialQueryState, "q");
    const dbMsg = applyEvent(s, { kind: "error", code: "db" }).error;
    const synthMsg = applyEvent(s, { kind: "error", code: "synth_unavailable" }).error;
    const internalMsg = applyEvent(s, { kind: "error", code: "internal" }).error;
    expect(new Set([dbMsg, synthMsg, internalMsg]).size).toBe(3);
  });
});

describe("markUnavailable / markStreamError — client-side terminal transitions", () => {
  it("markUnavailable transitions to unavailable without touching answer/candidates", () => {
    let s = startStream(initialQueryState, "q");
    s = applyEvent(s, { kind: "candidates", entries: [seedCandidate("aa", "t")] });
    s = applyEvent(s, { kind: "answer_delta", text: "partial" });
    s = markUnavailable(s);
    expect(s.status).toBe("unavailable");
    // Preserves pre-failure context so the UI can still show what
    // came through before the 503 was observed.
    expect(s.candidates).toHaveLength(1);
    expect(s.answer).toBe("partial");
  });

  it("markStreamError sets status=error with the provided message (transport-level)", () => {
    let s = startStream(initialQueryState, "q");
    s = markStreamError(s, "Network failed: ECONNRESET");
    expect(s.status).toBe("error");
    expect(s.error).toBe("Network failed: ECONNRESET");
  });
});

describe("reset — returns to initial state", () => {
  it("clears all fields back to initial", () => {
    const fresh = reset();
    expect(fresh).toEqual(initialQueryState);
  });
});

describe("applyEvent — pure / deterministic", () => {
  it("does not mutate input state", () => {
    const before: QueryState = {
      ...initialQueryState,
      status: "streaming",
      query: "q",
      answer: "a",
    };
    const snapshot = JSON.stringify(before);
    applyEvent(before, { kind: "answer_delta", text: "b" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("forward-compatible: unknown event types return state UNCHANGED (no undefined leak)", () => {
    // Without the default branch, an unknown event would fall through
    // the switch and return undefined — feeding setState(undefined) into
    // React. The default-returns-state pattern is the runtime safety
    // net; this test pins it. Distinguishes from "throws on unknown"
    // (would crash the page) and from "returns undefined" (would crash
    // the next render). Both regressions detected.
    const s = startStream(initialQueryState, "q");
    const snapshot = JSON.stringify(s);
    const bogus = { kind: "future_unknown" } as unknown as QueryEvent;
    const next = applyEvent(s, bogus);
    expect(next).toBeDefined();
    expect(JSON.stringify(next)).toBe(snapshot);
  });
});
