// app/api/admin/tags/rename/route.test.ts — M4 #4 PR-A rename route tests.
//
// Pins:
//   - withAdmin gate: 401/403 paths do NOT invoke renameTag.
//   - Malformed body / Zod failure → 400, no audit row written.
//   - TagValidationError from the lib → 400, no audit row written.
//   - Happy path → 200 with audit_id + affected_entry_count + partial_failure.
//   - Catastrophic throw → 500 + fallback audit row attempted.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogSink, setLogSink } from "@/lib/log";
import { TagValidationError } from "@/lib/tags";

beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

// Mock the lib + db + embedder. The route is a thin wrapper; integration
// coverage lives in tests/tags.integration.test.ts.
const renameTagMock = vi.fn();
const dbInsertMock = vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) }));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({ insert: dbInsertMock })),
}));

vi.mock("@/lib/embedding", () => ({
  getEmbedder: vi.fn(() => ({ model: "stub", version: "v1" })),
}));

vi.mock("@/lib/tags", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tags")>("@/lib/tags");
  return {
    ...actual,
    renameTag: (...args: unknown[]) => renameTagMock(...args),
  };
});

import { POST } from "@/app/api/admin/tags/rename/route";

function adminReq(body: unknown): Request {
  return new Request("http://x/api/admin/tags/rename", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "admin",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function userReq(body: unknown): Request {
  return new Request("http://x/api/admin/tags/rename", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "user",
    },
    body: JSON.stringify(body),
  });
}

function anonReq(body: unknown): Request {
  return new Request("http://x/api/admin/tags/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  renameTagMock.mockReset();
  dbInsertMock.mockReset();
  dbInsertMock.mockImplementation(() => ({ values: vi.fn(() => Promise.resolve()) }));
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/admin/tags/rename — withAdmin gate", () => {
  it("returns 401 for unauthenticated requests; does NOT invoke renameTag", async () => {
    const res = await POST(anonReq({ from: "a", to: "b" }) as never, {} as never);
    expect(res.status).toBe(401);
    expect(renameTagMock).not.toHaveBeenCalled();
  });

  it("returns 403 for user role; does NOT invoke renameTag", async () => {
    const res = await POST(userReq({ from: "a", to: "b" }) as never, {} as never);
    expect(res.status).toBe(403);
    expect(renameTagMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tags/rename — Zod validation (400, no audit)", () => {
  it("returns 400 on malformed JSON; no audit row written", async () => {
    const res = await POST(adminReq("{ not-json") as never, {} as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(renameTagMock).not.toHaveBeenCalled();
    // Fallback audit row writer must NOT fire on a 400 path.
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("returns 400 when from is missing; no lib call", async () => {
    const res = await POST(adminReq({ to: "b" }) as never, {} as never);
    expect(res.status).toBe(400);
    expect(renameTagMock).not.toHaveBeenCalled();
  });

  it("returns 400 when to is missing; no lib call", async () => {
    const res = await POST(adminReq({ from: "a" }) as never, {} as never);
    expect(res.status).toBe(400);
    expect(renameTagMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tags/rename — TagValidationError → 400 (A4 case 2)", () => {
  it("returns 400 when lib throws TagValidationError on `to`", async () => {
    renameTagMock.mockRejectedValueOnce(
      new TagValidationError("to", "niqqud", "to contains niqqud"),
    );
    const res = await POST(adminReq({ from: "a", to: "bad" }) as never, {} as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0].path).toBe("to");
    expect(body.issues[0].code).toBe("niqqud");
    // No fallback audit row on the validation 400 path (A4 says no audit).
    expect(dbInsertMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tags/rename — happy path", () => {
  it("returns 200 with the lib's result shape", async () => {
    renameTagMock.mockResolvedValueOnce({
      audit_id: "00000000-0000-0000-0000-000000000001",
      affected_entry_ids: ["e1", "e2", "e3"],
      partial_failure: false,
    });
    const res = await POST(adminReq({ from: "vendor", to: "supplier" }) as never, {} as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(body.affected_entry_count).toBe(3);
    expect(body.partial_failure).toBe(false);
    expect(body.partial_failure_reason).toBeUndefined();
  });

  it("surfaces partial_failure + reason from the lib result", async () => {
    renameTagMock.mockResolvedValueOnce({
      audit_id: "00000000-0000-0000-0000-000000000002",
      affected_entry_ids: ["e1"],
      partial_failure: true,
      partial_failure_reason: "Error: voyage 503",
    });
    const res = await POST(adminReq({ from: "a", to: "b" }) as never, {} as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.partial_failure).toBe(true);
    expect(body.partial_failure_reason).toBe("Error: voyage 503");
  });
});

describe("POST /api/admin/tags/rename — catastrophic throw → 500 + fallback audit attempt", () => {
  it("returns 500 + attempts to write a fallback audit row when lib throws non-validation", async () => {
    renameTagMock.mockRejectedValueOnce(new Error("DB unreachable"));
    const res = await POST(adminReq({ from: "a", to: "b" }) as never, {} as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal");
    // The fallback audit-write code path runs (best-effort INSERT).
    expect(dbInsertMock).toHaveBeenCalled();
  });
});
