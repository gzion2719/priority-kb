// lib/retrieval-voyage-rerank.test.ts — Voyage rerank-2 adapter unit tests.
//
// All tests inject `fetchImpl` — no live API calls (iron rule #8). The
// "default-fetch path" test verifies the adapter uses `globalThis.fetch`
// when no `fetchImpl` is provided, without actually hitting Voyage (the
// global fetch is spied + rejected to prove the wire-up, not exercise it).

import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  VOYAGE_RERANK_API_VERSION,
  VOYAGE_RERANK_MODEL,
  createVoyageReranker,
} from "@/lib/retrieval-voyage-rerank";
import { RerankUnavailableError } from "@/lib/retrieval";

const API_KEY = "pa-test-key-not-real";
const URL = "https://api.voyageai.com/v1/rerank";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function happyBody() {
  return {
    data: [
      { index: 2, relevance_score: 0.91 },
      { index: 0, relevance_score: 0.72 },
      { index: 1, relevance_score: 0.55 },
    ],
    model: "rerank-2",
    usage: { total_tokens: 1234 },
  };
}

describe("createVoyageReranker — happy path", () => {
  it("returns ranking + tokens_used from a 200 response", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse(happyBody()),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });

    const result = await reranker.rerank("how do refunds work", ["a", "b", "c"]);

    expect(result).toEqual({
      ranking: [
        { index: 2, score: 0.91 },
        { index: 0, score: 0.72 },
        { index: 1, score: 0.55 },
      ],
      tokens_used: 1234,
    });
  });

  it("propagates Voyage's usage.total_tokens verbatim (billing-authoritative)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ...happyBody(), usage: { total_tokens: 9999 } }),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    const result = await reranker.rerank("q", ["x", "y", "z"]);
    expect(result.tokens_used).toBe(9999);
  });

  it("exposes model + version constants", () => {
    expect(VOYAGE_RERANK_MODEL).toBe("rerank-2");
    expect(VOYAGE_RERANK_API_VERSION).toBe("v1");
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl: vi.fn() });
    expect(reranker.model).toBe("rerank-2");
    expect(reranker.version).toBe("v1");
  });
});

describe("createVoyageReranker — request shape (pinned)", () => {
  it("posts EXACTLY {query, documents, model, return_documents} when no top_n", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse(happyBody()),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await reranker.rerank("the query", ["doc a", "doc b", "doc c"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(init?.method).toBe("POST");
    // EXACT-keys body via toEqual — a future bug that added a stray field
    // (e.g. temperature: 1.5) would fail here. NOT toMatchObject.
    const parsed = JSON.parse(init!.body as string);
    expect(parsed).toEqual({
      query: "the query",
      documents: ["doc a", "doc b", "doc c"],
      model: "rerank-2",
      return_documents: false,
    });
  });

  it("includes top_k when top_n option is provided", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse(happyBody()),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await reranker.rerank("q", ["a", "b", "c"], { top_n: 5 });

    const init = fetchImpl.mock.calls[0]![1]!;
    const parsed = JSON.parse(init.body as string);
    expect(parsed).toEqual({
      query: "q",
      documents: ["a", "b", "c"],
      model: "rerank-2",
      return_documents: false,
      top_k: 5,
    });
  });

  it("sends Authorization: Bearer <apiKey> and Content-Type: application/json", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse(happyBody()),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await reranker.rerank("q", ["a", "b", "c"]);

    const init = fetchImpl.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("posts to exactly https://api.voyageai.com/v1/rerank", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse(happyBody()),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await reranker.rerank("q", ["a", "b", "c"]);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.voyageai.com/v1/rerank");
  });
});

describe("createVoyageReranker — empty docs short-circuit", () => {
  it("returns {ranking: [], tokens_used: 0} without calling fetch", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse(happyBody()),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });

    const result = await reranker.rerank("q", []);

    expect(result).toEqual({ ranking: [], tokens_used: 0 });
    // Negative-assertion: distinguishes the short-circuit from a path that
    // calls fetch and gets an empty-ranking response by coincidence.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createVoyageReranker — error mapping (transient → unavailable)", () => {
  it("maps 500 to RerankUnavailableError", async () => {
    const fetchImpl = vi.fn(async () => textResponse("internal error", 500));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await expect(reranker.rerank("q", ["a"])).rejects.toBeInstanceOf(RerankUnavailableError);
  });

  it("maps 502 to RerankUnavailableError", async () => {
    const fetchImpl = vi.fn(async () => textResponse("bad gateway", 502));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await expect(reranker.rerank("q", ["a"])).rejects.toBeInstanceOf(RerankUnavailableError);
  });

  it("maps 503 to RerankUnavailableError", async () => {
    const fetchImpl = vi.fn(async () => textResponse("unavailable", 503));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await expect(reranker.rerank("q", ["a"])).rejects.toBeInstanceOf(RerankUnavailableError);
  });

  it("maps 408 Request Timeout to RerankUnavailableError (edge-proxy idle timeout)", async () => {
    const fetchImpl = vi.fn(async () => textResponse("timeout", 408));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await expect(reranker.rerank("q", ["a"])).rejects.toBeInstanceOf(RerankUnavailableError);
  });

  it("maps 429 Too Many Requests to RerankUnavailableError", async () => {
    const fetchImpl = vi.fn(async () => textResponse("rate limited", 429));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await expect(reranker.rerank("q", ["a"])).rejects.toBeInstanceOf(RerankUnavailableError);
  });

  it("maps fetch network error (TypeError) to RerankUnavailableError, preserving cause", async () => {
    const networkErr = new TypeError("fetch failed");
    const fetchImpl = vi.fn(async () => {
      throw networkErr;
    });
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    try {
      await reranker.rerank("q", ["a"]);
      throw new Error("expected RerankUnavailableError, got resolution");
    } catch (err) {
      expect(err).toBeInstanceOf(RerankUnavailableError);
      expect((err as { cause?: unknown }).cause).toBe(networkErr);
    }
  });

  it("maps JSON-parse failure on a 5xx response to RerankUnavailableError (inherits status bucket)", async () => {
    // Simulate an edge proxy returning HTML on a 502 — body isn't JSON.
    // Status branch fires first, so we never reach response.json().
    const fetchImpl = vi.fn(async () => textResponse("<html>bad gateway</html>", 502));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await expect(reranker.rerank("q", ["a"])).rejects.toBeInstanceOf(RerankUnavailableError);
  });
});

describe("createVoyageReranker — error mapping (config / loud rethrow)", () => {
  it("rethrows 401 as a loud Error (NOT RerankUnavailableError)", async () => {
    const fetchImpl = vi.fn(async () => textResponse("invalid api key", 401));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    try {
      await reranker.rerank("q", ["a"]);
      throw new Error("expected throw, got resolution");
    } catch (err) {
      // Positive assertions per WORKFLOW.md negative-assertion sub-rule.
      // `.not.toBeInstanceOf(RerankUnavailableError)` alone would silently
      // pass if a future bug mapped 401 to a new "RerankConfigError" class.
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RerankUnavailableError);
      const e = err as Error & { status?: number };
      expect(e.status).toBe(401);
      expect(e.message).toMatch(/voyage rerank 401/i);
      expect(e.message).toMatch(/invalid api key/i);
    }
  });

  it("rethrows 400 as a loud Error with status field", async () => {
    const fetchImpl = vi.fn(async () => textResponse("bad request", 400));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    try {
      await reranker.rerank("q", ["a"]);
      throw new Error("expected throw, got resolution");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RerankUnavailableError);
      expect((err as Error & { status?: number }).status).toBe(400);
    }
  });

  it("rethrows 403 as a loud Error", async () => {
    const fetchImpl = vi.fn(async () => textResponse("forbidden", 403));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    try {
      await reranker.rerank("q", ["a"]);
      throw new Error("expected throw, got resolution");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RerankUnavailableError);
      expect((err as Error & { status?: number }).status).toBe(403);
    }
  });
});

describe("createVoyageReranker — malformed response (loud)", () => {
  it("throws loud Error when .data is missing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ model: "rerank-2", usage: { total_tokens: 1 } }),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    try {
      await reranker.rerank("q", ["a"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RerankUnavailableError);
      expect((err as Error).message).toMatch(/missing \.data/);
    }
  });

  it("throws loud Error when .usage.total_tokens is missing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, relevance_score: 0.5 }], model: "rerank-2" }),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await expect(reranker.rerank("q", ["a"])).rejects.toThrow(/total_tokens/);
  });

  it("throws loud Error when a data row is missing index/relevance_score", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ index: 0 } as unknown as { index: number; relevance_score: number }],
        model: "rerank-2",
        usage: { total_tokens: 1 },
      }),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await expect(reranker.rerank("q", ["a"])).rejects.toThrow(/data\[0\]/);
  });

  it("throws loud Error when data.length > docs.length (Voyage returned extras)", async () => {
    // Asks for rerank of 2 docs; Voyage returns 3 rows. Silently passing
    // this through would widen the candidate set beyond the input. Loud.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 0, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.8 },
          { index: 0, relevance_score: 0.7 },
        ],
        model: "rerank-2",
        usage: { total_tokens: 5 },
      }),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    try {
      await reranker.rerank("q", ["a", "b"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RerankUnavailableError);
      expect((err as Error).message).toMatch(/data\.length=3 > docs\.length=2/);
    }
  });

  it("throws loud Error when row.index is out of [0, docs.length) range", async () => {
    // 3 docs sent, response references index=99. Downstream docs[99]
    // would be undefined; throw loud at the boundary.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ index: 99, relevance_score: 0.5 }],
        model: "rerank-2",
        usage: { total_tokens: 5 },
      }),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    try {
      await reranker.rerank("q", ["a", "b", "c"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RerankUnavailableError);
      expect((err as Error).message).toMatch(/data\[0\]\.index=99 out of range \[0, 3\)/);
    }
  });

  it("throws loud Error when row.index is negative", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ index: -1, relevance_score: 0.5 }],
        model: "rerank-2",
        usage: { total_tokens: 5 },
      }),
    );
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    await expect(reranker.rerank("q", ["a", "b"])).rejects.toThrow(/index=-1 out of range/);
  });

  it("throws loud Error when JSON parse fails on a 200 response", async () => {
    // 200 OK with HTML body — status-branch lets us through, parse fails.
    const fetchImpl = vi.fn(async () => textResponse("<html>not json</html>", 200));
    const reranker = createVoyageReranker({ apiKey: API_KEY, fetchImpl });
    try {
      await reranker.rerank("q", ["a"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RerankUnavailableError);
      expect((err as Error).message).toMatch(/malformed response.*JSON parse/i);
    }
  });
});

describe("createVoyageReranker — construction-time guards", () => {
  it("throws RangeError when apiKey is empty string (mirror of factory iron-rule-#1 floor)", () => {
    expect(() => createVoyageReranker({ apiKey: "" })).toThrow(RangeError);
  });

  it("throws RangeError when apiKey is missing (defensive — should never reach via the factory)", () => {
    expect(() => createVoyageReranker({ apiKey: undefined as unknown as string })).toThrow(
      RangeError,
    );
  });
});

describe("createVoyageReranker — default fetchImpl wiring", () => {
  it("uses globalThis.fetch when no fetchImpl is provided", async () => {
    // Spy on global fetch and reject — proves the adapter wires to it
    // without actually hitting Voyage. After the test, restore.
    const realFetch = globalThis.fetch;
    const spy = vi.fn(async () => {
      throw new TypeError("global fetch reached");
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const reranker = createVoyageReranker({ apiKey: API_KEY });
      await expect(reranker.rerank("q", ["a"])).rejects.toBeInstanceOf(RerankUnavailableError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("createVoyageReranker — source-file mechanical floors", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "retrieval-voyage-rerank.ts"), "utf8");

  it("source file reads no process.env (env-truth lives at the factory)", () => {
    // Mirrors the agents-anthropic floor: the adapter must accept apiKey
    // via constructor injection, not read process.env directly. This keeps
    // the env-boundary single-sourced at lib/retrieval.ts.
    expect(src).not.toMatch(/process\.env/);
  });

  it("source file imports no SDK (iron rule #8: voyageai/openai/cohere/google/anthropic)", () => {
    expect(src).not.toMatch(/from\s+["']voyage(ai)?["']/);
    expect(src).not.toMatch(/from\s+["']@anthropic[/-]/);
    expect(src).not.toMatch(/from\s+["']openai["']/);
    expect(src).not.toMatch(/from\s+["']cohere-ai["']/);
    expect(src).not.toMatch(/from\s+["']@google\/generative-ai["']/);
  });

  it("positive control: regex would catch a synthetic process.env read", () => {
    const synthetic = `const k = process.env.VOYAGE_API_KEY;`;
    expect(synthetic).toMatch(/process\.env/);
  });

  it("positive control: regex would catch a synthetic voyageai SDK import", () => {
    const synthetic = `import { Client } from "voyageai";`;
    expect(synthetic).toMatch(/from\s+["']voyage(ai)?["']/);
  });
});
