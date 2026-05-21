// lib/retrieval-ann.ts — ADR-0012 §B stage B (ANN candidates) with the
// ADR-0013 §2.3 entry-collapse + K=20→50 over-fetch refinement.
//
// Sibling to lib/retrieval-keyword.ts. Pure Postgres + pgvector, no SDK
// calls; satisfies iron rule #8 against a local DB. Sensitivity is compiled
// into the SQL WHERE (iron rule #6); embedding model+version are part of
// the WHERE so cross-version ANN scores are unreachable (iron rule #9, per
// ADR-0012 §B's "cross-version ANN scores are meaningless" note).
//
// Returns entry-collapsed top-N: one row per entry_id, ranked by the
// minimum cosine distance among its chunks. `best_chunk_id` carries the
// closest chunk so the rerank-input-selection slice (ADR-0013 §2.3
// "stage C's per-entry rerank input is still the best ANN chunk") can
// fetch chunk bodies without a second ANN query.
//
// Sibling-shape asymmetry vs lib/retrieval-keyword.ts: this helper opens a
// per-call transaction (BEGIN/COMMIT) where the keyword sibling uses a plain
// `pool.query`. The transaction is required so `SET LOCAL hnsw.ef_search`
// scopes to one connection — without it, the SET would either leak pool-wide
// or be ineffective.
//
// HNSW `ef_search` is bumped from pgvector's default of 40 to 100 inside
// a per-request transaction via `SET LOCAL`. Without this, the inner
// `LIMIT $innerLimit` of 50 silently caps at ef_search=40 (pgvector's
// HNSW reader will not return more results than ef_search), making the
// over-fetch math in ADR-0013 §2.3 dishonest. Holding the SET inside a
// `BEGIN; ... COMMIT;` confines it to one connection's transaction — no
// pool-wide state mutation.
//
// Known failure mode (deferred per ADR-0013 §"Negative"): if the 50
// nearest chunks all belong to fewer than `limit` distinct entries, the
// outer result will be short. ADR-0013 acknowledges "the K may need to
// climb further; surface in the eval set, not pre-emptively."

import type { Pool } from "pg";

import { STUB_DIMENSIONS } from "@/lib/embedding";
import type { Sensitivity } from "@/drizzle/schema";

/** Output of one entry-collapsed ANN row. */
export type AnnCandidate = {
  entry_id: string;
  /** The single closest chunk under this entry — input to per-entry rerank. */
  best_chunk_id: string;
  /** Raw pgvector cosine distance ∈ [0, 2]; lower is better. Kept raw (not
   *  flipped to a similarity score) because RRF consumes rank-only and the
   *  audit row wants the interpretable distance. */
  ann_distance: number;
  /** 1-indexed position in the returned ranking. */
  rank: number;
};

/**
 * Stage B ANN candidates query. Parametrized SQL:
 *   $1 = queryVector formatted as `'[v1,v2,...]'` pgvector literal
 *   $2 = sensitivity_allowed[] (compiled into WHERE; iron rule #6)
 *   $3 = embeddingModel  (iron rule #9 — cross-version forbidden)
 *   $4 = embeddingVersion
 *   $5 = outer limit (post-collapse cap)
 *   $6 = inner limit  (pre-collapse over-fetch, default 50 per ADR-0013 §2.3)
 *
 * `pgvector` parameter binding: node-postgres has no native serializer for
 * `number[] → vector`, so we pre-format to the `'[v1,v2,...]'` literal and
 * cast `$1::vector`. Pattern matches tests/ingest.integration.test.ts:177
 * and tests/migration.test.ts:145.
 *
 * Throws RangeError on bad inputs BEFORE acquiring a connection:
 *   - queryVector not an array of finite numbers with length STUB_DIMENSIONS
 *   - queryVector all-zeros (cosine distance is NaN against the zero vector)
 *   - limit / innerLimit outside [1, 1000]
 *   - innerLimit < limit (over-fetch must not be smaller than the cap)
 *   - empty/whitespace embeddingModel or embeddingVersion (caller bug)
 *
 * Empty sensitivityAllowed short-circuits to []. No SQL issued.
 */
export async function annCandidates(
  pool: Pool,
  queryVector: number[],
  sensitivityAllowed: Sensitivity[],
  embeddingModel: string,
  embeddingVersion: string,
  limit = 20,
  innerLimit = 50,
): Promise<AnnCandidate[]> {
  // ── Validate inputs ──────────────────────────────────────────────────────
  if (!Array.isArray(queryVector) || queryVector.length !== STUB_DIMENSIONS) {
    throw new RangeError(
      `annCandidates: queryVector must be a number[] of length ${STUB_DIMENSIONS}; got ${
        Array.isArray(queryVector) ? `length ${queryVector.length}` : typeof queryVector
      }`,
    );
  }
  // O(n) scan is justified: it lets us throw RangeError synchronously
  // WITHOUT acquiring a pool connection. Deleting this loop would push the
  // failure to pgvector inside an opened transaction — costlier and worse
  // for diagnostics. (Cross-ref CR n8.)
  let hasNonZero = false;
  for (let i = 0; i < queryVector.length; i++) {
    const v = queryVector[i]!;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new RangeError(
        `annCandidates: queryVector[${i}] must be a finite number; got ${typeof v} (${v})`,
      );
    }
    if (v !== 0) hasNonZero = true;
  }
  if (!hasNonZero) {
    throw new RangeError(
      "annCandidates: queryVector is all-zeros; cosine distance against the zero vector is NaN",
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError(`annCandidates: limit must be an integer in [1, 1000]; got ${limit}`);
  }
  if (!Number.isInteger(innerLimit) || innerLimit < 1 || innerLimit > 1000) {
    throw new RangeError(
      `annCandidates: innerLimit must be an integer in [1, 1000]; got ${innerLimit}`,
    );
  }
  if (innerLimit < limit) {
    throw new RangeError(
      `annCandidates: innerLimit (${innerLimit}) must be >= limit (${limit}); over-fetch must not be smaller than the cap`,
    );
  }
  if (typeof embeddingModel !== "string" || embeddingModel.trim().length === 0) {
    throw new RangeError("annCandidates: embeddingModel must be a non-empty string");
  }
  if (typeof embeddingVersion !== "string" || embeddingVersion.trim().length === 0) {
    throw new RangeError("annCandidates: embeddingVersion must be a non-empty string");
  }
  if (sensitivityAllowed.length === 0) {
    return [];
  }

  // pgvector literal: `[v1,v2,...]`. We trust the finite-number check above
  // (no NaN/Infinity slipped through), so plain Number.toString() is safe.
  // pgvector accepts JS Number.toString output including scientific notation
  // (e.g. `1e-7`) in vector literals.
  const vecLiteral = `[${queryVector.join(",")}]`;

  // DISTINCT ON (entry_id) collapses chunks to one row per entry, keeping
  // the smallest distance per group. Outer ORDER BY then re-sorts by that
  // best distance. We carry the chunk_id forward so the next slice can
  // fetch the per-entry rerank input without a second ANN scan.
  const sql = `
    WITH ranked AS (
      SELECT chunks.entry_id,
             chunks.id AS chunk_id,
             (chunks.embedding <=> $1::vector) AS distance
      FROM chunks
      WHERE chunks.sensitivity = ANY($2::text[])
        AND chunks.embedding_model = $3
        AND chunks.embedding_version = $4
      ORDER BY chunks.embedding <=> $1::vector
      LIMIT $6
    ),
    collapsed AS (
      SELECT DISTINCT ON (entry_id)
             entry_id,
             chunk_id AS best_chunk_id,
             distance AS ann_distance
      FROM ranked
      ORDER BY entry_id, distance ASC
    )
    SELECT entry_id, best_chunk_id, ann_distance
    FROM collapsed
    -- entry_id ASC is the stable tiebreaker, matching retrieval-keyword.ts
    -- (ORDER BY keyword_score DESC, entries.id ASC).
    ORDER BY ann_distance ASC, entry_id ASC
    LIMIT $5
  `;

  // Per-connection transaction so `SET LOCAL hnsw.ef_search` doesn't leak
  // pool-wide. Without the SET, pgvector's default ef_search=40 silently
  // caps the inner LIMIT of 50.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL hnsw.ef_search = 100");
    // pgvector's `<=>` returns `double precision`; node-postgres maps that to
    // JS `number` (not the `string` it uses for `numeric`). Number() wrap below
    // is a belt-and-suspenders cast in case a future driver flips the mapping.
    const res = await client.query<{
      entry_id: string;
      best_chunk_id: string;
      ann_distance: number;
    }>(sql, [vecLiteral, sensitivityAllowed, embeddingModel, embeddingVersion, limit, innerLimit]);
    await client.query("COMMIT");

    // `rank` is 1-indexed within the RETURNED slice (post-LIMIT). ADR-0013
    // §2.4 RRF consumes post-limit rank from each lane — `lib/retrieval.ts`
    // `rrfFuse` reads `RrfLane.rankedEntryIds[i]` with `rank = i+1`, so a
    // helper that returns N entries always feeds ranks 1..N. No "global rank"
    // semantics intended; cross-ref retrieval-keyword.ts's identical contract.
    return res.rows.map((row, idx) => ({
      entry_id: row.entry_id,
      best_chunk_id: row.best_chunk_id,
      ann_distance: Number(row.ann_distance),
      rank: idx + 1,
    }));
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback; original error wins.
    }
    throw err;
  } finally {
    client.release();
  }
}
