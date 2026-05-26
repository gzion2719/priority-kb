"""Application runtime logger for the FastAPI worker.

Scope: this is the process-level logging primitive — used for application
diagnostics (startup, shutdown, request lifecycle, unexpected errors).

This is NOT the LogEvent emitter. The Python equivalent of ``lib/log.ts``
``logEvent`` (structured per-vendor records for Claude / Voyage / retrieval
pipeline) lands separately in M2b #4 with its own ADR cross-referencing
ADR-0005. See ADR-0018 §"Scope" for the boundary.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

_INITIALIZED = False


class JSONFormatter(logging.Formatter):
    """Emit one JSON object per log record on stdout.

    Shape: ``{"ts": ISO8601, "level": str, "msg": str, "logger": str}`` plus
    any caller-supplied ``extra={}`` keys merged into the top-level object.

    Pinned-key precedence: the four base-shape keys (``ts``, ``level``, ``msg``,
    ``logger``) ALWAYS win over caller-supplied extras carrying the same name.
    This blocks the log-forgery shape where a caller (or untrusted input
    flowing into ``extra={}``) could overwrite the helper-injected timestamp
    or level — same defensive posture as the Node-side ``lib/log.ts``
    ``ts?: never`` type-ban on caller-supplied timestamps.
    """

    _RESERVED_ATTRS = frozenset(
        {
            "args",
            "asctime",
            "created",
            "exc_info",
            "exc_text",
            "filename",
            "funcName",
            "levelname",
            "levelno",
            "lineno",
            "message",
            "module",
            "msecs",
            "msg",
            "name",
            "pathname",
            "process",
            "processName",
            "relativeCreated",
            "stack_info",
            "thread",
            "threadName",
            "taskName",
        }
    )

    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, tz=UTC).isoformat()
        extras = {
            key: value
            for key, value in record.__dict__.items()
            if key not in self._RESERVED_ATTRS and not key.startswith("_")
        }
        # Pinned keys after extras → extras lose any name collision.
        payload: dict[str, Any] = {
            **extras,
            "ts": ts,
            "level": record.levelname,
            "msg": record.getMessage(),
            "logger": record.name,
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def init_logging(level: int = logging.INFO) -> None:
    """Configure the root logger with a stdout JSON handler.

    Self-healing idempotent: subsequent calls are no-ops if the latch is set
    AND ``logging.getLogger().handlers`` is non-empty. If the handlers were
    externally cleared (a library, a stray test reset, a debugger session),
    ``init_logging`` re-installs them — the latch alone is not the contract,
    "installed handlers are present" is. Tests that need to clear the latch
    itself must use ``_reset_for_tests``.

    Pinned name per ADR-0016 §6 (anchor ``py-script-logging-init``) and
    ADR-0018 §"Decision".
    """
    global _INITIALIZED
    root = logging.getLogger()
    if _INITIALIZED and root.handlers:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JSONFormatter())
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
    _INITIALIZED = True


def _reset_for_tests() -> None:
    """Reset the idempotency latch — TESTS ONLY.

    Production code must never call this. ``init_logging`` is intentionally
    one-shot per process; tests that need to assert idempotency or to
    replay init logic need this hook.
    """
    global _INITIALIZED
    _INITIALIZED = False
    logging.getLogger().handlers.clear()
