import { describe, expect, it } from "vitest";

import { EMAIL_TOKEN, ID_TOKEN, PHONE_TOKEN, PRICE_TOKEN, scrubPii } from "@/lib/scrub";

describe("scrubPii — happy path (M2a categories)", () => {
  it("replaces emails with [email]", () => {
    expect(scrubPii("contact gal@example.com please")).toBe(`contact ${EMAIL_TOKEN} please`);
  });

  it("replaces Israeli mobile (+972 / 050 / 0501234567)", () => {
    // Negative-assertion: if PHONE_RE were removed, "+972-50-1234567" would
    // pass through verbatim. Asserting on the redacted form distinguishes.
    expect(scrubPii("call +972-50-1234567")).toBe(`call ${PHONE_TOKEN}`);
    expect(scrubPii("call 050-1234567")).toBe(`call ${PHONE_TOKEN}`);
    expect(scrubPii("call 0501234567")).toBe(`call ${PHONE_TOKEN}`);
  });

  it("replaces standalone 9-digit IDs with [id]", () => {
    // Negative-assertion: if ID_RE were removed, "123456789" would survive.
    expect(scrubPii("teudat zehut: 123456789")).toBe(`teudat zehut: ${ID_TOKEN}`);
  });

  it("leaves clean prose untouched", () => {
    const text = "Receiving doc validation rejected line item — quantity must be > 0.";
    expect(scrubPii(text)).toBe(text);
  });
});

describe("scrubPii — does not over-rewrite", () => {
  it("does not redact short numeric sequences (versions, dates)", () => {
    // Negative-assertion: if the phone post-filter `looksLikePhone` were
    // removed, "v1.2.3" or "in 2026" would be redacted. Asserting they
    // survive distinguishes a too-aggressive scrub from a correct one.
    expect(scrubPii("upgrade to v1.2.3")).toBe("upgrade to v1.2.3");
    expect(scrubPii("released in 2026")).toBe("released in 2026");
    expect(scrubPii("error code 1234")).toBe("error code 1234");
  });

  it("does not redact a 9-digit run that is part of a longer alphanumeric token", () => {
    // ID_RE uses \b-style boundaries to avoid eating into SKUs / order #s
    // that happen to contain 9 digits.
    expect(scrubPii("PO-SKU123456789X")).toBe("PO-SKU123456789X");
  });
});

describe("scrubPii — price (M2b)", () => {
  it("redacts symbol-prefixed amounts (₪ $ € £)", () => {
    // Negative-assertion: if PRICE_RES were removed, "₪1,500" survives.
    expect(scrubPii("total ₪1,500 due")).toBe(`total ${PRICE_TOKEN} due`);
    expect(scrubPii("costs $99.99 each")).toBe(`costs ${PRICE_TOKEN} each`);
    expect(scrubPii("£50 deposit")).toBe(`${PRICE_TOKEN} deposit`);
  });

  it("redacts the European decimal format (€1.234,56)", () => {
    expect(scrubPii("price €1.234,56 net")).toBe(`price ${PRICE_TOKEN} net`);
  });

  it("redacts suffix-symbol amounts (50 ₪ / 1500₪) — the \\b-anchor gap", () => {
    // Negative-assertion: a `\b`-anchored pattern silently misses these
    // because `\b` does not assert between a space and `₪`.
    expect(scrubPii("שולם 50 ₪ בלבד")).toBe(`שולם ${PRICE_TOKEN} בלבד`);
    expect(scrubPii("paid 1500₪ total")).toBe(`paid ${PRICE_TOKEN} total`);
  });

  it("redacts separator-less amounts (OCR drops thousands separators)", () => {
    // Negative-assertion against the B2 corruption: a grouped-only pattern
    // would leave "[price]4567" with the trailing digits surviving to disk.
    expect(scrubPii("amount ₪1234567 paid")).toBe(`amount ${PRICE_TOKEN} paid`);
    expect(scrubPii("amount ₪1234567 paid")).not.toContain("4567");
  });

  it("redacts 3-letter currency codes, prefix and suffix, case-insensitive", () => {
    expect(scrubPii("budget ILS 1500")).toBe(`budget ${PRICE_TOKEN}`);
    expect(scrubPii("billed 1,234.50 NIS")).toBe(`billed ${PRICE_TOKEN}`);
    expect(scrubPii("99USD flat")).toBe(`${PRICE_TOKEN} flat`);
  });

  it("preserves a trailing sentence period (number core ends on a digit)", () => {
    expect(scrubPii("the fee is ₪1,500.")).toBe(`the fee is ${PRICE_TOKEN}.`);
  });

  it("does not redact bare numbers without a currency marker", () => {
    // The currency marker is what distinguishes a price; bare numbers
    // (quantities, codes, versions, years) must survive.
    expect(scrubPii("order quantity 1500")).toBe("order quantity 1500");
    expect(scrubPii("upgrade to v1.2.3")).toBe("upgrade to v1.2.3");
    expect(scrubPii("error code 1234")).toBe("error code 1234");
  });
});

describe("scrubPii — vendor / customer label-anchored ID (M2b)", () => {
  it("redacts the value after מס. לקוח / מס. ספק, keeping the label", () => {
    // Negative-assertion: without VENDOR_LABEL_RE the alphanumeric value
    // C-1024 survives — the bare ID pass cannot catch it (only 4 digits).
    expect(scrubPii("מס. לקוח: C-1024")).toBe(`מס. לקוח: ${ID_TOKEN}`);
    expect(scrubPii("מס. ספק SUP/0042 פעיל")).toBe(`מס. ספק ${ID_TOKEN} פעיל`);
    expect(scrubPii("מס. לקוח: C-1024")).not.toContain("C-1024");
  });

  it("redacts a numeric value via the label anchor (no-op for trailing ID pass)", () => {
    expect(scrubPii("מספר ספק 7000123")).toBe(`מספר ספק ${ID_TOKEN}`);
  });

  it("tolerates an OCR line break between label and value", () => {
    expect(scrubPii("מס. לקוח:\nC-1024")).toBe(`מס. לקוח:\n${ID_TOKEN}`);
  });

  it("does not eat a following Hebrew word (value must be ASCII-alphanumeric)", () => {
    // "customer no. new created" — חדש is not an ID and must survive.
    const text = "מס. לקוח חדש נוצר";
    expect(scrubPii(text)).toBe(text);
  });

  it("redacts the FULL numeric value, even over the CHAR(16) length (no trailing leak)", () => {
    // The value capture is unbounded so an over-length OCR'd value does not
    // leave trailing digits adjacent to [id]. Negative-assertion: a bounded
    // {0,15} capture would leak "7890" here.
    const out = scrubPii("מס. לקוח: 12345678901234567890");
    expect(out).toBe(`מס. לקוח: ${ID_TOKEN}`);
    expect(out).not.toMatch(/\d/);
  });

  it("stops the value at an intervening Hebrew word (later number caught by ID pass)", () => {
    // "customer no. OF 7000123" — של (Hebrew) blocks the label-anchored value
    // capture; the standalone 7-digit run is then caught by the bare ID pass.
    expect(scrubPii("מס. לקוח של 7000123")).toBe(`מס. לקוח של ${ID_TOKEN}`);
  });
});

describe("scrubPii — monotonic / idempotent (ADR-0009 §7)", () => {
  it("running scrub twice equals running it once", () => {
    // Sample spans every category incl. the M2b additions so monotonicity is
    // proven for price + vendor-label, not just the M2a tokens.
    const sample =
      "email gal@x.co, call +972-50-1234567, id 123456789, ₪1,500 and €1.234,56, " +
      "מס. לקוח: C-1024, see ticket #4242";
    const once = scrubPii(sample);
    const twice = scrubPii(once);
    expect(twice).toBe(once);
  });

  it("already-scrubbed tokens adjacent to a marker/label do not re-match", () => {
    // The design's idempotency claim is that an output token next to a stray
    // currency symbol or a vendor label is inert. Pin it explicitly.
    expect(scrubPii(`${PRICE_TOKEN}₪`)).toBe(`${PRICE_TOKEN}₪`);
    expect(scrubPii(`₪${PRICE_TOKEN}`)).toBe(`₪${PRICE_TOKEN}`);
    expect(scrubPii(`מס. לקוח: ${ID_TOKEN}`)).toBe(`מס. לקוח: ${ID_TOKEN}`);
  });
});

describe("scrubPii — multi-category in one body", () => {
  it("redacts email + phone + id in a single pass without ordering bugs", () => {
    const input = "ping gal@x.co or 050-1234567; teudat: 123456789";
    const out = scrubPii(input);
    expect(out).toContain(EMAIL_TOKEN);
    expect(out).toContain(PHONE_TOKEN);
    expect(out).toContain(ID_TOKEN);
    expect(out).not.toContain("gal@x.co");
    expect(out).not.toContain("050-1234567");
    expect(out).not.toContain("123456789");
  });
});
