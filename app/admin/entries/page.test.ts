import { describe, expect, it } from "vitest";

import {
  buildHref,
  clampFiltersForAudit,
  clampQueryForAudit,
  parseFilters,
  parseSearchQuery,
} from "@/app/admin/entries/page";

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

// ---------------------------------------------------------------------------
// parseSearchQuery (M4 #1c) — same first-wins + invalid-drops policy
// ---------------------------------------------------------------------------

describe("parseSearchQuery — ?q= ingest", () => {
  it("valid string passes through (trimmed)", () => {
    expect(parseSearchQuery({ q: "invoice" })).toBe("invoice");
    expect(parseSearchQuery({ q: "  multi keyword  " })).toBe("multi keyword");
  });

  it("missing / empty / whitespace-only → null (no chip rendered)", () => {
    expect(parseSearchQuery({})).toBeNull();
    expect(parseSearchQuery({ q: "" })).toBeNull();
    expect(parseSearchQuery({ q: "   " })).toBeNull();
  });

  it("first-wins on repeated params (matches firstParam policy)", () => {
    expect(parseSearchQuery({ q: ["A", "B"] })).toBe("A");
  });

  it("invalid (control char) drops silently — no chip will render", () => {
    // Mirror of the parseFilters regression pin: a regression that
    // returned the raw value here would render an invisible "active"
    // chip the SQL is ignoring.
    expect(parseSearchQuery({ q: "a\nb" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildHref — query handling + emission order
// ---------------------------------------------------------------------------

describe("buildHref — query parameter handling", () => {
  it("query alone emits ?q= only", () => {
    expect(buildHref({ cursor: null, filters: {}, query: "invoice" })).toBe(
      "/admin/entries?q=invoice",
    );
  });

  it("query undefined or null → no q param", () => {
    expect(buildHref({ cursor: null, filters: {} })).toBe("/admin/entries");
    expect(buildHref({ cursor: null, filters: {}, query: null })).toBe("/admin/entries");
  });

  it("emission order is cursor → q → CHIP_ORDER (sensitivity → category → tag)", () => {
    // Regression pin for the canonical order. A future change that
    // reordered (e.g. CHIP_ORDER moved before q) would break screenshot
    // tests and any consumer relying on the documented contract.
    const href = buildHref({
      cursor: {
        updatedAt: new Date("2026-01-15T10:00:00.000Z"),
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      filters: { tag: "voyage", category: "howto", sensitivity: "public" },
      query: "invoice",
    });
    const cursorIdx = href.indexOf("cursor_updated_at=");
    const qIdx = href.indexOf("q=");
    const sIdx = href.indexOf("sensitivity=");
    const cIdx = href.indexOf("category=");
    const tIdx = href.indexOf("tag=");
    expect(cursorIdx).toBeGreaterThan(-1);
    expect(qIdx).toBeGreaterThan(cursorIdx);
    expect(sIdx).toBeGreaterThan(qIdx);
    expect(cIdx).toBeGreaterThan(sIdx);
    expect(tIdx).toBeGreaterThan(cIdx);
  });

  it("Load-more path: cursor + filters + query all preserved", () => {
    const cursor = {
      updatedAt: new Date("2026-01-15T10:00:00.000Z"),
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const href = buildHref({ cursor, filters: { category: "howto" }, query: "invoice" });
    expect(href).toContain("cursor_updated_at=2026-01-15T10%3A00%3A00.000Z");
    expect(href).toContain("q=invoice");
    expect(href).toContain("category=howto");
  });

  it("query-chip-remove path: query dropped, filters preserved, cursor dropped", () => {
    // Chip-remove for the search chip emits the URL with query:null.
    // Filters should survive; cursor should not (filter/query change
    // resets pagination).
    const href = buildHref({
      cursor: null,
      filters: { category: "howto", sensitivity: "public" },
      query: null,
    });
    expect(href).not.toContain("q=");
    expect(href).not.toContain("cursor_");
    expect(href).toContain("category=howto");
    expect(href).toContain("sensitivity=public");
  });
});

// ---------------------------------------------------------------------------
// clampQueryForAudit (M4 #1c) — served vs unauthorized branch
// ---------------------------------------------------------------------------

describe("clampQueryForAudit — anonymous-rate log-amp guard for query", () => {
  it("returns null when no query supplied (always-three-keys serialization)", () => {
    expect(clampQueryForAudit(null, "served")).toBeNull();
    expect(clampQueryForAudit(null, "unauthorized")).toBeNull();
  });

  it("served branch: passes through up to 256 chars verbatim", () => {
    expect(clampQueryForAudit("invoice", "served")).toBe("invoice");
    expect(clampQueryForAudit("x".repeat(256), "served")).toBe("x".repeat(256));
  });

  it("served branch: truncates above 256 to compromise log-row size", () => {
    // Validator allows 500 chars; served-branch audit caps at 256 to
    // keep payload size comparable to filter rows.
    const out = clampQueryForAudit("x".repeat(500), "served");
    expect(out).toHaveLength(256);
  });

  it("unauthorized branch: caps at 64 chars (FILTER_LOG_MAX precedent)", () => {
    const out = clampQueryForAudit("x".repeat(500), "unauthorized");
    expect(out).toHaveLength(64);
  });

  it("unauthorized branch: short queries pass through unchanged", () => {
    expect(clampQueryForAudit("invoice", "unauthorized")).toBe("invoice");
  });
});
