import { describe, expect, it } from "vitest";

import { IngestBody } from "@/lib/ingest-schema";
import { toDateInputValue, toIsoWithLocalOffset } from "@/lib/iso-date";

describe("toIsoWithLocalOffset", () => {
  it("throws RangeError on malformed input", () => {
    // `<input type="date">` guarantees the YYYY-MM-DD shape — a malformed
    // value is a caller bug; surface it as RangeError so a regression
    // can't silently passthrough.
    expect(() => toIsoWithLocalOffset("")).toThrow(RangeError);
    expect(() => toIsoWithLocalOffset("2026/05/31")).toThrow(RangeError);
    expect(() => toIsoWithLocalOffset("2026-5-31")).toThrow(RangeError);
    expect(() => toIsoWithLocalOffset("not-a-date")).toThrow(RangeError);
  });

  it("emits ISO 8601 with explicit local offset", () => {
    // Asserts the SHAPE (offset present, in ±HH:MM form) — not the
    // literal offset, since the test runs in whatever tz the
    // CI/sandbox provides.
    const out = toIsoWithLocalOffset("2026-05-31");
    expect(out).toMatch(/^2026-05-31T00:00:00[+-]\d{2}:\d{2}$/);
  });

  it("round-trips through IngestBody Zod schema (THE production contract)", () => {
    // Load-bearing assertion. If the emitted string fails Zod's
    // `.datetime({ offset: true })`, the PUT route returns 400 on
    // every form submit.
    const iso = toIsoWithLocalOffset("2026-05-31");
    const result = IngestBody.safeParse({
      title: "t",
      category: "c",
      tags: [],
      body: "b",
      source_pointer: "ticket://1",
      last_verified_at: iso,
      sensitivity: "internal",
    });
    expect(result.success).toBe(true);
  });

  it("negative-assertion: bare YYYY-MM-DD (no offset) is rejected by IngestBody", () => {
    // Regression pin per Step 7b plan-CR M3 — if a future refactor
    // degraded the helper to pass through YYYY-MM-DD, the form would
    // submit and the route would 400 on `last_verified_at`. This test
    // would fail first, before the bug shipped.
    const result = IngestBody.safeParse({
      title: "t",
      category: "c",
      tags: [],
      body: "b",
      source_pointer: "ticket://1",
      last_verified_at: "2026-05-31",
      sensitivity: "internal",
    });
    expect(result.success).toBe(false);
  });
});

describe("toDateInputValue", () => {
  it("converts a Date to YYYY-MM-DD using the local calendar day", () => {
    // 2026-05-31 in the test runner's local tz. month is 0-indexed.
    const d = new Date(2026, 4, 31);
    expect(toDateInputValue(d)).toBe("2026-05-31");
  });

  it("zero-pads single-digit months and days", () => {
    const d = new Date(2026, 0, 5);
    expect(toDateInputValue(d)).toBe("2026-01-05");
  });

  it("round-trip: toIsoWithLocalOffset → new Date → toDateInputValue preserves the calendar day", () => {
    const original = "2026-05-31";
    const iso = toIsoWithLocalOffset(original);
    const roundTrip = toDateInputValue(new Date(iso));
    expect(roundTrip).toBe(original);
  });
});
