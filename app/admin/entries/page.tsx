// app/admin/entries/page.tsx — M4 #1a admin entry browser (list view).
//
// Read-only listing of every entry, keyset-paginated by (updated_at, id),
// linking each row to the existing read-only detail page at /entries/[id].
// Non-admin requests collapse to notFound() — mirrors the /entries/[id]
// auth-fail-and-not-found collapse so the URL surface yields a single
// shape regardless of role.
//
// Why a server component:
//   - Pure rendered HTML, no client-side state.
//   - resolveRoleFromHeader runs on the request thread, same path the
//     detail page uses, so the auth gate stays in lock-step with the
//     route-handler primitives (`withAdmin` / `withUserOrAdmin`).
//   - Cursor decoding is flat query-param (no opaque token) so the URL
//     is debuggable in server logs and `gh` paste-able.
//
// Cache stance: `dynamic = "force-dynamic"` is non-negotiable. The page
// renders restricted-tier rows for admin; Next's full route cache would
// otherwise serve those bytes back on a subsequent non-admin request to
// the same URL. Same rationale as app/entries/[id]/page.tsx.

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";

import * as schema from "@/drizzle/schema";
import { resolveRoleFromHeader, STUB_ROLE_HEADER, type Role } from "@/lib/auth";
import { getDb, getPool } from "@/lib/db";
import {
  isUuid,
  listEntriesForAdmin,
  validateFilterString,
  validateSearchQuery,
  validateSensitivityFilter,
  type EntryListItem,
  type ListCursor,
  type ListFilters,
} from "@/lib/entries";
import type { Sensitivity } from "@/drizzle/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_LIMIT = 25;
// Display-only tag cap — entries.tags has no semantic priority order, so
// "first N" is purely a layout choice, NOT a ranking signal. Documented
// here so future readers don't infer a sort.
const TAG_DISPLAY_CAP = 3;

interface PageProps {
  searchParams: Promise<{
    cursor_updated_at?: string | string[];
    cursor_id?: string | string[];
    category?: string | string[];
    tag?: string | string[];
    sensitivity?: string | string[];
    q?: string | string[];
  }>;
}

const SEARCH_INPUT_MAXLENGTH = 500;

/**
 * `shouldDropCursor` — when ANY of {filter, query} is present in the
 * URL alongside `cursor_*`, drop the cursor. A pasted URL that mixes
 * a stale cursor (from an unfiltered/unsearched browse) with a fresh
 * filter or query would land mid-page on a different result set —
 * confusing UX with newer matching rows hidden above the cursor.
 * Filter/query change always resets to page 1 of the new set.
 */
function shouldDropCursor(filters: ListFilters, query: string | null): boolean {
  return query !== null || CHIP_ORDER.some((k) => filters[k] !== undefined);
}

// Deterministic chip-row + URL emission order — sensitivity → category → tag.
// Helps screenshot tests + lets a future e2e assert chip presence by index.
//
// NOTE: this URL/UI ordering is intentionally DISTINCT from the SQL-builder
// filter-append order in `lib/entries.ts` (category → tag → sensitivity).
// They serve different invariants:
//   - SQL-append order pins parameter positions for the bind-contract tests.
//   - CHIP_ORDER pins what an admin sees rendered + what `buildHref` emits.
// Changing either does NOT require changing the other; they're independent
// stable orderings of the same three-element set.
const CHIP_ORDER: ReadonlyArray<keyof ListFilters> = ["sensitivity", "category", "tag"];

export default async function AdminEntriesListPage({
  searchParams,
}: PageProps): Promise<React.ReactNode> {
  const sp = await searchParams;
  const headerStore = await headers();
  const role = resolveRoleFromHeader(headerStore.get(STUB_ROLE_HEADER));

  // Parse filters + query BEFORE the auth gate so the audit row on the
  // unauthorized branch can capture the attempted state (forensic value
  // when a non-admin URL-pokes `?sensitivity=restricted` or `?q=foo`).
  const filters = parseFilters(sp);
  const query = parseSearchQuery(sp);
  const hasActiveFilter = CHIP_ORDER.some((k) => filters[k] !== undefined);
  const hasActiveQuery = query !== null;

  // Non-admin collapses to notFound() — same shape as a missing route.
  // Audit row is written FIRST (mirrors detail-page discipline), then
  // notFound() throws and unwinds. Forensics survive in audit_log.
  if (role !== "admin") {
    await writeListAuditRow({
      role,
      cursor: null,
      resultCount: 0,
      outcome: "unauthorized",
      filters,
      query,
    });
    notFound();
  }

  // Filter/query + cursor coherence: see shouldDropCursor docstring.
  const cursor = shouldDropCursor(filters, query) ? null : parseCursor(sp);

  const result = await listEntriesForAdmin(getPool(), role, {
    limit: PAGE_LIMIT,
    cursor,
    filters,
    query: query ?? undefined,
  });

  await writeListAuditRow({
    role,
    cursor,
    resultCount: result.rows.length,
    outcome: "served",
    filters,
    query,
  });

  return (
    <main
      style={{
        maxWidth: "60rem",
        margin: "0 auto",
        padding: "2rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h1 style={{ margin: 0 }}>Entries</h1>
        <p style={{ fontSize: "0.875rem", color: "var(--kramer-neutral)", margin: 0 }}>
          {composeListSummary(result.rows.length, hasActiveFilter, hasActiveQuery)}
        </p>
        <SearchForm query={query} filters={filters} />
      </header>

      {(hasActiveFilter || hasActiveQuery) && <FilterChipRow filters={filters} query={query} />}

      {result.rows.length === 0 ? (
        <p data-testid="admin-entries-empty" style={{ opacity: 0.8 }}>
          {composeEmptyCopy(query, hasActiveFilter)}
        </p>
      ) : (
        <ul
          aria-label="Entries"
          data-testid="admin-entries-list"
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          {result.rows.map((row) => (
            <EntryCard key={row.id} row={row} />
          ))}
        </ul>
      )}

      {result.nextCursor !== null && (
        <nav style={{ fontSize: "0.875rem" }}>
          <Link
            data-testid="admin-entries-load-more"
            href={buildHref({ cursor: result.nextCursor, filters, query })}
          >
            Load more →
          </Link>
        </nav>
      )}
    </main>
  );
}

function composeListSummary(rowCount: number, hasFilter: boolean, hasQuery: boolean): string {
  // Single "matching" adjective when filter and/or query is active —
  // the chip-row above the list communicates WHICH constraints are in
  // effect, so the header copy doesn't need to enumerate them.
  // Previous "matched"-only fallthrough when both were active hid the
  // filter signal in the summary line.
  const prefix = hasFilter || hasQuery ? "Showing " : "";
  const adjective = hasFilter || hasQuery ? "matching " : "";
  const plural = rowCount === 1 ? "" : "s";
  return `Admin browser — read-only. ${prefix}${rowCount} ${adjective}row${plural} on this page.`;
}

function composeEmptyCopy(query: string | null, hasFilter: boolean): string {
  // Branched per iron-rule-#12 degraded-mode UX: an admin needs to
  // distinguish "no matches for this search" from "no filters match"
  // from "the corpus is empty."
  if (query !== null && hasFilter) {
    return `No entries match "${query}" with the active filters.`;
  }
  if (query !== null) {
    return `No entries match "${query}".`;
  }
  if (hasFilter) {
    return "No entries match the active filters.";
  }
  return "No entries yet.";
}

function SearchForm({
  query,
  filters,
}: {
  query: string | null;
  filters: ListFilters;
}): React.ReactNode {
  return (
    <form
      method="get"
      action="/admin/entries"
      role="search"
      aria-label="Search entries"
      data-testid="admin-entries-search-form"
      style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
    >
      {/* Visually-hidden label for screen readers. */}
      <label htmlFor="admin-entries-search-input" className="sr-only">
        Search entries
      </label>
      <input
        id="admin-entries-search-input"
        name="q"
        type="search"
        defaultValue={query ?? ""}
        placeholder="Search title, tags, body…"
        maxLength={SEARCH_INPUT_MAXLENGTH}
        autoComplete="off"
        style={{
          flex: "1 1 18rem",
          fontFamily: "inherit",
          fontSize: "0.875rem",
          padding: "0.375rem 0.625rem",
          borderRadius: "0.375rem",
          border: "1px solid var(--kramer-neutral)",
          background: "rgba(220, 221, 222, 0.04)",
          color: "inherit",
        }}
      />
      {/*
        Preserve active filters across the GET submit so search composes
        WITH filters rather than replacing them. Hidden inputs for cursor
        are DELIBERATELY omitted — submitting the form resets to page 1
        (same rule as any chip-row edit).
      */}
      {CHIP_ORDER.map((key) => {
        const value = filters[key];
        if (value === undefined) return null;
        return <input key={key} type="hidden" name={key} value={value} />;
      })}
      <button
        type="submit"
        style={{
          fontFamily: "inherit",
          fontSize: "0.875rem",
          padding: "0.375rem 0.875rem",
          borderRadius: "0.375rem",
          border: "1px solid var(--kramer-neutral)",
          background: "var(--kramer-neutral)",
          color: "var(--kramer-bg)",
          cursor: "pointer",
        }}
      >
        Search
      </button>
    </form>
  );
}

function FilterChipRow({
  filters,
  query,
}: {
  filters: ListFilters;
  query: string | null;
}): React.ReactNode {
  return (
    <ul
      aria-label="Active filters"
      data-testid="admin-entries-filter-chips"
      style={{
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "flex",
        flexWrap: "wrap",
        gap: "0.5rem",
      }}
    >
      {/*
        Search chip renders FIRST — the broadest active constraint and
        the most actionable thing to clear. Reading order: search →
        sensitivity → category → tag (CHIP_ORDER).
      */}
      {query !== null && (
        <li className="filter-chip" data-testid="admin-entries-filter-chip-q" data-filter-key="q">
          <span className="filter-chip-label">search:</span>{" "}
          <span className="filter-chip-value">{`"${query}"`}</span>
          <Link
            aria-label="Remove search query"
            data-testid="admin-entries-filter-chip-remove-q"
            href={buildHref({ cursor: null, filters, query: null })}
            className="filter-chip-remove"
          >
            ×
          </Link>
        </li>
      )}
      {CHIP_ORDER.map((key) => {
        const value = filters[key];
        if (value === undefined) return null;
        // Chip-remove drops the cursor in addition to the removed filter
        // (filter change resets pagination — same rule as filter-add).
        // Search query is PRESERVED across a filter-chip remove (the two
        // chip families compose independently).
        const removeHref = buildHref({
          cursor: null,
          filters: { ...filters, [key]: undefined },
          query,
        });
        return (
          <li
            key={key}
            className="filter-chip"
            data-testid={`admin-entries-filter-chip-${key}`}
            data-filter-key={key}
          >
            <span className="filter-chip-label">{key}:</span>{" "}
            <span className="filter-chip-value">{value}</span>
            <Link
              aria-label={`Remove ${key} filter`}
              data-testid={`admin-entries-filter-chip-remove-${key}`}
              href={removeHref}
              className="filter-chip-remove"
            >
              ×
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function EntryCard({ row }: { row: EntryListItem }): React.ReactNode {
  const verifiedDate = row.last_verified_at.toISOString().slice(0, 10);
  const updatedDate = row.updated_at.toISOString().slice(0, 10);
  const visibleTags = row.tags.slice(0, TAG_DISPLAY_CAP);
  const hiddenTagCount = row.tags.length - visibleTags.length;

  return (
    <li
      style={{
        background: "rgba(220, 221, 222, 0.04)",
        border: "1px solid var(--kramer-neutral)",
        borderRadius: "0.5rem",
        padding: "0.875rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "baseline" }}>
        <Link
          href={`/entries/${row.id}`}
          dir="auto"
          style={{ fontSize: "1.0625rem", fontWeight: 600 }}
        >
          {row.title}
        </Link>
        <span
          className="sensitivity-pill"
          data-tier={row.sensitivity}
          data-testid="sensitivity-pill"
        >
          {row.sensitivity}
        </span>
        <span style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)" }}>
          category: {row.category}
        </span>
        {/*
          M4 #2 — admin Edit affordance. Page is already admin-gated at
          the top, so this Link renders only for admins by construction.
          marginLeft: auto pushes it to the row's trailing edge.
        */}
        <Link
          href={`/admin/entries/${row.id}/edit`}
          data-testid="admin-entries-edit-link"
          style={{ marginLeft: "auto", fontSize: "0.75rem" }}
        >
          Edit
        </Link>
      </div>

      {visibleTags.length > 0 && (
        <ul
          aria-label="Tags"
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexWrap: "wrap",
            gap: "0.375rem",
          }}
        >
          {visibleTags.map((tag) => (
            <li
              key={tag}
              style={{
                fontSize: "0.75rem",
                padding: "0.125rem 0.5rem",
                borderRadius: "999px",
                border: "1px solid var(--kramer-neutral)",
                opacity: 0.85,
              }}
            >
              {tag}
            </li>
          ))}
          {hiddenTagCount > 0 && (
            <li
              style={{
                fontSize: "0.75rem",
                color: "var(--kramer-neutral)",
                opacity: 0.7,
              }}
            >
              +{hiddenTagCount} more
            </li>
          )}
        </ul>
      )}

      <div style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)", opacity: 0.85 }}>
        verified {verifiedDate} · updated {updatedDate}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Cursor: flat query-param pair (?cursor_updated_at=ISO&cursor_id=UUID).
// Validation is strict — any malformed value collapses to "no cursor" and
// the user gets page 1. Never throw; never 500 on a bad URL.
// ---------------------------------------------------------------------------
function parseCursor(sp: {
  cursor_updated_at?: string | string[];
  cursor_id?: string | string[];
}): ListCursor | null {
  const rawAt = firstParam(sp.cursor_updated_at);
  const rawId = firstParam(sp.cursor_id);
  if (rawAt === null || rawId === null) return null;
  if (!isUuid(rawId)) return null;
  const ms = Date.parse(rawAt);
  if (!Number.isFinite(ms)) return null;
  // Round-trip precision: node-postgres already truncates timestamptz to
  // ms when materializing JS Date (Date can't represent µs), so the cursor
  // we emit is ms-precision in the first place; toISOString → Date.parse
  // preserves it exactly. Postgres column precision (µs) matters only if
  // a future raw-SQL caller seeds rows with sub-ms timestamps.
  return { updatedAt: new Date(ms), id: rawId };
}

// Repeated-param policy: `?cursor_updated_at=A&cursor_updated_at=B` uses
// `A` and silently drops `B`. Either silent-first or reject-as-malformed
// would be defensible; first-wins matches Next's typical convention and
// is the friendliest to copy-pasted "Load more" links.
function firstParam(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value;
}

/**
 * Compose the admin/entries URL from a target {cursor, filters} state.
 * Used by the "Load more" link (cursor advances, filters preserved) AND
 * by each chip-remove link (filters edited, cursor dropped). The two
 * call sites share this helper so the param-emission contract can't
 * silently drift between them.
 *
 * Param emission order is stable for screenshot-test friendliness:
 * cursor_* first, then `q` (search), then sensitivity → category → tag
 * (matches CHIP_ORDER). Note the form-GET submission path emits in
 * field-declaration order rather than this canonical order — both shapes
 * are accepted by `parseFilters` + `parseSearchQuery` (order-independent),
 * so users browsing via the form and users following Load-more links
 * land on the same result set regardless of param order.
 */
export function buildHref(state: {
  cursor: ListCursor | null;
  filters: ListFilters;
  query?: string | null;
}): string {
  const params = new URLSearchParams();
  if (state.cursor !== null) {
    params.set("cursor_updated_at", state.cursor.updatedAt.toISOString());
    params.set("cursor_id", state.cursor.id);
  }
  if (state.query !== null && state.query !== undefined) {
    params.set("q", state.query);
  }
  for (const key of CHIP_ORDER) {
    const value = state.filters[key];
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs.length > 0 ? `/admin/entries?${qs}` : "/admin/entries";
}

/**
 * Parse + validate the three filter query params. Returns a sparse
 * `ListFilters` object containing only POST-VALIDATION values, so the
 * chip-row driver and the SQL builder agree on what's actually active.
 *
 * Repeated-param policy matches `firstParam` (first-wins, silent on
 * subsequent values). Invalid values are dropped silently — the
 * resulting chip-row simply doesn't render that chip, signaling to
 * the admin that their input was rejected.
 */
export function parseFilters(sp: {
  category?: string | string[];
  tag?: string | string[];
  sensitivity?: string | string[];
}): ListFilters {
  const filters: ListFilters = {};
  const rawCategory = firstParam(sp.category);
  const validCategory = validateFilterString(rawCategory);
  if (validCategory !== null) filters.category = validCategory;

  const rawTag = firstParam(sp.tag);
  const validTag = validateFilterString(rawTag);
  if (validTag !== null) filters.tag = validTag;

  const rawSensitivity = firstParam(sp.sensitivity);
  const validSensitivity = validateSensitivityFilter(rawSensitivity);
  if (validSensitivity !== null) filters.sensitivity = validSensitivity;

  return filters;
}

/**
 * Parse + validate the `?q=` search-query param. Returns the post-
 * validation trimmed string or `null`. Same first-wins repeated-param
 * policy as `parseFilters`; same drop-silently-on-invalid policy so a
 * typo like `?q=\n` renders no chip and emits no `tsv @@ ...` clause.
 */
export function parseSearchQuery(sp: { q?: string | string[] }): string | null {
  const raw = firstParam(sp.q);
  return validateSearchQuery(raw);
}

// ---------------------------------------------------------------------------
// Audit row. Mirrors the detail-page discipline (entry_view): one row per
// page render, served AND denied branches, single jsonb payload. The kind
// `entry_list_view` is new — it's a user-action audit (not an agent call),
// so prompt_hash stays null and the CHECK
// `audit_log_prompt_hash_required_for_agent` is satisfied.
// ---------------------------------------------------------------------------
/**
 * Per-axis cap (in chars) on filter values written to `audit_log.payload`
 * on the unauthorized branch. Mirrors `ID_PARAM_MAX_LOG_LEN=64` on the
 * detail page — keeps anonymous URL-pokers from amplifying a single
 * request into ~400 chars of log payload via 200-char `category` +
 * 200-char `tag` strings.
 */
const FILTER_LOG_MAX = 64;

/**
 * Served-branch audit cap on the search query value. Larger than
 * FILTER_LOG_MAX because legitimate queries are sometimes long
 * (multi-keyword sentences); smaller than the validator's 500 char
 * cap because the served-branch row otherwise grows to 2.5x the
 * filter-row size. Unauthorized-branch uses the smaller
 * FILTER_LOG_MAX (anonymous-rate log-amplification ceiling).
 */
const QUERY_LOG_MAX_SERVED = 256;

/**
 * Audit-payload shape for `filters`. Always serializes the three keys
 * (never omitted), so downstream forensic queries can use
 * `payload->'filters'->>'category' IS NULL` without two-branch existence
 * tests. On the unauthorized branch, category + tag are truncated to
 * `FILTER_LOG_MAX` chars to bound the log-amplification surface.
 *
 * Exported for the co-located unit test.
 */
export function clampFiltersForAudit(
  filters: ListFilters,
  outcome: "served" | "unauthorized",
): {
  category: string | null;
  tag: string | null;
  sensitivity: Sensitivity | null;
} {
  const clamp = (raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    if (outcome === "served") return raw;
    return raw.length > FILTER_LOG_MAX ? raw.slice(0, FILTER_LOG_MAX) : raw;
  };
  return {
    category: clamp(filters.category),
    tag: clamp(filters.tag),
    // Sensitivity is enum-validated post-parseFilters, so it's bounded
    // already; no truncation arithmetic needed.
    sensitivity: filters.sensitivity ?? null,
  };
}

/**
 * Per-branch cap on the search query value written to audit_log.payload.
 * Served branch: QUERY_LOG_MAX_SERVED (256) — keeps the row from being
 * 2.5x the size of filter rows while leaving headroom for legitimate
 * multi-keyword searches. Unauthorized branch: FILTER_LOG_MAX (64) —
 * caps anonymous-rate log amplification at the same ceiling as the
 * filter axes. Returns null when no query was supplied.
 */
export function clampQueryForAudit(
  query: string | null,
  outcome: "served" | "unauthorized",
): string | null {
  if (query === null) return null;
  const cap = outcome === "served" ? QUERY_LOG_MAX_SERVED : FILTER_LOG_MAX;
  return query.length > cap ? query.slice(0, cap) : query;
}

async function writeListAuditRow(args: {
  role: Role | null;
  cursor: ListCursor | null;
  resultCount: number;
  outcome: "served" | "unauthorized";
  filters: ListFilters;
  query: string | null;
}): Promise<void> {
  try {
    await getDb()
      .insert(schema.audit_log)
      .values({
        kind: "entry_list_view",
        prompt_hash: null,
        // entry_id stays NULL — this is a list-view, not a per-entry read.
        // Per-row entry ids would re-introduce a timing oracle (FK-validating
        // single row vs. a list-shaped payload). Forensics use payload.
        entry_id: null,
        payload: {
          outcome: args.outcome,
          role: args.role,
          result_count: args.resultCount,
          cursor:
            args.cursor === null
              ? null
              : {
                  updated_at: args.cursor.updatedAt.toISOString(),
                  id: args.cursor.id,
                },
          // Captured on BOTH served and unauthorized branches — the
          // unauthorized branch surfaces what a non-admin attempted
          // (e.g., `?sensitivity=restricted` URL-poking), which has
          // forensic value at near-zero log-noise cost.
          //
          // Unauthorized-branch hardening: a non-admin request is
          // *anonymous-rate* (no auth gate before this audit write),
          // so adversary-controlled free-text in the payload becomes
          // a log-amplification surface. Truncate category + tag
          // values on the unauthorized branch to FILTER_LOG_MAX
          // (mirrors the detail-page `ID_PARAM_MAX_LOG_LEN=64`
          // precedent). Sensitivity is an enum literal post-validation,
          // so no truncation needed. The served branch keeps the
          // full 200-char window (admin requests are auth-gated and
          // forensically more valuable).
          filters: clampFiltersForAudit(args.filters, args.outcome),
          query: clampQueryForAudit(args.query, args.outcome),
        },
      });
  } catch {
    // Audit-write failure is non-fatal. Mirrors detail-page policy:
    // never turn an audit failure into a 500 for the user.
  }
}
