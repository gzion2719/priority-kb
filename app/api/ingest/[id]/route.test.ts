import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogSink, setLogSink } from "@/lib/log";

beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

// `db.select(...).from(...).where(...)` is a Promise-resolving chain in
// Drizzle. The mock returns a thenable that yields whatever
// `selectSensitivityRows` is set to for the current test. ADR-0021 §D4
// added a sensitivity-preservation SELECT to the PUT path; this mock
// supports it without spinning up Postgres.
let selectSensitivityRows: Array<{ sensitivity: string }> = [{ sensitivity: "internal" }];
function resetDbMock(): void {
  selectSensitivityRows = [{ sensitivity: "internal" }];
}
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown): Promise<Array<{ sensitivity: string }>> =>
          Promise.resolve(selectSensitivityRows),
      }),
    }),
  })),
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
  resetDbMock();
});
afterEach(() => {
  vi.clearAllMocks();
});

function adminReqWithHeaders(body: unknown, extraHeaders: Record<string, string>): Request {
  return new Request(`http://x/api/ingest/${VALID_UUID}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "admin",
      ...extraHeaders,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

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

  it("rejects missing required field (title) with 400 path-pointing issue", async () => {
    // ADR-0021 §D4 made sensitivity OPTIONAL on PUT; this gate test now
    // uses `title` (still required) to confirm the Zod boundary still
    // fires for genuinely missing fields.
    const { title: _omitted, ...withoutTitle } = validBody;
    const res = await PUT(adminReq(withoutTitle) as never, ctx(VALID_UUID) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues.some((i: { path: string }) => i.path === "title")).toBe(true);
  });
});

describe("PUT /api/ingest/[id] — ADR-0021 §D4 sensitivity preservation on PUT", () => {
  it("when sensitivity omitted, SELECTs current value and passes it to updateEntry", async () => {
    selectSensitivityRows = [{ sensitivity: "restricted" }];
    updateEntryMock.mockResolvedValueOnce({ id: VALID_UUID, version_no: 2, chunk_count: 1 });
    const { sensitivity: _omitted, ...withoutSensitivity } = validBody;
    const res = await PUT(adminReq(withoutSensitivity) as never, ctx(VALID_UUID) as never);
    expect(res.status).toBe(200);
    expect(updateEntryMock).toHaveBeenCalledTimes(1);
    const callArg = updateEntryMock.mock.calls[0][0];
    expect(callArg.input.sensitivity).toBe("restricted");
  });

  it("when sensitivity omitted and entry vanished, returns 404 BEFORE invoking updateEntry", async () => {
    selectSensitivityRows = [];
    const { sensitivity: _omitted, ...withoutSensitivity } = validBody;
    const res = await PUT(adminReq(withoutSensitivity) as never, ctx(VALID_UUID) as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // Negative-assertion: dropping the preservation SELECT (or its
    // early-return when zero rows) would invoke updateEntry with
    // sensitivity:undefined and fail later — distinguishes the gate.
    expect(updateEntryMock).not.toHaveBeenCalled();
  });

  it("when sensitivity present in body, the value is used as-is", async () => {
    // Distinct value from the mock's default so we'd see drift if the
    // route accidentally swapped to the preserved value.
    selectSensitivityRows = [{ sensitivity: "internal" }];
    updateEntryMock.mockResolvedValueOnce({ id: VALID_UUID, version_no: 2, chunk_count: 1 });
    const res = await PUT(
      adminReq({ ...validBody, sensitivity: "public" }) as never,
      ctx(VALID_UUID) as never,
    );
    expect(res.status).toBe(200);
    const callArg = updateEntryMock.mock.calls[0][0];
    expect(callArg.input.sensitivity).toBe("public");
  });
});

describe("PUT /api/ingest/[id] — ADR-0021 §D3 worker attribution headers", () => {
  it("passes x-worker-id + x-worker-job-id into updateEntry.audit_extra", async () => {
    updateEntryMock.mockResolvedValueOnce({ id: VALID_UUID, version_no: 2, chunk_count: 1 });
    const res = await PUT(
      adminReqWithHeaders(validBody, {
        "x-worker-id": "worker-host-42-abcd",
        "x-worker-job-id": "00000000-1111-2222-3333-444444444444",
      }) as never,
      ctx(VALID_UUID) as never,
    );
    expect(res.status).toBe(200);
    const callArg = updateEntryMock.mock.calls[0][0];
    expect(callArg.audit_extra).toEqual({
      worker_id: "worker-host-42-abcd",
      job_id: "00000000-1111-2222-3333-444444444444",
    });
  });

  it("omits audit_extra entirely when neither header is present", async () => {
    updateEntryMock.mockResolvedValueOnce({ id: VALID_UUID, version_no: 2, chunk_count: 1 });
    await PUT(adminReq(validBody) as never, ctx(VALID_UUID) as never);
    const callArg = updateEntryMock.mock.calls[0][0];
    expect(callArg.audit_extra).toBeUndefined();
  });

  it("includes ONLY the header that was sent (worker_id without job_id)", async () => {
    updateEntryMock.mockResolvedValueOnce({ id: VALID_UUID, version_no: 2, chunk_count: 1 });
    await PUT(
      adminReqWithHeaders(validBody, { "x-worker-id": "worker-host-42-abcd" }) as never,
      ctx(VALID_UUID) as never,
    );
    const callArg = updateEntryMock.mock.calls[0][0];
    expect(callArg.audit_extra).toEqual({ worker_id: "worker-host-42-abcd" });
    // Negative-assertion: an explicit `job_id: undefined` would change
    // downstream `"job_id" in audit_extra` checks even though `toEqual`
    // tolerates the mismatch; pin the key-set so a regression that
    // re-introduces the undefined key fails here.
    expect("job_id" in (callArg.audit_extra as object)).toBe(false);
  });

  it("reads x-worker-id case-insensitively per the Fetch spec (ADR-0021 §D3)", async () => {
    updateEntryMock.mockResolvedValueOnce({ id: VALID_UUID, version_no: 2, chunk_count: 1 });
    await PUT(
      adminReqWithHeaders(validBody, {
        "X-Worker-Id": "worker-uppercase-test",
        "X-Worker-Job-Id": "00000000-1111-2222-3333-444444444444",
      }) as never,
      ctx(VALID_UUID) as never,
    );
    // If the route ever swaps `req.headers.get(...)` for an entries()
    // walk + literal-case compare, this fails — exactly the
    // case-sensitivity-regression-test the CR (M3) asked for.
    const callArg = updateEntryMock.mock.calls[0][0];
    expect(callArg.audit_extra).toEqual({
      worker_id: "worker-uppercase-test",
      job_id: "00000000-1111-2222-3333-444444444444",
    });
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
