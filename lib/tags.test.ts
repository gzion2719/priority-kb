// lib/tags.test.ts — M4 #4 PR-A unit tests for tag-validation primitives.
//
// DB-bound paths (renameTag / deleteTag end-to-end) live in
// tests/tags.integration.test.ts. This file pins the pure helpers:
// normalizeTag, validateTagStrict, validateTagFromLooseLength.
//
// Per ADR-0025 D9 + Amendment A5.

import { describe, expect, it } from "vitest";

import {
  MAX_TAG_LENGTH,
  TagValidationError,
  normalizeTag,
  validateTagFromLooseLength,
  validateTagStrict,
} from "@/lib/tags";

describe("normalizeTag", () => {
  it("NFC-normalizes composed vs decomposed forms to byte-equal output", () => {
    // U+00E9 (é, NFC) vs U+0065 U+0301 (e + combining acute, NFD)
    const nfc = "café";
    const nfd = "café";
    expect(normalizeTag(nfc)).toBe(normalizeTag(nfd));
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeTag("  vendor  ")).toBe("vendor");
  });

  it("collapses interior whitespace runs to a single ASCII space", () => {
    expect(normalizeTag("purchase   order")).toBe("purchase order");
  });

  it("passes already-normalized input unchanged", () => {
    expect(normalizeTag("priority-vendor")).toBe("priority-vendor");
  });
});

describe("validateTagStrict", () => {
  it("accepts a valid Hebrew tag (no niqqud)", () => {
    expect(() => validateTagStrict("עדיפות", "to")).not.toThrow();
  });

  it("accepts a valid ASCII tag", () => {
    expect(() => validateTagStrict("purchase-order", "to")).not.toThrow();
  });

  it("rejects empty string with empty reason", () => {
    expect(() => validateTagStrict("", "to")).toThrow(TagValidationError);
    try {
      validateTagStrict("", "to");
    } catch (e) {
      expect(e).toBeInstanceOf(TagValidationError);
      expect((e as TagValidationError).reason).toBe("empty");
      expect((e as TagValidationError).field).toBe("to");
    }
  });

  it("rejects tags longer than MAX_TAG_LENGTH code points", () => {
    const tooLong = "x".repeat(MAX_TAG_LENGTH + 1);
    try {
      validateTagStrict(tooLong, "to");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as TagValidationError).reason).toBe("too_long");
    }
  });

  it("counts code points (NFC), not UTF-16 units, for length", () => {
    // Surrogate-pair emoji (U+1F600) is 1 code point but 2 UTF-16 units.
    // 33 emoji × 1 code-point = 33; if length were UTF-16 it'd be 66 (still under 64? no, 66 > 64).
    // Use 64 emoji = 64 code-points (passes) vs 65 emoji = 65 code-points (fails).
    const sixtyFour = "\u{1F600}".repeat(64);
    expect(() => validateTagStrict(sixtyFour, "to")).not.toThrow();
    const sixtyFive = "\u{1F600}".repeat(65);
    try {
      validateTagStrict(sixtyFive, "to");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as TagValidationError).reason).toBe("too_long");
    }
  });

  it("rejects ASCII control characters", () => {
    try {
      validateTagStrict("vendor", "to");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as TagValidationError).reason).toBe("control_char");
    }
  });

  it("rejects Hebrew niqqud (composed form, U+0591-U+05BD range)", () => {
    // עְדִיפוּת — 'ayin + sheva + dalet + hiriq + yod + ... contains niqqud
    const withNiqqud = "עְדִיפוּת";
    try {
      validateTagStrict(withNiqqud, "to");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as TagValidationError).reason).toBe("niqqud");
    }
  });

  it("rejects commas", () => {
    try {
      validateTagStrict("a,b", "to");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as TagValidationError).reason).toBe("comma_or_semicolon");
    }
  });

  it("rejects semicolons", () => {
    try {
      validateTagStrict("a;b", "to");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as TagValidationError).reason).toBe("comma_or_semicolon");
    }
  });

  it("uses the supplied field name in the thrown error", () => {
    try {
      validateTagStrict("", "tag");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as TagValidationError).field).toBe("tag");
    }
  });
});

describe("validateTagFromLooseLength — A5 from-field rule", () => {
  it("accepts ASCII tags", () => {
    expect(() => validateTagFromLooseLength("priority")).not.toThrow();
  });

  it("accepts niqqud-bearing tags (the whole point of A5 — pre-D9 cleanup)", () => {
    const withNiqqud = "עְדִיפוּת";
    expect(() => validateTagFromLooseLength(withNiqqud)).not.toThrow();
  });

  it("accepts comma-bearing tags (pre-D9)", () => {
    expect(() => validateTagFromLooseLength("a,b")).not.toThrow();
  });

  it("rejects empty string", () => {
    try {
      validateTagFromLooseLength("");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as TagValidationError).reason).toBe("empty");
      expect((e as TagValidationError).field).toBe("from");
    }
  });

  it("rejects beyond MAX_TAG_LENGTH (length is the only `from` constraint)", () => {
    try {
      validateTagFromLooseLength("x".repeat(MAX_TAG_LENGTH + 1));
      expect.fail("expected throw");
    } catch (e) {
      expect((e as TagValidationError).reason).toBe("too_long");
    }
  });
});

describe("TagValidationError", () => {
  it("preserves field + reason on the instance", () => {
    const e = new TagValidationError("to", "niqqud", "test message");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("TagValidationError");
    expect(e.field).toBe("to");
    expect(e.reason).toBe("niqqud");
    expect(e.message).toBe("test message");
  });
});
