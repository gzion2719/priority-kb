"""Worker handlers — one per ``jobs.queue_name``.

Registry is keyed by ``queue_name`` (worker layer) per
[ADR-0021 §D7](../../docs/adr/0021-worker-http-callback-architecture.md):
content-type dispatch is a handler-internal detail, not a worker-layer
concern. The ``ingest`` queue dispatches to ``media_ingest.handle``,
which routes by ``payload.content_type`` internally.

Unknown queues fall back to ``api.worker._default_handler`` (explicit
fail, NOT silent drop) per [ADR-0019 §D6](../../docs/adr/0019-job-queue.md).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from api.jobs import Job

from api.handlers.types import WorkerErrorClass

# Handler signature — must match `api.worker.poll_loop`'s expectation of
# `handler(job)`. The worker constructs a closure that injects
# `conn_factory` + `worker_id` + `http_client` + `ingest_api_base_url`
# from `main()`; tests can substitute the closure directly.
HandlerFn = Callable[["Job"], Awaitable[None]]


# Pure registry — values are wired by `api/worker.py main()` because the
# closures need `conn_factory` + `worker_id` + `http_client` from the
# worker's startup config. The registry is a Mapping returned by a
# factory rather than a module-level constant to keep the import graph
# acyclic (handlers import from api.jobs; api.worker imports both).
def build_registry(
    media_ingest_handler: HandlerFn,
) -> dict[str, HandlerFn]:
    """Return the queue_name → handler mapping for the worker.

    Inject the already-bound `media_ingest` handler. Adding a new queue
    is a new injected arg + a new mapping entry — no module-level
    mutation, no import-side effect.
    """
    return {"ingest": media_ingest_handler}


__all__ = ["HandlerFn", "WorkerErrorClass", "build_registry"]
