"""HTTP client wrapper for the worker → Node `PUT /api/ingest/[id]` call.

Per [ADR-0021 §D10](../../docs/adr/0021-worker-http-callback-architecture.md)
the `httpx.AsyncClient` is constructed ONCE per worker lifetime in
`api/worker.py main()` and injected into the handler closure — keeps
connection pool + keepalive intact across PUTs.

Per [ADR-0021 §D9](../../docs/adr/0021-worker-http-callback-architecture.md)
no retry policy lives in this client. The worker's `mark_failed` →
re-claim cycle is the retry mechanism; an additional retry layer here
would double-count `attempts` against the queue's `max_attempts`.
"""

from __future__ import annotations

import httpx

# Conservative default: long enough for a real PUT against a busy Node
# server (Voyage embed + chunk + DB write), short enough that a stuck
# upstream surfaces before the visibility timeout reclaim. Tunable via
# `INGEST_API_TIMEOUT_S` env var in `api/worker.py main()`.
DEFAULT_TIMEOUT_S = 30.0


def build_client(*, timeout_s: float = DEFAULT_TIMEOUT_S) -> httpx.AsyncClient:
    """Construct the worker-lifetime httpx client.

    The caller is responsible for `await client.aclose()` on shutdown.
    `api/worker.py main()` handles this via a `try/finally` around the
    poll loop.
    """
    return httpx.AsyncClient(timeout=timeout_s)
