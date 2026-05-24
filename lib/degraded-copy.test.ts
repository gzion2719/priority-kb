// lib/degraded-copy.test.ts — coverage + shape for degradedCopy().
//
// The compile-time `satisfies never` in lib/degraded-copy.ts already
// guarantees that every DegradedReasonCode is handled. This test is the
// runtime belt-and-braces: it enumerates DEGRADED_REASON_CODES at runtime
// and asserts shape + non-emptiness on every value. A future enum addition
// that somehow slips the type system (e.g., a stringly-typed cast) is
// caught here, AND copy edits that accidentally clear a title/description
// fail loudly.

import { describe, expect, it } from "vitest";
import { DEGRADED_REASON_CODES, type DegradedReasonCode } from "@/lib/retrieval-degraded";
import { degradedCopy } from "@/lib/degraded-copy";

describe("degradedCopy", () => {
  describe.each(DEGRADED_REASON_CODES)("for code %s", (code) => {
    const copy = degradedCopy(code);

    it("returns a non-empty title", () => {
      expect(typeof copy.title).toBe("string");
      expect(copy.title.length).toBeGreaterThan(0);
    });

    it("returns a non-empty description", () => {
      expect(typeof copy.description).toBe("string");
      expect(copy.description.length).toBeGreaterThan(0);
    });
  });

  it("returns distinct copy per code (no accidental duplicates)", () => {
    // Each reason describes a distinct degraded surface (ADR-0012 §3 +
    // ADR-0013 §3). If two codes share copy, either a paste-error
    // happened or the codes should have been merged at the enum layer.
    const titles = DEGRADED_REASON_CODES.map((c) => degradedCopy(c).title);
    const uniqueTitles = new Set(titles);
    expect(uniqueTitles.size).toBe(titles.length);
  });

  it("throws on undefined input (invariant-defense)", () => {
    // The only correct call site (app/query/page.tsx) gates on
    // state.degraded === true; the reducer pairs degraded + degradedReason
    // on every set (lib/query-chat-state.ts:200-201, 215-216). Reaching
    // degradedCopy(undefined) is a reducer regression, not a runtime
    // expectation — so throw loudly rather than return a sentinel.
    expect(() => degradedCopy(undefined)).toThrow(/undefined code/i);
  });

  it("throws on an unknown code (defense against untyped wire input)", () => {
    // A future wire-vocab extension that lands a new code on the
    // QueryEvent side before this file is updated would reach the
    // `default` branch. The `satisfies never` is compile-time only;
    // this guards the runtime path from an untyped cast.
    expect(() => degradedCopy("not_a_real_code" as unknown as DegradedReasonCode)).toThrow(
      /unhandled reason code/i,
    );
  });
});
