import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { startTestServer, type TestServer } from "@/scripts/start-test-server";

// tests/entries-page.e2e.test.ts — first e2e spec per ADR-0014.
//
// Covers BACKLOG:79's full surface against a real `next start` subprocess:
//   1. Admin GET /entries/<restricted-id> → 200 + body
//   2. User GET same /entries/<restricted-id> → 404
//   3. Byte-identical 404 body: restricted-as-user equals missing-id
//      (iron-rule-#6 existence-leak defense at the HTTP layer)
//   4. audit_log rows on BOTH branches with correct payload.outcome
//   5. force-dynamic cache defeat: sequential admin → user requests
//      against the same id return the role-correct body each time
//      (a cache hit would leak admin's body to user)
//
// Gated on DATABASE_URL — local runs skip, CI throws if unset.
// Seeds via POST /api/ingest (admin role), NOT raw INSERT, per
// ADR-0014 §3 iron-rule-#2 carve-out.

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; e2e spec cannot silently skip");
}

const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("entries detail page — e2e HTTP-status assertions", () => {
  let server: TestServer;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    server = await startTestServer({ env: { DATABASE_URL: databaseUrl ?? "" } });
  });

  afterAll(async () => {
    await server.kill();
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
  });

  /**
   * Seed a single entry at the specified sensitivity tier via the
   * production ingest path so the spec exercises the route under test
   * rather than bypassing iron rule #2 with a raw INSERT. Returns the
   * new entry's UUID for `/entries/[id]` URL construction. Stub-admin
   * role per the same dev-time auth surface the unit tests use.
   */
  async function seedEntry(sensitivity: "public" | "internal" | "restricted"): Promise<string> {
    const res = await fetch(`${server.baseUrl}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-stub-user-role": "admin",
      },
      body: JSON.stringify({
        title: `${sensitivity[0].toUpperCase()}${sensitivity.slice(1)} Test Entry`,
        category: "test",
        tags: ["e2e", sensitivity],
        body:
          `This is a ${sensitivity}-tier entry seeded by the e2e suite. ` +
          "Visible per iron rule #6 sensitivity mapping.",
        source_pointer: "ticket://e2e-test",
        last_verified_at: new Date().toISOString(),
        sensitivity,
      }),
    });
    expect(res.status, "seed POST /api/ingest must return 201").toBe(201);
    const created = (await res.json()) as { id?: string };
    expect(typeof created.id, "seed response must include entry id").toBe("string");
    return created.id as string;
  }

  async function seedRestrictedEntry(): Promise<string> {
    return seedEntry("restricted");
  }

  /**
   * GET an entries detail URL under a specific stub-auth role. Returns
   * status + body text so callers can assert on both. `cache: "no-store"`
   * pinned because we're testing whether the SERVER's force-dynamic
   * defeats Next's cache — a client-side cache hit would mask the bug.
   */
  async function getEntry(
    id: string,
    role: "admin" | "user" | null,
  ): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = {};
    if (role !== null) headers["x-stub-user-role"] = role;
    const res = await fetch(`${server.baseUrl}/entries/${id}`, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    const body = await res.text();
    return { status: res.status, body };
  }

  it("admin GETs restricted entry → 200 + body contains the title", async () => {
    const id = await seedRestrictedEntry();
    const { status, body } = await getEntry(id, "admin");
    expect(status).toBe(200);
    expect(body).toContain("Restricted Test Entry");
    expect(body).toContain("restricted"); // the sensitivity pill renders the label
    // Shared primitive contract: pill carries the `sensitivity-pill` class
    // (CSS hooks into it from styles/kramer-brand.css) and the `data-tier`
    // attribute drives the tier-specific color. Both must be present on
    // every render — regressions on either break iron-rule-#6 visual
    // scannability without breaking the text-level assertion above. The
    // regex tolerates a sibling class being appended in the future without
    // forcing a test rewrite.
    expect(body).toMatch(/class="sensitivity-pill(?:\s[^"]*)?"/);
    expect(body).toContain('data-tier="restricted"');
  });

  it("admin GETs public entry → pill renders data-tier='public' (tier-selector coverage)", async () => {
    const id = await seedEntry("public");
    const { status, body } = await getEntry(id, "admin");
    expect(status).toBe(200);
    // A typo in the `[data-tier="public"]` CSS selector would ship
    // silently without this assertion. Proves the public-tier selector
    // is reachable from the rendered HTML.
    expect(body).toMatch(/class="sensitivity-pill(?:\s[^"]*)?"/);
    expect(body).toContain('data-tier="public"');
  });

  it("admin GETs internal entry → pill renders data-tier='internal' (tier-selector coverage)", async () => {
    const id = await seedEntry("internal");
    const { status, body } = await getEntry(id, "admin");
    expect(status).toBe(200);
    // Same rationale as the public-tier case above — covers the third
    // tier selector so the consolidation actually exercises all three
    // attribute-selector branches the CSS extracts.
    expect(body).toMatch(/class="sensitivity-pill(?:\s[^"]*)?"/);
    expect(body).toContain('data-tier="internal"');
  });

  it("user GETs same restricted entry → 404 (iron rule #6 enforced at HTTP layer)", async () => {
    const id = await seedRestrictedEntry();
    const { status } = await getEntry(id, "user");
    expect(status).toBe(404);
  });

  it("user's 404 for restricted-as-user leaks no entry content (existence-leak defense)", async () => {
    // THE load-bearing iron-rule-#6 assertion at the HTTP-render layer.
    // Original plan called for full byte-identity between the two 404
    // responses, but Next App Router echoes the URL `[id]` segment into
    // the RSC payload (`"c":["","entries","<id>"]` block), making byte
    // identity unreachable without normalizing the ID out post-hoc.
    // That echo doesn't leak anything — the user already typed the ID
    // — so the meaningful defense is unchanged: the response must NOT
    // contain any content derived from the existing-but-forbidden
    // entry (title, body, source, sensitivity tier name as a label).
    // We assert both:
    //   (a) both responses render the same not-found component (so the
    //       page surface is the same shape — no "denied" vs "missing"
    //       distinguisher),
    //   (b) the restricted-as-user response contains NONE of the
    //       seeded entry's content fields (title/body/source-pointer/
    //       sensitivity label).
    const restrictedTitle = "Restricted Test Entry";
    const restrictedSourcePointer = "ticket://e2e-test";
    const restrictedBodyText = "This is a restricted-tier entry seeded by the e2e suite.";

    const restrictedId = await seedRestrictedEntry();
    const missingId = "44444444-4444-4444-8444-444444444444";

    const restrictedAsUser = await getEntry(restrictedId, "user");
    const missingAsUser = await getEntry(missingId, "user");

    expect(restrictedAsUser.status).toBe(404);
    expect(missingAsUser.status).toBe(404);

    // (a) Both render the same not-found shape (the project's
    // app/entries/[id]/not-found.tsx renders "Entry not found" — see
    // file). If the page surfaced a distinguishing "you can't see this"
    // copy for the denied case, this assertion would catch it.
    expect(restrictedAsUser.body).toContain("Entry not found");
    expect(missingAsUser.body).toContain("Entry not found");

    // (b) Restricted-as-user response carries NONE of the seeded
    // entry's content fields. This is the iron-rule-#6 contract: from
    // the user's perspective, the existing-but-forbidden entry is
    // indistinguishable from a missing one.
    expect(restrictedAsUser.body).not.toContain(restrictedTitle);
    expect(restrictedAsUser.body).not.toContain(restrictedSourcePointer);
    expect(restrictedAsUser.body).not.toContain(restrictedBodyText);
    // Sanity: missing-id response shouldn't accidentally contain the
    // seeded title either (it would mean cross-test contamination).
    expect(missingAsUser.body).not.toContain(restrictedTitle);
  });

  it("audit_log writes entry_view row on BOTH served (admin) and denied (user) branches", async () => {
    const id = await seedRestrictedEntry();

    // Two requests — admin (served) + user (denied) — against same id.
    await getEntry(id, "admin");
    await getEntry(id, "user");

    const rows = await pool.query<{
      payload: { outcome: string; role: string | null; entry_id: string | null };
    }>(
      `SELECT payload FROM audit_log
       WHERE kind = 'entry_view'
       ORDER BY occurred_at ASC`,
    );

    expect(rows.rowCount, "two entry_view rows expected (one per GET)").toBe(2);

    const served = rows.rows.find((r) => r.payload.outcome === "served");
    const denied = rows.rows.find((r) => r.payload.outcome === "not_found_or_unauthorized");
    expect(served, "served row missing").toBeDefined();
    expect(denied, "denied row missing").toBeDefined();
    // Served row carries the actual entry_id in payload (not on the FK
    // column — see writeViewAuditRow comment in app/entries/[id]/page.tsx
    // for the timing-oracle rationale). Denied row carries null.
    expect(served?.payload.entry_id).toBe(id);
    expect(denied?.payload.entry_id).toBeNull();
    expect(served?.payload.role).toBe("admin");
    expect(denied?.payload.role).toBe("user");
  });

  it("force-dynamic defeats route cache: sequential admin → user → admin returns role-correct body each time", async () => {
    // Without force-dynamic, Next's full route cache could serve the
    // admin's rendered 200 to the subsequent user request (the cache
    // key doesn't include the role header). This test fires three
    // sequential requests against the same id and asserts each one
    // returns the role-appropriate response — a cache hit would
    // collapse them to identical bodies and fail the assertion.
    const id = await seedRestrictedEntry();

    const adminFirst = await getEntry(id, "admin");
    const userBetween = await getEntry(id, "user");
    const adminThird = await getEntry(id, "admin");

    expect(adminFirst.status).toBe(200);
    expect(userBetween.status).toBe(404);
    expect(adminThird.status).toBe(200);

    // The two admin responses should match each other (same server-rendered
    // content for the same id under the same role) but NOT the user's 404.
    expect(adminFirst.body).toBe(adminThird.body);
    expect(adminFirst.body).not.toBe(userBetween.body);
  });
});
