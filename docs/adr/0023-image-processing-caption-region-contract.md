# ADR-0023 — Image processing: display-only caption column + deferred region-attribution contract (M2b #7)

- **Date:** 2026-05-28
- **Status:** Accepted (design only — no production code in the ratifying PR)
- **Deciders:** Gal Zilberman + Claude (with independent plan-reviewer subagent)

## Context

[ROADMAP M2b #7](../ROADMAP.md) reads: *"Image processing: screenshots get OCR'd
+ caption extracted; stored as chunks attributed to the parent entry."* Two of
those three clauses already ship:

- **OCR'd** — [api/handlers/media_ingest.py](../../api/handlers/media_ingest.py)
  routes image MIMEs through `OcrAdapter.ocr_bytes` (Azure DI `prebuilt-layout`
  or the deterministic stub) per [ADR-0022](0022-ocr-adapter.md).
- **Stored as chunks attributed to the parent entry** — the worker flattens
  `OcrResult.text` and PUTs it as the entry `body`; Node chunks + embeds it
  against `entry_id` per [ADR-0009](0009-chunking-strategy.md). The chunk→entry
  attribution is the existing composite-FK (`chunks.(entry_id, sensitivity) →
  entries.(id, sensitivity)`).

So M2b #7's **net-new** surface is exactly two things:

1. **Caption extraction** — a short human-readable label for the screenshot,
   distinct from its (often long, form-label-dense) OCR body.
2. **Region attribution** — [ADR-0022 D1](0022-ocr-adapter.md) recorded that
   *"M2b #7 will amend the contract to add an optional `regions:
   list[BoundingRegion] | None` field"*, so a citation can eventually point at
   *where on the screenshot* an answer came from.

Two facts constrain the design:

- **The worker→Node boundary flattens structure.** The PUT body carries
  `body: str` only (ADR-0021 D1); `OcrResult.paragraphs`, per-paragraph
  `boundingRegions`, and paragraph `role` tags that `prebuilt-layout` returns
  are discarded at the worker before Node sees them. Region-attributed chunks
  therefore require threading paragraph+region structure across that boundary,
  a region-aware chunker, and new `chunks` columns — none of which exist.
- **There are no real images in the corpus yet, and the embedder is the
  deterministic stub.** Per [ADR-0011 Amendment 2026-05-27](0011-repo-visibility.md#amendment-2026-05-27--revert-trigger-event-gated-to-production-stage-transition)
  the project is in the development/synthetic-fixture stage; no live Azure DI
  smoke has run and retrieval quality on real screenshots is unmeasurable. Any
  retrieval-quality-motivated work built now optimizes a path that cannot be
  observed.

`entries.body` is **post-PII-scrub** canonical text ([ADR-0009 §5](0009-chunking-strategy.md));
`OcrResult.paragraphs` is **pre-scrub** raw OCR. The retrieval/embed prefix is
`Title:` + `Tags:` only, embed-time-only, applied to every chunk of every entry
by the shared `buildEmbedInput` in [lib/chunk.ts](../../lib/chunk.ts) via
`deriveChunksAndEmbeddings` in [lib/ingest.ts](../../lib/ingest.ts) ([ADR-0009 §6](0009-chunking-strategy.md)).

## Decision

### D1 — Caption is a display-only field, derived from the post-scrub body

The caption is the **first non-empty line of `entries.body`** (the post-scrub
canonical text), trimmed and clipped to `CAPTION_DISPLAY_CLIP_CHARS = 160`.

- **Source is the scrubbed body, NOT `OcrResult.paragraphs`.** Deriving from the
  raw OCR result would surface PII on the citation card that the body scrub
  removed — an iron-rule #6 / PII regression. The caption must never carry text
  the body doesn't.
- **Deterministic, no LLM.** No model call → no iron-rule #8 surface (no live
  API SDK on the embed/agent path), no iron-rule #10 surface (no agent response
  to hash), no Anthropic-key dependency, fully reproducible in tests.
- **Upgrade path documented, not built.** A higher-quality caption can later use
  `prebuilt-layout` paragraph `role` tags (`title` / `sectionHeading` /
  `pageHeader`). That requires threading roles through the flattening boundary
  (see D3) and is **deferred**; the first-line heuristic is the stopgap that
  needs no contract change.

### D2 — Caption storage: nullable display-only column, NOT embedded

```ts
// drizzle schema — entries table addition (migration deferred to impl slice)
caption: text("caption"),   // nullable; display-only; derived from post-scrub body
```

- **Nullable.** Text-only entries (the common non-media case) have no caption;
  the column is `NULL`, not an empty string.
- **NOT in the embed prefix.** The caption is **not** added to `buildEmbedInput`.
  Reasoning: for an OCR'd screenshot the caption is a literal prefix-substring of
  chunk 0's already-embedded body, so embedding it again adds ~zero recall lift;
  and changing the shared `Title:`/`Tags:` prefix would shift the embedding
  distance space for the **entire corpus** (every chunk of every entry, text
  entries included), forcing a `embedding_version` bump + full re-embed via
  `scripts/rechunk.ts` ([ADR-0009 §8](0009-chunking-strategy.md)) — a KB-wide
  blast radius for a contested benefit. The caption's value is **display**
  (citation card / entry-detail header), not retrieval.
- **NOT separately chunked.** It is short and already a substring of the body.
- **Sensitivity.** The caption renders only where the entry itself is already
  visible to the requesting role (it derives from the same post-scrub body that
  `findEntryForRole` already gates); no separate sensitivity column is needed
  because the caption is never served independently of its entry.

### D3 — `BoundingRegion` / `OcrResult.regions`: contract named in intent, field deferred

This ADR **names the intent** of the region amendment ADR-0022 D1 promised and
**does not add the field** to the frozen `OcrResult` dataclass this session.
Adding `regions` now — with no producer (the stub has none) and no consumer (no
region-aware chunker, no `chunks` columns) — would be a field nobody populates,
which the project's just-in-time posture rejects.

Intended eventual shape (illustrative; **field shape is TBD-at-implementation**,
not pinned, because it must survive contact with a real region-aware chunker and
a renderable-coordinate requirement):

```python
# ILLUSTRATIVE — not added to api/ocr/types.py in this ADR's PR.
@dataclass(frozen=True, slots=True)
class BoundingRegion:
    page_number: int          # 1-based, per Azure DI
    polygon: list[float]      # flat [x1,y1,...]; UNIT + page extent TBD
    # NOTE: Azure prebuilt-layout polygons are in inches and require the
    # page `unit` + `width`/`height` to normalize to renderable coordinates.
    # Pinning `polygon` without those would not survive a real UI consumer,
    # so the field shape is intentionally left open until the implementation
    # slice has a concrete renderer to design against.

# OcrResult would gain:  regions: list[BoundingRegion] | None
```

**Why region-attributed chunks are hard (documented so the impl slice doesn't
re-discover it):** `chunks.content_start/content_end` are char offsets into
`entries.body` (the *flattened, joined, post-scrub* string). To attribute a
chunk to a screenshot region you must map a body char-offset → the source OCR
paragraph → that paragraph's `boundingRegions`. But the worker discards
paragraph structure before Node builds the body, so the mapping is unrecoverable
downstream. Closing this requires, at minimum: (a) the worker PUTs structured
paragraphs+regions, not a flat string; (b) a region-aware chunker that records,
per chunk, which source region(s) it spans; (c) new nullable `chunks` columns
(e.g. `regions jsonb`); (d) a citation UI that renders the polygon over the
stored image. Each is its own slice. **All deferred.**

### D4 — Deferral gates (the heavy legs)

| Deferred work | Gate (trigger to revisit) |
|---|---|
| Region-attributed chunks (D3 implementation) | Real screenshots ingested **and** a citation-precision gap traceable to "answer came from an un-locatable image region" |
| Vision-model caption (Claude vision describing the screenshot) | Real screenshots **and** a measured retrieval/UX gap the first-line caption demonstrably fails to close — this is a new iron-#8/#10 agent surface and gets its own ADR |
| Role-aware caption (`prebuilt-layout` heading roles) | The structured-PUT boundary from D3 lands (roles ride the same channel as regions) |
| Tesseract OCR fallback | Carried from [ADR-0022 D6](0022-ocr-adapter.md); unchanged here |

### D5 — Implementation slice this ADR unblocks (caption only)

When implemented (separate PR, not this one), the narrowest E2E slice is:

1. Migration: add nullable `entries.caption text`.
2. Derive caption from the post-scrub body at write time (create + update
   paths in [lib/ingest.ts](../../lib/ingest.ts)); applies to **all** entries
   uniformly (media and text), not an OCR-special-case — the first-line
   heuristic is content-type-agnostic.
3. Surface `caption` on the entry-detail page + citation card.
4. No change to `buildEmbedInput`, no re-embed, no `embedding_version` bump.

Region-chunks and vision-caption are **out of scope** for that slice.

## Worked example (verification artifact for a design-only ADR)

Against the committed redacted Azure fixture
[api/tests/fixtures/azure_di_layout_real.redacted.json](../../api/tests/fixtures/azure_di_layout_real.redacted.json)
(a real `prebuilt-layout` response, PII-redacted per [ADR-0022 D9](0022-ocr-adapter.md)):

- **OCR body (post-flatten, post-scrub)** begins with the form's first paragraph
  — a Priority screen label/heading line.
- **Caption (D1)** = that first non-empty body line, clipped to 160 chars.
  Concretely: a single Priority form-screen label, NOT the whole form dump. This
  is what renders on the citation card.
- **Region (D3, illustrative only)** = the `boundingRegions[0]` of that same
  first paragraph — `page_number` + `polygon` — which a future UI would draw
  over the stored screenshot. The fixture confirms `prebuilt-layout` does emit
  per-paragraph `boundingRegions`, so the eventual contract has a real producer.

This example is falsifiable against a committed artifact without writing code,
which is the design-time check that D1's caption is "a label" (useful) rather
than "the first 160 chars of an undifferentiated text wall" (useless). If a
representative fixture showed the latter, D1's first-line heuristic would be
wrong and the caption leg should defer entirely.

## Iron-rule footprint

| Rule | Status | Note |
|------|--------|------|
| #1 (no secret commit) | N/A | no new secrets; Azure creds unchanged from ADR-0022 |
| #2 (KB writes via agent/route) | ✓ | caption written through the existing ingest write path, not a raw insert |
| #6 (sensitivity tagging + redaction) | ✓ | caption derives from post-scrub body, never raw OCR (D1); renders only with its already-gated entry |
| #8 (no live API SDK in embed/agent path) | ✓ | caption is deterministic, no model call; vision-caption deferred (D4) |
| #9 (chunks carry model + version) | N/A | caption is not a chunk and not embedded (D2) |
| #10 (prompt hash per agent response) | N/A | no agent invocation; vision-caption deferred (D4) |
| #12 (degraded mode) | N/A | unchanged from ADR-0022 |

## Consequences

**Positive.**

- **Lands one concrete decision** — the display-only caption-column contract +
  the region-intent pin — so the ADR is not a no-op restatement of ADR-0022 D1.
- **Zero retrieval blast radius.** No embed-prefix change → no corpus re-embed,
  no `embedding_version` bump, no risk to the existing chunking/retrieval path.
- **No premature surface.** No frozen-dataclass field with no producer; no
  vision-agent (iron #8/#10) plumbing for an unmeasurable benefit; no schema
  columns for regions that have no renderer yet.
- **The hard part is documented, not hand-waved.** The offset→paragraph→region
  mapping problem and the flattening-boundary blocker are written down so the
  implementation slice plans against them instead of rediscovering them.

**Negative / accepted.**

- **The distinctive M2b #7 feature (region attribution) does not ship.** M2b #7
  is effectively gated on real images; this ADR pins the contract and defers the
  implementation. Accepted — building region infra against zero real images and
  a stub embedder is the just-in-case pattern the project rejects.
- **The first-line caption is a heuristic, not a true caption.** It can be a
  poor label for a screenshot whose first body line isn't its most descriptive
  text. Accepted as a cheap, safe, reversible stopgap; the role-aware and
  vision upgrades are gated in D4.
- **`BoundingRegion` shape is left open.** A future reader wanting a pinned
  contract finds intent, not a frozen field. Accepted — pinning coordinates
  without a renderer is the contract-that-won't-survive-contact failure mode.

## Alternatives considered

- **Caption in the embed prefix (recall play).** Rejected — KB-wide re-embed +
  `embedding_version` bump for a caption that is a substring of already-embedded
  body text; near-zero recall lift for maximal blast radius (D2).
- **Caption derived from `OcrResult.paragraphs` (richer source).** Rejected —
  raw OCR is pre-scrub; would leak PII onto the citation card (iron #6). Must
  derive from post-scrub `entries.body` (D1).
- **Vision-model caption now.** Rejected for this slice — new iron-#8/#10 agent
  surface + Anthropic-key dependency for a benefit unmeasurable without real
  images; gets its own ADR when gated (D4).
- **Add `OcrResult.regions` field now (honor the ADR-0022 D1 promise literally).**
  Rejected — a frozen-dataclass field with no producer and no consumer is dead
  weight; the promise is honored as a named-intent contract, implemented when a
  consumer exists (D3).
- **Defer caption too (ADR pins regions only).** Considered and rejected as the
  *headline* outcome — the display-only caption column is cheap, safe, and
  leaves the project measurably better this slice without the heavy legs. The
  worked example is the guard: if a representative fixture showed the first-line
  heuristic produces junk, this alternative becomes correct.

## Files this ADR's acceptance touches (no production code in THIS PR)

- `docs/adr/README.md` — add ADR-0023 to the index.
- `docs/ROADMAP.md` M2b #7 — annotate with the caption / region-contract split
  and the deferral gates (kept `[ ]` — the heavy legs are deferred, not done).
