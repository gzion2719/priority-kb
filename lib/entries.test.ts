import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { findEntryForRole, isUuid } from "@/lib/entries";

// Mock-pool factory: returns a Pool-shaped object whose .query returns
// `rows`. We assert on the captured (sql, params) tuple to prove the
// iron-rule-#6 allow-list lands in the SQL parameters, not in
// JS-side post-hoc filtering.
function mockPool(rows: unknown[] = []): {
  pool: Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rows } as { rows: unknown[] };
  });
  return { pool: { query } as unknown as Pool, calls };
}

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("isUuid — guards SQL from Postgres' uuid-syntax error", () => {
  it("accepts canonical lowercase hex 8-4-4-4-12", () => {
    expect(isUuid(VALID_UUID)).toBe(true);
  });

  it("accepts uppercase hex (Postgres uuid type is case-insensitive)", () => {
    expect(isUuid(VALID_UUID.toUpperCase())).toBe(true);
  });

  it.each([
    "not-a-uuid",
    "",
    "11111111-1111-4111-8111-11111111111", // 35 chars
    "11111111-1111-4111-8111-1111111111111", // 37 chars
    "11111111x1111-4111-8111-111111111111", // wrong separator
    "11111111-1111-4111-8111-11111111111g", // non-hex
    "../../etc/passwd",
    "11111111-1111-4111-8111-111111111111\n", // trailing newline
    "1' OR 1=1; --",
  ])("rejects malformed input %s", (v) => {
    expect(isUuid(v)).toBe(false);
  });
});

describe("findEntryForRole — collapses all denial modes to null", () => {
  // The single most load-bearing property of this function: a user
  // cannot tell "I'm not authorized" apart from "this id doesn't
  // exist" apart from "the id is malformed". The four cases below
  // pin that collapse from the unit-test side; the integration test
  // flips the SAME id between admin (row returned) and user (null)
  // to prove the SQL WHERE — not a post-hoc filter — is the gate.

  it("returns null when role is null without sending SQL", async () => {
    const { pool, calls } = mockPool([{ id: VALID_UUID }]);
    const result = await findEntryForRole(pool, VALID_UUID, null);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null on malformed UUID without sending SQL", async () => {
    // If we let the malformed id reach Postgres, the driver throws
    // `invalid input syntax for type uuid` — a 500 that distinguishes
    // "malformed" from "missing" (a discriminator!). This test proves
    // the regex short-circuits BEFORE pool.query is reached.
    const { pool, calls } = mockPool([{ id: VALID_UUID }]);
    const result = await findEntryForRole(pool, "not-a-uuid", "admin");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when SQL returns zero rows", async () => {
    const { pool } = mockPool([]);
    const result = await findEntryForRole(pool, VALID_UUID, "admin");
    expect(result).toBeNull();
  });

  it("returns the row when SQL returns one", async () => {
    const row = {
      id: VALID_UUID,
      title: "t",
      category: "c",
      tags: ["a"],
      body: "b",
      source_pointer: "s",
      last_verified_at: new Date(),
      sensitivity: "public",
      created_at: new Date(),
      updated_at: new Date(),
    };
    const { pool } = mockPool([row]);
    const result = await findEntryForRole(pool, VALID_UUID, "user");
    expect(result).toEqual(row);
  });
});

describe("findEntryForRole — iron-rule #6 lives in SQL WHERE, not in JS", () => {
  it("passes the admin allow-list as a parameter (admin sees all three tiers)", async () => {
    const { pool, calls } = mockPool([]);
    await findEntryForRole(pool, VALID_UUID, "admin");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/sensitivity\s*=\s*ANY\s*\(\s*\$2/i);
    expect(calls[0].params[0]).toBe(VALID_UUID);
    expect(calls[0].params[1]).toEqual(["public", "internal", "restricted"]);
  });

  it("passes the user allow-list of only 'public'", async () => {
    // Negative-assertion: a regression that mapped user → all tiers
    // here would let users see internal/restricted entries via direct
    // /entries/[id] navigation, completely bypassing the existence-
    // leak defense.
    const { pool, calls } = mockPool([]);
    await findEntryForRole(pool, VALID_UUID, "user");
    expect(calls[0].params[1]).toEqual(["public"]);
    expect(calls[0].params[1]).not.toContain("internal");
    expect(calls[0].params[1]).not.toContain("restricted");
  });

  it("does NOT post-hoc filter the row's sensitivity in JS", async () => {
    // If the row returned by pool.query has sensitivity='restricted'
    // and the role is 'user', a defensive JS post-filter would convert
    // that to null and "look correct" while leaving the SQL allow-list
    // path untested. We prove the function trusts the SQL by handing
    // it a row whose sensitivity is OUTSIDE the role's allow-list —
    // the function still returns it, because the SQL is the gate; the
    // contract is "if the SQL returned it, it's allowed". This pins
    // the architecture: never add a JS-side defensive filter.
    const restrictedRow = {
      id: VALID_UUID,
      title: "t",
      category: "c",
      tags: [],
      body: "b",
      source_pointer: "s",
      last_verified_at: new Date(),
      sensitivity: "restricted" as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const { pool } = mockPool([restrictedRow]);
    const result = await findEntryForRole(pool, VALID_UUID, "user");
    expect(result).not.toBeNull();
    expect(result?.sensitivity).toBe("restricted");
  });
});
