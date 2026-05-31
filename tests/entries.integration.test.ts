import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import { deriveCaption } from "@/lib/caption";
import { createStubEmbedder } from "@/lib/embedding";
import {
  findEntryForRole,
  getVersion,
  listEntriesForAdmin,
  listVersionsForEntry,
} from "@/lib/entries";
import { createEntry, updateEntry } from "@/lib/ingest";
import * as schema from "@/drizzle/schema";
import type { Sensitivity } from "@/drizzle/schema";

// Integration test: flip-positive sensitivity proof against real
// Postgres — the unit tests with a mock Pool show iron-rule #6 lands
// in the SQL parameters, but only Postgres can prove the SQL WHERE
// actually denies cross-tier reads. Mirrors tests/ingest.integration.test.ts'
// skip-locally / fail-loud-in-CI pattern.

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; entries integration test cannot silently skip");
}

const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("findEntryForRole — integration against Postgres", () => {
  let pool: Pool;
  const publicId = "11111111-1111-4111-8111-111111111111";
  const internalId = "22222222-2222-4222-8222-222222222222";
  const restrictedId = "33333333-3333-4333-8333-333333333333";

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
  });

  async function seedTier(id: string, sensitivity: "public" | "internal" | "restricted") {
    await pool.query(
      `INSERT INTO entries (id, title, category, tags, body, source_pointer,
                            last_verified_at, sensitivity)
       VALUES ($1, $2, 'cat', ARRAY['t'], 'body text', 'ticket://1',
               NOW(), $3)`,
      [id, `entry ${sensitivity}`, sensitivity],
    );
  }

  it("flip-positive: same restricted id → row for admin, null for user", async () => {
    // THE load-bearing test. If iron rule #6 were implemented as a
    // post-hoc JS filter, both calls would short-circuit identically
    // (mocked the same way). Round-trip to Postgres proves the SQL
    // WHERE is what filters.
    await seedTier(restrictedId, "restricted");

    const adminResult = await findEntryForRole(pool, restrictedId, "admin");
    const userResult = await findEntryForRole(pool, restrictedId, "user");

    expect(adminResult).not.toBeNull();
    expect(adminResult?.id).toBe(restrictedId);
    expect(adminResult?.sensitivity).toBe("restricted");

    // The same id, the same row in the DB, but a different role yields
    // the indistinguishable-from-missing null. This is the iron-rule-#6
    // existence-leak defense end-to-end.
    expect(userResult).toBeNull();
  });

  it("public entry visible to both roles (sanity — admin doesn't get extra)", async () => {
    await seedTier(publicId, "public");

    const adminResult = await findEntryForRole(pool, publicId, "admin");
    const userResult = await findEntryForRole(pool, publicId, "user");

    expect(adminResult?.id).toBe(publicId);
    expect(userResult?.id).toBe(publicId);
  });

  it("internal entry visible to both roles (post-2026-05-24 reconciliation: user → [public, internal])", async () => {
    // Iron rule #6 / ADR-0012 §6: `internal` is org-internal and reachable
    // by authenticated end users by design. `restricted` is the admin-only
    // escape hatch — the load-bearing admin-only negative-assertion lives
    // in the restricted-tier test above. See lib/auth.ts:175 JSDoc.
    await seedTier(internalId, "internal");

    const adminResult = await findEntryForRole(pool, internalId, "admin");
    const userResult = await findEntryForRole(pool, internalId, "user");

    expect(adminResult?.id).toBe(internalId);
    expect(userResult?.id).toBe(internalId);
    expect(userResult?.sensitivity).toBe("internal");
  });

  it("null role yields null for any tier (no SQL sent)", async () => {
    await seedTier(publicId, "public");
    // Even for a public entry that user-role would see, role=null
    // (unrecognized auth header) must collapse to null. This pins the
    // page-level contract that auth-failure is indistinguishable from
    // existence-failure.
    expect(await findEntryForRole(pool, publicId, null)).toBeNull();
  });

  it("missing id and restricted-id-as-user produce indistinguishable nulls", async () => {
    // No seed for `restrictedId` — but we DO seed a different restricted
    // entry to make sure "no rows in table" isn't what's producing null.
    await seedTier(restrictedId, "restricted");
    const missingId = "44444444-4444-4444-8444-444444444444";

    const missingForUser = await findEntryForRole(pool, missingId, "user");
    const restrictedForUser = await findEntryForRole(pool, restrictedId, "user");

    // Both null — that's the only signal the caller gets. The audit
    // log distinguishes them server-side; the page surface does not.
    expect(missingForUser).toBeNull();
    expect(restrictedForUser).toBeNull();
  });

  it("projects the caption column from real Postgres (ADR-0023 read path)", async () => {
    // The unit test proves the SELECT string contains `caption`; this proves
    // the column actually round-trips from a real row. seedTier leaves
    // caption NULL, so insert one explicitly here and assert it surfaces.
    await pool.query(
      `INSERT INTO entries (id, title, category, tags, body, caption,
                            source_pointer, last_verified_at, sensitivity)
       VALUES ($1, 'captioned', 'cat', ARRAY['t'], 'body text', $2,
               'ticket://cap', NOW(), 'public')`,
      [publicId, "PO Receipt — Validation"],
    );
    const result = await findEntryForRole(pool, publicId, "user");
    expect(result?.caption).toBe("PO Receipt — Validation");
  });

  it("malformed UUID short-circuits BEFORE Postgres sees it", async () => {
    // If the regex pre-check were removed, Postgres would throw
    // `invalid input syntax for type uuid` and node-postgres would
    // reject the promise — a 500 to the page caller. We assert the
    // function resolves to null without throwing, proving the regex
    // gate is in front of the pool.query call.
    await expect(findEntryForRole(pool, "not-a-uuid", "admin")).resolves.toBeNull();
    await expect(findEntryForRole(pool, "''; DROP TABLE entries; --", "admin")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listEntriesForAdmin — integration against real Postgres
//
// The unit tests pin wire shape. Only the DB can prove that the keyset
// row-comparison `(updated_at, id) < ($, $)` paired with
// `ORDER BY updated_at DESC, id DESC` actually yields no-overlap +
// no-gap pages. That requires real lexicographic semantics + a real
// btree, not a mock.
// ---------------------------------------------------------------------------
describeIfDb("listEntriesForAdmin — integration against Postgres", () => {
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

  async function seedN(
    n: number,
    sensitivity: "public" | "internal" | "restricted" = "public",
  ): Promise<void> {
    // Distinct updated_at per row so the keyset has a clean ordering for
    // most assertions; the tie-break test below seeds equal updated_at
    // values explicitly and relies on id DESC.
    for (let i = 0; i < n; i++) {
      // UTC explicit — the `Date(y, m, d, …)` form interprets in host
      // local time which would make the seeded timestamps machine-dependent.
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();
      await pool.query(
        `INSERT INTO entries (title, category, tags, body, source_pointer,
                              last_verified_at, sensitivity,
                              created_at, updated_at)
         VALUES ($1, 'cat', ARRAY['t'], 'body ' || $1, 'ticket://' || $1,
                 NOW(), $2, $3, $3)`,
        [`row-${i.toString().padStart(3, "0")}`, sensitivity, ts],
      );
    }
  }

  it("30 rows paginated 25 + 5: full coverage, no overlap, no gap (with tied-timestamp boundary)", async () => {
    // THE load-bearing pagination test. Negative-assertions this fixture
    // distinguishes:
    //   - cursor IGNORED  → page2 re-includes page1's rows → disjointness fails.
    //   - cursor HALF-honored: drops `id` from the row-compare → at the
    //     tied-timestamp boundary the row(s) sharing the cursor's
    //     updated_at are either ALL skipped (`updated_at < $cu`) or ALL
    //     re-included (`updated_at <= $cu`) — either way coverage OR
    //     disjointness fails.
    //   - cursor HALF-honored: drops `updated_at` from the row-compare
    //     (only `id < $ci`) → smaller-id rows with larger updated_at get
    //     skipped → coverage fails.
    //
    // The boundary tie is the load-bearing fixture detail: rows 24 + 25
    // (zero-indexed: the LAST row of page1 and the FIRST row of page2)
    // share an `updated_at`. With strictly distinct timestamps a
    // dropped-`id` regression would yield IDENTICAL row sets and the
    // disjointness check would falsely pass.
    const N = 30;
    const tiedBoundaryIndex = 24; // page1 row 25 (zero-indexed 24)
    for (let i = 0; i < N; i++) {
      // Tie row 24 and row 25 by reusing the same millisecond stamp.
      const stampIndex = i === tiedBoundaryIndex + 1 ? tiedBoundaryIndex : i;
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, stampIndex)).toISOString();
      await pool.query(
        `INSERT INTO entries (title, category, tags, body, source_pointer,
                              last_verified_at, sensitivity,
                              created_at, updated_at)
         VALUES ($1, 'cat', ARRAY['t'], 'body', 'ticket://' || $1,
                 NOW(), 'public', $2, $2)`,
        [`row-${i.toString().padStart(3, "0")}`, ts],
      );
    }

    const page1 = await listEntriesForAdmin(pool, "admin", { limit: 25 });
    expect(page1.rows).toHaveLength(25);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listEntriesForAdmin(pool, "admin", {
      limit: 25,
      cursor: page1.nextCursor,
    });
    expect(page2.rows).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const ids1 = new Set(page1.rows.map((r) => r.id));
    const ids2 = new Set(page2.rows.map((r) => r.id));

    // Disjointness: no row appears on both pages.
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }

    // Coverage: page1 ∪ page2 covers ALL 30 seeded rows.
    const union = new Set([...ids1, ...ids2]);
    expect(union.size).toBe(N);
  });

  it("admin sees all three sensitivity tiers in one page", async () => {
    // Positive-control mirror of the findEntryForRole integration test:
    // the SQL allow-list for admin includes restricted, so a single-page
    // listing must surface a row of each tier.
    await seedN(1, "public");
    await seedN(1, "internal");
    await seedN(1, "restricted");

    const result = await listEntriesForAdmin(pool, "admin");
    const tiers = new Set(result.rows.map((r) => r.sensitivity));
    expect(tiers).toEqual(new Set(["public", "internal", "restricted"]));
  });

  it("user role omits restricted rows (defense-in-depth)", async () => {
    // The page rejects non-admin upstream; but listEntriesForAdmin
    // called with role="user" MUST still honor iron-rule #6. Seed one of
    // each tier; user should see public + internal only.
    await seedN(1, "public");
    await seedN(1, "internal");
    await seedN(1, "restricted");

    const result = await listEntriesForAdmin(pool, "user");
    const tiers = new Set(result.rows.map((r) => r.sensitivity));
    expect(tiers).toEqual(new Set(["public", "internal"]));
    expect(tiers).not.toContain("restricted");
  });

  it("deterministic tiebreak on equal updated_at: order by id DESC", async () => {
    // All three rows share updated_at; the only differentiator is id.
    // Without `, id DESC` in the ORDER BY the row order would be
    // implementation-defined and pagination would not survive ties.
    const sameTs = "2026-02-01T00:00:00.000Z";
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    for (const id of ids) {
      await pool.query(
        `INSERT INTO entries (id, title, category, tags, body, source_pointer,
                              last_verified_at, sensitivity,
                              created_at, updated_at)
         VALUES ($1, 'tie', 'cat', ARRAY['t'], 'b', 's',
                 NOW(), 'public', $2, $2)`,
        [id, sameTs],
      );
    }

    const result = await listEntriesForAdmin(pool, "admin");
    // ORDER BY updated_at DESC, id DESC → ids descending. Postgres stores
    // uuid as 16 binary bytes; for these specific UUIDs (`1111…`/`2222…`/
    // `3333…`) the binary byte order matches the leading-hex-digit lex
    // order, so the assertion is shape-dependent on this fixture. Do NOT
    // generalize to random UUIDs without re-deriving the expected order.
    expect(result.rows.map((r) => r.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it("empty table → rows:[], nextCursor:null", async () => {
    const result = await listEntriesForAdmin(pool, "admin");
    expect(result).toEqual({ rows: [], nextCursor: null });
  });
});

// ---------------------------------------------------------------------------
// listEntriesForAdmin — filter facets (M4 #1b) integration
//
// Every filter test asserts BOTH `length === N` AND
// `result.every(r => r.<field> === filterValue)`. The length-only check
// would pass a regression that accidentally dropped the WHERE clause and
// returned N+M rows under the limit; the `every` check distinguishes
// "filter applied" from "filter ignored". Per WORKFLOW.md negative-
// assertion-tests-distinguish-from-the-regression.
// ---------------------------------------------------------------------------
describeIfDb("listEntriesForAdmin — filter facets integration", () => {
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

  async function seedRow(opts: {
    title: string;
    category: string;
    tags: string[];
    sensitivity: "public" | "internal" | "restricted";
  }): Promise<void> {
    await pool.query(
      `INSERT INTO entries (title, category, tags, body, source_pointer,
                            last_verified_at, sensitivity)
       VALUES ($1, $2, $3::text[], 'body', 'ticket://' || $1,
               NOW(), $4)`,
      [opts.title, opts.category, opts.tags, opts.sensitivity],
    );
  }

  it("category filter: only matching rows + every row matches", async () => {
    await seedRow({ title: "a", category: "howto", tags: ["t"], sensitivity: "public" });
    await seedRow({ title: "b", category: "howto", tags: ["t"], sensitivity: "public" });
    await seedRow({ title: "c", category: "ticket", tags: ["t"], sensitivity: "public" });

    const result = await listEntriesForAdmin(pool, "admin", {
      filters: { category: "howto" },
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.category === "howto")).toBe(true);
  });

  it("tag filter: membership match (any-of-array), not exact equality", async () => {
    await seedRow({ title: "a", category: "x", tags: ["voyage", "embed"], sensitivity: "public" });
    await seedRow({ title: "b", category: "x", tags: ["voyage"], sensitivity: "public" });
    await seedRow({ title: "c", category: "x", tags: ["other"], sensitivity: "public" });

    const result = await listEntriesForAdmin(pool, "admin", {
      filters: { tag: "voyage" },
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.tags.includes("voyage"))).toBe(true);
  });

  it("tag filter is CASE-SENSITIVE (matches storage; documented in ListFilters JSDoc)", async () => {
    await seedRow({ title: "a", category: "x", tags: ["voyage"], sensitivity: "public" });

    const result = await listEntriesForAdmin(pool, "admin", {
      filters: { tag: "Voyage" },
    });
    expect(result.rows).toHaveLength(0);
  });

  it("sensitivity filter for admin: every row matches the filter", async () => {
    // Positive control: admin's allow-list is all-3, so a filter to a
    // single tier narrows in. A regression that ANDed `sensitivity=$X`
    // but dropped the allow-list would still pass length here (admin
    // sees all anyway), but the `every` check pins the AND-compose.
    await seedRow({ title: "a", category: "x", tags: ["t"], sensitivity: "public" });
    await seedRow({ title: "b", category: "x", tags: ["t"], sensitivity: "internal" });
    await seedRow({ title: "c", category: "x", tags: ["t"], sensitivity: "restricted" });

    const result = await listEntriesForAdmin(pool, "admin", {
      filters: { sensitivity: "restricted" },
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows.every((r) => r.sensitivity === "restricted")).toBe(true);
  });

  it("sensitivity filter outside user allow-list → empty (iron-rule #6 still in WHERE)", async () => {
    // THE load-bearing iron-rule pin: user role filters by `restricted`.
    // SQL produces `sensitivity = ANY($1::text[]) AND sensitivity = $X`
    // — the allow-list at $1 is [public, internal], the filter value is
    // 'restricted'; intersection is ∅. Returns 0 rows even though the
    // restricted entry exists in the table.
    await seedRow({ title: "a", category: "x", tags: ["t"], sensitivity: "restricted" });

    const result = await listEntriesForAdmin(pool, "user", {
      filters: { sensitivity: "restricted" },
    });
    expect(result.rows).toHaveLength(0);
  });

  it("combined filters AND: all three must match", async () => {
    await seedRow({ title: "a", category: "howto", tags: ["voyage"], sensitivity: "public" });
    await seedRow({ title: "b", category: "howto", tags: ["voyage"], sensitivity: "internal" });
    await seedRow({ title: "c", category: "howto", tags: ["other"], sensitivity: "public" });
    await seedRow({ title: "d", category: "ticket", tags: ["voyage"], sensitivity: "public" });

    const result = await listEntriesForAdmin(pool, "admin", {
      filters: { category: "howto", tag: "voyage", sensitivity: "public" },
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe("a");
    // Every-check on each filter axis (negative-assertion distinguishes
    // a regression that dropped any one AND-clause).
    expect(result.rows.every((r) => r.category === "howto")).toBe(true);
    expect(result.rows.every((r) => r.tags.includes("voyage"))).toBe(true);
    expect(result.rows.every((r) => r.sensitivity === "public")).toBe(true);
  });

  it("filter narrows BEFORE pagination: limit applies to the filtered set", async () => {
    // 5 matching rows + 5 non-matching, limit 3 → 3 matching rows + cursor.
    for (let i = 0; i < 5; i++) {
      await seedRow({ title: `m${i}`, category: "match", tags: ["t"], sensitivity: "public" });
    }
    for (let i = 0; i < 5; i++) {
      await seedRow({ title: `n${i}`, category: "skip", tags: ["t"], sensitivity: "public" });
    }
    const result = await listEntriesForAdmin(pool, "admin", {
      limit: 3,
      filters: { category: "match" },
    });
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.category === "match")).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listEntriesForAdmin — free-text search (M4 #1c) integration
//
// Production-tokenization-mirror sub-rule applied throughout:
// - English seed body contains the bare token `invoice` as a standalone
//   alphanumeric run, so the simple-config tokenizer + websearch_to_tsquery
//   produce the same lexeme on both index and query sides.
// - Hebrew tests exercise the niqqud-strip pipeline BIDIRECTIONALLY:
//   one direction seeds body with niqqud + queries bare (proves index
//   strips); the other seeds bare + queries with niqqud (proves query
//   strips). Either side dropping the regexp_replace breaks one direction.
// ---------------------------------------------------------------------------
describeIfDb("listEntriesForAdmin — search (tsv lane) integration", () => {
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

  async function seedRow(opts: {
    title: string;
    body: string;
    category?: string;
    tags?: string[];
    sensitivity?: Sensitivity;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO entries (title, category, tags, body, source_pointer,
                            last_verified_at, sensitivity)
       VALUES ($1, $2, $3::text[], $4, 'ticket://' || $1,
               NOW(), $5)`,
      [
        opts.title,
        opts.category ?? "x",
        opts.tags ?? ["t"],
        opts.body,
        opts.sensitivity ?? "public",
      ],
    );
  }

  it("English search: only matching rows + every row contains the lexeme", async () => {
    await seedRow({ title: "a", body: "this is the invoice approval flow" });
    await seedRow({ title: "b", body: "another invoice clarification" });
    await seedRow({ title: "c", body: "purchase order receipt" });

    const result = await listEntriesForAdmin(pool, "admin", { query: "invoice" });
    expect(result.rows).toHaveLength(2);
    // Negative-assertion via set-wise pin on titles. EntryListItem does
    // NOT carry `body` (the list projection excludes it for #1a payload
    // size), so the distinguishing check is "the right two rows came
    // back" rather than "every row's body contains the token." A
    // regression that returned the wrong 2 rows (e.g. dropped `unaccent`
    // corrupting the lexeme match) or returned all 3 rows (dropped the
    // tsv clause entirely) would fail this assertion. Per WORKFLOW.md
    // "Negative-assertion tests distinguish from the regression."
    const titles = result.rows.map((r) => r.title).sort();
    expect(titles).toEqual(["a", "b"]);
  });

  it("Hebrew bidirectional: index-side niqqud-strip alive (body niqqud, query bare)", async () => {
    // Seed body with niqqud-padded קַבָּלָה (qof-patah, bet-dagesh+qamats,
    // lamed-qamats, heh). On INSERT the trigger strips niqqud, so the
    // index stores the bare lexeme קבלה. A query for bare קבלה matches.
    // Regression: if the INDEX-side trigger dropped the regexp_replace,
    // index would store קַבָּלָה literally, and a bare-קבלה query (which
    // the query-side strips trivially since there are no marks to strip)
    // would NOT match. This test runs against the live trigger so it
    // pins the index-side strip alive.
    await seedRow({ title: "he-a", body: "תהליך קַבָּלָה של מסמכים" });
    await seedRow({ title: "he-b", body: "מסמכי לקוח" });

    const result = await listEntriesForAdmin(pool, "admin", { query: "קבלה" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe("he-a");
  });

  it("Hebrew bidirectional: query-side niqqud-strip alive (body bare, query niqqud)", async () => {
    // Seed body with bare קבלה; query with niqqud-padded קַבָּלָה. The
    // INDEX stores the bare lexeme; the QUERY-side regexp_replace must
    // strip the marks from the query string before websearch_to_tsquery
    // tokenizes it. If the query-side strip were dropped, websearch
    // would tokenize 'קַבָּלָה' as a different lexeme than the indexed
    // 'קבלה', and the match would fail.
    await seedRow({ title: "he-a", body: "תהליך קבלה של מסמכים" });
    await seedRow({ title: "he-b", body: "מסמכי לקוח" });

    const result = await listEntriesForAdmin(pool, "admin", { query: "קַבָּלָה" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe("he-a");
  });

  it("Search AND-composes with filters: query + category narrows further", async () => {
    await seedRow({ title: "a", body: "invoice", category: "howto" });
    await seedRow({ title: "b", body: "invoice", category: "ticket" });
    await seedRow({ title: "c", body: "receipt", category: "howto" });

    const result = await listEntriesForAdmin(pool, "admin", {
      query: "invoice",
      filters: { category: "howto" },
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe("a");
    expect(result.rows.every((r) => r.category === "howto")).toBe(true);
  });

  it("Search AND-composes with iron-rule #6: user role + restricted-only matching row → ∅", async () => {
    // Seed a restricted-tier row containing the query term. Iron rule
    // #6's allow-list at $1 plus the filter (none in this case) plus
    // the tsv clause must still produce 0 rows for user-role since
    // restricted is not in the user allow-list.
    await seedRow({
      title: "secret",
      body: "internal invoice procedure",
      sensitivity: "restricted",
    });

    const result = await listEntriesForAdmin(pool, "user", { query: "invoice" });
    expect(result.rows).toHaveLength(0);
  });

  it("Search returning 0 rows on a non-empty corpus → empty page (no error)", async () => {
    await seedRow({ title: "a", body: "purchase order" });
    const result = await listEntriesForAdmin(pool, "admin", { query: "nonsense-token-xyz" });
    expect(result.rows).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listVersionsForEntry / getVersion / revert flow — M4 #3 integration
//
// The unit tests pin SQL wire shape (ORDER BY DESC, LIMIT 1, malformed-id
// short-circuit). Only real Postgres proves the version_no monotonic
// MAX+1 contract under createEntry → updateEntry → updateEntry-as-revert,
// and that the revert restores sensitivity + re-derives caption from the
// reverted body (load-bearing per Step 7b plan-CR B1 + B2).
// ---------------------------------------------------------------------------
describeIfDb("version history + revert flow — integration", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
  });

  async function seedAndEdit(): Promise<{
    id: string;
    v1Body: string;
    v2Body: string;
  }> {
    const embedder = createStubEmbedder();
    const v1Body = "Original procedure step.\nLine two.";
    const v2Body = "Revised procedure step.\nLine two updated.";
    const created = await createEntry({
      db,
      embedder,
      source: { kind: "direct" },
      input: {
        title: "Procedure",
        category: "howto",
        tags: ["proc"],
        body: v1Body,
        source_pointer: "ticket://m4-3-revert-test",
        last_verified_at: new Date(),
        sensitivity: "public",
      },
    });
    // Update path: same entry, new body — appends v2.
    await updateEntry({
      db,
      embedder,
      id: created.id,
      source: { kind: "direct" },
      input: {
        title: "Procedure (revised)",
        category: "howto",
        tags: ["proc", "revised"],
        body: v2Body,
        source_pointer: "ticket://m4-3-revert-test",
        last_verified_at: new Date(),
        sensitivity: "restricted",
      },
    });
    return { id: created.id, v1Body, v2Body };
  }

  it("listVersionsForEntry returns versions in DESC order [2, 1] (negative-assertion against order drift)", async () => {
    const { id } = await seedAndEdit();

    const versions = await listVersionsForEntry(pool, id);
    // EXACT ordered equality — a regression that returned [1, 2] (ASC)
    // or [1] (LIMIT 1) would surface here. The history page reads
    // currentVersionNo from versions[0], so the order is load-bearing.
    expect(versions.map((v) => v.version_no)).toEqual([2, 1]);
  });

  it("getVersion(entry, 1) returns the v1 snapshot — NOT the current state (distinguishes 'returns latest' bug)", async () => {
    const { id, v1Body, v2Body } = await seedAndEdit();

    const v1 = await getVersion(pool, id, 1);
    expect(v1).not.toBeNull();
    expect(v1?.body).toBe(v1Body);
    // Negative-assertion: the v1 snapshot must NOT carry v2's content.
    // A regression that ignored the version_no WHERE clause would return
    // the latest snapshot (v2) regardless of the requested versionNo.
    expect(v1?.body).not.toBe(v2Body);
    expect(v1?.title).toBe("Procedure");
    expect(v1?.title).not.toBe("Procedure (revised)");
    expect(v1?.sensitivity).toBe("public");
    expect(v1?.sensitivity).not.toBe("restricted");
    expect(v1?.tags).toEqual(["proc"]);
    expect(v1?.tags).not.toEqual(["proc", "revised"]);
  });

  it("getVersion(entry, MAX+1) returns null (missing version, not crash)", async () => {
    const { id } = await seedAndEdit();
    expect(await getVersion(pool, id, 999)).toBeNull();
  });

  it("revert flow: writes v3 with v1's snapshot fields + preserves current source_pointer (negative-assertions on sensitivity + caption)", async () => {
    const { id, v1Body, v2Body } = await seedAndEdit();
    const embedder = createStubEmbedder();

    // Simulate the RevertForm's PUT payload: snapshot fields + preserved
    // source_pointer + preserved last_verified_at (from the current entry).
    const v1 = await getVersion(pool, id, 1);
    expect(v1).not.toBeNull();

    // Read the CURRENT entry to source the preserved fields.
    const currentBefore = await findEntryForRole(pool, id, "admin");
    expect(currentBefore).not.toBeNull();

    await updateEntry({
      db,
      embedder,
      id,
      source: { kind: "direct" },
      input: {
        title: v1!.title,
        category: v1!.category,
        tags: v1!.tags,
        body: v1!.body,
        sensitivity: v1!.sensitivity, // public — explicitly from snapshot.
        // Preserved from current — snapshot doesn't carry these.
        source_pointer: currentBefore!.source_pointer,
        last_verified_at: currentBefore!.last_verified_at,
      },
    });

    // Negative-assertion: list now contains [3, 2, 1] — a regression that
    // overwrote in place would yield [2, 1] (unchanged) or [3] alone (history wipe).
    const versions = await listVersionsForEntry(pool, id);
    expect(versions.map((v) => v.version_no)).toEqual([3, 2, 1]);

    // Negative-assertion: v3 carries v1's content, not v2's.
    const v3 = await getVersion(pool, id, 3);
    expect(v3?.body).toBe(v1Body);
    expect(v3?.body).not.toBe(v2Body);

    // Negative-assertion (Step 7b plan-CR B2): sensitivity restored to
    // v1's PUBLIC tier. A regression that omitted sensitivity from the
    // revert payload would land via IngestBodyForPut's worker-only
    // preserve-current branch and the current state would stay
    // RESTRICTED — load-bearing iron-rule #6 contract.
    const currentAfter = await findEntryForRole(pool, id, "admin");
    expect(currentAfter?.sensitivity).toBe("public");
    expect(currentAfter?.sensitivity).not.toBe("restricted");

    // Negative-assertion (Step 7b plan-CR B1): caption re-derived from
    // the reverted body. A regression that stopped calling deriveCaption
    // inside updateEntry would leave the stale v2 caption. The deriveCaption
    // contract is "first non-empty line of body, grapheme-safe clip".
    expect(currentAfter?.caption).toBe(deriveCaption(v1Body));
    expect(currentAfter?.caption).not.toBe(deriveCaption(v2Body));
  });
});
