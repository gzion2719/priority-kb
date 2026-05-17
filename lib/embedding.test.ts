import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EmbeddingUnavailableError,
  STUB_DIMENSIONS,
  STUB_MODEL,
  STUB_VERSION,
  createStubEmbedder,
  getEmbedder,
  resetEmbedderForTests,
} from "./embedding";

afterEach(() => {
  resetEmbedderForTests();
  delete process.env.EMBEDDING_PROVIDER;
});

describe("createStubEmbedder — deterministic stub for #8-compliant tests", () => {
  it("exposes dimensions, model, version as readonly contract properties", () => {
    const e = createStubEmbedder();
    expect(e.dimensions).toBe(STUB_DIMENSIONS);
    expect(e.model).toBe(STUB_MODEL);
    expect(e.version).toBe(STUB_VERSION);
  });

  it("embed() returns a 1024-length vector carrying model + version + tokens_used", async () => {
    const e = createStubEmbedder();
    const r = await e.embed("hello");
    expect(r.vector).toHaveLength(STUB_DIMENSIONS);
    expect(r.model).toBe(STUB_MODEL);
    expect(r.version).toBe(STUB_VERSION);
    expect(r.tokens_used).toBe(0);
  });

  it("stub vector values lie strictly in [-1, 1] (mapping-math regression guard)", async () => {
    const e = createStubEmbedder();
    const r = await e.embed("range check across SHA-256 byte distribution");
    for (const v of r.vector) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic across calls for identical ASCII input", async () => {
    const e = createStubEmbedder();
    const a = await e.embed("priority order entry");
    const b = await e.embed("priority order entry");
    expect(a.vector).toEqual(b.vector);
  });

  it("is deterministic across calls for identical Hebrew (multi-byte UTF-8) input", async () => {
    const e = createStubEmbedder();
    const a = await e.embed("הזמנת רכש — שגיאת אימות");
    const b = await e.embed("הזמנת רכש — שגיאת אימות");
    expect(a.vector).toEqual(b.vector);
  });

  it("produces different vectors for different inputs", async () => {
    const e = createStubEmbedder();
    const a = await e.embed("alpha");
    const b = await e.embed("beta");
    expect(a.vector).not.toEqual(b.vector);
  });

  it("embedBatch returns a batch result with one vector per input and aggregate model/version/tokens_used", async () => {
    const e = createStubEmbedder();
    const r = await e.embedBatch(["one", "two", "three"]);
    expect(r.vectors).toHaveLength(3);
    expect(r.vectors[0]).toHaveLength(STUB_DIMENSIONS);
    expect(r.model).toBe(STUB_MODEL);
    expect(r.version).toBe(STUB_VERSION);
    expect(r.tokens_used).toBe(0);
  });

  it("embedBatch preserves input order (vectors[i] corresponds to texts[i])", async () => {
    const e = createStubEmbedder();
    const inputs = ["alpha", "beta", "gamma", "delta"];
    const batch = await e.embedBatch(inputs);
    for (let i = 0; i < inputs.length; i++) {
      const single = await e.embed(inputs[i]);
      expect(batch.vectors[i]).toEqual(single.vector);
    }
  });

  it("embedBatch with empty array returns zero vectors but still carries model/version/tokens_used", async () => {
    const e = createStubEmbedder();
    const r = await e.embedBatch([]);
    expect(r.vectors).toEqual([]);
    expect(r.model).toBe(STUB_MODEL);
    expect(r.tokens_used).toBe(0);
  });

  it("embed and embedBatch agree on the vector for the same input", async () => {
    const e = createStubEmbedder();
    const single = await e.embed("same");
    const batch = await e.embedBatch(["same"]);
    expect(single.vector).toEqual(batch.vectors[0]);
  });
});

describe("getEmbedder — env-driven factory", () => {
  it("returns the stub when EMBEDDING_PROVIDER is unset", () => {
    expect(getEmbedder().model).toBe(STUB_MODEL);
  });

  it("returns the stub when EMBEDDING_PROVIDER=stub", () => {
    process.env.EMBEDDING_PROVIDER = "stub";
    expect(getEmbedder().model).toBe(STUB_MODEL);
  });

  it("throws RangeError when EMBEDDING_PROVIDER=voyage (adapter ships with M2a)", () => {
    process.env.EMBEDDING_PROVIDER = "voyage";
    expect(() => getEmbedder()).toThrow(RangeError);
    expect(() => getEmbedder()).toThrow(/M2a/);
  });

  it("throws RangeError for an unknown provider — fail-loud, no silent fallback", () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    expect(() => getEmbedder()).toThrow(RangeError);
    expect(() => getEmbedder()).toThrow(/unknown EMBEDDING_PROVIDER/);
  });

  it("caches the embedder across calls (singleton)", () => {
    const a = getEmbedder();
    const b = getEmbedder();
    expect(a).toBe(b);
  });

  it("resetEmbedderForTests() re-evaluates the provider on next call", () => {
    process.env.EMBEDDING_PROVIDER = "stub";
    const first = getEmbedder();
    resetEmbedderForTests();
    process.env.EMBEDDING_PROVIDER = "voyage";
    expect(() => getEmbedder()).toThrow(/M2a/);
    resetEmbedderForTests();
    delete process.env.EMBEDDING_PROVIDER;
    const third = getEmbedder();
    expect(third).not.toBe(first);
  });
});

describe("EmbeddingUnavailableError", () => {
  it("is an instanceof Error with a stable name", () => {
    const err = new EmbeddingUnavailableError("voyage 503");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EmbeddingUnavailableError");
  });

  it("preserves a cause for retrieval-side logging", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new EmbeddingUnavailableError("upstream down", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("non-negotiable #8 — no live API client imports in lib/embedding.ts", () => {
  it("source file imports no voyage/anthropic client modules", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "embedding.ts"), "utf8");
    // No `import ... from "voyageai"`, `from "@anthropic-ai/..."`, etc. The
    // mechanical-floor proper for #8 lands with M2a per ADR-0008 §9; this is
    // the M1 stop-gap that keeps the stub honest.
    expect(src).not.toMatch(/from\s+["']voyage(ai)?["']/);
    expect(src).not.toMatch(/from\s+["']@anthropic[/-]/);
    expect(src).not.toMatch(/from\s+["']openai["']/);
    // Coarser blanket guard for dynamic / type-only imports the regex above misses.
    expect(src).not.toMatch(/voyageai/);
    expect(src).not.toMatch(/@anthropic-ai/);
  });
});
