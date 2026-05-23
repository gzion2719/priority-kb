import { afterEach, describe, expect, it, vi } from "vitest";

import { ERROR_MAX_LEN, logEvent, resetLogSink, setLogSink, type LogEvent } from "@/lib/log";

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function captureLog(): {
  lines: string[];
  writer: (chunk: string) => boolean;
} {
  const lines: string[] = [];
  return {
    lines,
    writer: (chunk: string) => {
      lines.push(chunk);
      return true;
    },
  };
}

afterEach(() => {
  resetLogSink();
});

describe("logEvent — Claude variant", () => {
  it("emits one NDJSON line with all required fields", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "claude",
      model: "claude-sonnet-4-6",
      model_version: "2026-01-15",
      prompt_hash: "abc123",
      tokens: { input: 10, output: 5, total: 15 },
      latency_ms: 123,
      cost_usd: 0.5,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.kind).toBe("claude");
    expect(parsed.model).toBe("claude-sonnet-4-6");
    expect(parsed.model_version).toBe("2026-01-15");
    expect(parsed.prompt_hash).toBe("abc123");
    expect(parsed.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(parsed.latency_ms).toBe(123);
    expect(parsed.cost_usd).toBe(0.5);
    expect(parsed.ts).toMatch(ISO_8601);
  });

  it("carries optional agent fields (tool_iterations + streaming) when present — ADR-0010 LogEvent extension", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "claude",
      model: "claude-haiku-4-5-20251001",
      model_version: "2026-05-18",
      prompt_hash: "deadbeef",
      tokens: { input: 100, output: 50, total: 150 },
      latency_ms: 800,
      cost_usd: 0.001,
      tool_iterations: 3,
      streaming: true,
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.tool_iterations).toBe(3);
    expect(parsed.streaming).toBe(true);
  });

  it("omits agent fields from the raw NDJSON line when absent — assert on string, not on JSON.parse (which silently drops undefined-valued keys)", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "claude",
      model: "claude-sonnet-4-6",
      model_version: "2026-01-15",
      prompt_hash: "abc123",
      latency_ms: 100,
      cost_usd: 0.01,
    });

    // Assert on the raw NDJSON line (the actual wire output). A regression
    // that wrote `tool_iterations: undefined` into the spread would still
    // produce `JSON.parse(line)` with no `tool_iterations` key (because
    // JSON.stringify drops undefined values), but the raw line would
    // contain the key name. The string assertion catches that drift; the
    // `in parsed` form would not.
    expect(lines[0]).not.toMatch(/"tool_iterations"/);
    expect(lines[0]).not.toMatch(/"streaming"/);
  });
});

describe("logEvent — Voyage variant", () => {
  it("emits one NDJSON line without a prompt_hash field", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "voyage",
      model: "voyage-3-large",
      model_version: "1",
      latency_ms: 50,
      cost_usd: null,
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.kind).toBe("voyage");
    expect("prompt_hash" in parsed).toBe(false);
    expect(parsed.cost_usd).toBeNull();
  });
});

describe("logEvent — cost_usd handling", () => {
  it("preserves cost_usd: 0 (regression guard against falsy filtering)", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "voyage",
      model: "voyage-3-large",
      model_version: "1",
      latency_ms: 10,
      cost_usd: 0,
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.cost_usd).toBe(0);
    expect("cost_usd" in parsed).toBe(true);
  });

  it("preserves cost_usd: null as null (not absent from the line)", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "voyage",
      model: "voyage-3-large",
      model_version: "1",
      latency_ms: 10,
      cost_usd: null,
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.cost_usd).toBeNull();
    expect("cost_usd" in parsed).toBe(true);
  });

  it("throws when cost_usd is undefined-smuggled via `as any`", () => {
    expect(() =>
      logEvent({
        kind: "voyage",
        model: "voyage-3-large",
        model_version: "1",
        latency_ms: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cost_usd: undefined as any,
      }),
    ).toThrow(/cost_usd must be a number or null/);
  });
});

describe("logEvent — sequence", () => {
  it("two calls produce two writes with non-decreasing timestamps", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    const event: LogEvent = {
      kind: "voyage",
      model: "voyage-3-large",
      model_version: "1",
      latency_ms: 1,
      cost_usd: null,
    };

    logEvent(event);
    logEvent(event);

    expect(lines).toHaveLength(2);
    const ts1 = new Date(JSON.parse(lines[0] ?? "").ts).getTime();
    const ts2 = new Date(JSON.parse(lines[1] ?? "").ts).getTime();
    expect(ts2).toBeGreaterThanOrEqual(ts1);
  });
});

describe("logEvent — error field hygiene", () => {
  it("truncates error strings longer than ERROR_MAX_LEN", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    const longError = "x".repeat(ERROR_MAX_LEN * 4);
    logEvent({
      kind: "claude",
      model: "claude-sonnet-4-6",
      model_version: "2026-01-15",
      prompt_hash: "abc",
      latency_ms: 1,
      cost_usd: null,
      status: "error",
      error: longError,
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.status).toBe("error");
    expect(parsed.error).toHaveLength(ERROR_MAX_LEN);
    expect(parsed.error).toBe("x".repeat(ERROR_MAX_LEN));
  });

  it("preserves error strings shorter than the cap unchanged", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "voyage",
      model: "voyage-3-large",
      model_version: "1",
      latency_ms: 1,
      cost_usd: null,
      status: "error",
      error: "ECONNREFUSED",
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.error).toBe("ECONNREFUSED");
  });

  it("redacts Bearer / Authorization / sk- / pa- secrets in error", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "claude",
      model: "claude-sonnet-4-6",
      model_version: "2026-01-15",
      prompt_hash: "abc",
      latency_ms: 1,
      cost_usd: null,
      status: "error",
      error:
        "401 from api — Authorization: Bearer sk-ant-abc123def456 (req used key pa-voyage-xyz789abc)",
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.error).not.toContain("sk-ant-abc123def456");
    expect(parsed.error).not.toContain("pa-voyage-xyz789abc");
    expect(parsed.error).toContain("[REDACTED]");
  });
});

describe("logEvent — latency_ms guard", () => {
  it("throws on NaN", () => {
    expect(() =>
      logEvent({
        kind: "voyage",
        model: "voyage-3-large",
        model_version: "1",
        latency_ms: Number.NaN,
        cost_usd: null,
      }),
    ).toThrow(/finite non-negative number/);
  });

  it("throws on +Infinity", () => {
    expect(() =>
      logEvent({
        kind: "voyage",
        model: "voyage-3-large",
        model_version: "1",
        latency_ms: Number.POSITIVE_INFINITY,
        cost_usd: null,
      }),
    ).toThrow(/finite non-negative number/);
  });

  it("throws on -Infinity", () => {
    expect(() =>
      logEvent({
        kind: "voyage",
        model: "voyage-3-large",
        model_version: "1",
        latency_ms: Number.NEGATIVE_INFINITY,
        cost_usd: null,
      }),
    ).toThrow(/finite non-negative number/);
  });

  it("throws on negative finite values", () => {
    expect(() =>
      logEvent({
        kind: "voyage",
        model: "voyage-3-large",
        model_version: "1",
        latency_ms: -1,
        cost_usd: null,
      }),
    ).toThrow(/finite non-negative number/);
  });
});

describe("logEvent — sink robustness", () => {
  it("does not propagate sink errors into the caller", () => {
    setLogSink(() => {
      throw new Error("sink exploded");
    });

    expect(() =>
      logEvent({
        kind: "voyage",
        model: "voyage-3-large",
        model_version: "1",
        latency_ms: 1,
        cost_usd: null,
      }),
    ).not.toThrow();
  });
});

describe("logEvent — retrieval_pipeline variant (ADR-0005 amendment 2026-05-23)", () => {
  it("emits one NDJSON line with all required fields and omits LogEventBase shape", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "retrieval_pipeline",
      latency_ms: 1234,
      cost_usd: null,
      role: "user",
      degraded: false,
      citation_validation_outcome: "ok",
      retry_attempted: false,
      keyword_only: false,
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.kind).toBe("retrieval_pipeline");
    expect(parsed.latency_ms).toBe(1234);
    expect(parsed.cost_usd).toBeNull();
    expect(parsed.role).toBe("user");
    expect(parsed.degraded).toBe(false);
    expect(parsed.citation_validation_outcome).toBe("ok");
    expect(parsed.retry_attempted).toBe(false);
    expect(parsed.keyword_only).toBe(false);
    expect(parsed.ts).toMatch(ISO_8601);
    // LogEventBase shape NOT carried — no model / model_version / tokens /
    // prompt_hash on the aggregate event (per-vendor lines carry those).
    expect("model" in parsed).toBe(false);
    expect("model_version" in parsed).toBe(false);
    expect("prompt_hash" in parsed).toBe(false);
    // Assert on raw line — JSON.parse silently drops undefined-valued keys,
    // would miss a regression that wrote `model: undefined` into the spread.
    expect(lines[0]).not.toMatch(/"model"/);
    expect(lines[0]).not.toMatch(/"prompt_hash"/);
  });

  it("preserves optional fields (status, error, query_hash, degraded_reason, pipeline_request_id) when present", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "retrieval_pipeline",
      latency_ms: 50,
      cost_usd: null,
      role: "admin",
      degraded: true,
      degraded_reason: "synth_unavailable",
      citation_validation_outcome: null,
      retry_attempted: false,
      keyword_only: false,
      status: "error",
      error: "stage D unavailable",
      query_hash: "deadbeefcafe1234",
      pipeline_request_id: "req-abc-123",
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.degraded).toBe(true);
    expect(parsed.degraded_reason).toBe("synth_unavailable");
    expect(parsed.status).toBe("error");
    expect(parsed.error).toBe("stage D unavailable");
    expect(parsed.query_hash).toBe("deadbeefcafe1234");
    expect(parsed.pipeline_request_id).toBe("req-abc-123");
  });

  it("omits optional fields from the raw NDJSON line when absent (string-level assertion)", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "retrieval_pipeline",
      latency_ms: 10,
      cost_usd: null,
      role: "user",
      degraded: false,
      citation_validation_outcome: null,
      retry_attempted: false,
      keyword_only: false,
    });

    // Assert on the raw line — same rationale as the Claude-variant test:
    // JSON.parse drops undefined-valued keys, but a `spread` regression
    // that wrote `query_hash: undefined` would leave the key name in the
    // raw string.
    expect(lines[0]).not.toMatch(/"status"/);
    expect(lines[0]).not.toMatch(/"error"/);
    expect(lines[0]).not.toMatch(/"query_hash"/);
    expect(lines[0]).not.toMatch(/"degraded_reason"/);
    expect(lines[0]).not.toMatch(/"pipeline_request_id"/);
  });

  it("inherits the latency_ms guard (throws on NaN)", () => {
    expect(() =>
      logEvent({
        kind: "retrieval_pipeline",
        latency_ms: Number.NaN,
        cost_usd: null,
        role: "user",
        degraded: false,
        citation_validation_outcome: null,
        retry_attempted: false,
        keyword_only: false,
      }),
    ).toThrow(/finite non-negative number/);
  });

  it("inherits the cost_usd guard (throws on undefined-smuggled-as-any)", () => {
    expect(() =>
      logEvent({
        kind: "retrieval_pipeline",
        latency_ms: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cost_usd: undefined as any,
        role: "user",
        degraded: false,
        citation_validation_outcome: null,
        retry_attempted: false,
        keyword_only: false,
      }),
    ).toThrow(/cost_usd must be a number or null/);
  });

  it("inherits the error redact + truncate pipeline", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "retrieval_pipeline",
      latency_ms: 1,
      cost_usd: null,
      role: "user",
      degraded: true,
      degraded_reason: "synth_unavailable",
      citation_validation_outcome: null,
      retry_attempted: false,
      keyword_only: false,
      status: "error",
      error: "401 Authorization: Bearer sk-ant-XXXXXXXXXXXX",
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.error).not.toContain("sk-ant-XXXXXXXXXXXX");
    expect(parsed.error).toContain("[REDACTED]");
  });

  it("ts is helper-injected and not caller-overridable via structural cast", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "retrieval_pipeline",
      latency_ms: 1,
      cost_usd: null,
      role: "user",
      degraded: false,
      citation_validation_outcome: null,
      retry_attempted: false,
      keyword_only: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ ts: "1970-01-01T00:00:00.000Z" } as any),
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.ts).not.toBe("1970-01-01T00:00:00.000Z");
    expect(parsed.ts).toMatch(ISO_8601);
  });
});

describe("logEvent — sink injection", () => {
  it("resetLogSink stops the swapped writer and resumes default", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);
    resetLogSink();

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      logEvent({
        kind: "voyage",
        model: "voyage-3-large",
        model_version: "1",
        latency_ms: 1,
        cost_usd: null,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      // Capture writer must NOT have been called after reset.
      expect(lines).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
