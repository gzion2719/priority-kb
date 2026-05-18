import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogSink, setLogSink } from "@/lib/log";

beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
}));
vi.mock("@/lib/embedding", () => ({
  getEmbedder: vi.fn(() => ({ model: "stub", version: "v1" })),
}));

const updateEntryMock = vi.fn();
vi.mock("@/lib/ingest", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ingest")>("@/lib/ingest");
  return {
    ...actual,
    updateEntry: (...args: unknown[]) => updateEntryMock(...args),
  };
});

import { PUT } from "@/app/api/ingest/[id]/route";
import { EntryNotFoundError } from "@/lib/ingest";

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

function adminReq(body: unknown): Request {
  return new Request(`http://x/api/ingest/${VALID_UUID}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-stub-user-role": "admin" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function userReq(body: unknown): Request {
  return new Request(`http://x/api/ingest/${VALID_UUID}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-stub-user-role": "user" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  title: "PO Receipt — Updated",
  category: "validation",
  tags: ["po"],
  body: "Updated guidance: quantity > 0 AND vendor must be active.",
  source_pointer: "ticket://4242",
  last_verified_at: "2026-05-18T12:00:00Z",
  sensitivity: "internal",
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  updateEntryMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/ingest/[id] — auth + uuid + zod boundary", () => {
  it("rejects non-admin without invoking updateEntry", async () => {
    const res = await PUT(userReq(validBody) as never, ctx(VALID_UUID) as never);
    expect(res.status).toBe(403);
    expect(updateEntryMock).not.toHaveBeenCalled();
  });

  it("rejects malformed uuid in path with 400 invalid_uuid", async () => {
    const res = await PUT(adminReq(validBody) as never, ctx("not-a-uuid") as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues[0].code).toBe("invalid_uuid");
    // Negative-assertion: if the UUID gate were removed, the body would
    // be parsed and updateEntry would run with a bad id.
    expect(updateEntryMock).not.toHaveBeenCalled();
  });

  it("rejects missing field with 400 path-pointing issue", async () => {
    const { sensitivity: _omitted, ...withoutSensitivity } = validBody;
    const res = await PUT(adminReq(withoutSensitivity) as never, ctx(VALID_UUID) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues.some((i: { path: string }) => i.path === "sensitivity")).toBe(true);
  });
});

describe("PUT /api/ingest/[id] — 404 + 500 paths", () => {
  it("returns 404 {error:'not_found'} when updateEntry throws EntryNotFoundError", async () => {
    updateEntryMock.mockRejectedValueOnce(new EntryNotFoundError(VALID_UUID));
    const res = await PUT(adminReq(validBody) as never, ctx(VALID_UUID) as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns generic 500 {error:'internal'} on unexpected throw without echoing err.message", async () => {
    updateEntryMock.mockRejectedValueOnce(new Error("secret-pii-9999 in error"));
    const res = await PUT(adminReq(validBody) as never, ctx(VALID_UUID) as never);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: "internal" });
    expect(JSON.stringify(json)).not.toContain("secret-pii-9999");
  });
});

describe("PUT /api/ingest/[id] — happy path", () => {
  it("returns 200 with the updateEntry result + passes id from path", async () => {
    updateEntryMock.mockResolvedValueOnce({ id: VALID_UUID, version_no: 3, chunk_count: 2 });
    const res = await PUT(adminReq(validBody) as never, ctx(VALID_UUID) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: VALID_UUID, version_no: 3, chunk_count: 2 });
    expect(updateEntryMock).toHaveBeenCalledTimes(1);
    const callArg = updateEntryMock.mock.calls[0][0];
    expect(callArg.id).toBe(VALID_UUID);
    expect(callArg.input.last_verified_at).toBeInstanceOf(Date);
  });
});
