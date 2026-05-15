import { afterEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("@/lib/db", () => ({
  getPool: () => ({ query }),
}));

afterEach(() => {
  query.mockReset();
});

async function callRoute() {
  const { GET } = await import("./route");
  return GET();
}

describe("GET /healthz", () => {
  it("returns 200 with pgvector=true when extension is present", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ "?column?": 1 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ extname: "vector" }] });

    const res = await callRoute();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, pgvector: true });
  });

  it("returns 503 with pgvector=false when extension is missing", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ "?column?": 1 }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await callRoute();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, pgvector: false });
    expect(body.error).toMatch(/vector extension/i);
  });

  it("returns 503 when the database is unreachable", async () => {
    query.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await callRoute();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, pgvector: false });
    expect(body.error).toMatch(/ECONNREFUSED/);
  });
});
