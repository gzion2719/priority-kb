// scripts/seed-synthetic-entries.ts — M2a #8 development-stage smoke.
//
// Seeds 3 synthetic-fixture Priority Q&A entries via `lib/ingest.ts::createEntry`
// (the canonical write path — same code path the API route and chat UI hit).
// Idempotent on `source_pointer`: re-runs skip entries that already exist.
//
// Per ADR-0011 Amendment 2026-05-27, synthetic-fixture entries (`source_pointer`
// matches `synthetic-fixture-YYYY-MM-DD-<slug>`, generic Priority ERP
// terminology, no customer/vendor identifiers) are explicitly permitted during
// the development-stage public window and do not trigger the revert.
//
// Each entry maps to one queued golden-set case (per Step 7 plan Q4 fix) so
// future Phase B work has obvious anchor points:
//   - en-001 (English procedural): "duplicate customer codes on Excel import"
//   - en-009 (English diagnostic): "FK constraint error on customer delete"
//   - he-003 (Hebrew procedural):  "fiscal year setup in GL"
//
// Embedder: stub (per ADR-0011 Amendment 2026-05-27 + lib/embedding.ts
// `getEmbedder()` — Voyage adapter not wired). Stub vectors are NOT
// L2-normalized; the development-stage smoke proves the ingest pipeline
// shape, NOT real-world retrieval recall. Real-world recall measurement is
// a production-stage transition gate.
//
// Usage:
//   npx tsx scripts/seed-synthetic-entries.ts            # dry-run (default)
//   npx tsx scripts/seed-synthetic-entries.ts --apply    # commit to DB
//
// Forensic discriminator (post-seed):
//   SELECT id, title, source_pointer FROM entries WHERE source_pointer LIKE 'synthetic-fixture-%';
//
// Iron-rule footprint:
//   #1  no real credentials/secrets — synthetic content only.
//   #2  writes via lib/ingest.ts::createEntry — same canonical path as the
//       API route (audit row `kind:"ingest"`, null `prompt_hash`). Forensic
//       discriminator is `entries.source_pointer LIKE 'synthetic-fixture-%'`.
//   #6  every entry tagged with `sensitivity` from the validated enum.
//   #7  every entry has `source_pointer` + `last_verified_at`.
//   #8  no live API in tests — this is a dev seed, not a test.
//   #9  `embedding_model` + `embedding_version` populated by the stub.

import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";

// Load .env.local FIRST (Next.js convention), then .env as fallback
// (drizzle-kit). Mirrors drizzle.config.ts dual-load pattern. Static imports
// of lib/db / lib/ingest are safe because getPool() / getDb() are LAZY —
// they read DATABASE_URL at call time, not at module-import time.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
dotenv.config({ path: resolve(repoRoot, ".env.local") });
dotenv.config({ path: resolve(repoRoot, ".env") });

import { getDb } from "@/lib/db";
import { createStubEmbedder } from "@/lib/embedding";
import { createEntry } from "@/lib/ingest";
import * as schema from "@/drizzle/schema";
import { SEED_FIXTURE_IDS } from "@/evals/fixture-ids";

const APPLY = process.argv.includes("--apply");

const SEED_DATE = "2026-05-27";

// Three synthetic Priority Q&A entries. Content is hand-crafted to match the
// shape of real Priority KB entries: a clear Q&A title, a procedural or
// diagnostic body grounded in generic Priority ERP terminology, no customer
// or vendor identifiers, no real ticket numbers.
// Each entry pins an explicit `id` from SEED_FIXTURE_IDS so a fresh DB (CI)
// reproduces the exact UUIDs evals/golden_set.yaml anchors to — see
// evals/fixture-ids.ts for why. The reconciliation test guards seed↔golden
// drift.
const SEED_ENTRIES = [
  {
    // Maps to golden-set en-001
    id: SEED_FIXTURE_IDS["en-001"],
    title: "Fixing duplicate customer codes during Excel import",
    category: "procedural",
    tags: ["customers", "import", "excel", "duplicates"],
    body: `When importing customer records from an Excel file via the Import Wizard, Priority will reject rows whose customer code (CUSTNAME) already exists in the database. The wizard returns a "duplicate key" error and aborts the entire batch by default.

To fix duplicate customer codes:

1. Open the Import Wizard from Financials > Customers > Import Customers.
2. Click "Validate" before "Run" — the validation pass produces a CSV of conflicting rows without writing anything to the database.
3. For each conflict, decide: (a) update the existing customer (set the Import Wizard's "Update existing records" toggle ON), or (b) renumber the incoming row with a unique CUSTNAME.
4. If you chose (a), the wizard merges field-by-field — empty cells in the import file leave existing fields untouched. Only non-empty cells overwrite. This is rarely what you want for fields like CREDLIMIT (credit limit), so review the diff preview before committing.
5. Re-run with "Run" once the conflict CSV is empty.

Common pitfalls:
- The Import Wizard treats CUSTNAME as case-sensitive. "ACME-001" and "acme-001" are two different customers; importing both will create duplicates Priority cannot then merge automatically.
- Trailing whitespace in the Excel cell is NOT trimmed. "ACME-001" and "ACME-001 " (trailing space) are different keys.
- If your Excel file uses formulas, the wizard reads the displayed VALUE not the formula text. Save the file with formulas resolved before import.`,
    source_pointer: `synthetic-fixture-${SEED_DATE}-duplicate-customer-codes`,
    last_verified_at: new Date("2026-05-27T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set en-009
    id: SEED_FIXTURE_IDS["en-009"],
    title: "Resolving 'cannot delete record - foreign key constraint' errors on customer deletion",
    category: "diagnostic",
    tags: ["customers", "errors", "foreign-key", "deletion"],
    body: `When attempting to delete a customer record (CUSTOMERS form), Priority returns:

    Error: cannot delete record - foreign key constraint

This error fires when one or more child records reference the customer. Priority's referential integrity prevents the delete to protect downstream data — sales orders, invoices, receipts, and contact records all point back to the customer row.

Diagnostic steps:

1. Open the customer in the CUSTOMERS form and run "Customer Activity" (Ctrl+Shift+F6 by default) to see open orders, open invoices, and open balances.
2. Run a quick check on the most common child tables:
   - ORDERS (open sales orders): set CUSTNAME filter, look for any non-closed status.
   - AINVOICES (A/R invoices): same filter, look for unpaid balance.
   - CUSTCONTACTS (contacts): customer must have zero contacts before delete.
3. If the customer is genuinely inactive but has historical records, the correct path is NOT to delete. Use the "Inactive" flag on the customer form. Priority will hide the customer from active selection lists but preserve referential integrity for historical reports.
4. If the customer is a test record with no historical value, you must delete in reverse order: contacts first, then any open documents (cancel orders, void invoices), then the customer.

When NOT to force-delete:
- Year-end audits require historical customer data to be reproducible. Deleting a customer that has invoices in a prior fiscal year breaks the audit trail. Inactive-flag is the only correct path post-year-end.
- The PRIV table records WHO performed historical actions — deleting linked privilege records can break the audit chain even when the FK constraint allows it.

If the constraint blocks a delete you genuinely need (e.g., a duplicate test customer created in error within the current open period), drop the linked rows in this order via the relevant forms: contacts (CUSTCONTACTS) → open orders (ORDERS, must be cancelled first) → customer (CUSTOMERS).`,
    source_pointer: `synthetic-fixture-${SEED_DATE}-fk-constraint-customer-delete`,
    last_verified_at: new Date("2026-05-27T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-003
    id: SEED_FIXTURE_IDS["he-003"],
    title: "הגדרת שנת כספים חדשה במודול הנהלת חשבונות",
    category: "procedural",
    tags: ["finance", "fiscal-year", "ledger", "hebrew"],
    body: `כדי לפתוח שנת כספים חדשה במודול הנהלת חשבונות בפריוריטי, יש לעבור על השלבים הבאים בסדר המתואר.

שלב 1 — הגדרת תקופות הדיווח החדשות:
היכנס לטופס "תקופות חשבונאיות" (PERIODS). לחץ על "פתח שנה חדשה". פריוריטי ייצור 12 תקופות חודשיות לשנה הקלנדרית הבאה, פלוס תקופה 13 (התאמות סוף שנה).

שלב 2 — סגירת היתרות של השנה הקודמת:
הרץ את "סגירת שנה" (CLOSEYR) רק לאחר שכל היומנים של השנה הקודמת אושרו ונרשמו. הסגירה יוצרת רשומות יומן אוטומטיות שמעבירות יתרות של חשבונות תוצאתיים לרווח/הפסד צבור, ויתרות מאזניות לפתיחת השנה החדשה.

שלב 3 — עדכון פרמטרי המערכת:
- ב-CONSTANTS, עדכן את הפרמטר CURYEAR לערך השנה החדשה.
- ב-CONSTANTS, עדכן את CURPERIOD לתקופה 1 של השנה החדשה.
- ודא שהפרמטר NEXTYEAR מכוון לשנה שאחרי הנוכחית, כדי שמסמכים עם תאריך עתידי לא ייכשלו על "תקופה לא קיימת".

שלב 4 — אימות:
- צור פקודת יומן בדיקה (יומן כללי) בתאריך מהשנה החדשה. אם הפקודה נשמרת ללא שגיאה — התקופות החדשות פעילות.
- הרץ את הדוח "מאזן בוחן" עבור התקופה 1 של השנה החדשה — אמורות להופיע יתרות פתיחה זהות ליתרות הסגירה של השנה הקודמת.

טעויות נפוצות:
- הרצת CLOSEYR לפני שכל היומנים נרשמו — יתרת הפתיחה לא תכלול את היומנים שלא היו רשומים.
- שכחה לעדכן את NEXTYEAR — מסמכים עם תאריך לשנה שאחרי הנוכחית ייכשלו.
- ביצוע שלב 3 לפני שלב 2 — פריוריטי ינסה לרשום יומנים בתקופה החדשה לפני שיתרות הפתיחה חושבו, מה שמייצר אי-עקביות במאזן.`,
    source_pointer: `synthetic-fixture-${SEED_DATE}-fiscal-year-setup-gl-he`,
    last_verified_at: new Date("2026-05-27T00:00:00Z"),
    sensitivity: "internal" as const,
  },
];

async function main(): Promise<number> {
  console.log(`seed-synthetic-entries — ${APPLY ? "APPLY MODE" : "DRY-RUN (default)"}`);
  console.log(`  ${SEED_ENTRIES.length} entries planned\n`);

  if (!process.env.DATABASE_URL) {
    console.error("FAIL: DATABASE_URL is not set (check .env.local).");
    return 1;
  }

  const db = getDb();
  const embedder = createStubEmbedder();

  // Pre-flight: check which source_pointers already exist. Idempotency.
  const existing = await db
    .select({ id: schema.entries.id, source_pointer: schema.entries.source_pointer })
    .from(schema.entries)
    .where(
      sql`${schema.entries.source_pointer} IN (${sql.join(
        SEED_ENTRIES.map((e) => sql`${e.source_pointer}`),
        sql`, `,
      )})`,
    );

  const existingPointers = new Set(existing.map((r) => r.source_pointer));
  if (existingPointers.size > 0) {
    console.log("  pre-existing source_pointers (will skip):");
    for (const row of existing) {
      console.log(`    - ${row.source_pointer}  (id=${row.id})`);
    }
    console.log();
  }

  const toInsert = SEED_ENTRIES.filter((e) => !existingPointers.has(e.source_pointer));

  if (toInsert.length === 0) {
    console.log("All synthetic entries already exist. Nothing to do.");
    return 0;
  }

  for (const entry of toInsert) {
    const prefix = APPLY ? "[INSERT]" : "[DRY-RUN]";
    console.log(`${prefix} ${entry.title}`);
    console.log(`           source_pointer: ${entry.source_pointer}`);
    console.log(`           sensitivity:    ${entry.sensitivity}`);
    console.log(`           category:       ${entry.category}`);
    console.log(`           body length:    ${entry.body.length} chars`);
    console.log();

    if (APPLY) {
      // Split the pinned `id` out of the IngestInput fields — createEntry takes
      // `id` as a top-level arg (it is NOT part of IngestInput).
      const { id: entryId, ...input } = entry;
      const result = await createEntry({
        db,
        embedder,
        input,
        id: entryId,
        source: { kind: "direct" },
      });
      console.log(
        `           → id=${result.id}, version_no=${result.version_no}, chunks=${result.chunk_count}`,
      );
      console.log();
    }
  }

  if (!APPLY) {
    console.log(`Dry-run complete. Re-run with --apply to commit ${toInsert.length} entries.`);
  } else {
    console.log(`Apply complete. ${toInsert.length} entries inserted.`);
    console.log("\nForensic verification:");
    console.log(
      "  SELECT id, title, source_pointer FROM entries WHERE source_pointer LIKE 'synthetic-fixture-%';",
    );
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
