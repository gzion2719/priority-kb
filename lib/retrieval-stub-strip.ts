// lib/retrieval-stub-strip.ts — stub-synthesizer artifact stripping.
//
// The stub Synthesizer (lib/retrieval.ts createStubSynthesizer) emits a
// deterministic answer of the shape:
//
//   stub-answer: <8-hex-handle>\n\nSources: [00000000-0000-4000-8000-000000000000]
//
// The trailing `Sources: [zero-uuid]` is a §5-validation-passing sentinel
// so the format-regex check survives; it is NOT a real citation. If that
// text reached the UI verbatim, an end user would see a citation pointing
// at a nonexistent entry (iron rule #3 violation: "no source = no claim").
//
// This helper strips the trailing Sources block before the answer is
// streamed; the route emits the REAL candidate IDs on the `done` event.
//
// Slice "M3 item 3 full" replaces the stub with the live Anthropic
// Sonnet synth — that path retains the Sources block AND runs the
// ADR-0013 §5 retry-once citation-validation policy. This helper is
// only used while the stub is the active synthesizer.

/**
 * Removes a TRAILING `Sources: [...]` block from synthesized answer text.
 *
 * Match rules:
 *   - Anchored to end-of-input (`$`). A `Sources:` block in the MIDDLE of
 *     the answer is preserved — only the final one is stripped.
 *   - Leading whitespace/newlines before `Sources:` are consumed.
 *   - The bracket content `[...]` cannot itself contain `]` — the stub
 *     synth never emits nested brackets, so this is safe.
 *   - Case-insensitive on the literal `Sources` keyword.
 *   - If no trailing block matches, returns the input unchanged (no-op).
 *
 * @example
 *   stripSynthSourcesBlock("answer text\n\nSources: [00000000-...]") // → "answer text"
 *   stripSynthSourcesBlock("plain answer")                            // → "plain answer"
 *   stripSynthSourcesBlock("see [1] for details. Sources: [uuid]")    // → "see [1] for details."
 */
export function stripSynthSourcesBlock(answer: string): string {
  return answer.replace(/\s*Sources\s*:\s*\[[^\]]*\]\s*$/i, "");
}
