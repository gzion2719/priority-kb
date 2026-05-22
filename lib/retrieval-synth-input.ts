// lib/retrieval-synth-input.ts — Stage-D synthesis input-block builder.
//
// Pure helper. No I/O, no SDK, no factory wiring. The route layer consumes
// this when composing the Synthesizer.synthesize(prompt, context) call: each
// returned string in `context: string[]` is one structured block describing
// one reranked chunk to the model.
//
// Format choice: XML tags. ADR-0012 §"Decision" / Stage D calls the block
// "tool-style"; XML tags are the Claude-preferred shape for structured
// context blocks, and the deterministic escape rules below (< > & inside
// text nodes; the only attribute values are a UUID and a numeric score, so
// attribute-quote escaping is defensive but practically unreachable) make
// the rendering byte-stable for snapshot tests.
//
// Field-name source of truth: prompts/retrieval-agent.md v0.2.0 line 20
// documents the entry shape as `{entry_id, title, body, category, tags[],
// source, last_verified_at, sensitivity, score}` — note `source`, not
// `source_pointer`. ADR-0012 §D's prose says `source_pointer`; the prompt
// is the contract the model was trained on this turn (the prompt hash is
// pinned per iron rule #10), so the rendered XML tag MUST be `<source>`.
// The TS field stays `source_pointer` to match the underlying
// `entries.source_pointer` schema column — the mapping happens in the
// renderer, not at the boundary type.
//
// Out of scope for this slice:
// - The route-layer wire-up that calls this helper (sub-slice 2c).
// - The §5 citations validator (sub-slice 2b).
// - Hashing the block-format itself for audit-drift detection — provenance
//   for the synth call lives on the audit row per ADR-0012 §E (the prompt
//   hash, model, version, candidate IDs, reranked IDs). Tracked in BACKLOG.
// - `(embedding_model, embedding_version)` are intentionally NOT surfaced
//   to the synth — the retrieval-agent prompt's freshness signal is
//   `last_verified_at`, not embedder version (see retrieval-agent.md
//   "Freshness check"). Embedder provenance lives on the audit row per §E.
//
// Why a separate file vs adding to lib/retrieval.ts: separation of
// concerns. The sibling adapters (retrieval-voyage-rerank.ts,
// retrieval-anthropic-synth.ts) split off lib/retrieval.ts to satisfy the
// no-SDK-literal source-file scan; this helper has no SDK to isolate, but
// keeping it standalone keeps lib/retrieval.ts focused on the interface
// + stub + factory triad and lets the helper own its own test surface.

/**
 * Sensitivity enum literals, matching the schema CHECK constraint on
 * `entries.sensitivity` / `chunks.sensitivity`. Validated at the helper
 * boundary so a caller can't pass a free-form string into the rendered
 * block — defensive floor for iron rule #6 (the actual enforcement is
 * ADR-0012 §B's SQL WHERE on the candidate fetch).
 */
export const SENSITIVITY_VALUES = ["public", "internal", "restricted"] as const;
export type Sensitivity = (typeof SENSITIVITY_VALUES)[number];

/**
 * One reranked chunk, ready to be rendered into the synth-input block.
 *
 * Boundary type: this is what the route layer hands the helper after
 * joining stage-C rerank output with entries-metadata. `body` is the
 * CHUNK CONTENT SLICE (the substring `entries.body[content_start..content_end]`
 * per ADR-0012 §B), NOT the full entry body — context-budget math in
 * ADR-0012 §D pins ~500 tokens per chunk × 5 chunks ≈ 3.5K input tokens;
 * passing whole entries here blows that budget silently.
 *
 * `source_pointer` (TS field) renders to `<source>` (XML tag) to match
 * prompts/retrieval-agent.md v0.2.0 line 20. See file header.
 *
 * `score` is the stage-C Voyage rerank `relevance_score`, NOT the stage-B
 * pgvector cosine distance. Documented because the two are easy to confuse
 * at the route-layer wire-up.
 *
 * `last_verified_at` is an ISO 8601 string (e.g. "2026-05-21T00:00:00Z").
 * Caller hydrates from `Date` via `.toISOString()`.
 *
 * `(embedding_model, embedding_version)` intentionally omitted — synth
 * doesn't see embedder provenance; that lives on the audit row.
 */
export interface SynthInputChunk {
  entry_id: string;
  title: string;
  body: string;
  category: string;
  tags: string[];
  source_pointer: string | null;
  last_verified_at: string;
  sensitivity: Sensitivity;
  score: number;
}

/**
 * Fixed precision for the rendered `score` attribute. 4 decimals is enough
 * to distinguish Voyage rerank scores (which are typically in [0, 1] but
 * not guaranteed) without exposing IEEE-754 tail noise that would make
 * snapshot tests fragile across Node minor versions.
 */
export const SYNTH_INPUT_SCORE_PRECISION = 4;

/**
 * Escape `<`, `>`, `&` for XML text-node insertion. Quote characters are
 * NOT escaped here — this function is for text-node content only. Attribute
 * values use {@link escapeAttribute}.
 */
export function escapeXmlText(s: string): string {
  // Order is load-bearing: `&` MUST be replaced first, otherwise the `&`
  // introduced by `&lt;` / `&gt;` would be double-escaped by a later
  // `& → &amp;` pass. The escape-test in the companion test file pins this
  // by feeding mixed `<`/`>`/`&` input and asserting the exact escaped form.
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape for XML double-quoted attribute values. Adds `"` and `'` on top of
 * the text-node set. In practice the only attributes this helper emits are
 * `entry_id` (a UUID, no special chars) and `score` (a numeric string from
 * `.toFixed`), so this is defensive — a future maintainer who promotes a
 * field to an attribute won't silently produce malformed XML.
 */
export function escapeAttribute(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Render one {@link SynthInputChunk} as an XML-tagged block.
 *
 * Layout (1-based `index` per `entries[]` position, NOT the original
 * stage-B candidate rank):
 *
 *   <entry index="1" entry_id="..." score="0.8765">
 *     <title>...</title>
 *     <category>...</category>
 *     <tags>tag1, tag2</tags>
 *     <source>...</source>
 *     <last_verified_at>2026-...</last_verified_at>
 *     <sensitivity>public</sensitivity>
 *     <body>...</body>
 *   </entry>
 *
 * Empty `tags: []` renders as `<tags></tags>` (shape-stable, NOT an omitted
 * element — a future maintainer adding a `tags`-aware test should be able
 * to assume the tag is always present). `source_pointer: null` renders as
 * `<source></source>` (same reasoning).
 *
 * Throws `RangeError` on `sensitivity` outside {@link SENSITIVITY_VALUES} —
 * defensive floor for iron rule #6 at the helper boundary.
 */
function renderChunk(chunk: SynthInputChunk, index: number): string {
  if (!SENSITIVITY_VALUES.includes(chunk.sensitivity)) {
    throw new RangeError(
      `SynthInputChunk.sensitivity must be one of ${SENSITIVITY_VALUES.join(
        ", ",
      )}; got ${JSON.stringify(chunk.sensitivity)}`,
    );
  }
  if (typeof chunk.entry_id !== "string" || chunk.entry_id.length === 0) {
    // Iron rule #3 boundary floor: a citation block missing entry_id can't
    // be cited by the model. Reject before rendering rather than emit an
    // empty `entry_id=""` attribute that would silently fail downstream
    // §5 candidate-set membership validation.
    throw new RangeError(
      `SynthInputChunk.entry_id must be a non-empty string; got ${JSON.stringify(chunk.entry_id)}`,
    );
  }
  if (!Number.isFinite(chunk.score)) {
    // `(NaN).toFixed(4)` returns the string "NaN"; `(Infinity).toFixed(4)`
    // returns "Infinity". Either would render as `score="NaN"` into the
    // model context — the helper already guards `sensitivity` defensively,
    // and `score` is the other field with a documented bad-value mode
    // (Voyage rerank scores aren't bounded). Reject loudly.
    throw new RangeError(`SynthInputChunk.score must be a finite number; got ${chunk.score}`);
  }

  const indexAttr = escapeAttribute(String(index));
  const entryIdAttr = escapeAttribute(chunk.entry_id);
  const scoreAttr = escapeAttribute(chunk.score.toFixed(SYNTH_INPUT_SCORE_PRECISION));

  const title = escapeXmlText(chunk.title);
  const category = escapeXmlText(chunk.category);
  const tags = escapeXmlText(chunk.tags.join(", "));
  const source = escapeXmlText(chunk.source_pointer ?? "");
  const lastVerifiedAt = escapeXmlText(chunk.last_verified_at);
  const sensitivity = escapeXmlText(chunk.sensitivity);
  const body = escapeXmlText(chunk.body);

  return [
    `<entry index="${indexAttr}" entry_id="${entryIdAttr}" score="${scoreAttr}">`,
    `  <title>${title}</title>`,
    `  <category>${category}</category>`,
    `  <tags>${tags}</tags>`,
    `  <source>${source}</source>`,
    `  <last_verified_at>${lastVerifiedAt}</last_verified_at>`,
    `  <sensitivity>${sensitivity}</sensitivity>`,
    `  <body>${body}</body>`,
    `</entry>`,
  ].join("\n");
}

/**
 * Build the `context: string[]` argument for `Synthesizer.synthesize`.
 *
 * Order-preserving: `result[i]` is the rendered block for `chunks[i]`.
 * Each block carries the 1-based `index` attribute (`i + 1`) so the model
 * can reference chunks by position in addition to entry_id.
 *
 * Empty input → empty output. The route layer is responsible for the
 * empty-`retrieved_entries[]` short-circuit (the v0.2.0 prompt at
 * retrieval-agent.md line 19 guarantees the model never sees zero
 * entries); this helper does NOT enforce non-emptiness.
 */
export function buildSynthContext(chunks: SynthInputChunk[]): string[] {
  return chunks.map((chunk, i) => renderChunk(chunk, i + 1));
}
