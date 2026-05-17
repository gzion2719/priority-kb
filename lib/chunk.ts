// lib/chunk.ts — deterministic, model-free chunker per ADR-0009.
//
// The slicing layer: walks `entries.body` (post-scrub canonical, NFC) and emits
// ChunkSlice rows ready to be augmented with the embed columns
// (embedding/embedding_model/embedding_version) by the ingest writer.
// Iron rule #9 (embedding identifiers per chunk) lives at the ingest boundary,
// not here — see drizzle/schema.ts `chunks` for the full row shape.
//
// Future consumers: M2a `/api/ingest`, scripts/rechunk.ts (ADR-0009 §8).
// Re-chunk detects stale rows by comparing chunks.chunking_policy_version
// against CHUNKING_POLICY_VERSION exported below.
//
// Pure CPU module — no DB, no Voyage, no Claude (non-negotiable #8).

import { getEncoding, type Tiktoken } from "js-tiktoken";

/** Increment when ANY chunking-policy decision changes. ADR-0009 §4. */
export const CHUNKING_POLICY_VERSION = "v1-2026-05-17";

export const DEFAULT_CHUNK_TOKENS = 500;
export const DEFAULT_OVERLAP_TOKENS = 60;
export const MIN_TRAILING_TOKENS = 60;
/** 256 *chars*, not tokens. The Voyage 32k *token* limit is a separate check. */
export const TITLE_CLIP_CHARS = 256;
export const VOYAGE_MAX_INPUT_TOKENS = 32000;

/** Slicing output. Ingest writer adds `entry_id`, `sensitivity`, and the embed columns. */
export type ChunkSlice = {
  chunk_index: number;
  chunk_total: number;
  content_start: number;
  content_end: number;
  token_count: number;
  chunking_policy_version: string;
};

let cachedEncoder: Tiktoken | null = null;
function getEncoder(): Tiktoken {
  if (!cachedEncoder) {
    cachedEncoder = getEncoding("o200k_base");
  }
  return cachedEncoder;
}

/**
 * Encode the body once and return a char-offset map: charOffsetAtToken[i] is the
 * char position in `body` where token i begins; charOffsetAtToken[tokens.length]
 * equals body.length.
 *
 * Per-token decode (`decode([t])`) is unsafe: a multi-byte UTF-8 codepoint split
 * across BPE tokens decodes to replacement chars in isolation, so per-token
 * lengths can drift from the source. Fast path sums per-token lengths and
 * verifies the total. If the verification fails (always rare; common for
 * pathological multi-byte inputs), fall back to cumulative `decode(slice(0,i+1))`
 * which is O(N²) but correct. For the M1-M3 ingestion-time corpus this is fast
 * enough; revisit at M5 if it shows up in observability latency.
 */
function encodeWithCharOffsets(body: string): { tokens: number[]; charOffsetAtToken: number[] } {
  const enc = getEncoder();
  const tokens = enc.encode(body);
  const charOffsetAtToken = new Array<number>(tokens.length + 1);
  charOffsetAtToken[0] = 0;

  // Fast path: per-token decode.
  let acc = 0;
  for (let i = 0; i < tokens.length; i++) {
    acc += enc.decode([tokens[i]]).length;
    charOffsetAtToken[i + 1] = acc;
  }
  if (acc === body.length) {
    return { tokens, charOffsetAtToken };
  }

  // Slow path: cumulative decode. Authoritative because decode(tokens) === body.
  for (let i = 1; i <= tokens.length; i++) {
    charOffsetAtToken[i] = enc.decode(tokens.slice(0, i)).length;
  }
  return { tokens, charOffsetAtToken };
}

function tokenIndexAtCharOffset(charOffsetAtToken: number[], charOffset: number): number {
  // Binary search for the largest index i where charOffsetAtToken[i] <= charOffset.
  let lo = 0;
  let hi = charOffsetAtToken.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (charOffsetAtToken[mid] <= charOffset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

type Range = [start: number, end: number];

/**
 * Compute char-offset ranges where a chunk boundary is illegal (ADR-0009 §3).
 * - Fenced code blocks (paired ``` ... ```). Unclosed fences are ignored.
 * - Inline code spans (single backticks on the same line, paired).
 * - Markdown table *rows* (one line at a time — splitting between rows is legal).
 */
export function computeForbiddenRanges(body: string): Range[] {
  const ranges: Range[] = [];

  // Fenced code blocks. Match opening fence (``` at start of line, optional info)
  // and closing fence (``` at start of line). Unmatched openings are ignored.
  const fenceRe = /^[ \t]*```[^\n]*\n/gm;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(body)) !== null) {
    const openStart = m.index;
    const afterOpen = m.index + m[0].length;
    const closeRe = /^[ \t]*```[ \t]*(?:\n|$)/gm;
    closeRe.lastIndex = afterOpen;
    const c = closeRe.exec(body);
    if (!c) {
      // Unclosed fence: ignore it entirely.
      continue;
    }
    const closeEnd = c.index + c[0].length;
    ranges.push([openStart, closeEnd]);
    fenceRe.lastIndex = closeEnd;
  }

  // Inline code spans (single backtick pairs, single-line). Skip ranges already
  // inside a fenced block (would double-count, harmless but messy).
  const lineRe = /[^\n]*\n?/g;
  let lm: RegExpExecArray | null;
  while ((lm = lineRe.exec(body)) !== null) {
    if (lm[0].length === 0) break;
    const lineStart = lm.index;
    const line = lm[0];
    if (rangesContain(ranges, lineStart)) continue;
    let i = 0;
    while (i < line.length) {
      const tick = line.indexOf("`", i);
      if (tick === -1) break;
      // Skip runs of 3+ consecutive backticks — those belong to fenced blocks
      // (handled above) or are stray fence punctuation, not inline-code pairs.
      let runEnd = tick;
      while (runEnd < line.length && line[runEnd] === "`") runEnd++;
      if (runEnd - tick >= 3) {
        i = runEnd;
        continue;
      }
      const close = line.indexOf("`", runEnd);
      if (close === -1) break;
      ranges.push([lineStart + tick, lineStart + close + 1]);
      i = close + 1;
    }
  }

  // Markdown table rows: any line whose first non-whitespace char is `|`.
  const tableLineRe = /^[ \t]*\|[^\n]*\n?/gm;
  while ((m = tableLineRe.exec(body)) !== null) {
    const rowStart = m.index;
    if (rangesContain(ranges, rowStart)) continue;
    ranges.push([rowStart, rowStart + m[0].length]);
  }

  // Sort + merge only TRULY overlapping ranges (strict less-than). Adjacent
  // ranges (e.g., two consecutive table rows) stay separate so that the
  // boundary between them remains a legal split point — ADR-0009 §3 forbids
  // splits *inside* a row, not *between* rows.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] < last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

function rangesContain(ranges: Range[], offset: number): boolean {
  for (const [s, e] of ranges) {
    if (offset >= s && offset < e) return true;
  }
  return false;
}

function rangeAt(ranges: Range[], offset: number): Range | null {
  for (const r of ranges) {
    if (offset >= r[0] && offset < r[1]) return r;
  }
  return null;
}

/**
 * Find the best chunk boundary char-offset in `body` for a chunk that starts at
 * `startOffset` and should end near `targetOffset`. ADR-0009 §3 preference:
 * paragraph break → sentence end → word break.
 *
 * Search window is [max(startOffset+1, targetOffset - W), targetOffset], where
 * W is one-tenth of (targetOffset - startOffset). Within the window the highest-
 * rank boundary type wins regardless of distance to target. If no legal boundary
 * exists in the window OR the target itself sits inside a forbidden range, the
 * boundary is pushed past the offending range (ADR-0009 §3 "never split inside").
 */
function findBoundary(
  body: string,
  startOffset: number,
  targetOffset: number,
  forbidden: Range[],
): number {
  // If target is inside a forbidden range, extend past it.
  const containing = rangeAt(forbidden, targetOffset);
  if (containing) {
    return Math.min(body.length, containing[1]);
  }

  const span = Math.max(1, targetOffset - startOffset);
  const windowStart = Math.max(startOffset + 1, targetOffset - Math.floor(span * 0.1));

  type Candidate = { offset: number; rank: 3 | 2 | 1 };
  const candidates: Candidate[] = [];

  for (let i = targetOffset; i >= windowStart; i--) {
    // Paragraph break: \n\n+ ending at i (i is the first char of the next block).
    if (body[i - 1] === "\n" && body[i - 2] === "\n") {
      if (!rangesContain(forbidden, i)) candidates.push({ offset: i, rank: 3 });
      continue;
    }
    // Sentence end: ., ?, or ! followed by a whitespace char; cut at the position
    // right after that whitespace.
    if (i >= 2 && /[.?!]/.test(body[i - 2]) && /\s/.test(body[i - 1])) {
      if (!rangesContain(forbidden, i)) candidates.push({ offset: i, rank: 2 });
      continue;
    }
    // Word break: whitespace boundary.
    if (/\s/.test(body[i - 1]) && !/\s/.test(body[i] ?? "")) {
      if (!rangesContain(forbidden, i)) candidates.push({ offset: i, rank: 1 });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.rank - a.rank || b.offset - a.offset);
    return candidates[0].offset;
  }

  // No legal boundary in window — fall back to target (already proven outside
  // forbidden ranges above).
  return targetOffset;
}

/**
 * Slice `body` per ADR-0009: 500-token chunks, 60-token overlap, trailing-merge
 * when the last fragment is <60 tokens, boundary preference paragraph→sentence→
 * word, never splits inside fenced code / inline code / table rows.
 *
 * `body` is NFC-normalized before processing. The returned char offsets index
 * into the *normalized* body — callers must store the normalized form as
 * `entries.body` (the post-scrub canonical text per ADR-0009 §5).
 */
export function chunk(
  body: string,
  opts: { size?: number; overlap?: number; minTrailing?: number } = {},
): ChunkSlice[] {
  const size = opts.size ?? DEFAULT_CHUNK_TOKENS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP_TOKENS;
  const minTrailing = opts.minTrailing ?? MIN_TRAILING_TOKENS;

  const normalized = body.normalize("NFC");
  if (normalized.length === 0) return [];

  const { tokens, charOffsetAtToken } = encodeWithCharOffsets(normalized);
  const totalTokens = tokens.length;

  if (totalTokens <= size) {
    return [
      {
        chunk_index: 0,
        chunk_total: 1,
        content_start: 0,
        content_end: normalized.length,
        token_count: totalTokens,
        chunking_policy_version: CHUNKING_POLICY_VERSION,
      },
    ];
  }

  const forbidden = computeForbiddenRanges(normalized);
  const out: Array<Omit<ChunkSlice, "chunk_index" | "chunk_total">> = [];

  let startCharOffset = 0;
  while (startCharOffset < normalized.length) {
    const startTokenIdx = tokenIndexAtCharOffset(charOffsetAtToken, startCharOffset);
    const targetTokenIdx = startTokenIdx + size;

    if (targetTokenIdx >= totalTokens) {
      const endTokenIdx = totalTokens;
      const token_count = endTokenIdx - startTokenIdx;
      out.push({
        content_start: startCharOffset,
        content_end: normalized.length,
        token_count,
        chunking_policy_version: CHUNKING_POLICY_VERSION,
      });
      break;
    }

    const targetCharOffset = charOffsetAtToken[targetTokenIdx];
    const boundary = findBoundary(normalized, startCharOffset, targetCharOffset, forbidden);
    let endTokenIdx = tokenIndexAtCharOffset(charOffsetAtToken, boundary);
    // Guard against zero-token chunks: if the boundary falls within the same
    // token as the start (can happen when `findBoundary` extends past a
    // forbidden range whose end lands inside the start token), advance by one
    // token so we always make progress.
    if (endTokenIdx <= startTokenIdx) {
      endTokenIdx = Math.min(startTokenIdx + 1, totalTokens);
    }
    const token_count = endTokenIdx - startTokenIdx;

    const effectiveBoundary =
      endTokenIdx === totalTokens ? normalized.length : charOffsetAtToken[endTokenIdx];
    out.push({
      content_start: startCharOffset,
      content_end: effectiveBoundary,
      token_count,
      chunking_policy_version: CHUNKING_POLICY_VERSION,
    });

    // Next chunk starts `overlap` tokens before this chunk's end. Guard against
    // pathological inputs (size <= overlap) by always advancing at least one token.
    let nextTokenIdx = endTokenIdx - overlap;
    if (nextTokenIdx <= startTokenIdx) nextTokenIdx = startTokenIdx + 1;
    if (nextTokenIdx >= totalTokens) break;
    startCharOffset = charOffsetAtToken[nextTokenIdx];
  }

  // Trailing-merge: if the last chunk is <minTrailing tokens, absorb it into the
  // prior chunk (ADR-0009 §1). If the merge would yield a chunk identical to the
  // prior (because overlap already covered the tail), drop the trailing entry.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    if (last.token_count < minTrailing) {
      const prev = out[out.length - 2];
      if (last.content_end <= prev.content_end) {
        out.pop();
      } else {
        const prevStartTokenIdx = tokenIndexAtCharOffset(charOffsetAtToken, prev.content_start);
        const newEndTokenIdx = tokenIndexAtCharOffset(charOffsetAtToken, last.content_end);
        prev.content_end = last.content_end;
        prev.token_count = newEndTokenIdx - prevStartTokenIdx;
        out.pop();
      }
    }
  }

  const total = out.length;
  return out.map((c, i) => ({
    chunk_index: i,
    chunk_total: total,
    content_start: c.content_start,
    content_end: c.content_end,
    token_count: c.token_count,
    chunking_policy_version: c.chunking_policy_version,
  }));
}

/**
 * Build the embed-time input string per ADR-0009 §6: `Title:`/`Tags:` prefix
 * plus the raw chunk slice. Only used at embedding time; rerank and Sonnet
 * paths use {@link getRawSlice} so they cannot accidentally double-count the
 * prefix.
 *
 * `tags` are joined with `, ` — tags containing commas will be ambiguous in the
 * prefix line, which is acceptable because the prefix is only fed to Voyage as
 * embedding input and never parsed back.
 */
export function buildEmbedInput(args: {
  title: string;
  tags: string[];
  body: string;
  content_start: number;
  content_end: number;
}): string {
  const titleClipped = args.title.slice(0, TITLE_CLIP_CHARS);
  return (
    "Title: " +
    titleClipped +
    "\nTags: " +
    args.tags.join(", ") +
    "\n\n" +
    getRawSlice(args.body, args.content_start, args.content_end)
  );
}

/**
 * Raw chunk text as it appears in `entries.body[content_start..content_end]`.
 * Use this — not {@link buildEmbedInput} — for the rerank candidate text and
 * the Sonnet synthesis prompt. ADR-0009 §6 bounds the title/tags prefix to
 * embedding time only.
 */
export function getRawSlice(body: string, content_start: number, content_end: number): string {
  return body.slice(content_start, content_end);
}

/**
 * Local-proxy o200k_base token count for an embed-input string. Throws when the
 * result exceeds {@link VOYAGE_MAX_INPUT_TOKENS} so the planner can fail fast
 * at chunk-prep time rather than at Voyage call time.
 */
export function embedInputTokenCount(input: string): number {
  const count = getEncoder().encode(input).length;
  if (count > VOYAGE_MAX_INPUT_TOKENS) {
    throw new RangeError(
      `embed input is ${count} tokens (o200k_base proxy), exceeds VOYAGE_MAX_INPUT_TOKENS=${VOYAGE_MAX_INPUT_TOKENS}`,
    );
  }
  return count;
}
