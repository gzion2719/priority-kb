"""Tests for api.log — JSONFormatter + init_logging.

Surface coverage matches Node-side ``lib/log.test.ts`` first-cut floor at
the runtime-logger layer: idempotency, timestamp shape, level mapping,
extras merge, JSON-roundtrip, no-double-init.
"""

from __future__ import annotations

import io
import json
import logging
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import cast

import pytest

from api import log as api_log


@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    """Reset the init latch + root handlers around each test."""
    api_log._reset_for_tests()
    yield
    api_log._reset_for_tests()


def _emit_and_capture(level: int, msg: str, **extras: object) -> dict[str, object]:
    """Run init_logging() against an in-memory stream, log one record, return parsed JSON."""
    buffer = io.StringIO()
    api_log.init_logging()
    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(api_log.JSONFormatter())
    root.addHandler(handler)
    root.log(level, msg, extra=extras)
    line = buffer.getvalue().strip()
    return cast(dict[str, object], json.loads(line))


def test_init_logging_is_idempotent() -> None:
    api_log.init_logging()
    handlers_after_first = len(logging.getLogger().handlers)
    api_log.init_logging()
    api_log.init_logging()
    assert len(logging.getLogger().handlers) == handlers_after_first


def test_ts_is_iso8601_utc() -> None:
    payload = _emit_and_capture(logging.INFO, "hello")
    ts = payload["ts"]
    assert isinstance(ts, str)
    parsed = datetime.fromisoformat(ts)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == UTC.utcoffset(parsed)


def test_level_mapping_uses_levelname_strings() -> None:
    info = _emit_and_capture(logging.INFO, "i")
    warn = _emit_and_capture(logging.WARNING, "w")
    error = _emit_and_capture(logging.ERROR, "e")
    assert info["level"] == "INFO"
    assert warn["level"] == "WARNING"
    assert error["level"] == "ERROR"


def test_extras_merge_into_payload() -> None:
    payload = _emit_and_capture(logging.INFO, "with extras", request_id="r-123", user_role="admin")
    assert payload["request_id"] == "r-123"
    assert payload["user_role"] == "admin"
    assert payload["msg"] == "with extras"


def test_payload_is_valid_json_roundtrip() -> None:
    payload = _emit_and_capture(logging.INFO, "roundtrip", count=7, active=True)
    reserialized = json.dumps(payload)
    again = json.loads(reserialized)
    assert again == payload


def test_external_clear_self_heals_on_reinit() -> None:
    """If root.handlers is cleared externally, the next init_logging() re-installs.

    The latch alone is not the contract — "installed handlers present" is. This protects against
    libraries / debuggers / stray test resets that clear root.handlers, after which app logs
    would otherwise vanish silently.
    """
    api_log.init_logging()
    assert len(logging.getLogger().handlers) == 1
    logging.getLogger().handlers.clear()
    api_log.init_logging()
    assert (
        len(logging.getLogger().handlers) == 1
    ), "handler should be re-installed after external clear"


def test_pinned_keys_win_over_caller_extras() -> None:
    """JSONFormatter pins ts/level/msg/logger over any colliding attr on the record.

    Stdlib ``Logger.makeRecord`` blocks ``extra={"msg": ...}`` at the logging-call layer
    (raises KeyError), so the formatter-layer defense is the second line. This test reaches
    past stdlib by constructing the record directly and forcibly setting attributes that
    conflict with the four pinned base-shape keys — JSONFormatter must still emit the
    helper-injected values, not the attacker's.

    Mirrors the Node-side ``lib/log.ts`` ``ts?: never`` type-ban on caller-supplied timestamps.
    """
    record = logging.LogRecord(
        name="real-logger",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="real-msg",
        args=(),
        exc_info=None,
    )
    # Forcibly set conflicting attrs (bypasses stdlib's makeRecord guard).
    record.__dict__["ts"] = "1970-01-01T00:00:00+00:00"
    record.__dict__["level"] = "DEBUG"
    # "msg" is already a LogRecord reserved attr (the message format string) — covered by
    # _RESERVED_ATTRS exclusion. "logger" is a synthetic key the formatter writes for us.
    record.__dict__["logger"] = "evil"
    out = api_log.JSONFormatter().format(record)
    payload = json.loads(out)
    assert payload["level"] == "INFO", "level pinned from levelname, not extras"
    assert payload["msg"] == "real-msg", "msg pinned from getMessage, not extras"
    assert payload["ts"] != "1970-01-01T00:00:00+00:00", "ts pinned from record.created, not extras"
    assert payload["logger"] == "real-logger", "logger pinned from record.name, not extras"


def test_exc_info_formatted_into_exc_field() -> None:
    """logger.exception() / logger.error(exc_info=True) emits payload["exc"] with a traceback."""
    buffer = io.StringIO()
    api_log.init_logging()
    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(api_log.JSONFormatter())
    root.addHandler(handler)
    try:
        raise ValueError("synthetic")
    except ValueError:
        root.exception("an error happened")
    payload = json.loads(buffer.getvalue().strip())
    assert "exc" in payload
    assert "ValueError: synthetic" in payload["exc"]


def test_init_logging_attaches_stdout_handler_not_stderr() -> None:
    """ADR-0018 pins stdout; silent flip to stderr would break aggregators expecting stdout JSON."""
    import sys

    api_log.init_logging()
    handlers = logging.getLogger().handlers
    assert len(handlers) == 1
    handler = handlers[0]
    assert isinstance(handler, logging.StreamHandler)
    assert handler.stream is sys.stdout, "ADR-0018 §Decision pins stdout"


def test_jsonformatter_emits_msg_unicode_intact() -> None:
    """Hebrew + special chars roundtrip without escape — required for M2b Hebrew-screenshot logs."""
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="שלום עולם",
        args=(),
        exc_info=None,
    )
    out = api_log.JSONFormatter().format(record)
    assert "שלום עולם" in out
    parsed = json.loads(out)
    assert parsed["msg"] == "שלום עולם"


def test_iso8601_format_matches_strict_regex() -> None:
    """Pin the ISO8601 shape so downstream log aggregators (M5 dashboard) don't see drift."""
    payload = _emit_and_capture(logging.INFO, "x")
    iso_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+00:00$")
    assert iso_pattern.match(
        str(payload["ts"])
    ), f"ts did not match strict ISO8601 UTC: {payload['ts']!r}"
