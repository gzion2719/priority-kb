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
