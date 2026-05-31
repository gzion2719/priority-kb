import { describe, expect, it } from "vitest";

import {
  findInvalidTags,
  formatRouteErrors,
  parseTagsCsv,
  TAG_MAX_COUNT,
  TAG_MAX_LEN,
  tagsToCsv,
} from "@/lib/edit-form-helpers";

describe("parseTagsCsv", () => {
  it("empty input → empty array", () => {
    expect(parseTagsCsv("")).toEqual([]);
  });

  it("single tag", () => {
    expect(parseTagsCsv("invoice")).toEqual(["invoice"]);
  });

  it("multiple tags are trimmed of surrounding whitespace", () => {
    expect(parseTagsCsv("invoice, vendor , receipt")).toEqual(["invoice", "vendor", "receipt"]);
  });

  it("preserves order (regression pin per plan-CR Q11)", () => {
    // Negative-assertion: a regression that sorted alphabetically would
    // flip the relative position of "c", "a", "b" — surface immediately.
    expect(parseTagsCsv("c, a, b")).toEqual(["c", "a", "b"]);
  });

  it("drops empty tokens from trailing or doubled commas", () => {
    expect(parseTagsCsv("invoice, , receipt,,")).toEqual(["invoice", "receipt"]);
  });

  it("Hebrew tags preserved verbatim", () => {
    expect(parseTagsCsv("חשבונית, ספק")).toEqual(["חשבונית", "ספק"]);
  });
});

describe("tagsToCsv", () => {
  it("round-trips with parseTagsCsv on a typical input", () => {
    const input = ["invoice", "vendor", "receipt"];
    expect(parseTagsCsv(tagsToCsv(input))).toEqual(input);
  });

  it("empty array → empty string", () => {
    expect(tagsToCsv([])).toBe("");
  });
});

describe("findInvalidTags — client-side preflight", () => {
  it("all valid tags → empty result", () => {
    expect(findInvalidTags(["invoice", "vendor"])).toEqual({ tooLong: [], tooMany: false });
  });

  it("flags over-length tags by index", () => {
    const tooLong = "x".repeat(TAG_MAX_LEN + 1);
    expect(findInvalidTags(["ok", tooLong, "ok2"])).toEqual({ tooLong: [1], tooMany: false });
  });

  it("boundary: exactly TAG_MAX_LEN is valid (negative-assertion against off-by-one)", () => {
    // A regression that used `>=` would flag this tag as invalid,
    // surfacing immediately. Pin the strict-`>` contract.
    const atCap = "x".repeat(TAG_MAX_LEN);
    expect(findInvalidTags([atCap]).tooLong).toEqual([]);
  });

  it("flags over-count tag arrays via tooMany flag", () => {
    const many = Array.from({ length: TAG_MAX_COUNT + 1 }, (_, i) => `t${i}`);
    expect(findInvalidTags(many).tooMany).toBe(true);
  });

  it("boundary: exactly TAG_MAX_COUNT is valid", () => {
    const atCap = Array.from({ length: TAG_MAX_COUNT }, (_, i) => `t${i}`);
    expect(findInvalidTags(atCap).tooMany).toBe(false);
  });
});

describe("formatRouteErrors", () => {
  it("Zod issues → per-field map", () => {
    expect(
      formatRouteErrors({
        error: "invalid_request",
        issues: [
          { path: "title", code: "too_small" },
          { path: "last_verified_at", code: "invalid_string" },
        ],
      }),
    ).toEqual({ title: "too_small", last_verified_at: "invalid_string" });
  });

  it("empty path → _form sentinel key", () => {
    expect(
      formatRouteErrors({
        error: "invalid_request",
        issues: [{ path: "", code: "invalid_json" }],
      }),
    ).toEqual({ _form: "invalid_json" });
  });

  it("no issues → error string lands under _form", () => {
    expect(formatRouteErrors({ error: "not_found" })).toEqual({ _form: "not_found" });
  });

  it("first issue per path wins (later issues silently dropped)", () => {
    expect(
      formatRouteErrors({
        error: "invalid_request",
        issues: [
          { path: "title", code: "too_small" },
          { path: "title", code: "too_big" },
        ],
      }),
    ).toEqual({ title: "too_small" });
  });
});
