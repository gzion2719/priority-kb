// lib/query-url-state.ts — URL-search-param encoder/decoder for the
// user-facing query UI's ?q=<encoded> share/restore parameter.
//
// Pure functions; no React, no DOM. Lives in lib/ rather than inline in
// app/query/page.tsx so the tests can import without dragging the
// "use client" page (and so the cap value has one canonical source).
//
// Why 2000 chars: the IE-legacy URL floor (2083 in IE9 — see Microsoft
// KB 208427) is the smallest historic cap; modern browsers and Vercel/
// Cloudflare infra cap higher (8KB total header line on Cloudflare
// gives ample headroom). 2000 keeps us well under every documented
// floor while still admitting realistic Hebrew or English KB queries
// (a typical Priority troubleshooting question is < 200 chars).

export const QUERY_PARAM_MAX_LEN = 2000;

/**
 * Encodes a query for the `?q=` URL parameter. Returns `null` if the
 * input is empty (no point sharing an empty query) or exceeds the cap
 * (rejects rather than silently truncates — a truncated query would
 * restore something the user didn't ask).
 */
export function encodeQueryParam(query: string): string | null {
  if (query.length === 0 || query.length > QUERY_PARAM_MAX_LEN) return null;
  return encodeURIComponent(query);
}

/**
 * Decodes a `?q=` URL parameter back to the query string. Returns
 * `null` on: missing param, malformed percent-encoding, or decoded
 * length outside (0, QUERY_PARAM_MAX_LEN]. Defensive against URL
 * tampering — a bad ?q= prefills nothing rather than rendering a
 * partial/broken query.
 */
export function decodeQueryParam(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null;
  // Reject raw input that couldn't possibly decode to <= MAX_LEN. A
  // single UTF-16 code unit can encode to up to 9 chars after
  // percent-encoding (a 4-byte UTF-8 sequence like an astral-plane
  // emoji or mathematical alphanumeric — 𝕏, 🚀 — encoded as
  // %F0%9D%95%8F is 3 bytes × 3 chars each = 9 chars per code unit).
  // 9× cap is the loose ceiling that admits every legitimate input
  // while still bounding decode CPU against a megabyte-long `?q=`.
  if (raw.length > QUERY_PARAM_MAX_LEN * 9) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > QUERY_PARAM_MAX_LEN) return null;
  return decoded;
}
