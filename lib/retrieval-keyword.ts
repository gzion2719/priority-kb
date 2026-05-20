// lib/retrieval-keyword.ts — ADR-0013 §2.3 stage B′ keyword lane.
//
// Pure Postgres tsvector search over entries.tsv (maintained by the trigger in
// drizzle/migrations/0002_unaccent_tsv_trigger.sql). Returns up to `limit`
// entries ranked by ts_rank_cd descending, scoped to the caller-supplied
// sensitivity-allowed set (iron rule #6, server-side authorization).
//
// Empty/whitespace-only `rawQuery` throws RangeError — the route layer is
// responsible for the user-facing 400 (ADR-0013 §4 §M5). Failing loud here
// rather than returning [] keeps the contract honest: an empty query is a
// caller bug, not a "no match" result.
//
// No external SDK calls; satisfies iron rule #8 against a local Postgres.

import type { Pool } from "pg";

import type { Sensitivity } from "@/drizzle/schema";

export type KeywordCandidate = {
  entry_id: string;
  keyword_score: number;
  /** 1-indexed position in the ranking. Useful for RRF input. */
  rank: number;
  /** The raw user query string, BEFORE the index-side normalization
   *  pipeline (regexp_replace niqqud-strip → unaccent → websearch_to_tsquery).
   *  Recorded on the Slice 2 audit row so an analyst can replay the request.
   *  Not the actual tsquery; the tsquery is computed inside Postgres. */
  raw_query: string;
};

/**
 * Stage B′ keyword-lane query. Parametrized SQL — `$1` the raw user query,
 * `$2` the role-derived sensitivity-allowed array, `$3` the row limit.
 *
 * Sensitivity is compiled into the WHERE clause, never applied post-hoc.
 * Empty/whitespace-only `rawQuery` throws RangeError before reaching SQL.
 *
 * `websearch_to_tsquery` tolerates quoted phrases, OR, and leading-minus
 * negation in user input without throwing on malformed syntax (cf.
 * plainto_tsquery, which throws on edge characters).
 */
export async function keywordCandidates(
  pool: Pool,
  rawQuery: string,
  sensitivityAllowed: Sensitivity[],
  limit = 20,
): Promise<KeywordCandidate[]> {
  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
    throw new RangeError(
      "keywordCandidates: rawQuery must be a non-empty string; route layer must 400 empty input before reaching this helper",
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError(`keywordCandidates: limit must be an integer in [1, 1000]; got ${limit}`);
  }
  if (sensitivityAllowed.length === 0) {
    // Empty allow-list = no rows can ever match. Short-circuit before SQL.
    return [];
  }

  // Query-side normalization mirrors the index-side trigger in migration 0002:
  // strip Hebrew niqqud + cantillation marks, then unaccent. Both layers MUST
  // apply identical normalization, or queries silently miss indexed lexemes.
  const sql = `
    SELECT entries.id AS entry_id,
           ts_rank_cd(entries.tsv, q) AS keyword_score
    FROM entries,
         websearch_to_tsquery('simple', unaccent(regexp_replace($1, '[֑-ׇ]', '', 'g'))) q
    WHERE entries.sensitivity = ANY($2::text[])
      AND entries.tsv @@ q
    ORDER BY keyword_score DESC, entries.id ASC
    LIMIT $3
  `;

  const res = await pool.query<{ entry_id: string; keyword_score: number }>(sql, [
    rawQuery,
    sensitivityAllowed,
    limit,
  ]);

  return res.rows.map((row, idx) => ({
    entry_id: row.entry_id,
    keyword_score: Number(row.keyword_score),
    rank: idx + 1,
    raw_query: rawQuery,
  }));
}
