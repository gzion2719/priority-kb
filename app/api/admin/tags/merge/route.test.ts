// app/api/admin/tags/merge/route.test.ts — M4 #4 PR-B merge route tests.
//
// Pins:
//   - withAdmin gate: 401/403 paths do NOT invoke mergeTags or any DB read.
//   - Malformed body / Zod failure → 400, no audit row written.
//   - TagValidationError from the lib → 400, no audit row written.
//   - Catalog membership re-check: unknown from element → 400 BEFORE lib call.
//   - MergeRollbackError from the lib → 500, finalize-audit-row UPDATE attempted.
//   - Happy path → 200 with audit_id + affected_entry_count (no partial_failure).
//   - Catastrophic pre-audit throw → 500 + fallback audit row attempted.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogSink, setLogSink } from "@/lib/log";
import { MergeRollbackError, TagValidationError } from "@/lib/tags";

beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

// Mock lib + db + embedder + catalog. Route is a thin wrapper; integration
// coverage lives in tests/tags.integration.test.ts.
const mergeTagsMock = vi.fn();
const listAdminTagsMock = vi.fn();
const dbInsertMock = vi.fn(() => ({
  values: vi.fn(() => ({
    returning: vi.fn(() => Promise.resolve([{ id: "fallback-audit-id" }])),
  })),
}));
const dbUpdateMock = vi.fn(() => ({
  set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
}));
const dbSelectMock = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => Promise.resolve([{ payload: { from: ["a"], to: "b" } }])),
  })),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    insert: dbInsertMock,
    update: dbUpdateMock,
    select: dbSelectMock,
  })),
  getPool: vi.fn(() => ({})),
}));

vi.mock("@/lib/embedding", () => ({
  getEmbedder: vi.fn(() => ({ model: "stub", version: "v1" })),
}));

vi.mock("@/lib/admin-tags", () => ({
  listAdminTagsForRole: (...args: unknown[]) => listAdminTagsMock(...args),
}));

vi.mock("@/lib/tags", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tags")>("@/lib/tags");
  return {
    ...actual,
    mergeTags: (...args: unknown[]) => mergeTagsMock(...args),
  };
});

import { POST } from "@/app/api/admin/tags/merge/route";

function adminReq(body: unknown): Request {
  return new Request("http://x/api/admin/tags/merge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "admin",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function userReq(body: unknown): Request {
  return new Request("http://x/api/admin/tags/merge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "user",
    },
    body: JSON.stringify(body),
  });
}

function anonReq(body: unknown): Request {
  return new Request("http://x/api/admin/tags/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mergeTagsMock.mockReset();
  listAdminTagsMock.mockReset();
  dbInsertMock.mockReset();
  dbUpdateMock.mockReset();
  dbSelectMock.mockReset();
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ id: "fallback-audit-id" }])),
    })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
  dbSelectMock.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([{ payload: { from: ["a"], to: "b" } }])),
    })),
  }));
  // Default catalog: enough to cover all test inputs except the catalog-miss case.
  listAdminTagsMock.mockResolvedValue([
    { name: "a", entry_count: 1 },
    { name: "b", entry_count: 1 },
    { name: "vendor", entry_count: 5 },
    { name: "supplier", entry_count: 2 },
    { name: "support", entry_count: 3 },
  ]);
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/admin/tags/merge — withAdmin gate", () => {
  it("returns 401 for unauthenticated requests; does NOT invoke mergeTags or catalog read", async () => {
    const res = await POST(anonReq({ from: ["a"], to: "b" }) as never, {} as never);
    expect(res.status).toBe(401);
    expect(mergeTagsMock).not.toHaveBeenCalled();
    expect(listAdminTagsMock).not.toHaveBeenCalled();
  });

  it("returns 403 for user role; does NOT invoke mergeTags or catalog read", async () => {
    const res = await POST(userReq({ from: ["a"], to: "b" }) as never, {} as never);
    expect(res.status).toBe(403);
    expect(mergeTagsMock).not.toHaveBeenCalled();
    expect(listAdminTagsMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tags/merge — Zod validation (400, no audit)", () => {
  it("returns 400 on malformed JSON; no lib call, no audit row", async () => {
    const res = await POST(adminReq("{ not-json") as never, {} as never);
    expect(res.status).toBe(400);
    expect(mergeTagsMock).not.toHaveBeenCalled();
    expect(dbInsertMock).not.toHaveBeenCalled();
    // Catalog read also not reached (Zod runs before catalog check).
    expect(listAdminTagsMock).not.toHaveBeenCalled();
  });

  it("returns 400 when from is missing", async () => {
    const res = await POST(adminReq({ to: "b" }) as never, {} as never);
    expect(res.status).toBe(400);
    expect(mergeTagsMock).not.toHaveBeenCalled();
  });

  it("returns 400 when from is an empty array (Zod min(1))", async () => {
    const res = await POST(adminReq({ from: [], to: "b" }) as never, {} as never);
    expect(res.status).toBe(400);
    expect(mergeTagsMock).not.toHaveBeenCalled();
  });

  it("returns 400 when to is missing", async () => {
    const res = await POST(adminReq({ from: ["a"] }) as never, {} as never);
    expect(res.status).toBe(400);
    expect(mergeTagsMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tags/merge — catalog membership re-check (400)", () => {
  it("returns 400 when a from element is not present in the catalog", async () => {
    const res = await POST(
      adminReq({ from: ["a", "bogus-tag-not-in-catalog"], to: "b" }) as never,
      {} as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0].code).toBe("not_in_catalog");
    expect(body.issues[0].path).toBe("from");
    expect(mergeTagsMock).not.toHaveBeenCalled();
    // No audit on this 400 path (mirrors A4 case 1).
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("lists every unknown from element in the issues array", async () => {
    const res = await POST(
      adminReq({ from: ["bogus1", "bogus2", "a"], to: "b" }) as never,
      {} as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.length).toBe(2);
    const codes = body.issues.map((i: { code: string }) => i.code);
    expect(codes.every((c: string) => c === "not_in_catalog")).toBe(true);
  });

  it("returns 500 when the catalog read itself throws", async () => {
    listAdminTagsMock.mockRejectedValueOnce(new Error("DB unreachable"));
    const res = await POST(adminReq({ from: ["a"], to: "b" }) as never, {} as never);
    expect(res.status).toBe(500);
    expect(mergeTagsMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tags/merge — TagValidationError → 400 (A4 case 2)", () => {
  it("returns 400 when lib throws TagValidationError on `to`", async () => {
    mergeTagsMock.mockRejectedValueOnce(
      new TagValidationError("to", "niqqud", "to contains niqqud"),
    );
    const res = await POST(adminReq({ from: ["a"], to: "bad" }) as never, {} as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0].path).toBe("to");
    expect(body.issues[0].code).toBe("niqqud");
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("returns 400 with to_in_from code when lib rejects to ∈ from", async () => {
    mergeTagsMock.mockRejectedValueOnce(
      new TagValidationError(
        "to",
        "to_in_from",
        `to "a" appears in from[]; use delete or restate the merge`,
      ),
    );
    const res = await POST(adminReq({ from: ["a", "b"], to: "a" }) as never, {} as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues[0].code).toBe("to_in_from");
    expect(dbInsertMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tags/merge — happy path", () => {
  it("returns 200 with audit_id + affected_entry_count; partial_failure omitted", async () => {
    mergeTagsMock.mockResolvedValueOnce({
      audit_id: "00000000-0000-0000-0000-000000000010",
      affected_entry_ids: ["e1", "e2", "e3"],
      partial_failure: false,
    });
    const res = await POST(
      adminReq({ from: ["vendor", "supplier"], to: "support" }) as never,
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit_id).toBe("00000000-0000-0000-0000-000000000010");
    expect(body.affected_entry_count).toBe(3);
    // Per Q1: partial_failure field is omitted on the merge response (unlike rename).
    expect(body.partial_failure).toBeUndefined();
    expect(body.partial_failure_reason).toBeUndefined();
  });
});

describe("POST /api/admin/tags/merge — MergeRollbackError → 500 + finalize audit", () => {
  it("returns 500 with audit_id; attempts the finalize UPDATE on the existing audit row", async () => {
    mergeTagsMock.mockRejectedValueOnce(
      new MergeRollbackError("00000000-0000-0000-0000-000000000099", "Error", "Error: voyage 503"),
    );
    const res = await POST(adminReq({ from: ["a"], to: "b" }) as never, {} as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal");
    expect(body.audit_id).toBe("00000000-0000-0000-0000-000000000099");
    // The route's atomic finalize UPDATE fired (M3 CR fix 2026-06-01: single
    // jsonb-concat UPDATE; no SELECT round-trip).
    expect(dbUpdateMock).toHaveBeenCalled();
    expect(dbSelectMock).not.toHaveBeenCalled();
    // No fallback INSERT on the rollback path (audit row already exists).
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("still returns 500 if the finalize UPDATE itself fails", async () => {
    mergeTagsMock.mockRejectedValueOnce(
      new MergeRollbackError("00000000-0000-0000-0000-0000000000aa", "Error", "Error: voyage 503"),
    );
    dbUpdateMock.mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.reject(new Error("audit DB down"))) })),
    }));
    const res = await POST(adminReq({ from: ["a"], to: "b" }) as never, {} as never);
    expect(res.status).toBe(500);
    // Negative-assertion: even if finalize fails, the route does NOT throw out
    // (the route's outer try wraps the finalize attempt).
    expect(await res.json()).toMatchObject({ error: "internal" });
  });
});

describe("POST /api/admin/tags/merge — catastrophic throw → 500 + fallback audit", () => {
  it("returns 500 + attempts fallback audit INSERT + surfaces fallback audit_id (N5 CR fix)", async () => {
    mergeTagsMock.mockRejectedValueOnce(new Error("DB unreachable"));
    const res = await POST(adminReq({ from: ["a"], to: "b" }) as never, {} as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal");
    // N5 CR fix 2026-06-01: catastrophic path surfaces the fallback audit_id
    // so the response shape matches the rollback path's forensic surface.
    expect(body.audit_id).toBe("fallback-audit-id");
    expect(dbInsertMock).toHaveBeenCalled();
    // Negative-assertion: catastrophic path should NOT take the rollback-finalize
    // path (no audit_id captured yet, so no UPDATE).
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });
});
