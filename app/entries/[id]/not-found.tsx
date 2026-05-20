// app/entries/[id]/not-found.tsx — segment-level 404 for the entry
// detail page. Rendered whenever `app/entries/[id]/page.tsx` calls
// `notFound()`, which by construction covers four indistinguishable
// upstream causes (see lib/entries.ts for the full list):
//
//   - No / unknown / malformed `x-stub-user-role` header.
//   - The `[id]` URL segment is not a syntactically valid UUID.
//   - The id is a valid UUID but no entry exists with that id.
//   - The entry exists, but its `sensitivity` is outside the
//     requester's allow-list.
//
// All four collapse to this exact page — same response shape, same
// rendered HTML — so a user cannot distinguish "I'm not authorized
// for this restricted entry" from "this id doesn't exist". This is
// iron rule #6's existence-leak defense at the page surface.
//
// The text deliberately avoids saying "you don't have access" — that
// phrasing would itself be a discriminator (it implies the entry
// exists). "Not found" covers all four causes truthfully.

import Link from "next/link";

// Belt-and-suspenders with the page's `force-dynamic`. The not-found
// content is static text today, but a future maintainer who adds
// dynamic content (e.g., a recently-viewed list) without this
// declaration would re-introduce a cross-role cache vector — Next
// would full-route-cache a render that omits the role header from
// the cache key. Keeping force-dynamic here pre-empts that regression.
export const dynamic = "force-dynamic";

export default function EntryNotFound(): React.ReactNode {
  return (
    <main
      style={{
        maxWidth: "32rem",
        margin: "0 auto",
        padding: "3rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        textAlign: "center",
      }}
    >
      <h1 style={{ margin: 0 }}>Entry not found</h1>
      <p style={{ color: "var(--kramer-neutral)", opacity: 0.85 }}>
        We couldn&apos;t find the entry you&apos;re looking for. It may have been removed, or you
        may have followed an outdated link.
      </p>
      <nav>
        <Link href="/query">← Back to query</Link>
      </nav>
    </main>
  );
}
