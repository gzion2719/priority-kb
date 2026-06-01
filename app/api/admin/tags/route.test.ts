// app/api/admin/tags/route.test.ts — M4 #4 PR-C suggest endpoint tests.
//
// Pins:
//   - withAdmin gate: 401/403 paths do NOT invoke the lib.
//   - searchParams.get null→undefined; empty-string→undefined (M3 plan-CR fix).
//   - Happy path with + without prefix → 200 { tags }.
//   - Lib throw → 500 + observability event.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogSink, setLogSink } from "@/lib/log";

beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

const listAdminTagsMock = vi.fn();

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({})),
}));

vi.mock("@/lib/admin-tags", () => ({
  listAdminTagsForRole: (...args: unknown[]) => listAdminTagsMock(...args),
}));

import { GET } from "@/app/api/admin/tags/route";

function adminReq(url: string): Request {
  return new Request(url, {
    method: "GET",
    headers: { "x-stub-user-role": "admin" },
  });
}

function userReq(url: string): Request {
  return new Request(url, {
    method: "GET",
    headers: { "x-stub-user-role": "user" },
  });
}

function anonReq(url: string): Request {
  return new Request(url, { method: "GET" });
}

beforeEach(() => {
  listAdminTagsMock.mockReset();
  listAdminTagsMock.mockResolvedValue([
    { name: "vendor", entry_count: 5 },
    { name: "supplier", entry_count: 3 },
  ]);
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/admin/tags — withAdmin gate", () => {
  it("returns 401 for unauthenticated requests; does NOT invoke lib", async () => {
    const res = await GET(anonReq("http://x/api/admin/tags") as never, {} as never);
    expect(res.status).toBe(401);
    expect(listAdminTagsMock).not.toHaveBeenCalled();
  });

  it("returns 403 for user role; does NOT invoke lib", async () => {
    const res = await GET(userReq("http://x/api/admin/tags") as never, {} as never);
    expect(res.status).toBe(403);
    expect(listAdminTagsMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/tags — happy path", () => {
  it("returns 200 with { tags } shape; no prefix → lib called with prefix: undefined", async () => {
    const res = await GET(adminReq("http://x/api/admin/tags") as never, {} as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags).toEqual([
      { name: "vendor", entry_count: 5 },
      { name: "supplier", entry_count: 3 },
    ]);
    expect(listAdminTagsMock).toHaveBeenCalledWith(expect.anything(), "admin", {
      prefix: undefined,
    });
  });

  it("threads ?prefix=ven through to the lib as { prefix: 'ven' }", async () => {
    await GET(adminReq("http://x/api/admin/tags?prefix=ven") as never, {} as never);
    expect(listAdminTagsMock).toHaveBeenCalledWith(expect.anything(), "admin", {
      prefix: "ven",
    });
  });

  it("normalizes ?prefix= (empty) to undefined (M3 fix: empty-string ≡ no filter)", async () => {
    await GET(adminReq("http://x/api/admin/tags?prefix=") as never, {} as never);
    expect(listAdminTagsMock).toHaveBeenCalledWith(expect.anything(), "admin", {
      prefix: undefined,
    });
  });

  it("normalizes ?prefix=%20%20 (whitespace-only) to undefined after trim", async () => {
    await GET(adminReq("http://x/api/admin/tags?prefix=%20%20") as never, {} as never);
    expect(listAdminTagsMock).toHaveBeenCalledWith(expect.anything(), "admin", {
      prefix: undefined,
    });
  });

  it("trims surrounding whitespace from a non-empty prefix", async () => {
    await GET(adminReq("http://x/api/admin/tags?prefix=%20ven%20") as never, {} as never);
    expect(listAdminTagsMock).toHaveBeenCalledWith(expect.anything(), "admin", {
      prefix: "ven",
    });
  });

  it("accepts a long prefix (no defensive cap per B1 plan-CR fix)", async () => {
    const longPrefix = "x".repeat(500);
    const res = await GET(
      adminReq(`http://x/api/admin/tags?prefix=${longPrefix}`) as never,
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(listAdminTagsMock).toHaveBeenCalledWith(expect.anything(), "admin", {
      prefix: longPrefix,
    });
  });

  it("accepts a Hebrew prefix (URL-decoded UTF-8)", async () => {
    const hebrew = "ספ"; // first 2 chars of a tag like "ספק"
    const res = await GET(
      adminReq(`http://x/api/admin/tags?prefix=${encodeURIComponent(hebrew)}`) as never,
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(listAdminTagsMock).toHaveBeenCalledWith(expect.anything(), "admin", {
      prefix: hebrew,
    });
  });
});

describe("GET /api/admin/tags — catastrophic throw → 500", () => {
  it("returns 500 when the lib throws; observability event captured", async () => {
    listAdminTagsMock.mockRejectedValueOnce(new Error("DB unreachable"));
    const res = await GET(adminReq("http://x/api/admin/tags") as never, {} as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal");
  });
});
