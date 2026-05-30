import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { findEntryForRole, isUuid, listEntriesForAdmin, type EntryListItem } from "@/lib/entries";

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

  it("returns the row when SQL returns one (caption flows through EntryDetail)", async () => {
    const row = {
      id: VALID_UUID,
      title: "t",
      category: "c",
      tags: ["a"],
      body: "b",
      caption: "PO Receipt — Validation",
      source_pointer: "s",
      last_verified_at: new Date(),
      sensitivity: "public",
      created_at: new Date(),
      updated_at: new Date(),
    };
    const { pool, calls } = mockPool([row]);
    const result = await findEntryForRole(pool, VALID_UUID, "user");
    expect(result).toEqual(row);
    // Explicit: the new caption column is projected by the SELECT and
    // surfaced on EntryDetail (the entry-detail page renders it). This is
    // the only sandbox-runnable coverage of caption on the read path; the
    // DB-gated integration test exercises real persistence.
    expect(result?.caption).toBe("PO Receipt — Validation");
    expect(calls[0].sql).toMatch(/\bcaption\b/);
  });

  it("surfaces a null caption (rows written before the column existed)", async () => {
    const row = {
      id: VALID_UUID,
      title: "t",
      category: "c",
      tags: [],
      body: "b",
      caption: null,
      source_pointer: "s",
      last_verified_at: new Date(),
      sensitivity: "public",
      created_at: new Date(),
      updated_at: new Date(),
    };
    const { pool } = mockPool([row]);
    const result = await findEntryForRole(pool, VALID_UUID, "user");
    expect(result?.caption).toBeNull();
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

  it("passes the user allow-list of public + internal (per ADR-0012 §6)", async () => {
    // Negative-assertion: a regression that mapped user → all tiers
    // here would let users see restricted entries via direct
    // /entries/[id] navigation, bypassing iron-rule #6's "restricted is
    // admin-only" semantics. `internal` IS in the user allow-list by
    // design (see lib/auth.ts:175 JSDoc + ADR-0012 §6 table).
    const { pool, calls } = mockPool([]);
    await findEntryForRole(pool, VALID_UUID, "user");
    expect(calls[0].params[1]).toEqual(["public", "internal"]);
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

// ---------------------------------------------------------------------------
// listEntriesForAdmin — unit tests (mocked Pool)
//
// Properties pinned here:
//   - iron-rule-#6: allow-list ALWAYS lands in SQL params, even for admin
//   - default + clamp behavior on `limit`
//   - peek-ahead (LIMIT N+1) → nextCursor non-null when more rows exist
//   - empty-result invariant
//   - cursor params reach SQL in the documented positions
//
// The negative-assertion "page-1 ∪ page-2 covers everything, no overlap"
// regression test runs in the DB-backed integration suite — it needs real
// Postgres for the row-comparison to mean anything. The unit tests below
// pin the wire shape, not the actual ordering.
// ---------------------------------------------------------------------------

function makeRow(over: Partial<EntryListItem> = {}): EntryListItem {
  return {
    id: VALID_UUID,
    title: "row",
    category: "cat",
    tags: [],
    sensitivity: "public",
    last_verified_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("listEntriesForAdmin — iron-rule #6 lives in SQL WHERE", () => {
  it("admin allow-list (all three tiers) lands in SQL params, never JS post-filter", async () => {
    const { pool, calls } = mockPool([]);
    await listEntriesForAdmin(pool, "admin");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/sensitivity\s*=\s*ANY\s*\(\s*\$1/i);
    expect(calls[0].params[0]).toEqual(["public", "internal", "restricted"]);
  });

  it("user allow-list (public + internal) lands in SQL params (defense-in-depth)", async () => {
    // The /admin/entries page rejects non-admin before calling this fn,
    // but the fn itself MUST degrade safely: a user-role call must NOT
    // leak `restricted` rows. Pin that property here.
    const { pool, calls } = mockPool([]);
    await listEntriesForAdmin(pool, "user");
    expect(calls[0].params[0]).toEqual(["public", "internal"]);
    expect(calls[0].params[0]).not.toContain("restricted");
  });
});

describe("listEntriesForAdmin — limit + cursor wire shape", () => {
  it("default limit is 25 (peek-ahead → LIMIT 26 in SQL)", async () => {
    const { pool, calls } = mockPool([]);
    await listEntriesForAdmin(pool, "admin");
    expect(calls[0].params[1]).toBe(26);
  });

  it("clamps limit to LIST_MAX_LIMIT (100) when caller asks for more", async () => {
    const { pool, calls } = mockPool([]);
    await listEntriesForAdmin(pool, "admin", { limit: 1000 });
    expect(calls[0].params[1]).toBe(101);
  });

  it("clamps limit floor to 1 when caller asks for 0 or negative", async () => {
    const { pool, calls } = mockPool([]);
    await listEntriesForAdmin(pool, "admin", { limit: 0 });
    expect(calls[0].params[1]).toBe(2);
  });

  it("floors fractional limit (Math.floor)", async () => {
    const { pool, calls } = mockPool([]);
    await listEntriesForAdmin(pool, "admin", { limit: 25.9 });
    expect(calls[0].params[1]).toBe(26);
  });

  it("first page: no cursor → no row-compare in SQL, 2 params", async () => {
    const { pool, calls } = mockPool([]);
    await listEntriesForAdmin(pool, "admin");
    expect(calls[0].sql).not.toMatch(/\(updated_at,\s*id\)\s*</);
    expect(calls[0].params).toHaveLength(2);
  });

  it("next page: cursor lands in $3, $4 with row-compare in SQL", async () => {
    const { pool, calls } = mockPool([]);
    const cursorUpdatedAt = new Date("2025-12-31T12:00:00Z");
    const cursorId = "99999999-9999-4999-8999-999999999999";
    await listEntriesForAdmin(pool, "admin", {
      cursor: { updatedAt: cursorUpdatedAt, id: cursorId },
    });
    expect(calls[0].sql).toMatch(/\(updated_at,\s*id\)\s*<\s*\(\$3,\s*\$4\)/);
    expect(calls[0].params[2]).toBe(cursorUpdatedAt);
    expect(calls[0].params[3]).toBe(cursorId);
  });

  it("ORDER BY is updated_at DESC, id DESC (deterministic tiebreak in SQL)", async () => {
    const { pool, calls } = mockPool([]);
    await listEntriesForAdmin(pool, "admin");
    expect(calls[0].sql).toMatch(/ORDER\s+BY\s+updated_at\s+DESC\s*,\s*id\s+DESC/i);
  });
});

describe("listEntriesForAdmin — peek-ahead → nextCursor", () => {
  it("empty result → rows:[], nextCursor:null", async () => {
    const { pool } = mockPool([]);
    const result = await listEntriesForAdmin(pool, "admin");
    expect(result).toEqual({ rows: [], nextCursor: null });
  });

  it("rows.length <= limit → nextCursor is null (no more pages)", async () => {
    // 3 rows returned, limit 25 → no peek-ahead consumed, no next page.
    const rows = [makeRow({ id: "11111111-1111-4111-8111-111111111111" })];
    const { pool } = mockPool(rows);
    const result = await listEntriesForAdmin(pool, "admin");
    expect(result.rows).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("rows.length === limit+1 → drops the peek row; cursor is LAST-of-page (not peek)", async () => {
    // Regression pin for the off-by-one fix: nextCursor is the row at
    // index `limit-1` (last row we DID return), not `limit` (the peek
    // we did NOT return). Page 2's `(updated_at, id) < lastOfPage`
    // strictly-less compare then surfaces the peek as page-2's first row.
    // Using the peek as cursor with `<` would silently drop the peek
    // entirely — the failure mode CI caught on the tied-boundary fixture.
    const limit = 2;
    const at = (s: string) => new Date(`2026-01-${s}T00:00:00Z`);
    const a = makeRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", updated_at: at("03") });
    const b = makeRow({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", updated_at: at("02") });
    const peek = makeRow({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      updated_at: at("01"),
    });
    const { pool } = mockPool([a, b, peek]);
    const result = await listEntriesForAdmin(pool, "admin", { limit });
    expect(result.rows).toEqual([a, b]);
    expect(result.rows).not.toContain(peek);
    // Cursor is `b` (last row of page), NOT `peek`.
    expect(result.nextCursor).toEqual({ updatedAt: b.updated_at, id: b.id });
    expect(result.nextCursor).not.toEqual({ updatedAt: peek.updated_at, id: peek.id });
  });
});
