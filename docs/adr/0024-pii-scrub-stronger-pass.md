# ADR-0024 — Stronger PII scrub: price + label-anchored vendor/customer ID; names deferred (M2b #8)

- **Date:** 2026-05-28
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent plan-reviewer subagent)

## Context

[ROADMAP M2b #8](../ROADMAP.md) reads: *"Stronger PII scrub on extracted text
(customer names, prices, vendor IDs)."* The M2a pass at
[lib/scrub.ts](../../lib/scrub.ts) (`scrubPii`) already redacts emails, Israeli
phone numbers, and 7–12 digit ID runs. This ADR records where the stronger
pass lives and which of the three named categories actually ship.

Two facts constrain the design:

- **`scrubPii` is the single choke point.** Every body written to
  `entries.body` flows through `lib/ingest.ts::deriveChunksAndEmbeddings`,
  which calls `scrubPii(rawBody)` as its first step (before chunk + embed +
  write), for **both** create and update paths. Under
  [ADR-0021](0021-worker-http-callback-architecture.md) Option Y the Python
  media-ingest worker has **no embed/write surface** — it PUTs parsed/OCR'd
  text to Node `PUT /api/ingest/[id]`, which runs the same `scrubPii`. So
  worker-extracted text is already scrubbed Node-side; there is no separate
  Python ingest path to a body column.

- **Priority customer/vendor IDs are a CHAR(16) free-form key** shown on the
  Hebrew form columns **"מס. לקוח"** (customer no.) and **"מס. ספק"** (vendor
  no.). The key value has no fixed shape — it can be numeric, alphanumeric, or
  contain `-`/`/` — so it cannot be matched by value pattern without flooding
  false positives across every 1–16 char token in the corpus.

## Decision

### D1 — Stronger scrub lives Node-side in `lib/scrub.ts`, not in the Python worker

The choke-point fact above settles it: a Python-side scrub would either
double-scrub (worker scrubs, then Node scrubs again) or fork the redaction
logic across two languages — a drift class the Python rules explicitly guard
against. "Node vs Python" is not a fresh decision; it is the direct
consequence of ADR-0021 Option Y. Recorded here only so a future reader sees
why M2b #8 — a "media/extracted-text" item — produced no `api/`-side code.

### D2 — Price: currency-marker-adjacent redaction → `[price]`

A number is redacted only when a currency marker (symbol `₪ $ € £`, or 3-letter
code `NIS/ILS/USD/EUR/GBP`) is adjacent on either side. The marker is what
distinguishes a price from any other digit run, so bare numbers (quantities,
versions, error codes, years) survive — consistent with the existing
"does-not-over-rewrite" discipline.

- Number core `\d(?:[\d.,]*\d)?` accepts grouped (`1,234.50`), European
  (`1.234,56`), and separator-less (`1500`, common in OCR) runs, and always
  ends on a digit so a trailing sentence period is not eaten.
- Symbol adjacency is matched literally with `\s?`, **not** with a `\b` word
  boundary: `\b` does not assert between a space and `₪`/`$` (both non-word
  chars), so a `\b`-anchored pattern would silently miss `50 ₪`.

### D3 — Vendor/customer ID: label-anchored redaction → `[id]`

Because the value cannot be matched by shape (D-context), the redaction
anchors on the Hebrew label: match `מס.`/`מס׳`/`מספר` + `לקוח`/`ספק`, optional
separator (incl. an OCR line break — the separator allows `\s`), then capture
the adjacent value as an ASCII-alphanumeric run (`[A-Za-z0-9][A-Za-z0-9\-_/]{0,15}`,
≤16 chars matching CHAR(16)). The label is preserved; only the value is
redacted to the existing `ID_TOKEN`.

Requiring an ASCII-alphanumeric value (a) matches the real key shape and
(b) stops at a following Hebrew word, so `מס. לקוח חדש נוצר` ("customer no. new
created") is **not** redacted. This pass uniquely catches **alphanumeric** keys
(`C-1024`) that the bare 7–12 digit ID pass cannot; purely numeric values are
redacted here too, making the trailing ID pass a no-op on them.

**Not handled:** reversed visual order (value appearing before the label in
OCR output). Shape-matching the value to recover that case would flood false
positives; the miss is accepted.

### D4 — Customer NAMES deferred (out of scope for a regex pass)

Free-text personal/company names are NER-hard: a regex is either all
false-positive (eating ordinary nouns) or all false-negative. A regex pass
here would be theater. Names are deferred to a future NER/Claude-assisted pass
(BACKLOG). ROADMAP M2b #8 therefore stays `[ ]` — the names leg is the
remaining work; price + vendor-label ship.

### D5 — Scrub order: email → phone → price → vendor-label → ID

Order is load-bearing: phone before price/ID (structural-marker phone regex);
price before vendor-label and ID (a currency-adjacent run becomes `[price]`,
and its digits are gone before the ID pass treats them as an identifier);
vendor-label before ID (so an alphanumeric label-anchored value is redacted
before the bare ID pass, which could not catch it anyway).

## Consequences

- One module + test changes; no new architectural surface, no schema change,
  no Python code. Gate is `npm run check` (Node side).
- Monotonicity (ADR-0009 §7) holds: `[price]` and `[id]` contain no digit,
  currency marker, or label that any pattern can re-match; the label pass
  fails to re-match its own `מס. לקוח: [id]` output because `[` is not an
  ASCII-alphanumeric value-start. The idempotent test sample is widened to
  include a price, a European decimal, and a label-anchored value so
  monotonicity is proven for the new categories, not just the M2a tokens.
- The redaction is one-way and lossy by design — there is no `body_raw`
  column (iron-rule note in `lib/scrub.ts`).
- **Known limitation:** two suffix-symbol amounts directly adjacent
  (`"1500₪ 2000₪"`) under-redact — the first amount's symbol binds forward to
  the second number, leaving the first amount's digits exposed. The common
  `₪`-prefix style and single amounts redact cleanly; reversing the pass order
  only moves the blind spot to the both-prefix-adjacent shape. The independent
  per-pattern `replace` design can't disambiguate a symbol shared between two
  numbers; a combined tokenizer with explicit binding precedence is deferred to
  BACKLOG until real OCR'd invoice tables make it matter. The leaked token is a
  bare number stripped of its currency marker, so price-ness is largely lost.
