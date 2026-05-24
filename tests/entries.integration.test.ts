import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { findEntryForRole } from "@/lib/entries";

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
