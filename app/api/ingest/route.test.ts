import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogSink, setLogSink } from "@/lib/log";

// Silence logEvent NDJSON sink during this suite (the 500-path test writes
// one). Mirrors lib/ingest.test.ts.
beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

// Mock the heavy collaborators BEFORE importing the route. We want to
// exercise the Zod boundary + the withAdmin wiring, not the DB or
// embedder — those are covered in lib/ingest.test.ts and
// tests/ingest.integration.test.ts.
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    /* unused on validation-fail paths */
  })),
}));
vi.mock("@/lib/embedding", () => ({
  getEmbedder: vi.fn(() => ({ model: "stub", version: "v1" })),
}));

const createEntryMock = vi.fn();
vi.mock("@/lib/ingest", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ingest")>("@/lib/ingest");
  return {
    ...actual,
    createEntry: (...args: unknown[]) => createEntryMock(...args),
  };
});

import { POST } from "@/app/api/ingest/route";

function adminReq(body: unknown): Request {
  return new Request("http://x/api/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "admin",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function userReq(body: unknown): Request {
  return new Request("http://x/api/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stub-user-role": "user",
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  title: "PO Receipt — Validation Errors",
  category: "validation",
  tags: ["po", "receipt"],
  body: "Quantity must be greater than zero.",
  source_pointer: "ticket://4242",
  last_verified_at: "2026-05-18T10:00:00Z",
  sensitivity: "internal",
};

beforeEach(() => {
  createEntryMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/ingest — auth passthrough (withAdmin wiring)", () => {
  it("rejects non-admin without invoking createEntry", async () => {
    const res = await POST(userReq(validBody) as never, {} as never);
    expect(res.status).toBe(403);
    // Negative-assertion: if withAdmin weren't wired, createEntry would
    // have been called. Asserting NOT-called distinguishes "auth gates
    // the route" from "auth wrapped but ignored".
    expect(createEntryMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest — Zod validation (400 shape)", () => {
  it("returns invalid_request without echoing offending body values", async () => {
    const res = await POST(
      adminReq({ ...validBody, sensitivity: "top-secret" }) as never,
      {} as never,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
    expect(Array.isArray(json.issues)).toBe(true);
    // Negative-assertion: a Zod default `.format()` would surface
    // `"top-secret"` in `received` / `message`. Asserting the body never
    // contains the offending value distinguishes safe-shape from a leak.
    expect(JSON.stringify(json)).not.toContain("top-secret");
    expect(createEntryMock).not.toHaveBeenCalled();
  });

  it("rejects missing required field with path-pointing issue", async () => {
    const { sensitivity: _omitted, ...withoutSensitivity } = validBody;
    const res = await POST(adminReq(withoutSensitivity) as never, {} as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues.some((i: { path: string }) => i.path === "sensitivity")).toBe(true);
  });

  it("rejects naive (no-offset) last_verified_at", async () => {
    const res = await POST(
      adminReq({ ...validBody, last_verified_at: "2026-05-18T10:00:00" }) as never,
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects empty body string", async () => {
    const res = await POST(adminReq({ ...validBody, body: "" }) as never, {} as never);
    expect(res.status).toBe(400);
    expect(createEntryMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_json on malformed JSON", async () => {
    const res = await POST(adminReq("{not json") as never, {} as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues[0].code).toBe("invalid_json");
  });

  it("rejects last_verified_at far in the future (iron rule #7 intent)", async () => {
    const res = await POST(
      adminReq({ ...validBody, last_verified_at: "2099-01-01T00:00:00Z" }) as never,
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects source_pointer containing ASCII control chars", async () => {
    const res = await POST(
      adminReq({ ...validBody, source_pointer: "ticket://4242\nINJECTED" }) as never,
      {} as never,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    // Negative-assertion: if the .refine() were removed, the value would
    // reach createEntry. The 400 distinguishes "control-char gate fired"
    // from "any field rejected the request".
    expect(json.issues.some((i: { path: string }) => i.path === "source_pointer")).toBe(true);
  });
});

describe("POST /api/ingest — 500 path is leak-safe", () => {
  it("returns generic {error:'internal'} without echoing err.message", async () => {
    createEntryMock.mockRejectedValueOnce(new Error("secret-pii-12345 in error message"));
    const res = await POST(adminReq(validBody) as never, {} as never);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: "internal" });
    // Negative-assertion: if the catch-all leaked err.message, the body
    // would contain the literal. Asserting NOT-contains distinguishes
    // "generic-shape response" from a leaked-message response.
    expect(JSON.stringify(json)).not.toContain("secret-pii-12345");
  });
});

describe("POST /api/ingest — happy-path delegates to createEntry", () => {
  it("returns 201 with the createEntry result", async () => {
    createEntryMock.mockResolvedValueOnce({
      id: "uuid-1",
      version_no: 1,
      chunk_count: 1,
    });
    const res = await POST(adminReq(validBody) as never, {} as never);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "uuid-1", version_no: 1, chunk_count: 1 });
    expect(createEntryMock).toHaveBeenCalledTimes(1);
    const callArg = createEntryMock.mock.calls[0][0];
    expect(callArg.input.last_verified_at).toBeInstanceOf(Date);
    expect(callArg.input.sensitivity).toBe("internal");
  });
});
