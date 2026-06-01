// lib/agents-tools.ts — agent tool registry (ADR-0010 §6).
//
// Four tools the Ingestion Agent can call:
//   - submit_entry      → wraps IngestBody, lands a new entry
//   - list_categories   → SELECT DISTINCT category FROM entries
//   - search_kb         → duplicate detection (M3-deferred; M2a stub)
//   - list_tags         → ADR-0025 D5 suggest endpoint mirror (M4 #4 PR-C):
//                         optional prefix; returns role-filtered catalog
//
// Wire-shape conforms to the Anthropic SDK's `tools` parameter:
// `{ name, description, input_schema }` where `input_schema` is JSON
// Schema Draft 7.
//
// Dispatch lives in step 3's SSE route's tool-use loop driver — the
// registry exports wire shape only. The driver does:
//   1. `IngestBody.safeParse(tool_use_start.input)` for submit_entry,
//   2. branches `name` to a local handler (list_categories runs a
//      SELECT; search_kb returns the M2a stub).
// Keeping dispatch out of the registry keeps this module pure-data and
// trivially testable.
//
// On `tags` defaulting: the agent's submit_entry call may omit `tags`
// entirely (it is NOT in the required[] list). The route driver feeds
// `tool_use_start.input` to `IngestBody.safeParse(...)` which fills the
// `tags: []` default before the wrapper receives `IngestInput`. The
// chain "agent omit → Zod default → wrapper gets []" is the load-bearing
// invariant the drift-floor test in agents-tools.test.ts protects.
//
// Iron-rule footprint:
//   #6  `sensitivity` enum is `sensitivityEnum` from drizzle/schema.ts
//       (single source of truth — not re-typed here).
//   #7  `source_pointer` and `last_verified_at` are both `required[]`.

import { sensitivityEnum } from "@/drizzle/schema";

// JSON Schema constants — `as const` deep-freezes the literals so a
// future maintainer cannot mutate a required[] entry at runtime, and so
// TS preserves the literal types for the discriminated union below.

export const SUBMIT_ENTRY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 512 },
    category: { type: "string", minLength: 1, maxLength: 128 },
    tags: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 64 },
      maxItems: 32,
      description: "Free-form tags. Omit to default to [].",
    },
    body: { type: "string", minLength: 1, maxLength: 200_000 },
    source_pointer: {
      type: "string",
      minLength: 1,
      maxLength: 2048,
      description: "Ticket #, conversation link, or doc URL. No ASCII control chars.",
    },
    last_verified_at: {
      type: "string",
      format: "date-time",
      description: "ISO 8601 with timezone offset. Must be no later than now.",
    },
    sensitivity: {
      type: "string",
      enum: sensitivityEnum,
      description:
        "public = anyone in the org; internal = staff-only; restricted = scoped to admin team.",
    },
  },
  required: ["title", "category", "body", "source_pointer", "last_verified_at", "sensitivity"],
  // NOTE: `additionalProperties: false` is an LLM coaching hint, NOT a
  // server-side gate. Anthropic delivers the model's tool_use input
  // unchecked; step 3's loop driver passes it to `IngestBody.safeParse`,
  // which is `z.object({...})` (no `.strict()`) — Zod 3's default
  // behavior is to SILENTLY STRIP unknown keys, not reject them. The
  // contract drift between this schema and Zod is intentional for M2a
  // (LLM-friendly) but a future ADR should decide whether to flip
  // IngestBody to `.strict()` so the agent gets `tool_result.ok:false`
  // on hallucinated fields and can self-correct.
  additionalProperties: false,
} as const;

export const LIST_CATEGORIES_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const SEARCH_KB_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description: "Search query for duplicate detection before submitting a new entry.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

// ADR-0025 D5 list_tags: optional ILIKE prefix; both omitted-prefix and
// present-prefix surface the role-filtered catalog. No length cap on prefix
// (B1 plan-CR fix 2026-06-01: D5 specifies none + withAdmin gates the
// surface + a UTF-16 .length cap would conflate with D9's NFC code-point
// measurement). additionalProperties: false is an LLM coaching hint, NOT a
// server-side gate (same posture as submit_entry; the route + dispatch
// Zod-parse the input for actual enforcement).
export const LIST_TAGS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    prefix: {
      type: "string",
      description:
        "Optional case-insensitive prefix to filter the catalog. Omit to fetch all tags.",
    },
  },
  additionalProperties: false,
} as const;

// Tool definitions. The outer object is deliberately NOT `as const` so
// each property stays writable at the type level — `AgentToolDefinitionShape`
// (lib/agents.ts) declares `name: string` (mutable), and a readonly
// `name: "submit_entry"` from a deeply-frozen literal is NOT assignable
// to a mutable string property in strict mode. Pinning `name` to its
// literal via per-field `as const` gives the discriminated-union
// narrowing below without breaking that assignability.

export const SUBMIT_ENTRY_TOOL = {
  name: "submit_entry" as const,
  description:
    "Submit the structured KB entry once the admin has confirmed all required fields. The server runs schema validation, PII scrub, chunking, and embedding. Only call after the admin has explicitly approved the final values; this is the one-shot commit path (no auto-retry on dropped connection).",
  input_schema: SUBMIT_ENTRY_INPUT_SCHEMA,
};

export const LIST_CATEGORIES_TOOL = {
  name: "list_categories" as const,
  description:
    "List the categories already in use across the KB. Use this to suggest a category that matches existing entries instead of creating a near-duplicate spelling. Returns { categories: string[] }.",
  input_schema: LIST_CATEGORIES_INPUT_SCHEMA,
};

export const SEARCH_KB_TOOL = {
  name: "search_kb" as const,
  description:
    "Search the KB for entries similar to a draft. Use before submit_entry to surface possible duplicates. In M2a the implementation is stubbed and returns { candidates: [], note: 'retrieval_unavailable_m2a' } — treat that as 'no duplicate-check available; proceed and inform the admin in one line'.",
  input_schema: SEARCH_KB_INPUT_SCHEMA,
};

export const LIST_TAGS_TOOL = {
  name: "list_tags" as const,
  description:
    "List existing tags in the KB, sorted by entry_count DESC then alphabetical. Optional `prefix` (case-insensitive) narrows the catalog — useful while collecting the `tags` field to suggest existing canonical names rather than create near-duplicate spellings. Returns { tags: Array<{ name: string, entry_count: number }> }. Always prefer reusing an existing canonical name (case-sensitive byte identity) over inventing a new tag.",
  input_schema: LIST_TAGS_INPUT_SCHEMA,
};

/**
 * Discriminated union over the three M2a tool names. Narrower than
 * `AgentToolDefinitionShape` from `lib/agents.ts`: each member pins
 * `name` to a literal so step 3's loop driver can exhaustively switch
 * on `tool_use_start.name` to dispatch.
 */
export type AgentToolDefinition =
  | typeof SUBMIT_ENTRY_TOOL
  | typeof LIST_CATEGORIES_TOOL
  | typeof SEARCH_KB_TOOL
  | typeof LIST_TAGS_TOOL;

/**
 * The registry the agent gets at every call. Static `ReadonlyArray` for
 * M2a — sensitivity-filtered subsets / feature-flag gating would
 * require a function form; revisit at M5 hosting cut (ADR-0010 §6).
 *
 * Assignment to `readonly AgentToolDefinitionShape[]` on
 * `AgentStreamInput.tools` is safe because the union members each
 * satisfy the structural shape (literal `name` ⊂ `string`; readonly
 * `input_schema` ⊂ `unknown`).
 */
export const AGENT_TOOLS: ReadonlyArray<AgentToolDefinition> = [
  SUBMIT_ENTRY_TOOL,
  LIST_CATEGORIES_TOOL,
  SEARCH_KB_TOOL,
  LIST_TAGS_TOOL,
];
