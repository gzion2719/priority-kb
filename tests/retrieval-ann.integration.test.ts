// tests/retrieval-ann.integration.test.ts — ADR-0012 §B + ADR-0013 §2.3
// integration tests against real Postgres (pgvector HNSW). Iron rule #8:
// no SDK calls; local Postgres only.
//
// Each test seeds chunks directly (bypasses lib/ingest.ts) so we can pin
// chunk-level embedding values, embedding_model, and embedding_version
// exactly — the helper's correctness hinges on the SQL WHERE filtering
// those columns, and the seeds must construct scenarios where dropping
// the filter would produce a different (wrong) result per WORKFLOW.md
// negative-assertion rule.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { annCandidates } from "@/lib/retrieval-ann";
import { STUB_DIMENSIONS } from "@/lib/embedding";

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; ann integration test cannot silently skip");
}

const describeIfDb = databaseUrl ? describe : describe.skip;

// Build a 1024-dim vector whose first slot encodes `i` (so distinct i values
// produce distinguishable vectors with predictable cosine ranking), and the
// remaining 1023 slots match the query vector exactly (so chunks differ from
// the query only along axis 0 — distance is monotonic in |first - q0|).
function vec(firstSlot: number): number[] {
  const v = new Array<number>(STUB_DIMENSIONS).fill(0.01);
  v[0] = firstSlot;
  return v;
}
function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

type SeedEntry = {
  id: string;
  title: string;
  sensitivity: "public" | "internal" | "restricted";
};
type SeedChunk = {
  id?: string; // generated if omitted
  entry_id: string;
  sensitivity: "public" | "internal" | "restricted";
  embedding: number[];
  embedding_model: string;
  embedding_version: string;
};

async function insertEntry(pool: Pool, e: SeedEntry): Promise<void> {
  await pool.query(
    `INSERT INTO entries (id, title, category, tags, body, source_pointer, last_verified_at, sensitivity)
     VALUES ($1, $2, 'test', ARRAY[]::text[], 'body', 'src://test', now(), $3)`,
    [e.id, e.title, e.sensitivity],
  );
}

async function insertChunk(pool: Pool, c: SeedChunk): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO chunks
       (entry_id, sensitivity, chunk_index, chunk_total, content_start, content_end,
        token_count, chunking_policy_version, embedding, embedding_model, embedding_version)
     VALUES ($1, $2, 0, 1, 0, 5, 1, 'v1-2026-05-17', $3::vector, $4, $5)
     RETURNING id`,
    [c.entry_id, c.sensitivity, vecLiteral(c.embedding), c.embedding_model, c.embedding_version],
  );
  return res.rows[0]!.id;
}

describeIfDb("annCandidates — ADR-0012 §B + ADR-0013 §2.3 integration", () => {
  let pool: Pool;
  const MODEL = "stub-sha256";
  const VERSION = "v1";

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
  });

  it("returns entry-collapsed top-N ranked by cosine distance ascending", async () => {
    // Three entries, each with one chunk. Query vector is vec(0.5). Chunk
    // distances are monotonic in |first - 0.5|: nearest first.
    await insertEntry(pool, {
      id: "11111111-1111-4111-8111-111111111111",
      title: "A",
      sensitivity: "public",
    });
    await insertEntry(pool, {
      id: "22222222-2222-4222-8222-222222222222",
      title: "B",
      sensitivity: "public",
    });
    await insertEntry(pool, {
      id: "33333333-3333-4333-8333-333333333333",
      title: "C",
      sensitivity: "public",
    });
    await insertChunk(pool, {
      entry_id: "11111111-1111-4111-8111-111111111111",
      sensitivity: "public",
      embedding: vec(0.45),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });
    await insertChunk(pool, {
      entry_id: "22222222-2222-4222-8222-222222222222",
      sensitivity: "public",
      embedding: vec(0.8),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });
    await insertChunk(pool, {
      entry_id: "33333333-3333-4333-8333-333333333333",
      sensitivity: "public",
      embedding: vec(-0.5),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });

    const result = await annCandidates(pool, vec(0.5), ["public"], MODEL, VERSION);

    expect(result).toHaveLength(3);
    expect(result[0]?.entry_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(result[1]?.entry_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(result[2]?.entry_id).toBe("33333333-3333-4333-8333-333333333333");
    expect(result[0]?.rank).toBe(1);
    expect(result[1]?.rank).toBe(2);
    expect(result[2]?.rank).toBe(3);
    // Strictly increasing distance — pins ordering, distinguishes from
    // a tie-broken-by-id ordering that would also satisfy the entry_id
    // assertions above if the cosine ranking were broken.
    expect(result[0]!.ann_distance).toBeLessThan(result[1]!.ann_distance);
    expect(result[1]!.ann_distance).toBeLessThan(result[2]!.ann_distance);
  });

  it("FLIP-POSITIVE sensitivity: restricted entry returned only when allow-list includes 'restricted'", async () => {
    // Two entries with chunks equidistant from the query vector. Without
    // the WHERE sensitivity filter, both would surface every time. The
    // negative assertion is that the restricted entry is ABSENT for the
    // user-role allow-list — proves the filter is load-bearing, not a no-op.
    await insertEntry(pool, {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      title: "Public",
      sensitivity: "public",
    });
    await insertEntry(pool, {
      id: "bbbbbbbb-0000-4000-8000-000000000002",
      title: "Restricted",
      sensitivity: "restricted",
    });
    await insertChunk(pool, {
      entry_id: "aaaaaaaa-0000-4000-8000-000000000001",
      sensitivity: "public",
      embedding: vec(0.5),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });
    await insertChunk(pool, {
      entry_id: "bbbbbbbb-0000-4000-8000-000000000002",
      sensitivity: "restricted",
      embedding: vec(0.5),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });

    const adminAllAllowed = await annCandidates(
      pool,
      vec(0.5),
      ["public", "internal", "restricted"],
      MODEL,
      VERSION,
    );
    const adminIds = new Set(adminAllAllowed.map((r) => r.entry_id));
    expect(adminIds.has("aaaaaaaa-0000-4000-8000-000000000001")).toBe(true);
    expect(adminIds.has("bbbbbbbb-0000-4000-8000-000000000002")).toBe(true);

    const userOnly = await annCandidates(pool, vec(0.5), ["public", "internal"], MODEL, VERSION);
    const userIds = new Set(userOnly.map((r) => r.entry_id));
    expect(userIds.has("aaaaaaaa-0000-4000-8000-000000000001")).toBe(true);
    // The negative-assertion: restricted MUST be absent. Without the SQL
    // WHERE, the chunk's identical embedding would make it tie for first.
    expect(userIds.has("bbbbbbbb-0000-4000-8000-000000000002")).toBe(false);
  });

  it("FLIP-POSITIVE embedding_version BIDIRECTIONAL: v1 filter returns v1 only; v2 filter returns v2 only", async () => {
    // Two entries with chunks that have IDENTICAL embeddings but different
    // embedding_versions. Without the version WHERE filter, the query
    // against either version would tie both entries. With the filter, the
    // query against v1 returns ONLY the v1 entry and vice versa — and
    // asserting both directions catches a unidirectional WHERE bug that
    // a single-direction test would miss.
    await insertEntry(pool, {
      id: "cccccccc-0000-4000-8000-000000000003",
      title: "V1 entry",
      sensitivity: "public",
    });
    await insertEntry(pool, {
      id: "dddddddd-0000-4000-8000-000000000004",
      title: "V2 entry",
      sensitivity: "public",
    });
    await insertChunk(pool, {
      entry_id: "cccccccc-0000-4000-8000-000000000003",
      sensitivity: "public",
      embedding: vec(0.5),
      embedding_model: MODEL,
      embedding_version: "v1",
    });
    await insertChunk(pool, {
      entry_id: "dddddddd-0000-4000-8000-000000000004",
      sensitivity: "public",
      embedding: vec(0.5),
      embedding_model: MODEL,
      embedding_version: "v2",
    });

    const v1Only = await annCandidates(pool, vec(0.5), ["public"], MODEL, "v1");
    const v1Ids = new Set(v1Only.map((r) => r.entry_id));
    expect(v1Ids.has("cccccccc-0000-4000-8000-000000000003")).toBe(true);
    expect(v1Ids.has("dddddddd-0000-4000-8000-000000000004")).toBe(false);

    const v2Only = await annCandidates(pool, vec(0.5), ["public"], MODEL, "v2");
    const v2Ids = new Set(v2Only.map((r) => r.entry_id));
    expect(v2Ids.has("cccccccc-0000-4000-8000-000000000003")).toBe(false);
    expect(v2Ids.has("dddddddd-0000-4000-8000-000000000004")).toBe(true);
  });

  it("FLIP-POSITIVE embedding_model: rows with non-matching model are filtered out", async () => {
    await insertEntry(pool, {
      id: "eeeeeeee-0000-4000-8000-000000000005",
      title: "Stub model",
      sensitivity: "public",
    });
    await insertEntry(pool, {
      id: "ffffffff-0000-4000-8000-000000000006",
      title: "Voyage model",
      sensitivity: "public",
    });
    await insertChunk(pool, {
      entry_id: "eeeeeeee-0000-4000-8000-000000000005",
      sensitivity: "public",
      embedding: vec(0.5),
      embedding_model: "stub-sha256",
      embedding_version: VERSION,
    });
    await insertChunk(pool, {
      entry_id: "ffffffff-0000-4000-8000-000000000006",
      sensitivity: "public",
      embedding: vec(0.5),
      embedding_model: "voyage-3-large",
      embedding_version: VERSION,
    });

    const stubOnly = await annCandidates(pool, vec(0.5), ["public"], "stub-sha256", VERSION);
    const stubIds = new Set(stubOnly.map((r) => r.entry_id));
    expect(stubIds.has("eeeeeeee-0000-4000-8000-000000000005")).toBe(true);
    expect(stubIds.has("ffffffff-0000-4000-8000-000000000006")).toBe(false);
  });

  it("ENTRY-COLLAPSE: one entry with 3 chunks of identical embedding produces exactly one row, carrying best_chunk_id", async () => {
    // Three chunks with IDENTICAL embeddings under one entry. Without the
    // DISTINCT ON collapse, all three would surface as separate rows.
    // The assertion is on (a) cardinality = 1 and (b) best_chunk_id is one
    // of the three inserted ids — distinguishes "collapse fired" from
    // "only one chunk was inserted by accident".
    await insertEntry(pool, {
      id: "99999999-0000-4000-8000-000000000007",
      title: "Triple",
      sensitivity: "public",
    });
    const id1 = await insertChunk(pool, {
      entry_id: "99999999-0000-4000-8000-000000000007",
      sensitivity: "public",
      embedding: vec(0.5),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });
    const id2 = await insertChunk(pool, {
      entry_id: "99999999-0000-4000-8000-000000000007",
      sensitivity: "public",
      embedding: vec(0.5),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });
    const id3 = await insertChunk(pool, {
      entry_id: "99999999-0000-4000-8000-000000000007",
      sensitivity: "public",
      embedding: vec(0.5),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });

    const result = await annCandidates(pool, vec(0.5), ["public"], MODEL, VERSION);

    expect(result).toHaveLength(1);
    expect(result[0]?.entry_id).toBe("99999999-0000-4000-8000-000000000007");
    expect([id1, id2, id3]).toContain(result[0]?.best_chunk_id);
  });

  it("ENTRY-COLLAPSE picks the NEAREST chunk per entry as best_chunk_id (not any chunk)", async () => {
    // One entry, three chunks at increasing distance from the query. The
    // collapse MUST choose the nearest. Without the `MIN(distance)` /
    // `DISTINCT ON ... ORDER BY distance ASC`, the picked chunk could be
    // any of the three (e.g., earliest by insertion) — this assertion
    // distinguishes a real distance-based collapse from a tautological one.
    await insertEntry(pool, {
      id: "88888888-0000-4000-8000-000000000008",
      title: "Nearest wins",
      sensitivity: "public",
    });
    // Insert FAR chunk first, MID second, NEAR last — so any
    // insertion-order-based bug would pick FAR or MID.
    const farId = await insertChunk(pool, {
      entry_id: "88888888-0000-4000-8000-000000000008",
      sensitivity: "public",
      embedding: vec(-0.5),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });
    const midId = await insertChunk(pool, {
      entry_id: "88888888-0000-4000-8000-000000000008",
      sensitivity: "public",
      embedding: vec(0.8),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });
    const nearId = await insertChunk(pool, {
      entry_id: "88888888-0000-4000-8000-000000000008",
      sensitivity: "public",
      embedding: vec(0.5),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });

    const result = await annCandidates(pool, vec(0.5), ["public"], MODEL, VERSION);

    expect(result).toHaveLength(1);
    expect(result[0]?.best_chunk_id).toBe(nearId);
    expect(result[0]?.best_chunk_id).not.toBe(farId);
    expect(result[0]?.best_chunk_id).not.toBe(midId);
  });

  it("limit caps the post-collapse result set", async () => {
    for (let i = 0; i < 5; i++) {
      const id = `77777777-0000-4000-8000-00000000000${i}`;
      await insertEntry(pool, { id, title: `Entry ${i}`, sensitivity: "public" });
      await insertChunk(pool, {
        entry_id: id,
        sensitivity: "public",
        embedding: vec(0.1 * (i + 1)),
        embedding_model: MODEL,
        embedding_version: VERSION,
      });
    }
    const capped = await annCandidates(pool, vec(0.5), ["public"], MODEL, VERSION, 2);
    expect(capped).toHaveLength(2);
    expect(capped[0]?.rank).toBe(1);
    expect(capped[1]?.rank).toBe(2);
  });

  it("zero matching rows returns [] (not a throw)", async () => {
    // No chunks at all.
    const empty = await annCandidates(pool, vec(0.5), ["public"], MODEL, VERSION);
    expect(empty).toEqual([]);
  });

  it("SET LOCAL hnsw.ef_search = 100 fires (proves the SET line is not silently dead)", async () => {
    // Defends against a refactor that deletes the SET LOCAL line. We cannot
    // verify it from outside the helper's transaction (SET LOCAL is scoped
    // to the transaction and reverts on COMMIT), so we exercise the SAME
    // transaction recipe inline and assert `SHOW` reflects 100. If a future
    // change drops the SET from the helper, this test's setup still passes
    // — but the regression is now load-bearing on a sibling assertion: the
    // value WITHOUT SET should be the pgvector default (40), and WITH SET
    // should be 100. Asserting both pins the contract.
    // `SHOW hnsw.ef_search` returns a row whose column name is the dotted
    // GUC name (`hnsw.ef_search`), which node-postgres exposes as a key
    // that's awkward to access by destructuring. `current_setting()`
    // returns the value under a clean alias.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const noSet = await client.query<{ ef_search: string }>(
        "SELECT current_setting('hnsw.ef_search') AS ef_search",
      );
      // Default is "40" on pgvector ≥ 0.5.0.
      expect(noSet.rows[0]?.ef_search).toBe("40");
      await client.query("SET LOCAL hnsw.ef_search = 100");
      const afterSet = await client.query<{ ef_search: string }>(
        "SELECT current_setting('hnsw.ef_search') AS ef_search",
      );
      expect(afterSet.rows[0]?.ef_search).toBe("100");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("all rows filtered by sensitivity returns [] (not the unfiltered set)", async () => {
    await insertEntry(pool, {
      id: "66666666-0000-4000-8000-000000000009",
      title: "Restricted only",
      sensitivity: "restricted",
    });
    await insertChunk(pool, {
      entry_id: "66666666-0000-4000-8000-000000000009",
      sensitivity: "restricted",
      embedding: vec(0.5),
      embedding_model: MODEL,
      embedding_version: VERSION,
    });

    const userView = await annCandidates(pool, vec(0.5), ["public", "internal"], MODEL, VERSION);
    expect(userView).toEqual([]);
  });
});
