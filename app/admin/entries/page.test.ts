import { describe, expect, it } from "vitest";

import { buildHref, clampFiltersForAudit, parseFilters } from "@/app/admin/entries/page";

// ---------------------------------------------------------------------------
// buildHref — single source of truth for /admin/entries URLs.
//
// Used by Load more (cursor advances, filters preserved) AND by each
// chip-remove link (filters edited, cursor dropped). The two call sites
// share this helper so the emission contract can't silently drift.
// ---------------------------------------------------------------------------

describe("buildHref — URL emission contract", () => {
  const cursor = {
    updatedAt: new Date("2026-01-15T10:00:00.000Z"),
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };

  it("no cursor, no filters → bare /admin/entries (no trailing ?)", () => {
    expect(buildHref({ cursor: null, filters: {} })).toBe("/admin/entries");
  });

  it('"Load more" path: cursor + filters preserved together', () => {
    const href = buildHref({
      cursor,
      filters: { category: "howto", tag: "voyage", sensitivity: "public" },
    });
    expect(href).toMatch(/^\/admin\/entries\?/);
    expect(href).toContain("cursor_updated_at=2026-01-15T10%3A00%3A00.000Z");
    expect(href).toContain(`cursor_id=${cursor.id}`);
    expect(href).toContain("category=howto");
    expect(href).toContain("tag=voyage");
    expect(href).toContain("sensitivity=public");
  });

  it("chip-remove path: filters edited, cursor dropped", () => {
    // Caller flow: drop one filter from the current set, set cursor to
    // null. The resulting URL retains the siblings only.
    const href = buildHref({
      cursor: null,
      filters: { category: "howto", tag: undefined, sensitivity: "public" },
    });
    expect(href).toContain("category=howto");
    expect(href).toContain("sensitivity=public");
    expect(href).not.toContain("tag=");
    expect(href).not.toContain("cursor_");
  });

  it("CHIP_ORDER emission: sensitivity → category → tag for screenshot stability", () => {
    const href = buildHref({
      cursor: null,
      filters: { tag: "v", category: "c", sensitivity: "public" },
    });
    const sIdx = href.indexOf("sensitivity=");
    const cIdx = href.indexOf("category=");
    const tIdx = href.indexOf("tag=");
    expect(sIdx).toBeGreaterThan(-1);
    expect(cIdx).toBeGreaterThan(-1);
    expect(tIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeLessThan(cIdx);
    expect(cIdx).toBeLessThan(tIdx);
  });

  it("cursor emitted BEFORE filters (debug log readability)", () => {
    const href = buildHref({ cursor, filters: { category: "c" } });
    expect(href.indexOf("cursor_updated_at=")).toBeLessThan(href.indexOf("category="));
  });

  it("symmetric: filter-add path uses the same helper as chip-remove", () => {
    // Regression pin per the m7 (symmetric URL-helper) review finding:
    // adding a filter (e.g. a future "+ filter" affordance) MUST use
    // the same helper as chip-remove so the emission contract stays
    // single-sourced. We exercise the add path here by building from a
    // bare state up to a filtered one — proving the same helper covers
    // both directions of edit.
    const start = buildHref({ cursor: null, filters: {} });
    const added = buildHref({ cursor: null, filters: { category: "howto" } });
    expect(start).toBe("/admin/entries");
    expect(added).toBe("/admin/entries?category=howto");
  });
});

// ---------------------------------------------------------------------------
// parseFilters — query-param → ListFilters with validation
// ---------------------------------------------------------------------------

describe("parseFilters — validated query-param ingest", () => {
  it("all three filters present + valid → all three returned", () => {
    expect(parseFilters({ category: "howto", tag: "voyage", sensitivity: "public" })).toEqual({
      category: "howto",
      tag: "voyage",
      sensitivity: "public",
    });
  });

  it("empty object → empty filters (no defaults sneak in)", () => {
    expect(parseFilters({})).toEqual({});
  });

  it("first-wins on repeated query-params (matches firstParam policy)", () => {
    // Regression pin per the m5 (multi-value first-wins) review finding.
    // Document policy via test: a future change to firstParam that
    // flipped to "last-wins" or "reject-as-malformed" would break
    // this expectation and surface immediately.
    expect(parseFilters({ tag: ["A", "B"] })).toEqual({ tag: "A" });
    expect(parseFilters({ category: ["a", "b", "c"] })).toEqual({ category: "a" });
    expect(parseFilters({ sensitivity: ["internal", "public"] })).toEqual({
      sensitivity: "internal",
    });
  });

  it("invalid sensitivity value drops silently (no chip will render)", () => {
    // The page's chip-row reads from the post-parse filters object, so
    // an invalid value must be ABSENT — NOT present-with-original-string.
    // Otherwise the chip-row would render a filter the SQL is ignoring.
    expect(parseFilters({ sensitivity: "PUBLIC" })).toEqual({});
    expect(parseFilters({ sensitivity: "secret" })).toEqual({});
  });

  it(">200-char filter drops silently (length cap)", () => {
    const long = "x".repeat(201);
    expect(parseFilters({ category: long })).toEqual({});
    expect(parseFilters({ tag: long })).toEqual({});
  });

  it("empty-string filter drops silently", () => {
    expect(parseFilters({ category: "", tag: "", sensitivity: "" })).toEqual({});
  });

  it("mixed valid/invalid: only valid filters survive", () => {
    // Negative-assertion: a regression that returned the raw value
    // for invalid sensitivity (e.g., `{ sensitivity: "PUBLIC" }`) would
    // silently re-introduce the chip-without-filter UX bug. Pin shape.
    expect(parseFilters({ category: "howto", sensitivity: "PUBLIC" })).toEqual({
      category: "howto",
    });
  });
});

// ---------------------------------------------------------------------------
// clampFiltersForAudit — anonymous-rate log-amplification guard.
// ---------------------------------------------------------------------------

describe("clampFiltersForAudit — unauthorized-branch payload bound", () => {
  it("served branch: full 200-char window passes through verbatim", () => {
    const long = "x".repeat(200);
    const out = clampFiltersForAudit({ category: long, tag: long }, "served");
    expect(out.category).toBe(long);
    expect(out.tag).toBe(long);
  });

  it("unauthorized branch: category + tag truncated to 64 chars", () => {
    const long = "x".repeat(200);
    const out = clampFiltersForAudit({ category: long, tag: long }, "unauthorized");
    expect(out.category).toHaveLength(64);
    expect(out.tag).toHaveLength(64);
  });

  it("unauthorized branch: short values pass through unchanged", () => {
    const out = clampFiltersForAudit({ category: "howto", tag: "voyage" }, "unauthorized");
    expect(out.category).toBe("howto");
    expect(out.tag).toBe("voyage");
  });

  it("always serializes the three keys (never omitted) — downstream forensic query stability", () => {
    const out = clampFiltersForAudit({}, "served");
    expect(out).toEqual({ category: null, tag: null, sensitivity: null });
  });

  it("sensitivity is NOT truncated (enum-validated upstream, bounded by construction)", () => {
    const out = clampFiltersForAudit({ sensitivity: "restricted" }, "unauthorized");
    expect(out.sensitivity).toBe("restricted");
  });
});
