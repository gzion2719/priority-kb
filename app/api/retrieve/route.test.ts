// app/api/retrieve/route.test.ts — M3 item 2 thin slice route tests.
//
// Two layers:
//   1. Pure validation / auth tests — exercise the POST handler with no
//      DB connection (validation rejects before stream construction).
//   2. DB integration tests — seed entries, invoke POST, parse the SSE
//      response, assert event ordering + audit-row shape. Skipped silently
//      when DATABASE_URL is unset (mirrors tests/migration.test.ts pattern).
//
// Iron-rule coverage gates:
//   - #6 sensitivity: seeded restricted entry whose body matches the query
//     does NOT appear when role=user; DOES appear when role=admin
//     (flip-positive negative-assertion, per WORKFLOW.md).
//   - #10 prompt hash: audit row's prompt_hash is non-null and equals
//     RETRIEVAL_AGENT_PROMPT_HASH.
//   - #12 degraded: audit row payload has degraded=true and the slice's
//     reason code; the no-content path still writes degraded:true.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { POST } from "@/app/api/retrieve/route";
import { RETRIEVAL_AGENT_PROMPT_HASH } from "@/lib/prompts";

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; retrieve route tests cannot silently skip");
}

function makeReq(body: unknown, role: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) headers["x-stub-user-role"] = role;
  return new Request("http://x/api/retrieve", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * Reads an SSE response body and returns the parsed `data:` events.
 * Discards keepalive comment lines.
 */
async function readSseEvents(res: Response): Promise<unknown[]> {
  const text = await res.text();
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice("data: ".length)));
    }
  }
  return events;
}

// ── Layer 1: validation / auth (no DB) ─────────────────────────────────────

describe("POST /api/retrieve — validation and auth (no DB)", () => {
  it("returns 401 when x-stub-user-role header is missing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "anything" }, null) as any, {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="stub"');
  });

  it("returns 401 on unknown role (negative-assertion: not 403 like withAdmin)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "anything" }, "superuser") as any, {});
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("returns 400 on empty query", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "" }, "user") as any, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "query_empty" });
  });

  it("returns 400 on whitespace-only query", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "   \n\t  " }, "user") as any, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "query_empty" });
  });

  it("returns 400 on punctuation-only query (no letters/digits)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "---???" }, "user") as any, {});
    expect(res.status).toBe(400);
    // Body code differs from query_empty — distinguishes the two reject
    // paths so future telemetry can tell them apart.
    expect(await res.json()).toEqual({ error: "query_invalid" });
  });

  it("returns 400 on invalid JSON", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq("not-json{", "user") as any, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });
});

// ── Layer 2: DB integration ────────────────────────────────────────────────

const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("POST /api/retrieve — DB integration", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
  });

  async function seed(
    rows: {
      id: string;
      title: string;
      body: string;
      sensitivity: "public" | "internal" | "restricted";
    }[],
  ): Promise<void> {
    for (const r of rows) {
      await pool.query(
        `INSERT INTO entries (id, title, category, tags, body, source_pointer, last_verified_at, sensitivity)
         VALUES ($1, $2, 'test', '{}'::text[], $3, 'src://test', now(), $4)`,
        [r.id, r.title, r.body, r.sensitivity],
      );
    }
  }

  it("happy path: candidates → answer_delta → done; citations are real entry IDs (NOT the stub synth's zero-UUID sentinel)", async () => {
    const realId = "11111111-1111-4111-8111-111111111111";
    await seed([
      {
        id: realId,
        title: "Invoice workflow",
        body: "Steps to issue and finalize an invoice in Priority.",
        sensitivity: "public",
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "invoice" }, "user") as any, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = (await readSseEvents(res)) as Array<{
      kind: string;
      entries?: Array<{ entry_id: string }>;
      citation_ids?: string[];
      text?: string;
    }>;

    // Event ordering invariant.
    expect(events.map((e) => e.kind)).toEqual(["candidates", "answer_delta", "done"]);

    // candidates contains the real seeded entry.
    expect(events[0]?.entries?.[0]?.entry_id).toBe(realId);

    // done's citation_ids are REAL — NOT the stub's zero-UUID sentinel.
    expect(events[2]?.citation_ids).toEqual([realId]);
    expect(events[2]?.citation_ids).not.toContain("00000000-0000-4000-8000-000000000000");

    // Stub synth's trailing "Sources: [zero-uuid]" was stripped from
    // the streamed answer text.
    expect(events[1]?.text ?? "").not.toContain("00000000-0000-4000-8000-000000000000");
    expect(events[1]?.text ?? "").not.toMatch(/Sources\s*:\s*\[/i);
  });

  it("iron rule #6: user role does NOT see restricted entries (flip-positive negative-assertion)", async () => {
    const restrictedId = "22222222-2222-4222-8222-222222222222";
    await seed([
      {
        id: restrictedId,
        title: "Restricted invoice notes",
        body: "Confidential invoice handling for VIP customers.",
        sensitivity: "restricted",
      },
    ]);

    // Same query, two roles → different outcomes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userRes = await POST(makeReq({ query: "invoice" }, "user") as any, {});
    const userEvents = (await readSseEvents(userRes)) as Array<{ kind: string }>;
    expect(userEvents.map((e) => e.kind)).toEqual(["no_content"]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminRes = await POST(makeReq({ query: "invoice" }, "admin") as any, {});
    const adminEvents = (await readSseEvents(adminRes)) as Array<{
      kind: string;
      entries?: Array<{ entry_id: string }>;
    }>;
    expect(adminEvents.map((e) => e.kind)).toContain("candidates");
    expect(adminEvents.find((e) => e.kind === "candidates")?.entries?.[0]?.entry_id).toBe(
      restrictedId,
    );
  });

  it("no_content path: empty corpus → no_content event + audit row still written with degraded:true", async () => {
    // No seed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "anything that matches nothing" }, "user") as any, {});
    expect(res.status).toBe(200);

    const events = (await readSseEvents(res)) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual(["no_content"]);

    // Audit row exists with the slice's degraded reason.
    const { rows } = await pool.query<{
      kind: string;
      prompt_hash: string;
      payload: {
        degraded: boolean;
        degraded_reason: string;
        keyword_only: boolean;
        candidate_count: number;
        role: string;
      };
    }>("SELECT kind, prompt_hash, payload FROM audit_log ORDER BY occurred_at DESC LIMIT 1");
    expect(rows[0]?.kind).toBe("agent_retrieval");
    expect(rows[0]?.prompt_hash).toBe(RETRIEVAL_AGENT_PROMPT_HASH);
    expect(rows[0]?.payload.degraded).toBe(true);
    expect(rows[0]?.payload.degraded_reason).toBe("embed_rerank_synth_unavailable_keyword_bare");
    expect(rows[0]?.payload.keyword_only).toBe(true);
    expect(rows[0]?.payload.candidate_count).toBe(0);
    expect(rows[0]?.payload.role).toBe("user");
  });

  it("audit row records sensitivity_allowed per role (iron rule #6 forensic replay)", async () => {
    await seed([
      {
        id: "33333333-3333-4333-8333-333333333333",
        title: "Public note",
        body: "Some public content with the word invoice in it.",
        sensitivity: "public",
      },
    ]);
    // Drain the SSE body — the route writes the audit row in a finally{}
    // block that fires when the stream's start() completes, which only
    // happens once the body is consumed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readSseEvents(await POST(makeReq({ query: "invoice" }, "user") as any, {}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readSseEvents(await POST(makeReq({ query: "invoice" }, "admin") as any, {}));

    const { rows } = await pool.query<{
      payload: { role: string; sensitivity_allowed: string[] };
    }>("SELECT payload FROM audit_log ORDER BY occurred_at ASC");
    expect(rows).toHaveLength(2);
    const userRow = rows.find((r) => r.payload.role === "user")!;
    const adminRow = rows.find((r) => r.payload.role === "admin")!;
    expect(userRow.payload.sensitivity_allowed).toEqual(["public"]);
    expect(adminRow.payload.sensitivity_allowed).toEqual(["public", "internal", "restricted"]);
  });

  it("audit row's prompt_hash satisfies the audit_log_prompt_hash_required_for_agent CHECK (non-null)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readSseEvents(await POST(makeReq({ query: "anything" }, "user") as any, {}));
    const { rows } = await pool.query<{ prompt_hash: string | null }>(
      "SELECT prompt_hash FROM audit_log ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(rows[0]?.prompt_hash).not.toBeNull();
    expect(rows[0]?.prompt_hash).toBe(RETRIEVAL_AGENT_PROMPT_HASH);
  });

  it("writes EXACTLY ONE audit row per request (negative-assertion: not zero, not two)", async () => {
    // A regression that wrote in both the early-return path AND the
    // finally{} block would produce two rows; a regression that dropped
    // either branch would produce zero on some path. The "===1" gate
    // distinguishes both directions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readSseEvents(await POST(makeReq({ query: "anything" }, "user") as any, {}));
    const { rows } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM audit_log");
    expect(rows[0]?.n).toBe(1);
  });

  it("redacts Bearer / sk- / pa- secrets from payload.query before persisting", async () => {
    // Mn6/Mn7: privileged surface, but a debug endpoint exposing audit_log
    // would leak any token a user pasted into the query. The redaction
    // helper from lib/log.ts is applied before INSERT.
    const req = makeReq(
      { query: "what does Bearer abc123def456ghi789 do?" },
      "user",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
    await readSseEvents(await POST(req, {}));
    const { rows } = await pool.query<{ payload: { query: string } }>(
      "SELECT payload FROM audit_log ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(rows[0]?.payload.query).not.toContain("abc123def456ghi789");
    expect(rows[0]?.payload.query).toContain("[REDACTED]");
  });
});
