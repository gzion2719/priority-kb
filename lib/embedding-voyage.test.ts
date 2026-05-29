// lib/embedding-voyage.test.ts — Voyage voyage-3-large embedder unit tests.
//
// All tests inject `fetchImpl` — no live API calls (iron rule #8). The
// "default-fetch path" test verifies the adapter uses `globalThis.fetch` when
// no `fetchImpl` is provided, without actually hitting Voyage (global fetch is
// spied + rejected to prove the wire-up, not exercise it). Mirrors the sibling
// lib/retrieval-voyage-rerank.test.ts deliberately.

import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  VOYAGE_EMBED_API_VERSION,
  VOYAGE_EMBED_DIMENSIONS,
  VOYAGE_EMBED_MODEL,
  createVoyageEmbedder,
} from "@/lib/embedding-voyage";
import { EmbeddingUnavailableError, STUB_DIMENSIONS } from "@/lib/embedding";

const API_KEY = "pa-test-key-not-real";
const URL = "https://api.voyageai.com/v1/embeddings";
const DIM = VOYAGE_EMBED_DIMENSIONS;

function vec(fill: number): number[] {
  return new Array<number>(DIM).fill(fill);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain" } });
}

/** Happy body for N inputs, vectors filled with distinct values, in order. */
function happyBody(n: number, totalTokens = 1234) {
  return {
    object: "list",
    data: Array.from({ length: n }, (_, i) => ({
      object: "embedding",
      embedding: vec(i / 10),
      index: i,
    })),
    model: "voyage-3-large",
    usage: { total_tokens: totalTokens },
  };
}

describe("createVoyageEmbedder — happy path", () => {
  it("returns vectors + model + version + tokens_used from a 200 response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(happyBody(2)));
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });

    const result = await embedder.embedBatch(["a", "b"]);

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toEqual(vec(0));
    expect(result.vectors[1]).toEqual(vec(0.1));
    expect(result.model).toBe("voyage-3-large");
    expect(result.version).toBe("v1");
    expect(result.tokens_used).toBe(1234);
  });

  it("reorders vectors by .index (does not trust positional order)", async () => {
    // Voyage returns rows out of order; vectors[i] must map to input[i].
    const body = {
      object: "list",
      data: [
        { object: "embedding", embedding: vec(0.2), index: 2 },
        { object: "embedding", embedding: vec(0.0), index: 0 },
        { object: "embedding", embedding: vec(0.1), index: 1 },
      ],
      model: "voyage-3-large",
      usage: { total_tokens: 7 },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });

    const result = await embedder.embedBatch(["x", "y", "z"]);

    expect(result.vectors[0]).toEqual(vec(0.0));
    expect(result.vectors[1]).toEqual(vec(0.1));
    expect(result.vectors[2]).toEqual(vec(0.2));
  });

  it("embed() is sugar over embedBatch([text]) — single vector", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(happyBody(1, 42)));
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });

    const result = await embedder.embed("hello");

    expect(result.vector).toEqual(vec(0));
    expect(result.tokens_used).toBe(42);
    expect(result.model).toBe("voyage-3-large");
  });

  it("exposes model + version + dimensions constants", () => {
    expect(VOYAGE_EMBED_MODEL).toBe("voyage-3-large");
    expect(VOYAGE_EMBED_API_VERSION).toBe("v1");
    expect(VOYAGE_EMBED_DIMENSIONS).toBe(1024);
    // Single-source pin: the literal in the adapter MUST equal STUB_DIMENSIONS
    // (the adapter can't reference it directly — import-cycle TDZ).
    expect(VOYAGE_EMBED_DIMENSIONS).toBe(STUB_DIMENSIONS);
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl: vi.fn() });
    expect(embedder.model).toBe("voyage-3-large");
    expect(embedder.version).toBe("v1");
    expect(embedder.dimensions).toBe(1024);
  });
});

describe("createVoyageEmbedder — request shape (pinned)", () => {
  it("posts EXACTLY {input, model, input_type, output_dimension} defaulting input_type=document", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse(happyBody(2)),
    );
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await embedder.embedBatch(["doc a", "doc b"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    // EXACT-keys body via toEqual — a stray field would fail here.
    const parsed = JSON.parse(init!.body as string);
    expect(parsed).toEqual({
      input: ["doc a", "doc b"],
      model: "voyage-3-large",
      input_type: "document",
      output_dimension: 1024,
    });
  });

  it("passes input_type=query through when the option is provided (asymmetric mode)", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse(happyBody(1)),
    );
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await embedder.embed("the query", { input_type: "query" });

    const init = fetchImpl.mock.calls[0]![1]!;
    const parsed = JSON.parse(init.body as string);
    expect(parsed.input_type).toBe("query");
    expect(parsed.input).toEqual(["the query"]);
  });
});

describe("createVoyageEmbedder — empty input short-circuit", () => {
  it("returns empty vectors without an HTTP call or token spend", async () => {
    const fetchImpl = vi.fn();
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });

    const result = await embedder.embedBatch([]);

    expect(result).toEqual({
      vectors: [],
      model: "voyage-3-large",
      version: "v1",
      tokens_used: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createVoyageEmbedder — error mapping (transient → EmbeddingUnavailableError)", () => {
  it.each([500, 502, 503, 429, 408])(
    "maps status %i to EmbeddingUnavailableError",
    async (status) => {
      const fetchImpl = vi.fn(async () => textResponse("upstream down", status));
      const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
      await expect(embedder.embedBatch(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    },
  );

  it("maps a network error (fetch throws) to EmbeddingUnavailableError with cause", async () => {
    const cause = new TypeError("fetch failed");
    const fetchImpl = vi.fn(async () => {
      throw cause;
    });
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await expect(embedder.embedBatch(["a"])).rejects.toMatchObject({
      name: "EmbeddingUnavailableError",
      cause,
    });
  });

  it("maps a 5xx that returns non-JSON (html) to EmbeddingUnavailableError, not a loud parse error", async () => {
    const fetchImpl = vi.fn(async () => textResponse("<html>502 Bad Gateway</html>", 502));
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await expect(embedder.embedBatch(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });
});

describe("createVoyageEmbedder — error mapping (config / loud rethrow)", () => {
  it.each([400, 401, 403, 404, 422])(
    "rethrows status %i loudly (NOT degradable)",
    async (status) => {
      const fetchImpl = vi.fn(async () => textResponse(`error ${status}`, status));
      const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
      const err = await embedder.embedBatch(["a"]).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
      expect((err as Error).message).toContain(String(status));
      // The numeric .status is attached for consumers that branch on it.
      expect((err as Error & { status?: number }).status).toBe(status);
    },
  );
});

describe("createVoyageEmbedder — malformed response (loud)", () => {
  it("throws on JSON parse failure for a 200", async () => {
    const fetchImpl = vi.fn(async () => textResponse("not json", 200));
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await expect(embedder.embedBatch(["a"])).rejects.toThrow(/malformed response/);
  });

  it("throws when .data is missing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ model: "voyage-3-large", usage: { total_tokens: 1 } }),
    );
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await expect(embedder.embedBatch(["a"])).rejects.toThrow(/missing \.data/);
  });

  it("throws when .usage.total_tokens is missing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: vec(0), index: 0 }], model: "voyage-3-large" }),
    );
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await expect(embedder.embedBatch(["a"])).rejects.toThrow(/usage\.total_tokens/);
  });

  it("throws when data.length != input.length (silent misalignment guard)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(happyBody(1)));
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await expect(embedder.embedBatch(["a", "b"])).rejects.toThrow(
      /data\.length=1 != input\.length=2/,
    );
  });

  it("throws when a returned vector length != 1024 (vector(1024) insert guard)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: "voyage-3-large",
        usage: { total_tokens: 1 },
      }),
    );
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await expect(embedder.embedBatch(["a"])).rejects.toThrow(/length=3 != 1024/);
  });

  it("throws when a row index is out of range", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ embedding: vec(0), index: 5 }],
        model: "voyage-3-large",
        usage: { total_tokens: 1 },
      }),
    );
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await expect(embedder.embedBatch(["a"])).rejects.toThrow(/out of range/);
  });

  it("throws on a duplicate index (which would leave a hole in vectors[])", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { embedding: vec(0), index: 0 },
          { embedding: vec(1), index: 0 },
        ],
        model: "voyage-3-large",
        usage: { total_tokens: 1 },
      }),
    );
    const embedder = createVoyageEmbedder({ apiKey: API_KEY, fetchImpl });
    await expect(embedder.embedBatch(["a", "b"])).rejects.toThrow(/duplicate index/);
  });
});

describe("createVoyageEmbedder — construction-time guards", () => {
  it("throws RangeError on empty apiKey", () => {
    expect(() => createVoyageEmbedder({ apiKey: "", fetchImpl: vi.fn() })).toThrow(RangeError);
  });

  it("throws RangeError on non-string apiKey", () => {
    // @ts-expect-error — deliberately wrong type to exercise the guard.
    expect(() => createVoyageEmbedder({ apiKey: undefined, fetchImpl: vi.fn() })).toThrow(
      RangeError,
    );
  });
});

describe("createVoyageEmbedder — default fetchImpl wiring", () => {
  it("uses globalThis.fetch when no fetchImpl is injected", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("boom"));
    try {
      const embedder = createVoyageEmbedder({ apiKey: API_KEY });
      await expect(embedder.embedBatch(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createVoyageEmbedder — source-file mechanical floors", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "embedding-voyage.ts"), "utf8");

  it("source file reads no process.env (env-truth lives at the factory)", () => {
    expect(src).not.toMatch(/process\.env/);
  });

  it("source file imports no SDK (iron rule #8: voyageai/openai/anthropic/cohere/google)", () => {
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
});
