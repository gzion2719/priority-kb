import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ERROR_MAX_LEN,
  disableFixtureRecording,
  enableFixtureRecording,
  logEvent,
  resetLogSink,
  setLogSink,
  type LogEvent,
} from "@/lib/log";

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
    expect(lines[0]).not.toMatch(/"stop_reason"/);
  });

  // ── stop_reason field (ADR-0005 Amendment 2026-05-28; BACKLOG:28) ────────
  it("carries stop_reason when present — refusal terminal lands in the NDJSON line", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "claude",
      model: "claude-haiku-4-5-20251001",
      model_version: "2026-05-18",
      prompt_hash: "deadbeef",
      tokens: { input: 50, output: 0, total: 50 },
      latency_ms: 400,
      cost_usd: 0.0005,
      streaming: true,
      tool_iterations: 0,
      stop_reason: "refusal",
    });

    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(parsed.stop_reason).toBe("refusal");
    expect(parsed.streaming).toBe(true);
  });

  it("each terminal stop_reason serializes to the raw NDJSON line as-is — all six values", () => {
    // Pins the full union from ADR-0010 §1 Amendment 2026-05-28. A future
    // narrowing (e.g. dropping `max_turns` from the union) would surface
    // here as a TS error on the cases array — exactly the drift detector
    // ADR-0005 Amendment 2026-05-28 calls out via the `Extract<AgentEvent, ...>`
    // type re-use.
    const cases: Array<
      "end_turn" | "tool_use" | "max_tokens" | "max_iterations" | "max_turns" | "refusal"
    > = ["end_turn", "tool_use", "max_tokens", "max_iterations", "max_turns", "refusal"];
    for (const sr of cases) {
      const { lines, writer } = captureLog();
      setLogSink(writer);
      logEvent({
        kind: "claude",
        model: "claude-haiku-4-5-20251001",
        model_version: "2026-05-18",
        prompt_hash: "abc123",
        latency_ms: 10,
        cost_usd: null,
        streaming: true,
        stop_reason: sr,
      });
      expect(lines[0]).toMatch(new RegExp(`"stop_reason":"${sr}"`));
      resetLogSink();
    }
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

describe("logEvent — route variant (ADR-0005 amendment 2026-05-27)", () => {
  it("emits one NDJSON line with all required fields and omits LogEventBase shape", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "route",
      route: "POST /api/ingest",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: "boom",
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.kind).toBe("route");
    expect(parsed.route).toBe("POST /api/ingest");
    expect(parsed.latency_ms).toBe(0);
    expect(parsed.cost_usd).toBeNull();
    expect(parsed.status).toBe("error");
    expect(parsed.error).toBe("boom");
    expect(parsed.ts).toMatch(ISO_8601);
    // LogEventBase shape NOT carried — no vendor model invoked, nothing
    // to attribute. Same carve-out rationale as kind:"retrieval_pipeline".
    expect("model" in parsed).toBe(false);
    expect("model_version" in parsed).toBe(false);
    expect("prompt_hash" in parsed).toBe(false);
    expect("tokens" in parsed).toBe(false);
    expect("request_id" in parsed).toBe(false);
    // Assert on raw line — JSON.parse silently drops undefined-valued
    // keys; would miss a regression that wrote `model: undefined` into
    // the spread.
    expect(lines[0]).not.toMatch(/"model"/);
    expect(lines[0]).not.toMatch(/"model_version"/);
    expect(lines[0]).not.toMatch(/"prompt_hash"/);
  });

  it("omits optional fields (status, error) from the raw NDJSON line when absent", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "route",
      route: "POST /api/agent/ingest",
      latency_ms: 0,
      cost_usd: null,
    });

    expect(lines[0]).not.toMatch(/"status"/);
    expect(lines[0]).not.toMatch(/"error"/);
  });

  it("inherits the latency_ms guard (throws on NaN)", () => {
    expect(() =>
      logEvent({
        kind: "route",
        route: "POST /api/ingest",
        latency_ms: Number.NaN,
        cost_usd: null,
      }),
    ).toThrow(/finite non-negative number/);
  });

  it("inherits the cost_usd guard (throws on undefined-smuggled-as-any)", () => {
    expect(() =>
      logEvent({
        kind: "route",
        route: "POST /api/ingest",
        latency_ms: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cost_usd: undefined as any,
      }),
    ).toThrow(/cost_usd must be a number or null/);
  });

  it("inherits the error redact + truncate pipeline", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "route",
      route: "POST /api/ingest",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: "ORM blew up Authorization: Bearer sk-ant-XXXXXXXXXXXX",
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.error).not.toContain("sk-ant-XXXXXXXXXXXX");
    expect(parsed.error).toContain("[REDACTED]");
  });

  it("ts is helper-injected and not caller-overridable via structural cast", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    logEvent({
      kind: "route",
      route: "POST /api/ingest",
      latency_ms: 0,
      cost_usd: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ ts: "1970-01-01T00:00:00.000Z" } as any),
    });

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.ts).not.toBe("1970-01-01T00:00:00.000Z");
    expect(parsed.ts).toMatch(ISO_8601);
  });

  it("does not propagate sink errors into the caller", () => {
    setLogSink(() => {
      throw new Error("sink exploded");
    });

    expect(() =>
      logEvent({
        kind: "route",
        route: "POST /api/ingest",
        latency_ms: 0,
        cost_usd: null,
        status: "error",
        error: "boom",
      }),
    ).not.toThrow();
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

// ── Fixture-recording tee (ADR-0005 Amendment 2026-05-30; BACKLOG:94) ─────
//
// The tee is a no-op until enableFixtureRecording(path) is called. When
// enabled, every logEvent NDJSON line is also appended to `path` via
// fs.appendFileSync. Same redaction + serialization pipeline as the sink;
// fs errors swallowed (observability never breaks the API path).
describe("logEvent — fixture-recording tee", () => {
  let tmpDir: string;
  let fixturePath: string;

  function newFixturePath(): string {
    return join(tmpDir, `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
  }

  function readLines(p: string): string[] {
    return readFileSync(p, "utf8").split("\n").filter(Boolean);
  }

  function basicVoyageEvent(): LogEvent {
    return {
      kind: "voyage",
      model: "voyage-3-large",
      model_version: "1",
      latency_ms: 5,
      cost_usd: null,
    };
  }

  // Block-level afterEach — orthogonal to the file-level resetLogSink at
  // line 21-23. Disable runs FIRST (LIFO), then file cleanup.
  afterEach(() => {
    disableFixtureRecording();
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    vi.unstubAllEnvs();
  });

  // Set up the tmpdir BEFORE each test runs (the path is built per-test
  // inside each `it`; this just ensures the holding dir exists).
  function freshTmpDir(): void {
    tmpDir = mkdtempSync(join(tmpdir(), "log-fixture-test-"));
    fixturePath = newFixturePath();
  }

  it("appends the NDJSON line to the fixture file when enabled", () => {
    freshTmpDir();
    const { lines, writer } = captureLog();
    setLogSink(writer);
    enableFixtureRecording(fixturePath);

    logEvent(basicVoyageEvent());

    expect(lines).toHaveLength(1);
    const fileLines = readLines(fixturePath);
    expect(fileLines).toHaveLength(1);
    // Tee captures EXACTLY what the sink received — byte-for-byte equal.
    expect(fileLines[0] + "\n").toBe(lines[0]);
  });

  it("appends two lines for two events (append mode, not truncate)", () => {
    freshTmpDir();
    setLogSink(captureLog().writer);
    enableFixtureRecording(fixturePath);

    logEvent(basicVoyageEvent());
    logEvent({ ...basicVoyageEvent(), latency_ms: 7 });

    const fileLines = readLines(fixturePath);
    expect(fileLines).toHaveLength(2);
    // Second line carries the second event's latency.
    expect(fileLines[1]).toMatch(/"latency_ms":7/);
  });

  it("does NOT write to the file when never enabled — negative assertion", () => {
    freshTmpDir();
    setLogSink(captureLog().writer);

    logEvent(basicVoyageEvent());

    // File should not exist (enableFixtureRecording was never called).
    expect(() => readFileSync(fixturePath, "utf8")).toThrow();
  });

  it("disable stops subsequent writes; the file is unchanged after disable", () => {
    freshTmpDir();
    setLogSink(captureLog().writer);
    enableFixtureRecording(fixturePath);

    logEvent(basicVoyageEvent());
    const beforeDisable = readFileSync(fixturePath, "utf8");

    disableFixtureRecording();
    logEvent(basicVoyageEvent());

    const afterDisable = readFileSync(fixturePath, "utf8");
    expect(afterDisable).toBe(beforeDisable);
  });

  it("re-enable to a new path: old path receives no further writes", () => {
    freshTmpDir();
    const pathA = fixturePath;
    const pathB = newFixturePath();
    setLogSink(captureLog().writer);

    enableFixtureRecording(pathA);
    logEvent(basicVoyageEvent());
    const beforeReenable = readFileSync(pathA, "utf8");

    enableFixtureRecording(pathB);
    logEvent(basicVoyageEvent());

    expect(readFileSync(pathA, "utf8")).toBe(beforeReenable);
    expect(readLines(pathB)).toHaveLength(1);
  });

  it("composes with the default sink: stdout receives the line AND the file gets it", () => {
    freshTmpDir();
    // Do NOT install a capture sink — use defaultSink (process.stdout).
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      enableFixtureRecording(fixturePath);
      logEvent(basicVoyageEvent());
      expect(spy).toHaveBeenCalledTimes(1);
      expect(readLines(fixturePath)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("composes with setLogSink: the swapped sink fires AND the file gets the line", () => {
    freshTmpDir();
    const { lines, writer } = captureLog();
    setLogSink(writer);
    enableFixtureRecording(fixturePath);

    logEvent(basicVoyageEvent());

    expect(lines).toHaveLength(1);
    expect(readLines(fixturePath)).toHaveLength(1);
  });

  it("swallows fs errors — primary sink still receives its line when fixture path is unwritable", () => {
    // Deliberately skip freshTmpDir — the unwritable path is the point of
    // this test, and the file-level afterEach `if (tmpDir)` guard tolerates
    // an undefined tmpDir cleanly.
    const { lines, writer } = captureLog();
    setLogSink(writer);
    enableFixtureRecording("/nonexistent-dir-priorityKB-test/x.ndjson");

    expect(() => logEvent(basicVoyageEvent())).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it("tees the degraded line on JSON.stringify failure (recording fidelity)", () => {
    freshTmpDir();
    setLogSink(captureLog().writer);
    enableFixtureRecording(fixturePath);

    // Smuggle a circular structure via `as unknown` (the type contract
    // says `error?:string` but we deliberately bypass to drive the
    // stringify-failure branch at lib/log.ts:337-347).
    const circular: { self?: unknown } = {};
    circular.self = circular;
    logEvent({
      kind: "voyage",
      model: "voyage-3-large",
      model_version: "1",
      latency_ms: 1,
      cost_usd: null,
      error: circular as unknown as string,
    });

    const fileLines = readLines(fixturePath);
    expect(fileLines).toHaveLength(1);
    expect(fileLines[0]).toContain('"error":"log serialization failed"');
  });

  it("refuses to enable when NODE_ENV=production (foot-gun guard)", () => {
    freshTmpDir();
    vi.stubEnv("NODE_ENV", "production");

    expect(() => enableFixtureRecording(fixturePath)).toThrow(/refused in production/);
  });

  it("allows enable when NODE_ENV is any non-production value (test, dev, empty string)", () => {
    // Three non-prod cases. Empty string is what vi.stubEnv("","") yields
    // — close enough to "unset" for the guard's `=== "production"` check
    // without leaning on vitest's undefined-stubbing nuances.
    freshTmpDir();
    vi.stubEnv("NODE_ENV", "test");
    expect(() => enableFixtureRecording(fixturePath)).not.toThrow();

    disableFixtureRecording();
    vi.stubEnv("NODE_ENV", "development");
    expect(() => enableFixtureRecording(fixturePath)).not.toThrow();

    disableFixtureRecording();
    vi.stubEnv("NODE_ENV", "");
    expect(() => enableFixtureRecording(fixturePath)).not.toThrow();
  });
});
