// tests/retrieval-keyword.integration.test.ts — ADR-0013 §2.3 stage B′
// integration tests against real Postgres (unaccent + tsvector trigger + GIN).
// Iron rule #8: no SDK calls; local Postgres only.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { keywordCandidates } from "@/lib/retrieval-keyword";

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; keyword integration test cannot silently skip");
}

const describeIfDb = databaseUrl ? describe : describe.skip;

type SeedRow = {
  id: string;
  title: string;
  tags: string[];
  body: string;
  sensitivity: "public" | "internal" | "restricted";
};

async function insertSeed(pool: Pool, rows: SeedRow[]): Promise<void> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO entries (id, title, category, tags, body, source_pointer, last_verified_at, sensitivity)
       VALUES ($1, $2, 'test', $3::text[], $4, 'src://test', now(), $5)`,
      [r.id, r.title, r.tags, r.body, r.sensitivity],
    );
  }
}

describeIfDb("keywordCandidates — ADR-0013 §2.3 integration", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
  });

  it("returns matching entries ranked by ts_rank_cd, with rank 1-indexed", async () => {
    await insertSeed(pool, [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Invoice workflow",
        tags: ["invoice", "billing"],
        body: "Steps to issue and finalize an invoice in Priority.",
        sensitivity: "public",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Purchase orders",
        tags: ["po"],
        body: "Approval workflow for purchase orders.",
        sensitivity: "public",
      },
    ]);

    const results = await keywordCandidates(pool, "invoice", ["public"]);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.entry_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(results[0]?.rank).toBe(1);
    expect(results[0]?.raw_query).toBe("invoice");
    expect(typeof results[0]?.keyword_score).toBe("number");
    expect(Number.isFinite(results[0]!.keyword_score)).toBe(true);
  });

  it("FLIP-POSITIVE sensitivity filter: same query returns restricted entry only when allowed", async () => {
    // Two entries that both match "shipping". Without the WHERE filter, both
    // would surface; the filter must be load-bearing.
    await insertSeed(pool, [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        title: "Public shipping notes",
        tags: ["ship"],
        body: "General shipping workflow.",
        sensitivity: "public",
      },
      {
        id: "bbbbbbbb-0000-4000-8000-000000000002",
        title: "Restricted shipping deals",
        tags: ["ship"],
        body: "Confidential shipping arrangements with vendors.",
        sensitivity: "restricted",
      },
    ]);

    const allAllowed = await keywordCandidates(pool, "shipping", [
      "public",
      "internal",
      "restricted",
    ]);
    const allowedIds = new Set(allAllowed.map((r) => r.entry_id));
    expect(allowedIds.has("aaaaaaaa-0000-4000-8000-000000000001")).toBe(true);
    expect(allowedIds.has("bbbbbbbb-0000-4000-8000-000000000002")).toBe(true);

    const publicOnly = await keywordCandidates(pool, "shipping", ["public"]);
    const publicIds = new Set(publicOnly.map((r) => r.entry_id));
    expect(publicIds.has("aaaaaaaa-0000-4000-8000-000000000001")).toBe(true);
    // The negative-assertion that distinguishes from a no-op WHERE clause:
    // restricted entry MUST be absent when the allow-list excludes it.
    expect(publicIds.has("bbbbbbbb-0000-4000-8000-000000000002")).toBe(false);
  });

  it("empty sensitivity allow-list returns []", async () => {
    await insertSeed(pool, [
      {
        id: "cccccccc-0000-4000-8000-000000000003",
        title: "Anything matches",
        tags: [],
        body: "Some body text here.",
        sensitivity: "public",
      },
    ]);
    const results = await keywordCandidates(pool, "anything", []);
    expect(results).toEqual([]);
  });

  it("handles websearch_to_tsquery syntax (quoted phrase, OR, negation) without throwing", async () => {
    await insertSeed(pool, [
      {
        id: "dddddddd-0000-4000-8000-000000000004",
        title: "Alpha workflow",
        tags: [],
        body: "alpha bravo charlie",
        sensitivity: "public",
      },
      {
        id: "eeeeeeee-0000-4000-8000-000000000005",
        title: "Delta workflow",
        tags: [],
        body: "delta echo",
        sensitivity: "public",
      },
    ]);
    // Quoted phrase
    await expect(keywordCandidates(pool, '"alpha bravo"', ["public"])).resolves.toBeDefined();
    // OR
    await expect(keywordCandidates(pool, "alpha OR delta", ["public"])).resolves.toBeDefined();
    // Negation
    const negated = await keywordCandidates(pool, "alpha -delta", ["public"]);
    // alpha entry should match, delta should be excluded by the -delta.
    const ids = new Set(negated.map((r) => r.entry_id));
    expect(ids.has("dddddddd-0000-4000-8000-000000000004")).toBe(true);
    expect(ids.has("eeeeeeee-0000-4000-8000-000000000005")).toBe(false);
  });

  it("punctuation-only input ('---') yields zero matches without throwing", async () => {
    await insertSeed(pool, [
      {
        id: "ffffffff-0000-4000-8000-000000000006",
        title: "Anything",
        tags: [],
        body: "alpha bravo",
        sensitivity: "public",
      },
    ]);
    // websearch_to_tsquery on punctuation-only input produces an empty tsquery
    // → tsv @@ '' is false → zero rows. Helper does NOT throw; route layer
    // is responsible for surfacing this as 400 if it wants to (ADR-0013 §M5).
    const results = await keywordCandidates(pool, "---", ["public"]);
    expect(results).toEqual([]);
  });

  it("empty / whitespace-only rawQuery throws RangeError (no SQL issued)", async () => {
    await expect(keywordCandidates(pool, "", ["public"])).rejects.toThrow(RangeError);
    await expect(keywordCandidates(pool, "   ", ["public"])).rejects.toThrow(RangeError);
    await expect(keywordCandidates(pool, "\n\t", ["public"])).rejects.toThrow(RangeError);
  });

  it("Hebrew niqqud collapses to non-niqqud lexeme via unaccent", async () => {
    // Source body has niqqud; query is bare. Both must tokenize to the same lexeme.
    await insertSeed(pool, [
      {
        id: "99999999-0000-4000-8000-000000000007",
        title: "שָׁלוֹם עולם",
        tags: [],
        body: "ברכת שָׁלוֹם בעברית.",
        sensitivity: "public",
      },
    ]);
    const bareQuery = await keywordCandidates(pool, "שלום", ["public"]);
    expect(bareQuery.map((r) => r.entry_id)).toContain("99999999-0000-4000-8000-000000000007");
  });

  it("Latin diacritics collapse via unaccent (café ↔ cafe)", async () => {
    await insertSeed(pool, [
      {
        id: "88888888-0000-4000-8000-000000000008",
        title: "Café au lait",
        tags: [],
        body: "morning café notes",
        sensitivity: "public",
      },
    ]);
    const bare = await keywordCandidates(pool, "cafe", ["public"]);
    expect(bare.map((r) => r.entry_id)).toContain("88888888-0000-4000-8000-000000000008");
  });

  it("limit caps the result set", async () => {
    const rows: SeedRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `77777777-0000-4000-8000-00000000000${i}`,
      title: `Workflow ${i}`,
      tags: ["common"],
      body: `entry ${i} body about workflows`,
      sensitivity: "public" as const,
    }));
    await insertSeed(pool, rows);
    const capped = await keywordCandidates(pool, "workflow", ["public"], 2);
    expect(capped).toHaveLength(2);
    expect(capped[0]?.rank).toBe(1);
    expect(capped[1]?.rank).toBe(2);
  });

  it("limit out of range throws RangeError", async () => {
    await expect(keywordCandidates(pool, "x", ["public"], 0)).rejects.toThrow(RangeError);
    await expect(keywordCandidates(pool, "x", ["public"], 1001)).rejects.toThrow(RangeError);
  });

  // --- PR fix/keyword-niqqud-class-drift coverage (2026-06-01) ---
  //
  // The drifted contiguous regex `[֑-ׇ]` in lib/retrieval-keyword.ts stripped
  // U+05BE MAQAF from query-side input, so a Hebrew compound-noun query like
  // `בית־ספר` (with maqaf) was normalized to `ביתספר` (one lexeme) while the
  // index held `{בית, ספר}` (two lexemes). Match: zero. These tests fix the
  // bug at the integration boundary; bidirectional coverage (M1 plan-CR fix)
  // distinguishes "fix removed the wrong strip" from "fix removed both strips".
  describe("Hebrew compound-noun MAQAF — bidirectional match (PR fix 2026-06-01)", () => {
    it("query WITH maqaf matches entry indexed WITH maqaf (the original bug repro)", async () => {
      await insertSeed(pool, [
        {
          id: "ff111111-0000-4000-8000-000000000001",
          title: "בית־ספר workflow",
          tags: [],
          body: "מסמכי בית־ספר עדיפות גבוהה",
          sensitivity: "public",
        },
      ]);
      const results = await keywordCandidates(pool, "בית־ספר", ["public"]);
      // Negative-assertion against the regression: under the buggy contiguous
      // regex this would be empty (one-lexeme query vs two-lexeme index).
      // Under the fixed shared module, the query produces {בית, ספר} which
      // matches the index's {בית, ספר}.
      expect(results.map((r) => r.entry_id)).toContain("ff111111-0000-4000-8000-000000000001");
    });

    it("query WITHOUT maqaf (space-separated) ALSO matches the same entry", async () => {
      await insertSeed(pool, [
        {
          id: "ff222222-0000-4000-8000-000000000002",
          title: "בית־ספר notes",
          tags: [],
          body: "פרוצדורת בית־ספר",
          sensitivity: "public",
        },
      ]);
      // Asymmetric direction: query 'בית ספר' (space) against indexed 'בית־ספר'
      // (maqaf). Both normalize to {בית, ספר} under the simple tokenizer + the
      // canonical niqqud-strip. This distinguishes "fix removed the wrong
      // strip" from "fix removed both strips" — a regression that stripped
      // maqaf on both sides would still match this test, but would fail the
      // reverse direction (query WITH maqaf, index WITHOUT) below.
      const results = await keywordCandidates(pool, "בית ספר", ["public"]);
      expect(results.map((r) => r.entry_id)).toContain("ff222222-0000-4000-8000-000000000002");
    });

    it("query WITH maqaf matches entry indexed WITHOUT maqaf (reverse asymmetric)", async () => {
      await insertSeed(pool, [
        {
          id: "ff333333-0000-4000-8000-000000000003",
          title: "בית ספר guide",
          tags: [],
          body: "מסמכי בית ספר",
          sensitivity: "public",
        },
      ]);
      const results = await keywordCandidates(pool, "בית־ספר", ["public"]);
      expect(results.map((r) => r.entry_id)).toContain("ff333333-0000-4000-8000-000000000003");
    });

    it("niqqud-bearing query still matches (the OTHER strip — combining marks — must work)", async () => {
      // Sanity check that the canonical class still strips real combining
      // marks. Without this, a fix that removed niqqud-strip entirely would
      // pass the maqaf tests above but break the original ADR-0013 intent.
      await insertSeed(pool, [
        {
          id: "ff444444-0000-4000-8000-000000000004",
          title: "Priority workflow",
          tags: [],
          body: "עדיפות גבוהה",
          sensitivity: "public",
        },
      ]);
      // עְדִיפוּת — same word as "עדיפות" but with niqqud added.
      const results = await keywordCandidates(pool, "עְדִיפוּת", ["public"]);
      expect(results.map((r) => r.entry_id)).toContain("ff444444-0000-4000-8000-000000000004");
    });
  });
});
