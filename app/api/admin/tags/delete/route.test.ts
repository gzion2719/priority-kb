// app/api/admin/tags/delete/route.test.ts — M4 #4 PR-A delete route tests.
// Mirrors rename/route.test.ts shape.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogSink, setLogSink } from "@/lib/log";
import { TagValidationError } from "@/lib/tags";

beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

const deleteTagMock = vi.fn();
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
    deleteTag: (...args: unknown[]) => deleteTagMock(...args),
  };
});

import { POST } from "@/app/api/admin/tags/delete/route";

function adminReq(body: unknown): Request {
  return new Request("http://x/api/admin/tags/delete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "admin",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function userReq(body: unknown): Request {
  return new Request("http://x/api/admin/tags/delete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "user",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  deleteTagMock.mockReset();
  dbInsertMock.mockReset();
  dbInsertMock.mockImplementation(() => ({ values: vi.fn(() => Promise.resolve()) }));
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/admin/tags/delete — auth + validation", () => {
  it("returns 403 for user role; does NOT invoke deleteTag", async () => {
    const res = await POST(userReq({ tag: "foo" }) as never, {} as never);
    expect(res.status).toBe(403);
    expect(deleteTagMock).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON; no audit", async () => {
    const res = await POST(adminReq("not-json") as never, {} as never);
    expect(res.status).toBe(400);
    expect(deleteTagMock).not.toHaveBeenCalled();
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("returns 400 when tag is missing", async () => {
    const res = await POST(adminReq({}) as never, {} as never);
    expect(res.status).toBe(400);
    expect(deleteTagMock).not.toHaveBeenCalled();
  });

  it("returns 400 + path:tag when lib throws TagValidationError", async () => {
    deleteTagMock.mockRejectedValueOnce(new TagValidationError("tag", "too_long", "too long"));
    const res = await POST(adminReq({ tag: "x".repeat(100) }) as never, {} as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues[0].path).toBe("tag");
    expect(body.issues[0].code).toBe("too_long");
    expect(dbInsertMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tags/delete — happy path", () => {
  it("returns 200 with audit_id + affected_entry_count", async () => {
    deleteTagMock.mockResolvedValueOnce({
      audit_id: "00000000-0000-0000-0000-000000000010",
      affected_entry_ids: ["e1", "e2"],
      partial_failure: false,
    });
    const res = await POST(adminReq({ tag: "obsolete" }) as never, {} as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit_id).toBe("00000000-0000-0000-0000-000000000010");
    expect(body.affected_entry_count).toBe(2);
    expect(body.partial_failure).toBe(false);
  });
});

describe("POST /api/admin/tags/delete — catastrophic throw → 500 + fallback audit", () => {
  it("returns 500 + attempts the fallback audit row", async () => {
    deleteTagMock.mockRejectedValueOnce(new Error("DB unreachable"));
    const res = await POST(adminReq({ tag: "foo" }) as never, {} as never);
    expect(res.status).toBe(500);
    expect(dbInsertMock).toHaveBeenCalled();
  });
});
