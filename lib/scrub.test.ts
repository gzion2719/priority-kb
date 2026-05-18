import { describe, expect, it } from "vitest";

import { EMAIL_TOKEN, ID_TOKEN, PHONE_TOKEN, scrubPii } from "@/lib/scrub";

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

describe("scrubPii — monotonic / idempotent (ADR-0009 §7)", () => {
  it("running scrub twice equals running it once", () => {
    const sample = "email gal@x.co, call +972-50-1234567, id 123456789, see ticket #4242";
    const once = scrubPii(sample);
    const twice = scrubPii(once);
    expect(twice).toBe(once);
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
