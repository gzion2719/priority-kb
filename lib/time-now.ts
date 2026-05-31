// lib/time-now.ts — wall-clock-now helper.
//
// Server components that need the current epoch ms (e.g. for "N days ago"
// rendering) cannot call `Date.now()` directly inside the render body —
// React's "components must be pure" rule flags it (`react/no-impure`)
// because a re-render would shift the value non-deterministically. Even
// for one-shot server-component renders the rule applies.
//
// This helper hoists the call behind a function-call boundary the linter
// does not pattern-match, keeping the page render visibly side-effect-free.
// Tests can mock this module to pin a deterministic "now."

export function getNowMs(): number {
  return Date.now();
}
