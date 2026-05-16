import { afterEach, describe, expect, it, vi } from "vitest";

import { logEvent, resetLogSink, setLogSink, type LogEvent } from "@/lib/log";

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
  it("preserves cost_usd: 0 (not dropped as falsy)", () => {
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
});

describe("logEvent — sequence", () => {
  it("two calls produce two separate writes with monotonic timestamps", () => {
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
  it("truncates error strings longer than 500 chars", () => {
    const { lines, writer } = captureLog();
    setLogSink(writer);

    const longError = "x".repeat(2000);
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
    expect(parsed.error).toHaveLength(500);
    expect(parsed.error).toBe("x".repeat(500));
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
    ).toThrow(/finite number/);
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
    ).toThrow(/finite number/);
  });
});

describe("logEvent — sink injection", () => {
  it("resetLogSink restores the default stdout writer", () => {
    const { writer } = captureLog();
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
    } finally {
      spy.mockRestore();
    }
  });
});
