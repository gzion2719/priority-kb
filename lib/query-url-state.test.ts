import { describe, expect, it } from "vitest";

import { decodeQueryParam, encodeQueryParam, QUERY_PARAM_MAX_LEN } from "@/lib/query-url-state";

describe("query-url-state", () => {
  it("round-trips Hebrew + English + URL-special characters through encode/decode", () => {
    // Mixed-script + characters that MUST be percent-encoded (& = ? # +
    // space). If encode passes any of these through bare, decode on the
    // other side either crashes or returns a different string and the
    // page's restore logic silently shows the wrong query — the test
    // catches both halves of that bug in one assertion.
    const cases = [
      "איך לסגור הזמנה",
      "how do I close an order",
      "מה זה BOM & ECO?",
      "query with spaces + punctuation = fun",
      "a", // single char (boundary)
      // AT-cap input MUST succeed; > cap is tested in the rejection
      // suite below. The asymmetry pins encode/decode's `>` (not `>=`)
      // semantics so a future refactor that flips the comparison
      // breaks this test instead of silently rejecting legitimate
      // max-length inputs.
      "a".repeat(QUERY_PARAM_MAX_LEN),
    ];
    for (const q of cases) {
      const encoded = encodeQueryParam(q);
      expect(encoded).not.toBeNull();
      // encoded must not contain bare URL delimiters that would break ?q= parsing
      expect(encoded).not.toMatch(/[&#?]/);
      expect(decodeQueryParam(encoded)).toBe(q);
    }
  });

  it("rejects empty input, over-cap input, and malformed pct-encoding (defensive against URL tampering)", () => {
    // Encoder boundaries: empty and over-cap MUST yield null (not "" or
    // truncated). A truncated query would prefill something the user
    // didn't ask, which is worse than not prefilling.
    expect(encodeQueryParam("")).toBeNull();
    expect(encodeQueryParam("a".repeat(QUERY_PARAM_MAX_LEN + 1))).toBeNull();

    // Decoder boundaries: null/empty/malformed-pct/decoded-over-cap all
    // collapse to null so the page falls back to a fresh empty input
    // rather than throwing on mount.
    expect(decodeQueryParam(null)).toBeNull();
    expect(decodeQueryParam("")).toBeNull();
    expect(decodeQueryParam("%E0%A4%A")).toBeNull(); // truncated UTF-8 escape
    expect(decodeQueryParam("a".repeat(QUERY_PARAM_MAX_LEN * 9 + 1))).toBeNull(); // raw over loose ceiling
  });
});
