import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RerankUnavailableError,
  STUB_RERANK_MODEL,
  STUB_RERANK_VERSION,
  STUB_SYNTH_MODEL,
  STUB_SYNTH_SENTINEL_UUID,
  STUB_SYNTH_VERSION,
  SynthUnavailableError,
  createStubReranker,
  createStubSynthesizer,
  getReranker,
  getSynthesizer,
  resetRerankerForTests,
  resetSynthesizerForTests,
  setRerankerForTests,
  setSynthesizerForTests,
} from "./retrieval";

afterEach(() => {
  resetRerankerForTests();
  resetSynthesizerForTests();
  delete process.env.RERANK_PROVIDER;
  delete process.env.SYNTH_PROVIDER;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("createStubReranker — deterministic ranking for #8-compliant tests", () => {
  it("exposes model + version as readonly contract properties", () => {
    const r = createStubReranker();
    expect(r.model).toBe(STUB_RERANK_MODEL);
    expect(r.version).toBe(STUB_RERANK_VERSION);
  });

  it("rerank() returns one entry per doc with valid index + [0,1) score", async () => {
    const r = createStubReranker();
    const docs = ["alpha", "beta", "gamma", "delta"];
    const result = await r.rerank("query", docs);
    expect(result.ranking.length).toBe(docs.length);
    const indices = result.ranking.map((x) => x.index);
    expect(new Set(indices).size).toBe(indices.length); // no duplicates
    for (const { index, score } of result.ranking) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(docs.length);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(1);
    }
    expect(result.tokens_used).toBe(0);
  });

  it("rerank() is byte-identical across two calls with the same inputs", async () => {
    const r = createStubReranker();
    const docs = ["one", "two", "three", "four", "five"];
    const a = await r.rerank("the query", docs);
    const b = await r.rerank("the query", docs);
    expect(b.ranking).toEqual(a.ranking);
    expect(b.tokens_used).toEqual(a.tokens_used);
  });

  it("rerank() sorts ranking descending by score; index breaks ties deterministically", async () => {
    const r = createStubReranker();
    const docs = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const result = await r.rerank("q", docs);
    for (let i = 1; i < result.ranking.length; i++) {
      const prev = result.ranking[i - 1]!;
      const cur = result.ranking[i]!;
      // descending by score, or equal score with ascending index
      const correctlyOrdered =
        prev.score > cur.score || (prev.score === cur.score && prev.index < cur.index);
      expect(correctlyOrdered).toBe(true);
    }
  });

  it("rerank() honors options.top_n by truncating the sorted ranking", async () => {
    const r = createStubReranker();
    const docs = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const full = await r.rerank("q", docs);
    const top3 = await r.rerank("q", docs, { top_n: 3 });
    expect(top3.ranking.length).toBe(3);
    expect(top3.ranking).toEqual(full.ranking.slice(0, 3));
  });

  it("rerank() with empty docs returns ranking:[] cleanly (no throw)", async () => {
    const r = createStubReranker();
    const result = await r.rerank("q", []);
    expect(result.ranking).toEqual([]);
    expect(result.tokens_used).toBe(0);
  });

  it("stub-mode discriminator is the model string, not the tokens_used value", async () => {
    const r = createStubReranker();
    const result = await r.rerank("q", ["only"]);
    // Production telemetry filters on `model.startsWith("stub-")` to skip stub
    // rows in token-sum aggregates; tokens_used=0 is also a real-world value.
    expect(r.model.startsWith("stub-")).toBe(true);
    expect(result.tokens_used).toBe(0);
  });
});

describe("createStubSynthesizer — deterministic answer for #8-compliant tests", () => {
  it("exposes model + version as readonly contract properties", () => {
    const s = createStubSynthesizer();
    expect(s.model).toBe(STUB_SYNTH_MODEL);
    expect(s.version).toBe(STUB_SYNTH_VERSION);
  });

  it("synthesize() returns answer with stub prefix + sentinel Sources block", async () => {
    const s = createStubSynthesizer();
    const result = await s.synthesize("system prompt", ["chunk a", "chunk b"]);
    expect(result.answer.startsWith("stub-answer: ")).toBe(true);
    expect(result.answer).toContain(`Sources: [${STUB_SYNTH_SENTINEL_UUID}]`);
    expect(result.tokens_in).toBe(0);
    expect(result.tokens_out).toBe(0);
  });

  it("synthesize() Sources block satisfies the ADR-0012 §5 format regex", async () => {
    const s = createStubSynthesizer();
    const result = await s.synthesize("p", ["c"]);
    // The §5 format regex: must match Sources:[<contents>] on its own trailing line.
    expect(result.answer).toMatch(/^Sources:\s*\[([^\]]*)\]\s*$/m);
    // And the bracket contents must be a non-empty list of UUID-shaped tokens.
    const m = result.answer.match(/^Sources:\s*\[([^\]]*)\]\s*$/m);
    expect(m).not.toBeNull();
    expect(m![1].trim().length).toBeGreaterThan(0);
  });

  it("synthesize() is byte-identical across two calls with the same inputs", async () => {
    const s = createStubSynthesizer();
    const a = await s.synthesize("prompt", ["c1", "c2"]);
    const b = await s.synthesize("prompt", ["c1", "c2"]);
    expect(b.answer).toBe(a.answer);
    expect(b.tokens_in).toBe(a.tokens_in);
    expect(b.tokens_out).toBe(a.tokens_out);
  });

  it("synthesize() with empty context returns cleanly with valid Sources block", async () => {
    const s = createStubSynthesizer();
    const result = await s.synthesize("p", []);
    expect(result.answer.startsWith("stub-answer: ")).toBe(true);
    expect(result.answer).toContain(`Sources: [${STUB_SYNTH_SENTINEL_UUID}]`);
  });

  it("stub-mode discriminator is the model string, not the tokens values", async () => {
    const s = createStubSynthesizer();
    const result = await s.synthesize("p", ["c"]);
    expect(s.model.startsWith("stub-")).toBe(true);
    expect(result.tokens_in).toBe(0);
    expect(result.tokens_out).toBe(0);
  });
});

describe("getReranker — env-driven singleton factory", () => {
  it("returns the stub when RERANK_PROVIDER is unset", () => {
    const r = getReranker();
    expect(r.model).toBe(STUB_RERANK_MODEL);
  });

  it('returns the stub when RERANK_PROVIDER="stub"', () => {
    process.env.RERANK_PROVIDER = "stub";
    const r = getReranker();
    expect(r.model).toBe(STUB_RERANK_MODEL);
  });

  it('throws RangeError naming VOYAGE_API_KEY when RERANK_PROVIDER="voyage" and key is absent', () => {
    process.env.RERANK_PROVIDER = "voyage";
    delete process.env.VOYAGE_API_KEY;
    let err: unknown;
    try {
      getReranker();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toMatch(/missing VOYAGE_API_KEY/);
    expect((err as Error).message).toMatch(/iron rule #1/i);
  });

  it('resolves the Voyage adapter when RERANK_PROVIDER="voyage" and VOYAGE_API_KEY is set', () => {
    process.env.RERANK_PROVIDER = "voyage";
    process.env.VOYAGE_API_KEY = "pa-test-key-not-real";
    try {
      const r = getReranker();
      expect(r.model).toBe("rerank-2");
      expect(r.version).toBe("v1");
    } finally {
      delete process.env.VOYAGE_API_KEY;
    }
  });

  it("throws RangeError naming the bad value when RERANK_PROVIDER is unknown", () => {
    process.env.RERANK_PROVIDER = "made-up-provider";
    let err: unknown;
    try {
      getReranker();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toContain("made-up-provider");
  });

  it("returns the same singleton instance across calls", () => {
    const a = getReranker();
    const b = getReranker();
    expect(b).toBe(a);
  });

  it("resetRerankerForTests() clears the singleton so the next call re-resolves env", () => {
    const a = getReranker();
    resetRerankerForTests();
    process.env.RERANK_PROVIDER = "voyage";
    // Explicit precondition: voyage branch without VOYAGE_API_KEY must
    // throw RangeError. Don't depend on test-order cleanup of a sibling
    // test's `finally` block.
    delete process.env.VOYAGE_API_KEY;
    expect(() => getReranker()).toThrow(RangeError);
    // sanity: also verify a fresh stub resolves after reset
    resetRerankerForTests();
    delete process.env.RERANK_PROVIDER;
    const b = getReranker();
    expect(b).not.toBe(a); // different instance after reset
    expect(b.model).toBe(STUB_RERANK_MODEL);
  });
});

describe("getSynthesizer — env-driven singleton factory", () => {
  it("returns the stub when SYNTH_PROVIDER is unset", () => {
    const s = getSynthesizer();
    expect(s.model).toBe(STUB_SYNTH_MODEL);
  });

  it('returns the stub when SYNTH_PROVIDER="stub"', () => {
    process.env.SYNTH_PROVIDER = "stub";
    const s = getSynthesizer();
    expect(s.model).toBe(STUB_SYNTH_MODEL);
  });

  it('throws RangeError naming ANTHROPIC_API_KEY when SYNTH_PROVIDER="anthropic" and key is absent', () => {
    process.env.SYNTH_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    let err: unknown;
    try {
      getSynthesizer();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toMatch(/missing ANTHROPIC_API_KEY/);
    expect((err as Error).message).toMatch(/iron rule #1/i);
  });

  it('resolves the Anthropic adapter when SYNTH_PROVIDER="anthropic" and ANTHROPIC_API_KEY is set', () => {
    process.env.SYNTH_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-not-real";
    try {
      const s = getSynthesizer();
      expect(s.model).toBe("claude-sonnet-4-6");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("throws RangeError naming the bad value when SYNTH_PROVIDER is unknown", () => {
    process.env.SYNTH_PROVIDER = "made-up-synth";
    let err: unknown;
    try {
      getSynthesizer();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toContain("made-up-synth");
  });

  it("returns the same singleton instance across calls", () => {
    const a = getSynthesizer();
    const b = getSynthesizer();
    expect(b).toBe(a);
  });

  it("resetSynthesizerForTests() clears the singleton so the next call re-resolves env", () => {
    const a = getSynthesizer();
    resetSynthesizerForTests();
    process.env.SYNTH_PROVIDER = "anthropic";
    expect(() => getSynthesizer()).toThrow(RangeError);
    resetSynthesizerForTests();
    delete process.env.SYNTH_PROVIDER;
    const b = getSynthesizer();
    expect(b).not.toBe(a);
    expect(b.model).toBe(STUB_SYNTH_MODEL);
  });

  it("setRerankerForTests() injects a reranker that getReranker returns identity-equal", () => {
    // Parallel to setSynthesizerForTests. The orchestrator slice (2c-ii)
    // needs to inject a typed-error-throwing reranker into the singleton
    // slot to drive the rerank-down matrix rows without touching env vars.
    const injected = createStubReranker();
    setRerankerForTests(injected);
    expect(getReranker()).toBe(injected);
    // resetRerankerForTests in afterEach clears the slot.
  });

  it("setSynthesizerForTests() injects a synthesizer that getSynthesizer returns identity-equal", () => {
    // Pin the symmetric setter's contract — the orchestrator slice will
    // drive synth-down rows the same way.
    const injected = createStubSynthesizer();
    setSynthesizerForTests(injected);
    expect(getSynthesizer()).toBe(injected);
  });
});

describe("RerankUnavailableError + SynthUnavailableError — typed for iron-rule-#12 instanceof checks", () => {
  it("RerankUnavailableError sets the right name and preserves cause", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new RerankUnavailableError("rerank upstream down", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RerankUnavailableError");
    expect(err.cause).toBe(cause);
  });

  it("SynthUnavailableError sets the right name and preserves cause", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new SynthUnavailableError("synth upstream down", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SynthUnavailableError");
    expect(err.cause).toBe(cause);
  });
});

describe("non-negotiable #8 — no live API client imports in lib/retrieval.ts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "retrieval.ts"), "utf8");

  it("source file imports no voyage / anthropic / openai / cohere / google client modules", () => {
    // Per ADR-0008 §9, this is a single-layer scan — the heavier transitive
    // floor lands at M2a. lib/embedding.test.ts:161-175 set the precedent.
    expect(src).not.toMatch(/from\s+["']voyage(ai)?["']/);
    expect(src).not.toMatch(/from\s+["']@anthropic[/-]/);
    expect(src).not.toMatch(/from\s+["']openai["']/);
    expect(src).not.toMatch(/from\s+["']cohere-ai["']/);
    expect(src).not.toMatch(/from\s+["']@google\/generative-ai["']/);
    // Coarser blanket guards for dynamic / type-only imports the regexes above miss.
    expect(src).not.toMatch(/voyageai/);
    expect(src).not.toMatch(/@anthropic-ai/);
    expect(src).not.toMatch(/cohere-ai/);
    expect(src).not.toMatch(/@google\/generative-ai/);
  });

  it("positive control: the regex set WOULD catch a synthetic voyageai import", () => {
    // Guards against regex-rot: if a future edit accidentally weakens the
    // pattern, the negative-assertion above would silently pass on an empty
    // file. This positive control proves the regex is the one that triggers.
    const synthetic = `import { Client } from "voyageai";\n`;
    expect(synthetic).toMatch(/from\s+["']voyage(ai)?["']/);
    expect(synthetic).toMatch(/voyageai/);
  });

  it("positive control: the regex set WOULD catch a synthetic @anthropic-ai/sdk import", () => {
    const synthetic = `import Anthropic from "@anthropic-ai/sdk";\n`;
    expect(synthetic).toMatch(/from\s+["']@anthropic[/-]/);
    expect(synthetic).toMatch(/@anthropic-ai/);
  });

  it("positive control: the regex set WOULD catch a synthetic openai import", () => {
    const synthetic = `import OpenAI from "openai";\n`;
    expect(synthetic).toMatch(/from\s+["']openai["']/);
  });

  it("positive control: the regex set WOULD catch a synthetic cohere-ai import", () => {
    const synthetic = `import { CohereClient } from "cohere-ai";\n`;
    expect(synthetic).toMatch(/from\s+["']cohere-ai["']/);
    expect(synthetic).toMatch(/cohere-ai/);
  });
});
