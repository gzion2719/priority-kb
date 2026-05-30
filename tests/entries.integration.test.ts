import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { findEntryForRole, listEntriesForAdmin } from "@/lib/entries";

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
