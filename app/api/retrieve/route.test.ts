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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { POST, RETRIEVAL_RETRY_PREFIX_HASH } from "@/app/api/retrieve/route";
import { RETRIEVAL_AGENT_PROMPT_HASH } from "@/lib/prompts";
import {
  resetSynthesizerForTests,
  setSynthesizerForTests,
  type Synthesizer,
} from "@/lib/retrieval";

/**
 * Build a Synthesizer fake that returns the i-th `answers` string on the
 * i-th call (with the last answer reused on any further calls — protects
 * the tests against accidental N>2 calls without bypassing the
 * retry-twice-forbidden audit assertion). Tracks call count for the
 * negative-assertion dual check on retry tests.
 */
function makeInjectedSynth(answers: string[]): Synthesizer & { calls: () => number } {
  let i = 0;
  const synth: Synthesizer = {
    model: "test-synth",
    version: "v1-test",
    async synthesize(_prompt: string, _ctx: string[]) {
      const idx = i;
      i += 1;
      return {
        answer: answers[Math.min(idx, answers.length - 1)] ?? "",
        tokens_in: 0,
        tokens_out: 0,
      };
    },
  };
  return Object.assign(synth, { calls: () => i });
}

function injectSynth(s: Synthesizer): void {
  // Goes through the dedicated lib helper rather than reaching into
  // globalThis directly — keeps the contract boundary single-sourced
  // (n1 cross-ref in the 2c-i code-CR).
  resetSynthesizerForTests();
  setSynthesizerForTests(s);
}

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

  beforeEach(() => {
    // Each test starts with a fresh synth singleton; tests that need an
    // injected synth call injectSynth(...) after this hook fires.
    resetSynthesizerForTests();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
    resetSynthesizerForTests();
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

  it("happy path: candidates → answer_delta → done; injected synth emits valid Sources block over real topNIds", async () => {
    const realId = "11111111-1111-4111-8111-111111111111";
    await seed([
      {
        id: realId,
        title: "Invoice workflow",
        body: "Steps to issue and finalize an invoice in Priority.",
        sensitivity: "public",
      },
    ]);

    // Inject a synth whose first attempt produces a §5-conformant answer:
    // one inline citation, trailing Sources block, set-equal to inline,
    // every UUID in `topNIds`, valid v4. The validator returns ok.
    const synth = makeInjectedSynth([`Answer text [${realId}].\n\nSources: [${realId}]`]);
    injectSynth(synth);

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

    // Event ordering invariant — validator passed first attempt.
    expect(events.map((e) => e.kind)).toEqual(["candidates", "answer_delta", "done"]);
    expect(events[0]?.entries?.[0]?.entry_id).toBe(realId);

    // done.citation_ids is the validator's deduplicated Sources list, NOT
    // raw topNIds. The two coincide here (single seeded entry), but the
    // assertion that it equals `validation.ids` distinguishes "validator
    // ran" from "validator was skipped and topNIds was sent verbatim" —
    // the latter would also produce `[realId]` here, so the wire shape is
    // additionally pinned by the "Sources block stripped from
    // answer_delta" assertion below (would NOT hold if the validator
    // were bypassed and the synth's raw answer were streamed).
    expect(events[2]?.citation_ids).toEqual([realId]);

    // The validator returns Sources-block-stripped body in `validation.body`.
    // A regression bypassing the validator would stream the raw answer
    // containing the literal "Sources: [...]" line.
    expect(events[1]?.text ?? "").not.toMatch(/Sources\s*:\s*\[/i);

    // Exactly one synth call — no retry on the happy path.
    expect(synth.calls()).toBe(1);
  });

  it("stub-default synth surfaces citation_validation_failed via chunks_only (2c-ii orchestrator)", async () => {
    const realId = "44444444-4444-4444-8444-444444444444";
    await seed([
      {
        id: realId,
        title: "Stub default smoke",
        body: "Body content for the stub-default smoke test.",
        sensitivity: "public",
      },
    ]);

    // No injectSynth — uses the default stub which emits a Sources block
    // citing the zero-UUID sentinel. That UUID is NOT in topNIds, so
    // validateCitations returns `hallucinated_id` on both attempts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "stub" }, "user") as any, {});
    expect(res.status).toBe(200);

    const events = (await readSseEvents(res)) as Array<{
      kind: string;
      degraded_reason?: string;
      entries?: Array<{ entry_id: string }>;
    }>;

    // 2c-ii: validation-fail-after-retry degrades to chunks_only per
    // ADR-0012 §3. The kind:"error" emission was a slice-2c-i row-8-by-
    // construction simplification, superseded by the orchestrator.
    expect(events.map((e) => e.kind)).toEqual(["candidates", "chunks_only"]);
    const terminal = events.find((e) => e.kind === "chunks_only")!;
    expect(terminal.degraded_reason).toBe("citation_validation_failed");
    // chunks_only carries the rerank-input snippets so the UI can render
    // citations without a synthesized answer (iron rule #3).
    expect(terminal.entries?.[0]?.entry_id).toBe(realId);

    // Audit row carries the §5 forensic fields.
    const { rows } = await pool.query<{
      payload: {
        degraded: boolean;
        degraded_reason: string;
        citation_ids: string[];
        citation_validation_outcome: string;
        citation_validation_detail: { offending_ids?: string[] } | null;
        retry_attempted: boolean;
        retry_prefix_hash: string | null;
        status: string;
      };
    }>("SELECT payload FROM audit_log ORDER BY occurred_at DESC LIMIT 1");
    expect(rows[0]?.payload.degraded).toBe(true);
    expect(rows[0]?.payload.degraded_reason).toBe("citation_validation_failed");
    expect(rows[0]?.payload.citation_validation_outcome).toBe("hallucinated_id");
    // Per-reason payload IS persisted. The stub synth's sentinel UUID is the offending id.
    expect(rows[0]?.payload.citation_validation_detail).toEqual({
      offending_ids: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(rows[0]?.payload.retry_attempted).toBe(true);
    expect(rows[0]?.payload.retry_prefix_hash).toBe(RETRIEVAL_RETRY_PREFIX_HASH);
    expect(rows[0]?.payload.citation_ids).toEqual([]);
    // Validation-fail is NOT a synth-down error — status stays "ok".
    expect(rows[0]?.payload.status).toBe("ok");
  });

  it("retry-once succeeds: first attempt fails hallucinated_id, second attempt passes", async () => {
    const realId = "55555555-5555-4555-8555-555555555555";
    await seed([
      {
        id: realId,
        title: "Retry-succeeds entry",
        body: "Body content for the retry-succeeds test.",
        sensitivity: "public",
      },
    ]);

    // Attempt 1: cites a UUID not in topNIds → hallucinated_id.
    // Attempt 2: cites the real id → ok.
    const hallucinatedId = "99999999-9999-4999-8999-999999999999";
    const synth = makeInjectedSynth([
      `First try [${hallucinatedId}].\n\nSources: [${hallucinatedId}]`,
      `Second try [${realId}].\n\nSources: [${realId}]`,
    ]);
    injectSynth(synth);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "retry" }, "user") as any, {});
    const events = (await readSseEvents(res)) as Array<{
      kind: string;
      citation_ids?: string[];
      text?: string;
    }>;

    // Happy terminal kind — retry succeeded.
    expect(events.map((e) => e.kind)).toEqual(["candidates", "answer_delta", "done"]);
    expect(events[2]?.citation_ids).toEqual([realId]);

    // DUAL ASSERTION (CR M5 negative-assertion floor): synthSpy call count
    // distinguishes "retry ran and succeeded" from "retry was skipped".
    // If retry were skipped, synth.calls()===1 and the first answer would
    // have surfaced as error.
    expect(synth.calls()).toBe(2);

    const { rows } = await pool.query<{
      payload: {
        retry_attempted: boolean;
        retry_prefix_hash: string | null;
        citation_validation_outcome: string;
        citation_validation_detail: unknown;
        citation_ids: string[];
        status: string;
      };
    }>("SELECT payload FROM audit_log ORDER BY occurred_at DESC LIMIT 1");
    expect(rows[0]?.payload.retry_attempted).toBe(true);
    expect(rows[0]?.payload.retry_prefix_hash).toBe(RETRIEVAL_RETRY_PREFIX_HASH);
    expect(rows[0]?.payload.citation_validation_outcome).toBe("ok");
    // CR M1: detail is null on success — only failure variants carry payload.
    expect(rows[0]?.payload.citation_validation_detail).toBeNull();
    expect(rows[0]?.payload.citation_ids).toEqual([realId]);
    expect(rows[0]?.payload.status).toBe("ok");
  });

  it("retry-once both fail: ADR-0012 §5 caps at 2 synth calls; degrades to chunks_only", async () => {
    const realId = "66666666-6666-4666-8666-666666666666";
    await seed([
      {
        id: realId,
        title: "Both-fail entry",
        body: "Body content for the both-fail test.",
        sensitivity: "public",
      },
    ]);

    // Same hallucinated id on both attempts.
    const hallucinatedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const synth = makeInjectedSynth([
      `Try 1 [${hallucinatedId}].\n\nSources: [${hallucinatedId}]`,
      `Try 2 [${hallucinatedId}].\n\nSources: [${hallucinatedId}]`,
      // Third element NEVER consumed — its presence pins that a future
      // regression to "retry-twice" would surface as the test still
      // asserting calls()===2 (negative-assertion floor).
      `Try 3 [${hallucinatedId}].\n\nSources: [${hallucinatedId}]`,
    ]);
    injectSynth(synth);

    // Query "test" matches the body's `test` token after Postgres' `simple`
    // tokenizer splits "both-fail" into {both, fail} — using "bothfail"
    // would not tokenize-match and the keyword lane would short-circuit to
    // no_content, never reaching the retry path under test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "test" }, "user") as any, {});
    const events = (await readSseEvents(res)) as Array<{
      kind: string;
      degraded_reason?: string;
    }>;

    expect(events.map((e) => e.kind)).toEqual(["candidates", "chunks_only"]);
    expect(events.find((e) => e.kind === "chunks_only")?.degraded_reason).toBe(
      "citation_validation_failed",
    );

    // DUAL ASSERTION: exactly 2 synth calls — §5 retry-once cap.
    // Regression dropping retry → calls===1. Regression retry-twice →
    // calls===3 (would consume the third answer in the array).
    expect(synth.calls()).toBe(2);

    const { rows } = await pool.query<{
      payload: {
        degraded: boolean;
        degraded_reason: string;
        citation_validation_outcome: string;
        citation_validation_detail: { offending_ids?: string[] } | null;
        citation_ids: string[];
        retry_attempted: boolean;
        status: string;
      };
    }>("SELECT payload FROM audit_log ORDER BY occurred_at DESC LIMIT 1");
    expect(rows[0]?.payload.degraded).toBe(true);
    expect(rows[0]?.payload.degraded_reason).toBe("citation_validation_failed");
    expect(rows[0]?.payload.citation_validation_outcome).toBe("hallucinated_id");
    // Per-reason payload preserved on the audit row — the offending UUID the
    // synth cited on the second attempt is recoverable.
    expect(rows[0]?.payload.citation_validation_detail).toEqual({
      offending_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    });
    expect(rows[0]?.payload.citation_ids).toEqual([]);
    expect(rows[0]?.payload.retry_attempted).toBe(true);
    // Validation-fail is NOT a synth-down error — status stays "ok".
    expect(rows[0]?.payload.status).toBe("ok");
  });

  it("validator-bypass negative assertion: done.citation_ids reflects the validator's Sources set, NOT topNIds", async () => {
    // Seed TWO entries; inject a synth that cites only one of them. A
    // regression that bypassed the validator and sent topNIds verbatim
    // would surface as [realId1, realId2]; the validator-driven flow
    // surfaces only the cited subset.
    const realId1 = "77777777-7777-4777-8777-777777777777";
    const realId2 = "88888888-8888-4888-8888-888888888888";
    await seed([
      {
        id: realId1,
        title: "First match",
        body: "Body 1 about validator subsets and citation handling.",
        sensitivity: "public",
      },
      {
        id: realId2,
        title: "Second match",
        body: "Body 2 about validator subsets and citation handling.",
        sensitivity: "public",
      },
    ]);

    // Synth cites only realId1 even though both are in topNIds.
    const synth = makeInjectedSynth([`Subset answer [${realId1}].\n\nSources: [${realId1}]`]);
    injectSynth(synth);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "validator" }, "user") as any, {});
    const events = (await readSseEvents(res)) as Array<{
      kind: string;
      citation_ids?: string[];
      text?: string;
    }>;

    expect(events.map((e) => e.kind)).toEqual(["candidates", "answer_delta", "done"]);
    // The validator-driven citation set is the SUBSET — not topNIds.
    expect(events[2]?.citation_ids).toEqual([realId1]);

    // CR m2 strengthening: also assert the answer text uses the
    // validator's stripped body, NOT the raw synth output. A regression
    // that bypassed the validator (sending synthResult.answer verbatim)
    // would surface the literal "Sources: [..." line; the validator's
    // `result.body` strips it. Distinguishes "validator-stripped body"
    // from "raw-answer-passthrough" — the topic the .toEqual above
    // doesn't fully cover (a bypass could still set citation_ids
    // correctly by accident if a future regression flipped only the
    // answer source).
    expect(events[1]?.text ?? "").not.toMatch(/Sources\s*:\s*\[/i);
    expect(events[1]?.text ?? "").toContain("Subset answer");
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

  it("no_content path: empty corpus → no_content event + audit row written with healthy embed state", async () => {
    // No seed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeReq({ query: "anything that matches nothing" }, "user") as any, {});
    expect(res.status).toBe(200);

    const events = (await readSseEvents(res)) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual(["no_content"]);

    // Audit row exists. Under 2c-ii's orchestrator the stub embedder runs
    // healthy and both lanes return zero rows from an empty corpus, so the
    // matrix lands on "no degraded" — embed-OK plus empty-fused is the
    // explicitly-not-degraded variant per `mapDegradedReason`'s flip-positive.
    const { rows } = await pool.query<{
      kind: string;
      prompt_hash: string;
      payload: {
        degraded: boolean;
        degraded_reason?: string;
        keyword_only: boolean;
        ann_candidate_ids: string[];
        keyword_candidate_ids: string[];
        fused_ids: string[];
        role: string;
      };
    }>("SELECT kind, prompt_hash, payload FROM audit_log ORDER BY occurred_at DESC LIMIT 1");
    expect(rows[0]?.kind).toBe("agent_retrieval");
    expect(rows[0]?.prompt_hash).toBe(RETRIEVAL_AGENT_PROMPT_HASH);
    expect(rows[0]?.payload.degraded).toBe(false);
    expect(rows[0]?.payload.degraded_reason).toBeUndefined();
    expect(rows[0]?.payload.keyword_only).toBe(false);
    expect(rows[0]?.payload.ann_candidate_ids).toEqual([]);
    expect(rows[0]?.payload.keyword_candidate_ids).toEqual([]);
    expect(rows[0]?.payload.fused_ids).toEqual([]);
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
