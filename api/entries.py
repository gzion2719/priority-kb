"""Read-only `entries` helpers for the worker handler path.

Currently exposes only `get_entry_metadata`, called by
`api.handlers.media_ingest` before constructing the Node `PUT
/api/ingest/[id]` body. The function does a single SELECT, no joins, no
FOR UPDATE — the worker is not the authoritative writer; Node's
`updateEntry` holds the FOR UPDATE during the actual write.

Iron-rule footprint:
    #2  Read-only — not a write surface.
    #6  Reads `entries.sensitivity` from the DB (never from job payload).
        The worker-handler then ALSO omits `sensitivity` from the PUT
        body per ADR-0021 §D4 so the Node side preserves the freshest
        value at PUT time; this helper exists for the other 6 metadata
        fields (title / category / tags / body / source_pointer /
        last_verified_at) that the PUT body must carry.
    #9  Does not write chunks.
    #10 Not an agent invocation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import psycopg

# Stable string literal of the sensitivity enum. Mirrors the Node-side
# `Sensitivity` type at `drizzle/schema.ts`. Re-deriving from a DB
# `information_schema` lookup would be more correct but adds startup
# cost for negligible gain — the enum is stable per ADR-0009 (composite
# FK invariant).
SensitivityValue = str  # one of "public" | "internal" | "restricted"


@dataclass(frozen=True)
class EntryMetadata:
    """Subset of `entries` columns the worker needs to construct a PUT body.

    All fields are required (the placeholder entry that M2b #4 created
    at upload time populated all of them — the upload route's Zod
    schema enforces it). A row that's missing any of these is a schema
    drift and the worker fails the job rather than papering over it.

    NOTE on `sensitivity`: loaded for two reasons even though the worker's
    PUT body intentionally OMITS it (per ADR-0021 §D4 — Node-side
    preservation closes the dispatch-to-PUT downgrade race):
      1. Forensics — `LogEvent` rows may want to surface the sensitivity
         tier of work-in-progress jobs (queued at restricted-tier vs
         public-tier) for dashboard breakdown.
      2. Future-proof — a follow-up that flips the architecture (e.g.,
         Option X resurrected for some queues) would already have the
         field at the right spot in the dataclass, no schema migration
         on the helper.
    Code-CR m2 (2026-05-27).
    """

    title: str
    category: str
    tags: list[str]
    body: str
    source_pointer: str
    last_verified_at: datetime
    sensitivity: SensitivityValue


async def get_entry_metadata(
    conn: psycopg.AsyncConnection[Any],
    *,
    entry_id: UUID,
) -> EntryMetadata | None:
    """Read the entry's current metadata. Returns None if the row vanished.

    Returning None (rather than raising) lets the handler distinguish
    "entry was deleted between enqueue and dispatch" from "DB connection
    failed" — the former maps to `WorkerErrorClass.EntryMetadataNotFound`
    (terminal-ish, no point retrying many times) and the latter escapes
    to the handler's top-level `except Exception` → `HandlerCrashed`.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT title, category, tags, body, source_pointer,
                   last_verified_at, sensitivity
            FROM   entries
            WHERE  id = %s
            """,
            (entry_id,),
        )
        row = await cur.fetchone()
        if row is None:
            return None
        return EntryMetadata(
            title=row[0],
            category=row[1],
            # tags column is `text[]` — psycopg v3 returns a Python list.
            tags=list(row[2]),
            body=row[3],
            source_pointer=row[4],
            last_verified_at=row[5],
            sensitivity=row[6],
        )
