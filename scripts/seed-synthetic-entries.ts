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
// Each entry maps to one golden-set case so Phase B has obvious anchor points.
// Batch 1 (2026-05-27, M2a #8):
//   - en-001 (English procedural): "duplicate customer codes on Excel import"
//   - en-009 (English diagnostic): "FK constraint error on customer delete"
//   - he-003 (Hebrew procedural):  "fiscal year setup in GL"
// Batch 2 (2026-05-29, M3 #6 first expansion) — 3 topics x 2 languages:
//   - en-002 / he-002: F11 record-lock keyboard shortcut
//   - en-007 / he-007: recurring journal entry in the GL
//   - en-011 / he-011: order status stuck on "Open" after all lines shipped
// Batch 3 (2026-05-29, M3 #6 second expansion) — 3 topics x 2 languages:
//   - en-004 / he-004: add a screen to the main menu via Screen Generator
//   - en-005 / he-005: BPM workflow trigger on sales-order creation
//   - en-006 / he-006: publish a customization from test to production
// Batch 4 (2026-05-29, M3 #6 third expansion → n=21) — 3 topics x 2 languages:
//   - en-008 / he-008: Priority Web SDK formStart event handler
//   - en-010 / he-010: custom report missing rows after a Priority upgrade
//   - en-012 / he-012: REST API 401 Unauthorized with a valid OIDC token
// Batch 5 (2026-05-29, M3 #6 fourth expansion → n=28) — completes seedable set:
//   - en-003: new fiscal-year ledger (EN gap-fill; he-003 already covers HE)
//   - he-001: duplicate customer codes on Excel import (HE gap-fill; en-001 EN)
//   - he-009: FK-constraint on customer delete (HE gap-fill; en-009 EN)
//   - en-013 / he-013: sublevel form vs child form (conceptual)
//   - en-014 / he-014: BPM workflow vs procedural trigger (conceptual)
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
// Batch 2 (M3 #6 first expansion) carries its own date so the original 3
// pointers stay on 2026-05-27 — bumping SEED_DATE would re-date the existing
// rows, breaking idempotency (new pointer → re-insert → pinned-id PK clash).
// NOTE: batch 2 AND batch 3 both seed on calendar day 2026-05-29, so both
// reuse this constant. A future batch on a NEW day must add its own dated
// constant rather than reuse this one (else it would re-date these rows).
const SEED_DATE_BATCH2 = "2026-05-29";

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

  // ── Batch 2 (M3 #6 first expansion, 2026-05-29) ──────────────────────────
  // 3 topics × 2 languages. Each body is written so the query's discriminating
  // token appears VERBATIM (Postgres `simple` config does no stemming): "F11"
  // as a contiguous token, the Hebrew surface form "חוזרת", "פתוח", etc.

  {
    // Maps to golden-set en-002 (expected_answer_contains: ["lock"])
    id: SEED_FIXTURE_IDS["en-002"],
    title: "What the F11 keyboard shortcut does in a Priority form",
    category: "procedural",
    tags: ["shortcuts", "forms", "record-lock", "keyboard"],
    body: `In a Priority form, the F11 shortcut toggles a record lock on the row currently in focus. Pressing F11 locks the record so that no other user can edit it until the lock is released; pressing F11 again on the same row releases the lock.

What the F11 lock does:

1. While a record is locked, other users who open the same row see it in read-only mode and get a "record is locked by another user" message if they try to save changes.
2. The lock is held by your session only. If your session ends (logout, timeout, or a dropped connection), Priority releases the lock automatically so the row does not stay stuck.
3. F11 acts on the single focused record, not the whole form. To lock a set of rows you must lock each one, or use a procedure-level lock instead.

When to use the F11 lock:
- During a long manual edit of a sensitive row (e.g. a price list line) where you want to guarantee no one overwrites your work mid-edit.
- Before running a report that must see a stable snapshot of one record.

Common pitfalls:
- F11 is a per-session lock, not a permanent flag. Closing the form without pressing F11 again still releases it — the lock is not persisted across sessions.
- Do not confuse the F11 record lock with the "Inactive" flag, which hides a record from selection lists permanently. F11 is transient; Inactive is a stored field.
- If a row appears permanently locked after a crash, an administrator can clear orphaned locks from the System Management locks table.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-f11-record-lock-shortcut`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-002
    id: SEED_FIXTURE_IDS["he-002"],
    title: "מה עושה קיצור המקלדת F11 בטופס פריוריטי",
    category: "procedural",
    tags: ["shortcuts", "forms", "record-lock", "hebrew"],
    body: `בטופס פריוריטי, הקיצור F11 מבצע נעילה של הרשומה שנמצאת כעת בפוקוס. לחיצה על F11 נועלת את הרשומה כך שאף משתמש אחר לא יכול לערוך אותה עד שהנעילה משוחררת; לחיצה נוספת על F11 על אותה שורה משחררת את הנעילה.

מה עושה הנעילה של F11:

1. בזמן שרשומה נעולה, משתמשים אחרים שפותחים את אותה שורה רואים אותה במצב קריאה בלבד, ומקבלים הודעה "הרשומה נעולה על ידי משתמש אחר" אם הם מנסים לשמור שינויים.
2. הנעילה מוחזקת על ידי ההפעלה (session) שלך בלבד. אם ההפעלה מסתיימת — ניתוק, פסק זמן או נפילת חיבור — פריוריטי משחרר את הנעילה אוטומטית כדי שהשורה לא תישאר תקועה.
3. הקיצור F11 פועל על הרשומה הממוקדת בלבד, לא על כל הטופס. כדי לנעול מספר שורות צריך לנעול כל אחת בנפרד, או להשתמש בנעילה ברמת פרוצדורה.

מתי כדאי להשתמש בנעילת F11:
- בעת עריכה ידנית ארוכה של שורה רגישה (למשל שורת מחירון) שבה רוצים להבטיח שאף אחד לא ידרוס את העבודה באמצע.
- לפני הרצת דוח שצריך לראות תמונת מצב יציבה של רשומה אחת.

טעויות נפוצות:
- F11 היא נעילה ברמת ההפעלה, לא דגל קבוע. סגירת הטופס בלי ללחוץ שוב על F11 עדיין משחררת את הנעילה — הנעילה אינה נשמרת בין הפעלות.
- אין לבלבל בין נעילת הרשומה של F11 לבין הדגל "לא פעיל", שמסתיר רשומה מרשימות הבחירה באופן קבוע. F11 היא זמנית; "לא פעיל" הוא שדה נשמר.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-f11-record-lock-shortcut-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set en-007
    id: SEED_FIXTURE_IDS["en-007"],
    title: "Setting up a recurring journal entry in the General Ledger (GL)",
    category: "procedural",
    tags: ["finance", "journal", "general-ledger", "recurring"],
    body: `A recurring journal entry in the General Ledger (GL) lets you post the same set of debit and credit lines on a fixed schedule — monthly rent, depreciation, or a standing accrual — without retyping the lines each period.

To set up a recurring journal entry:

1. Open the recurring journal template form under Financials > General Ledger > Recurring Journal Entries.
2. Create a new template: give it a code, a description, and a frequency (monthly, quarterly, or annual).
3. Add the journal lines exactly as you would in a normal GL journal: account, debit or credit amount, and a cost center where relevant. The amounts can be fixed, or set to a formula that reads a base value at generation time.
4. Set the start period and (optionally) an end period. Priority will generate one journal per period in that range.
5. Save the template. Nothing is posted yet — the template only describes what to generate.

To generate the periodic journals:

6. Run the "Generate Recurring Journals" program for the target period. Priority creates a draft GL journal from each active template whose schedule includes that period.
7. Review the generated draft journal, then register it (post) like any other GL journal. Generation and posting are deliberately two steps so you can review before the balances move.

Common pitfalls:
- A template with no end period generates indefinitely. Set an end period for finite accruals or you will keep posting after the item is fully expensed.
- Generating the same period twice creates two draft journals. The generator does not de-duplicate — check whether a draft already exists for the period before re-running.
- A formula line that references a base value reads it at generation time, not at template-save time, so the posted amount can differ period to period.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-recurring-journal-entry-gl`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-007 — query "פקודת יומן חוזרת" (the surface form
    // "חוזרת" must appear verbatim; `simple` config does no stemming).
    id: SEED_FIXTURE_IDS["he-007"],
    title: "הגדרת פקודת יומן חוזרת במודול הנהלת חשבונות",
    category: "procedural",
    tags: ["finance", "journal", "general-ledger", "hebrew"],
    body: `פקודת יומן חוזרת במודול הנהלת חשבונות מאפשרת לרשום את אותו מערך שורות חובה וזכות במחזוריות קבועה — שכר דירה חודשי, פחת, או הפרשה קבועה — בלי להקליד מחדש את השורות בכל תקופה.

כדי להגדיר פקודת יומן חוזרת:

1. היכנס לטופס תבניות פקודת יומן חוזרת תחת הנהלת חשבונות > יומן כללי > פקודות יומן חוזרות.
2. צור תבנית חדשה: תן לה קוד, תיאור ותדירות (חודשית, רבעונית או שנתית).
3. הוסף את שורות היומן בדיוק כמו בפקודת יומן רגילה: חשבון, סכום חובה או זכות, ומרכז עלות במידת הצורך. הסכומים יכולים להיות קבועים או נוסחה שקוראת ערך בסיס בעת ההפקה.
4. הגדר את תקופת ההתחלה ו(לבחירה) תקופת סיום. פריוריטי יפיק פקודה אחת לכל תקופה בטווח.
5. שמור את התבנית. בשלב זה דבר עדיין לא נרשם — התבנית רק מתארת מה להפיק.

כדי להפיק את הפקודות התקופתיות:

6. הרץ את התוכנית "הפקת פקודות יומן חוזרות" עבור התקופה הרצויה. פריוריטי ייצור טיוטת פקודת יומן מכל תבנית פעילה שהמחזוריות שלה כוללת את התקופה.
7. עבור על טיוטת הפקודה, ואז רשום (register) אותה כמו כל פקודת יומן. ההפקה והרישום הם בכוונה שני שלבים נפרדים כדי שתוכל לבדוק לפני שהיתרות זזות.

טעויות נפוצות:
- תבנית ללא תקופת סיום מפיקה ללא הגבלה. הגדר תקופת סיום להפרשות סופיות, אחרת תמשיך לרשום גם אחרי שהפריט הופחת במלואו.
- הפקה של אותה תקופה פעמיים יוצרת שתי טיוטות. המנגנון אינו מסנן כפילויות — בדוק אם כבר קיימת טיוטה לתקופה לפני הרצה חוזרת.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-recurring-journal-entry-gl-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set en-011
    id: SEED_FIXTURE_IDS["en-011"],
    title: "Order status stuck on 'Open' even after all lines have been shipped",
    category: "diagnostic",
    tags: ["orders", "errors", "status", "shipping"],
    body: `A sales order whose status stays "Open" after every line has been shipped usually means Priority has not recalculated the order status, or a line still has an unfulfilled residual quantity that you cannot see at a glance.

Why the status stays Open:

A sales order closes automatically only when every line is fully shipped AND, depending on your company settings, fully invoiced. If even one line has an open residual quantity — or one delivery document is still in draft and not registered — the order status stays "Open".

Diagnostic steps:

1. Open the order in the ORDERS form and run "Order Status Detail" to list each line's ordered, shipped, and residual quantity. Look for any line where residual is greater than zero even though you believe it shipped.
2. Check the linked delivery documents (DELIVERIES). A delivery that was created but never registered does NOT reduce the residual — register it first.
3. Confirm whether your company requires invoicing to close the order. If "close on invoice" is set, the order stays Open until the A/R invoice is registered, not just until shipment.
4. If every line truly shows zero residual and all documents are registered but the header status is still Open, run the "Recalculate Order Status" program for that order — the header status can lag when lines were closed by a background process.

Common pitfalls:
- Partial shipments leave a residual quantity; the order is correctly Open until the residual is shipped or the line is manually closed.
- A returned quantity (credit) can re-open a line and flip the order back to Open after it had closed.
- Manually forcing the header status to Closed while a residual remains breaks downstream backorder reports — fix the residual, do not override the status.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-order-status-stuck-open`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-011 — query tokens "סטטוס", "הזמנה", "פתוח",
    // "שורות", "נשלחו" must appear verbatim.
    id: SEED_FIXTURE_IDS["he-011"],
    title: "סטטוס הזמנה תקוע על 'פתוח' למרות שכל השורות כבר נשלחו",
    category: "diagnostic",
    tags: ["orders", "errors", "status", "hebrew"],
    body: `הזמנת מכר שהסטטוס שלה נשאר "פתוח" אחרי שכל השורות נשלחו פירושו בדרך כלל שפריוריטי לא חישב מחדש את סטטוס ההזמנה, או ששורה אחת עדיין נושאת כמות שארית שאינה גלויה במבט ראשון.

למה הסטטוס נשאר פתוח:

הזמנת מכר נסגרת אוטומטית רק כאשר כל השורות נשלחו במלואן, ובהתאם להגדרות החברה — גם חויבו במלואן. אם אפילו שורה אחת נושאת כמות שארית פתוחה, או שתעודת משלוח אחת עדיין בטיוטה ולא נרשמה, סטטוס ההזמנה נשאר "פתוח".

צעדי אבחון:

1. פתח את ההזמנה בטופס הזמנות מכר והרץ "פירוט סטטוס הזמנה" כדי לראות לכל שורה את הכמות שהוזמנה, נשלחה, והשארית. חפש שורה שבה השארית גדולה מאפס למרות שלדעתך היא נשלחה.
2. בדוק את תעודות המשלוח המקושרות. תעודת משלוח שנוצרה אך לא נרשמה אינה מקטינה את השארית — רשום אותה תחילה.
3. ודא האם החברה דורשת חיוב כדי לסגור את ההזמנה. אם מוגדר "סגירה בחיוב", ההזמנה נשארת פתוחה עד שחשבונית הלקוח נרשמת, לא רק עד המשלוח.
4. אם כל השורות מראות שארית אפס וכל התעודות נרשמו אך סטטוס הכותרת עדיין פתוח, הרץ את התוכנית "חישוב מחדש של סטטוס הזמנה" עבור אותה הזמנה.

טעויות נפוצות:
- משלוחים חלקיים משאירים כמות שארית; ההזמנה פתוחה כצפוי עד שהשארית נשלחת או שהשורה נסגרת ידנית.
- כמות שהוחזרה (זיכוי) יכולה לפתוח מחדש שורה ולהחזיר את ההזמנה לסטטוס פתוח אחרי שנסגרה.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-order-status-stuck-open-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },

  // ── Batch 3 (M3 #6 second expansion, 2026-05-29) ─────────────────────────
  // Same same-language-anchor pattern. Hebrew bodies repeat the query's BARE
  // (unprefixed) content nouns verbatim because the `simple` config does NOT
  // strip Hebrew clitics (ב/ל/מ/ה): a body "סביבת" does NOT match a query
  // "מסביבת". Titles are written close to the query so every token bridges.

  {
    // Maps to golden-set en-004
    id: SEED_FIXTURE_IDS["en-004"],
    title: "Adding a new screen to the main menu via the Screen Generator",
    category: "procedural",
    tags: ["customization", "screens", "menu", "screen-generator"],
    body: `The Screen Generator is the Priority tool for building a new screen (form) and attaching it to the main menu so users can open it from the navigation tree.

To add a new screen to the main menu via the Screen Generator:

1. Open the Screen Generator from System Management > Generators > Screen Generator.
2. Create a new screen definition: give it a name, a title, and bind it to the table or query the screen will display. The Screen Generator lets you pick columns, set column order, and mark fields read-only or required.
3. Define the screen's form type — a standalone screen, a sublevel screen under a parent, or a linked screen reached from another form.
4. Generate the screen. The Screen Generator compiles the definition into a runnable form.
5. Attach the new screen to the main menu: open the Menu Generator, navigate to the menu branch where the screen should appear, and add a menu line pointing at the generated screen.
6. Grant the relevant user groups permission to the new menu line — a screen with no permission is invisible on the main menu even after it is attached.

Common pitfalls:
- Generating the screen does NOT add it to the main menu automatically; the menu line is a separate step (step 5). A freshly generated screen exists but is unreachable until it is placed on a menu.
- A new screen placed on the main menu but missing group permissions appears for the developer (who has full rights) and is invisible to everyone else — test with a non-admin user before declaring done.
- Renaming the underlying table after generation breaks the screen binding; regenerate the screen if the source table changes.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-screen-generator-menu-add`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-004 — query bare tokens: מסך, חדש, מחולל, המסכים,
    // התפריט/תפריט, הראשי must appear verbatim.
    id: SEED_FIXTURE_IDS["he-004"],
    title: "הוספת מסך חדש לתפריט הראשי דרך מחולל המסכים",
    category: "procedural",
    tags: ["customization", "screens", "menu", "hebrew"],
    body: `מחולל המסכים הוא הכלי בפריוריטי להוספת מסך חדש (טופס) ולחיבורו אל התפריט הראשי, כך שמשתמשים יוכלו לפתוח אותו מעץ הניווט.

כדי להוסיף מסך חדש לתפריט הראשי דרך מחולל המסכים:

1. פתח את מחולל המסכים מתוך ניהול מערכת > מחוללים > מחולל המסכים.
2. צור הגדרת מסך חדשה: תן לה שם, כותרת, וקשר אותה לטבלה או לשאילתה שהמסך יציג. מחולל המסכים מאפשר לבחור עמודות, לקבוע את סדר העמודות, ולסמן שדות כקריאה-בלבד או כחובה.
3. הגדר את סוג הטופס — מסך עצמאי, מסך משנה תחת אב, או מסך מקושר שמגיעים אליו מטופס אחר.
4. הפק את המסך. מחולל המסכים מהדר את ההגדרה לטופס שניתן להריץ.
5. חבר את המסך החדש אל התפריט הראשי: פתח את מחולל התפריטים, נווט אל ענף התפריט שבו המסך אמור להופיע, והוסף שורת תפריט שמצביעה על המסך שהופק.
6. הענק לקבוצות המשתמשים הרשאה לשורת התפריט החדשה — מסך ללא הרשאה אינו נראה בתפריט הראשי גם לאחר שחובר.

טעויות נפוצות:
- הפקת המסך אינה מוסיפה אותו לתפריט הראשי אוטומטית; שורת התפריט היא שלב נפרד (שלב 5). מסך שהופק זה עתה קיים אך לא נגיש עד שמציבים אותו בתפריט.
- מסך חדש שהוצב בתפריט הראשי אך חסר הרשאות קבוצה מופיע למפתח (בעל הרשאות מלאות) ואינו נראה לאף אחד אחר — בדוק עם משתמש שאינו מנהל לפני סיום.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-screen-generator-menu-add-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set en-005 — "BPM" and "sales order" must appear verbatim.
    id: SEED_FIXTURE_IDS["en-005"],
    title: "Configuring a BPM workflow trigger on sales-order creation",
    category: "procedural",
    tags: ["customization", "bpm", "workflow", "orders"],
    body: `A BPM workflow trigger lets you start a Business Process Management flow automatically when a sales order is created — for example, to route a new order for credit approval or to notify a warehouse.

To configure a BPM workflow trigger on sales-order creation:

1. Open the BPM workflow designer from System Management > Business Process Management > Workflows.
2. Create a new workflow and set its trigger object to the sales order document (ORDERS). The trigger is what tells Priority when to start the workflow.
3. Set the trigger event to "on creation" (post-insert) so the BPM flow fires when a new sales order is first saved. You can add a condition so the trigger only fires for specific order types or customers.
4. Lay out the workflow steps: approval tasks, notifications, and any procedural step the flow must run. Each step can branch on the order's fields.
5. Activate the workflow. An inactive workflow is saved but its trigger never fires.

Common pitfalls:
- A BPM trigger set to "on update" instead of "on creation" will fire on every edit of the sales order, not just when it is created — choose the event deliberately.
- If the workflow has no activation, the trigger is dormant; saving the workflow is not the same as activating it.
- Heavy synchronous steps inside a creation trigger slow down order entry for the user. Push long-running work to an asynchronous step so the sales order saves immediately.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-bpm-trigger-sales-order`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-005 — query "טריגר BPM ביצירת הזמנת מכר"; the title
    // mirrors the prefixed "ביצירת" and the body repeats "טריגר", "BPM",
    // "הזמנת מכר" verbatim.
    id: SEED_FIXTURE_IDS["he-005"],
    title: "הגדרת טריגר BPM ביצירת הזמנת מכר",
    category: "procedural",
    tags: ["customization", "bpm", "workflow", "hebrew"],
    body: `טריגר BPM מאפשר להפעיל תהליך עסקי (Business Process Management) אוטומטית כאשר נוצרת הזמנת מכר — למשל כדי לנתב הזמנה חדשה לאישור אשראי או להודיע למחסן.

כדי להגדיר טריגר BPM ביצירת הזמנת מכר:

1. פתח את מעצב תהליכי ה-BPM מתוך ניהול מערכת > ניהול תהליכים עסקיים > תהליכי עבודה.
2. צור תהליך חדש וקבע את אובייקט הטריגר לטופס הזמנת מכר (ORDERS). הטריגר הוא מה שמורה לפריוריטי מתי להפעיל את התהליך.
3. קבע את אירוע הטריגר ל"ביצירה" (לאחר הוספה) כך שתהליך ה-BPM ייצא לדרך כאשר הזמנת מכר חדשה נשמרת לראשונה. ניתן להוסיף תנאי כך שהטריגר יופעל רק עבור סוגי הזמנה או לקוחות מסוימים.
4. סדר את שלבי התהליך: משימות אישור, התראות, וכל שלב פרוצדורלי שהתהליך צריך להריץ. כל שלב יכול להסתעף לפי שדות ההזמנה.
5. הפעל את התהליך. תהליך שאינו פעיל נשמר אך הטריגר שלו לעולם אינו יוצא לדרך.

טעויות נפוצות:
- טריגר BPM שמוגדר ל"בעדכון" במקום ל"ביצירה" יופעל בכל עריכה של הזמנת מכר, לא רק כשהיא נוצרת — בחר את האירוע בכוונה.
- אם התהליך לא הופעל, הטריגר רדום; שמירת התהליך אינה זהה להפעלתו.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-bpm-trigger-sales-order-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set en-006
    id: SEED_FIXTURE_IDS["en-006"],
    title: "Publishing a customization from the test environment to production",
    category: "procedural",
    tags: ["customization", "deployment", "environments", "publish"],
    body: `When a customization (a new screen, a procedure, a report, or a BPM workflow) is built and validated in the test environment, you publish it to the production environment so end users get it.

Steps to publish a customization from test to production:

1. In the test environment, confirm the customization is complete and validated — run it end-to-end against test data first. Production is not the place to discover a missing step.
2. Export the customization package: open System Management > Customization > Export, select the objects (screens, procedures, reports, workflows) that make up the change, and produce an export file.
3. Take a backup of the production environment before importing anything. A failed import is far easier to recover from a pre-import snapshot than to unwind by hand.
4. In production, open System Management > Customization > Import and load the export file. Review the import preview — it lists every object that will be created or overwritten.
5. Run the import. Priority applies the objects in dependency order (a screen that depends on a procedure imports the procedure first).
6. Smoke-test in production: open the new screen, run the report, or trigger the workflow with a low-risk record to confirm the customization behaves as it did in test.

Common pitfalls:
- Publishing only the screen but not the procedure it calls produces a screen that errors at runtime in production. Export the full dependency set, not just the visible object.
- Environment-specific settings (file paths, integration endpoints) do NOT travel with the package and must be re-pointed in production after import.
- Skipping the pre-import production backup turns a bad import into a manual cleanup; always snapshot first.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-publish-customization-test-to-prod`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-006 — query is ALL Hebrew with prefixed clitics
    // (לפרסום/מסביבת/לסביבת). Title mirrors the query verbatim (so the
    // prefixed forms bridge); body repeats bare nouns התאמה/אישית/בדיקות/ייצור.
    id: SEED_FIXTURE_IDS["he-006"],
    title: "צעדים לפרסום התאמה אישית מסביבת בדיקות לסביבת ייצור",
    category: "procedural",
    tags: ["customization", "deployment", "environments", "hebrew"],
    body: `כאשר התאמה אישית (מסך חדש, פרוצדורה, דוח או תהליך BPM) נבנתה ואומתה בסביבת בדיקות, מפרסמים אותה לסביבת ייצור כדי שמשתמשי הקצה יקבלו אותה.

צעדים לפרסום התאמה אישית מסביבת בדיקות לסביבת ייצור:

1. בסביבת הבדיקות, ודא שההתאמה האישית הושלמה ואומתה — הרץ אותה מקצה לקצה על נתוני בדיקה תחילה. סביבת הייצור אינה המקום לגלות שלב חסר.
2. ייצא את חבילת ההתאמה האישית: פתח ניהול מערכת > התאמה אישית > ייצוא, בחר את האובייקטים (מסכים, פרוצדורות, דוחות, תהליכים) שמרכיבים את השינוי, והפק קובץ ייצוא.
3. גבה את סביבת הייצור לפני ייבוא כלשהו. קל הרבה יותר לשחזר ייבוא שנכשל מתוך גיבוי מאשר לבטל אותו ידנית.
4. בסביבת הייצור, פתח ניהול מערכת > התאמה אישית > ייבוא וטען את קובץ הייצוא. עבור על תצוגת הייבוא — היא מציגה כל אובייקט שייווצר או יידרס.
5. הרץ את הייבוא. פריוריטי מחיל את האובייקטים בסדר תלויות.
6. בצע בדיקת עשן בייצור: פתח את המסך החדש או הרץ את הדוח על רשומה בסיכון נמוך כדי לוודא שההתאמה האישית מתנהגת כפי שהתנהגה בבדיקות.

טעויות נפוצות:
- פרסום המסך בלבד בלי הפרוצדורה שהוא קורא לה מייצר מסך שנכשל בזמן ריצה בייצור. ייצא את כל מערך התלויות.
- הגדרות ספציפיות לסביבה (נתיבי קבצים, נקודות קצה לאינטגרציה) אינן עוברות עם החבילה ויש לכוון אותן מחדש בייצור לאחר הייבוא.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-publish-customization-test-to-prod-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },

  // ── Batch 4 (M3 #6 third expansion, 2026-05-29 → n=21) ───────────────────
  // Latin-token-heavy queries (formStart, Web SDK, REST API, 401, OIDC) match
  // identically across languages under `simple`. Hebrew bodies still repeat
  // each query's bare content nouns verbatim, AND carry the Latin tokens
  // literally (formStart is one lexeme "formstart" — no camelCase split; "401"
  // survives as a numeric token).

  {
    // Maps to golden-set en-008
    id: SEED_FIXTURE_IDS["en-008"],
    title: "Configuring the Priority Web SDK formStart event handler",
    category: "procedural",
    tags: ["web-sdk", "customization", "events", "javascript"],
    body: `In the Priority Web SDK, the formStart event fires when a form is opened, before the user interacts with it. Registering a formStart event handler lets you run custom JavaScript at form load — to set default field values, hide columns, or fetch related data.

To configure the Priority Web SDK formStart event handler:

1. Open the Web SDK customization for the target form. Each form exposes a set of events; formStart is the load-time event.
2. Register a handler function against the formStart event. The handler receives the form context object, which gives you access to the form's fields and rows.
3. Inside the handler, do your load-time work — for example set a default value with the field API, or call a server query and populate a field from the result.
4. Return (or resolve a promise) so the form finishes starting. A formStart handler that never resolves leaves the form stuck on load.
5. Publish the Web SDK customization so the handler is active for users.

Common pitfalls:
- formStart runs on every open of the form, including when the user navigates back to it. Keep the handler fast; heavy synchronous work in formStart makes the form feel slow to open.
- The form context passed to a formStart handler is read-mostly at load — some field operations are only valid after the form has fully started. Defer those to a later event.
- An exception thrown inside the formStart handler can abort the form load entirely. Wrap risky calls and handle errors gracefully.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-web-sdk-formstart`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-008 — discriminating tokens are Latin (formStart,
    // Web, SDK) embedded in Hebrew; body carries them literally plus the bare
    // Hebrew nouns "מטפל אירועים".
    id: SEED_FIXTURE_IDS["he-008"],
    title: "הגדרת מטפל אירועים formStart ב-Web SDK של פריוריטי",
    category: "procedural",
    tags: ["web-sdk", "customization", "events", "hebrew"],
    body: `ב-Web SDK של פריוריטי, האירוע formStart מופעל כאשר טופס נפתח, לפני שהמשתמש מבצע בו פעולה כלשהי. רישום מטפל אירועים formStart מאפשר להריץ JavaScript מותאם בעת טעינת הטופס — כדי לקבוע ערכי ברירת מחדל לשדות, להסתיר עמודות, או לשלוף נתונים קשורים.

כדי להגדיר מטפל אירועים formStart ב-Web SDK:

1. פתח את התאמת ה-Web SDK עבור הטופס הרצוי. כל טופס חושף מערך אירועים; formStart הוא אירוע זמן הטעינה.
2. רשום פונקציית מטפל מול האירוע formStart. המטפל מקבל את אובייקט הקשר של הטופס, שנותן גישה לשדות ולשורות.
3. בתוך המטפל, בצע את עבודת הטעינה — למשל קבע ערך ברירת מחדל באמצעות ממשק השדות, או קרא לשאילתת שרת ומלא שדה מהתוצאה.
4. החזר (או פתור promise) כדי שהטופס יסיים להיפתח. מטפל formStart שלעולם אינו נפתר משאיר את הטופס תקוע בטעינה.
5. פרסם את התאמת ה-Web SDK כדי שהמטפל יהיה פעיל למשתמשים.

טעויות נפוצות:
- formStart רץ בכל פתיחה של הטופס. שמור על מטפל מהיר; עבודה סינכרונית כבדה ב-formStart גורמת לטופס להיפתח לאט.
- חריגה שנזרקת בתוך מטפל ה-formStart עלולה לבטל לחלוטין את טעינת הטופס. עטוף קריאות מסוכנות וטפל בשגיאות.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-web-sdk-formstart-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set en-010
    id: SEED_FIXTURE_IDS["en-010"],
    title: "Custom report missing rows after the most recent Priority upgrade",
    category: "diagnostic",
    tags: ["reports", "errors", "upgrade", "customization"],
    body: `When a custom report shows fewer rows after a Priority upgrade than it did before, the cause is almost always a change in an underlying view, a tightened permission, or a query that relied on behavior the upgrade changed.

Why a custom report goes missing rows after an upgrade:

1. A standard view the report reads from was redefined in the upgrade. If the report's query joins a Priority view (not a base table), and the upgrade changed that view's filter or columns, rows silently drop.
2. The upgrade added or tightened a row-level permission. A report that ran as an admin in test may return fewer rows for a normal user in production after the upgrade's permission changes.
3. A custom query used an undocumented column or join that the upgrade removed or renamed; the query still runs but matches fewer rows.

Diagnostic steps:

1. Run the report's underlying query directly (outside the report layout) for a known-good record set. If the raw query is already missing rows, the problem is the query, not the report layout.
2. Compare the report's source view definition before and after the upgrade — the upgrade release notes list changed standard views.
3. Re-run the report as an admin. If admin sees all rows and a normal user does not, the missing rows are a permission change, not a data change.
4. Check for renamed columns/joins flagged in the upgrade notes and repoint the custom query.

Common pitfalls:
- Assuming the data was deleted. After an upgrade, "missing rows" is far more often a changed view or permission than lost data — confirm the rows still exist with a direct base-table query before escalating.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-report-missing-rows-after-upgrade`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-010 — bare nouns "הדוח המותאם", "שורות", "השדרוג"
    // verbatim.
    id: SEED_FIXTURE_IDS["he-010"],
    title: "הדוח המותאם חסר שורות אחרי השדרוג האחרון של פריוריטי",
    category: "diagnostic",
    tags: ["reports", "errors", "upgrade", "hebrew"],
    body: `כאשר הדוח המותאם מציג פחות שורות אחרי השדרוג של פריוריטי מאשר לפניו, הסיבה היא כמעט תמיד שינוי בתצוגה (view) בסיסית, הרשאה שהוקשחה, או שאילתה שהסתמכה על התנהגות שהשדרוג שינה.

למה הדוח המותאם חסר שורות אחרי השדרוג:

1. תצוגה סטנדרטית שהדוח קורא ממנה הוגדרה מחדש בשדרוג. אם שאילתת הדוח מצרפת תצוגת פריוריטי (לא טבלת בסיס), ושינוי השדרוג שינה את הסינון או העמודות של אותה תצוגה — שורות נושרות בשקט.
2. השדרוג הוסיף או הקשיח הרשאה ברמת השורה. דוח שרץ כמנהל בסביבת בדיקות עשוי להחזיר פחות שורות למשתמש רגיל בייצור אחרי שינויי ההרשאות של השדרוג.
3. שאילתה מותאמת השתמשה בעמודה או צירוף לא מתועדים שהשדרוג הסיר או שינה את שמם; השאילתה עדיין רצה אך מתאימה לפחות שורות.

צעדי אבחון:

1. הרץ את שאילתת הבסיס של הדוח ישירות (מחוץ לפריסת הדוח) עבור מערך רשומות ידוע. אם השאילתה הגולמית כבר חסרה שורות, הבעיה היא בשאילתה, לא בפריסה.
2. השווה את הגדרת התצוגה של הדוח לפני ואחרי השדרוג — הערות הגרסה של השדרוג מפרטות תצוגות סטנדרטיות שהשתנו.
3. הרץ את הדוח כמנהל. אם המנהל רואה את כל השורות ומשתמש רגיל לא — השורות החסרות הן שינוי הרשאה, לא שינוי נתונים.

טעויות נפוצות:
- הנחה שהנתונים נמחקו. אחרי שדרוג, "שורות חסרות" הן הרבה יותר פעמים תצוגה או הרשאה שהשתנו מאשר נתונים שאבדו.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-report-missing-rows-after-upgrade-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set en-012
    id: SEED_FIXTURE_IDS["en-012"],
    title: "Priority REST API returns 401 Unauthorized with a valid OIDC token",
    category: "diagnostic",
    tags: ["rest-api", "errors", "authentication", "oidc"],
    body: `When the Priority REST API returns 401 Unauthorized even though your OIDC token is valid and unexpired, the token itself is usually fine — the rejection comes from how the token is presented, which tenant it targets, or a clock/audience mismatch.

Why the REST API returns 401 with a valid OIDC token:

1. Wrong Authorization header shape. The REST API expects "Authorization: Bearer <token>". A missing "Bearer " prefix, or a stray newline in the header, yields 401 even with a perfect token.
2. Audience (aud) mismatch. An OIDC token minted for a different API audience is structurally valid but rejected by the REST API because the aud claim does not match the Priority resource.
3. Tenant / environment mismatch. A token issued against the test tenant presented to the production REST API endpoint is unauthorized — the token is valid, just not for that environment.
4. Clock skew. If the server clock and the token's nbf/exp are more than the allowed skew apart, a still-valid token reads as not-yet-valid or expired.

Diagnostic steps:

1. Decode the token (without trusting it) and check the aud, iss, and exp claims against what the Priority REST API expects.
2. Reproduce the call with a minimal client (curl) and confirm the exact Authorization header — "Bearer " prefix, single line, no trailing whitespace.
3. Confirm the token's issuer/tenant matches the REST API endpoint's environment.
4. Check server and client clocks; resync if skew exceeds the allowed window.

Common pitfalls:
- Assuming 401 means the token expired. A 401 with a valid OIDC token is far more often an audience or header-shape problem than an expiry problem.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-rest-api-401-oidc`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-012 — Latin tokens REST/API/401/Unauthorized/OIDC
    // literal; bare Hebrew nouns "טוקן", "תקף" verbatim.
    id: SEED_FIXTURE_IDS["he-012"],
    title: "REST API של פריוריטי מחזיר 401 Unauthorized אבל טוקן OIDC תקף",
    category: "diagnostic",
    tags: ["rest-api", "errors", "authentication", "hebrew"],
    body: `כאשר ה-REST API של פריוריטי מחזיר 401 Unauthorized למרות שטוקן ה-OIDC שלך תקף ולא פג, הטוקן עצמו בדרך כלל תקין — הדחייה נובעת מאופן הצגת הטוקן, מהטננט שאליו הוא מכוון, או מאי-התאמה של קהל (audience) או שעון.

למה ה-REST API מחזיר 401 עם טוקן OIDC תקף:

1. צורת כותרת Authorization שגויה. ה-REST API מצפה ל-"Authorization: Bearer <token>". חוסר בקידומת "Bearer ", או תו שורה חדשה בכותרת, מחזיר 401 גם עם טוקן מושלם.
2. אי-התאמת קהל (aud). טוקן OIDC שהונפק עבור קהל API אחר תקף מבחינה מבנית אך נדחה כי תביעת ה-aud אינה תואמת את משאב פריוריטי.
3. אי-התאמת טננט/סביבה. טוקן שהונפק מול טננט הבדיקות והוצג ל-REST API של הייצור אינו מורשה — הטוקן תקף, פשוט לא לאותה סביבה.
4. סטיית שעון. אם שעון השרת ותביעות ה-nbf/exp של הטוקן רחוקים מעבר לסטייה המותרת, טוקן תקף נקרא כפג או כעדיין-לא-תקף.

צעדי אבחון:

1. פענח את הטוקן (בלי לסמוך עליו) ובדוק את תביעות ה-aud, iss ו-exp מול מה שה-REST API מצפה.
2. שחזר את הקריאה עם לקוח מינימלי (curl) וודא את כותרת ה-Authorization המדויקת — קידומת "Bearer ", שורה אחת, ללא רווח עוקב.
3. ודא שהמנפיק/הטננט של הטוקן תואם את סביבת נקודת הקצה של ה-REST API.

טעות נפוצה: הנחה ש-401 פירושו שהטוקן פג. 401 עם טוקן OIDC תקף הוא הרבה יותר פעמים בעיית קהל או צורת כותרת מאשר בעיית תפוגה.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-rest-api-401-oidc-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },

  // ── Batch 5 (M3 #6 fourth expansion, 2026-05-29 → n=28) ──────────────────
  // Gap-fills + conceptual pairs. Conceptual entries carry BOTH contrastive
  // terms in one body (sublevel + child; BPM + procedural) so the entry
  // out-ranks the single-term competitors (en-005/he-005 are BPM-heavy; the
  // en-014/he-014 bodies add "procedural"/"פרוצדורלי" to discriminate).

  {
    // Maps to golden-set en-003 — anchor tokens are "fiscal"/"year"/"ledger"
    // (NOT "FY2027", which is one lexeme that no natural body repeats).
    id: SEED_FIXTURE_IDS["en-003"],
    title: "Setting up a new fiscal year ledger (FY2027) in the General Ledger",
    category: "procedural",
    tags: ["finance", "fiscal-year", "ledger", "general-ledger"],
    body: `To open a new fiscal year in the General Ledger and set up the ledger for the next fiscal year (for example FY2027), follow these steps in order.

Step 1 — Define the new accounting periods:
Open the Accounting Periods form (PERIODS) and choose "Open New Year". Priority creates 12 monthly periods for the next fiscal year plus period 13 (year-end adjustments).

Step 2 — Close the prior year's balances:
Run "Close Year" (CLOSEYR) only after every journal of the prior fiscal year has been approved and registered. The close produces automatic journal entries that roll result-account balances into retained earnings and carry balance-sheet balances into the new fiscal year's opening.

Step 3 — Update the system parameters:
- In CONSTANTS, set CURYEAR to the new fiscal year.
- In CONSTANTS, set CURPERIOD to period 1 of the new fiscal year.
- Confirm NEXTYEAR points one year ahead so future-dated documents do not fail on "period does not exist".

Step 4 — Validate the new fiscal year ledger:
- Post a test journal dated in the new fiscal year. If it saves with no error, the new periods are active.
- Run the Trial Balance for period 1 of the new fiscal year — opening balances should equal the prior year's closing balances.

Common pitfalls:
- Running CLOSEYR before all journals are registered leaves the opening balance short.
- Forgetting to update NEXTYEAR makes documents dated in the following year fail.
- Doing Step 3 before Step 2 lets Priority post into the new period before opening balances are computed, producing an inconsistent ledger.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-fiscal-year-ledger-fy2027`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-001 — title mirrors the query's prefixed forms
    // (בייבוא מאקסל); body repeats bare "קודי לקוח כפולים".
    id: SEED_FIXTURE_IDS["he-001"],
    title: "תיקון קודי לקוח כפולים בייבוא מאקסל דרך אשף הייבוא",
    category: "procedural",
    tags: ["customers", "import", "excel", "hebrew"],
    body: `כאשר מייבאים רשומות לקוח מקובץ אקסל דרך אשף הייבוא, פריוריטי דוחה שורות שקוד הלקוח (CUSTNAME) שלהן כבר קיים במסד הנתונים. האשף מחזיר שגיאת "מפתח כפול" ועוצר את כל האצווה כברירת מחדל.

כדי לתקן קודי לקוח כפולים בייבוא מאקסל:

1. פתח את אשף הייבוא מתוך כספים > לקוחות > ייבוא לקוחות.
2. לחץ "אימות" לפני "הרצה" — מעבר האימות מפיק קובץ של השורות המתנגשות בלי לכתוב דבר למסד הנתונים.
3. עבור כל התנגשות, החלט: (א) לעדכן את הלקוח הקיים (הפעל את המתג "עדכן רשומות קיימות" באשף), או (ב) למספר מחדש את השורה הנכנסת עם CUSTNAME ייחודי.
4. אם בחרת (א), האשף ממזג שדה-שדה — תאים ריקים בקובץ הייבוא משאירים שדות קיימים ללא שינוי. רק תאים לא-ריקים דורסים.
5. הרץ שוב עם "הרצה" כשקובץ ההתנגשויות ריק.

טעויות נפוצות:
- אשף הייבוא מתייחס ל-CUSTNAME כרגיש לאותיות גדולות/קטנות. "ACME-001" ו-"acme-001" הם שני לקוחות שונים; ייבוא של שניהם ייצור כפילויות שפריוריטי לא יוכל למזג אוטומטית.
- רווח עוקב בתא האקסל אינו נחתך. "ACME-001" ו-"ACME-001 " הם מפתחות שונים.
- אם קובץ האקסל משתמש בנוסחאות, האשף קורא את הערך המוצג ולא את טקסט הנוסחה. שמור את הקובץ עם נוסחאות מחושבות לפני הייבוא.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-duplicate-customer-codes-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-009 — body carries "אילוץ מפתח זר", "למחוק",
    // "מחיקת", "רשומה" verbatim.
    id: SEED_FIXTURE_IDS["he-009"],
    title: "שגיאה: לא ניתן למחוק רשומה - אילוץ מפתח זר בעת מחיקת לקוח",
    category: "diagnostic",
    tags: ["customers", "errors", "foreign-key", "hebrew"],
    body: `כאשר מנסים למחוק רשומת לקוח (טופס CUSTOMERS), פריוריטי מחזיר:

    שגיאה: לא ניתן למחוק רשומה - אילוץ מפתח זר

השגיאה מופעלת כאשר רשומה אחת או יותר מפנה אל הלקוח. שלמות ההפניה (referential integrity) של פריוריטי מונעת את המחיקה כדי להגן על נתונים תלויים — הזמנות מכר, חשבוניות, קבלות ואנשי קשר כולם מצביעים חזרה אל שורת הלקוח.

צעדי אבחון:

1. פתח את הלקוח בטופס CUSTOMERS והרץ "פעילות לקוח" כדי לראות הזמנות פתוחות, חשבוניות פתוחות ויתרות פתוחות.
2. בדוק את טבלאות הבן הנפוצות:
   - ORDERS (הזמנות מכר פתוחות): סנן לפי CUSTNAME וחפש סטטוס שאינו סגור.
   - AINVOICES (חשבוניות לקוח): אותו סינון, חפש יתרה לא משולמת.
   - CUSTCONTACTS (אנשי קשר): ללקוח חייבים להיות אפס אנשי קשר לפני מחיקה.
3. אם הלקוח אינו פעיל אך יש לו רשומות היסטוריות, הדרך הנכונה אינה למחוק. השתמש בדגל "לא פעיל" בטופס הלקוח. פריוריטי יסתיר את הלקוח מרשימות בחירה פעילות אך ישמר את שלמות ההפניה לדוחות היסטוריים.
4. אם הלקוח הוא רשומת בדיקה ללא ערך היסטורי, יש למחוק בסדר הפוך: אנשי קשר תחילה, אחר כך מסמכים פתוחים (בטל הזמנות, בטל חשבוניות), ולבסוף מחיקת הלקוח.

מתי לא לכפות מחיקה:
- ביקורת סוף שנה דורשת שנתוני הלקוח ההיסטוריים יהיו ניתנים לשחזור. מחיקת לקוח שיש לו חשבוניות בשנת כספים קודמת שוברת את שובל הביקורת. דגל "לא פעיל" הוא הדרך הנכונה היחידה לאחר סוף שנה.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-fk-constraint-customer-delete-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set en-013 — conceptual; body carries BOTH "sublevel" and
    // "child" and "form" verbatim.
    id: SEED_FIXTURE_IDS["en-013"],
    title: "The difference between a sublevel form and a child form in Priority",
    category: "conceptual",
    tags: ["forms", "customization", "concepts", "screens"],
    body: `Priority developers often confuse a sublevel form with a child form. They are related but distinct concepts, and choosing the wrong one changes how data is keyed and how the screens navigate.

A child form (linked form):
A child form is a separate form reached FROM a parent form, usually via a "linked screen" relationship. The child has its OWN primary key and its OWN table. Navigating from the parent passes a filter value (the link), but the child is a full standalone form that can also be opened on its own from the menu. Example: opening the Orders form and drilling into a linked Deliveries form.

A sublevel form (sub-form):
A sublevel form is part of the SAME logical document as its parent — it is the lower level of a header/detail pair. Order lines are a sublevel of the order header: they share the document's key, they cannot exist without the header, and they are not opened independently from the menu. A sublevel is displayed nested under its header, not as a separate navigable screen.

The key differences:
- Identity: a child form has an independent primary key; a sublevel shares (and depends on) the parent's key.
- Independence: a child form can be opened standalone; a sublevel cannot exist without its header.
- Navigation: a child is a separate screen you link to; a sublevel is nested in the same screen.
- Deletion: deleting a header cascades to its sublevels; deleting a parent does NOT automatically delete linked child records (referential integrity blocks it).

Rule of thumb: if the lower record is meaningless without the upper one (order line without an order), it is a sublevel. If the lower record stands on its own (a contact that happens to belong to a customer), it is a child form.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-sublevel-vs-child-form`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-013 — body carries BOTH "טופס משנה" and "טופס בן"
    // as contiguous bigrams + "ההבדל".
    id: SEED_FIXTURE_IDS["he-013"],
    title: "ההבדל בין טופס משנה לבין טופס בן בפריוריטי",
    category: "conceptual",
    tags: ["forms", "customization", "concepts", "hebrew"],
    body: `מפתחי פריוריטי מבלבלים לעיתים קרובות בין טופס משנה לבין טופס בן. אלה מושגים קשורים אך נבדלים, ובחירה לא נכונה משנה את אופן המיפתוח של הנתונים ואת אופן הניווט בין המסכים.

טופס בן (טופס מקושר):
טופס בן הוא טופס נפרד שמגיעים אליו מטופס אב, בדרך כלל דרך קשר "מסך מקושר". לטופס הבן יש מפתח ראשי משלו וטבלה משלו. ניווט מהאב מעביר ערך סינון (הקישור), אך הבן הוא טופס עצמאי מלא שניתן לפתוח אותו גם בנפרד מהתפריט. דוגמה: פתיחת טופס הזמנות וצלילה לטופס תעודות משלוח מקושר.

טופס משנה (תת-טופס):
טופס משנה הוא חלק מאותו מסמך לוגי כמו האב שלו — הוא הרמה התחתונה של זוג כותרת/פירוט. שורות הזמנה הן טופס משנה של כותרת ההזמנה: הן חולקות את מפתח המסמך, אינן יכולות להתקיים בלי הכותרת, ואינן נפתחות באופן עצמאי מהתפריט.

ההבדלים המרכזיים:
- זהות: לטופס בן יש מפתח ראשי עצמאי; טופס משנה חולק את מפתח האב ותלוי בו.
- עצמאות: טופס בן ניתן לפתיחה עצמאית; טופס משנה אינו יכול להתקיים בלי הכותרת שלו.
- ניווט: טופס בן הוא מסך נפרד שמקשרים אליו; טופס משנה מקונן באותו מסך.
- מחיקה: מחיקת כותרת מדרדרת אל טפסי המשנה שלה; מחיקת אב אינה מוחקת אוטומטית רשומות בן מקושרות.

כלל אצבע: אם הרשומה התחתונה חסרת משמעות בלי העליונה (שורת הזמנה בלי הזמנה) — זהו טופס משנה. אם הרשומה התחתונה עומדת בפני עצמה — זהו טופס בן.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-sublevel-vs-child-form-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set en-014 — body carries "BPM", "workflow", "procedural",
    // "trigger"; "procedural" discriminates it from the en-005 BPM entry.
    id: SEED_FIXTURE_IDS["en-014"],
    title: "When to use a BPM workflow versus a procedural trigger in Priority",
    category: "conceptual",
    tags: ["bpm", "customization", "concepts", "triggers"],
    body: `Priority offers two main ways to run custom logic when data changes: a BPM workflow and a procedural trigger. They overlap, but each fits a different kind of job.

A procedural trigger:
A procedural trigger is server-side logic bound to a table event (insert, update, delete). It runs synchronously, inside the same transaction as the data change, in Priority's procedural language. Use a procedural trigger for fast, deterministic, data-integrity work: validate a field, compute a derived value, block an illegal change. Because it runs in-transaction, if the trigger fails the data change rolls back.

A BPM workflow:
A BPM (Business Process Management) workflow models a multi-step business process: approvals, notifications, routing, waits, and human tasks. It can run asynchronously and can span time (wait for an approver). Use a BPM workflow when the process involves people, multiple steps, or anything that should not block the user's save.

When to use which:
- Need synchronous validation or a computed field, in-transaction? Use a procedural trigger.
- Need an approval chain, notifications, or a long-running multi-step flow? Use a BPM workflow.
- Need to block a save on a business rule? Procedural trigger — a BPM workflow generally cannot veto the originating transaction.
- Worried about slowing down data entry? Keep heavy or human-dependent work out of a procedural trigger and put it in an asynchronous BPM workflow.

Rule of thumb: a procedural trigger is for data correctness now; a BPM workflow is for a business process over time.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-bpm-vs-procedural-trigger`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
    sensitivity: "internal" as const,
  },
  {
    // Maps to golden-set he-014 — body carries "BPM", "טריגר", "פרוצדורלי",
    // "לעומת"; "פרוצדורלי" discriminates it from the he-005 BPM entry.
    id: SEED_FIXTURE_IDS["he-014"],
    title: "מתי כדאי להשתמש ב-BPM לעומת טריגר פרוצדורלי בפריוריטי",
    category: "conceptual",
    tags: ["bpm", "customization", "concepts", "hebrew"],
    body: `פריוריטי מציע שתי דרכים עיקריות להריץ לוגיקה מותאמת כאשר נתונים משתנים: תהליך BPM וטריגר פרוצדורלי. הם חופפים, אך כל אחד מתאים לסוג עבודה אחר.

טריגר פרוצדורלי:
טריגר פרוצדורלי הוא לוגיקת צד-שרת הקשורה לאירוע טבלה (הוספה, עדכון, מחיקה). הוא רץ באופן סינכרוני, בתוך אותה טרנזקציה של שינוי הנתונים, בשפה הפרוצדורלית של פריוריטי. השתמש בטריגר פרוצדורלי לעבודת שלמות-נתונים מהירה ודטרמיניסטית: אימות שדה, חישוב ערך נגזר, חסימת שינוי לא חוקי. מכיוון שהוא רץ בתוך הטרנזקציה, אם הטריגר נכשל — שינוי הנתונים מתבטל.

תהליך BPM:
תהליך BPM (ניהול תהליכים עסקיים) ממדל תהליך עסקי רב-שלבי: אישורים, התראות, ניתוב, המתנות ומשימות אנושיות. הוא יכול לרוץ באופן אסינכרוני ולהימשך לאורך זמן. השתמש בתהליך BPM כאשר התהליך מערב אנשים, שלבים מרובים, או כל דבר שלא צריך לחסום את השמירה של המשתמש.

מתי להשתמש במה:
- צריך אימות סינכרוני או שדה מחושב, בתוך הטרנזקציה? השתמש בטריגר פרוצדורלי.
- צריך שרשרת אישורים, התראות, או תהליך רב-שלבי ארוך? השתמש בתהליך BPM.
- צריך לחסום שמירה על בסיס חוק עסקי? טריגר פרוצדורלי — תהליך BPM בדרך כלל אינו יכול לבטל את הטרנזקציה המקורית.

כלל אצבע: טריגר פרוצדורלי הוא לנכונות נתונים עכשיו; תהליך BPM הוא לתהליך עסקי לאורך זמן.`,
    source_pointer: `synthetic-fixture-${SEED_DATE_BATCH2}-bpm-vs-procedural-trigger-he`,
    last_verified_at: new Date("2026-05-29T00:00:00Z"),
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
