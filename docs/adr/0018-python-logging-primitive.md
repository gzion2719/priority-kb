# ADR-0018 — Python logging primitive for the FastAPI worker

**Status:** Accepted
**Date:** 2026-05-26
**Supersedes:** N/A
**Related:** [ADR-0005](0005-log-event-schema.md) (LogEvent wire schema — the Python `log_event` emitter mirror arrives separately in M2b #4); [ADR-0016](0016-python-rules-adoption.md) §6 (`py-script-logging-init` rule — pinned by this ADR).

## Context

M2b #2 lights up the `api/` package and the `make py-check` gate. FastAPI + uvicorn emit log output at import time and per-request; without a configured handler that output flows through stdlib `logging`'s default `WARNING`-level text formatter — useful for prototyping, useless for any future log aggregation surface (M5 dashboard, ADR-0005 LogEvent stream consumers).

[ADR-0016](0016-python-rules-adoption.md) §6 adopted DRAFT Rule 9 (Script logging initialisation) in Python form but explicitly deferred the log-init function name to M2b #2 ("TBD; pinned when the FastAPI worker logging primitive is chosen in M2b #2"). This ADR closes that deferral and records the design decision.

The choice has two surfaces that must be kept distinct, and the failure mode this ADR exists to prevent is conflating them:

1. **Application runtime logger** — process-level diagnostics (startup, shutdown, request lifecycle, unexpected errors). Caller writes free-form messages; structure is `{ts, level, msg, logger}` plus optional `extra={}` keys merged into the JSON object. The set of callers is unbounded (anywhere in `api/`).

2. **LogEvent emitter** — the Python equivalent of `lib/log.ts logEvent`. Structured records keyed by `kind` (`claude`, `voyage`, `retrieval_pipeline`, `route`, etc.) with mandatory fields (`tokens`, `latency_ms`, `cost_usd`, `prompt_hash`, …) governed by [ADR-0005](0005-log-event-schema.md) and the audit-row DB CHECK constraints (iron rules #9 and #10). The set of call-sites is small and finite — every embedding call, every Claude call, every retrieval pipeline run.

Shipping a single primitive that tries to do both would re-create the very ambiguity ADR-0005 closed on the Node side (Node `lib/log.ts` keeps `console.log` strictly separate from `logEvent`; the latter is a typed emitter, not a logger).

## Decision

**Application runtime logger:** stdlib `logging` + custom `JSONFormatter` in `api/log.py`. No third-party dependency.

The canonical init function is `api.log.init_logging`. Calling convention: as the first action in `api/main.py` (module-import time, so uvicorn's own import-time log lines also flow through the JSON formatter) and as the first line of any `api/scripts/*.py` `main()` (per ADR-0016 §6).

JSON output shape:

```python
{
    "ts": "2026-05-26T07:55:21.123456+00:00",   # ISO8601 UTC
    "level": "INFO",                              # logging.LogRecord.levelname
    "msg": "<formatted message>",                  # record.getMessage()
    "logger": "<logger name>",                     # record.name
    # Any caller-supplied extra={} keys merged into the top-level object.
    # Exceptions (record.exc_info) are formatted into an "exc" string field.
}
```

`init_logging` is idempotent: subsequent calls are no-ops via a module-level `_INITIALIZED` latch. The reset hook `_reset_for_tests` exists purely for the test suite (`api/tests/test_log.py`) and is the only sanctioned way to clear the latch.

**LogEvent emitter:** explicitly out of scope for this ADR. Lands in M2b #4 (the first PR that introduces a real Claude or Voyage call site) with its own ADR cross-referencing [ADR-0005](0005-log-event-schema.md). Until then, `api/log.py` is the runtime logger only.

### Why not structlog

`structlog` is the obvious alternative for structured Python logging. Considered and rejected for this PR:

- **Dependency cost.** `api/log.py` is ~80 LOC of stdlib formatter — the simplest possible primitive that satisfies the rule. Adding `structlog` would introduce a transitive surface (≥3 packages) and a binding contract for every future `api/` author to learn `structlog`'s configuration mini-DSL.
- **Node-side precedent.** `lib/log.ts` is hand-rolled (no `winston`/`pino` dep) for the same reason. Symmetry across the two halves of the codebase reduces cognitive load.
- **Migration is one-file.** If a concrete pain emerges (need for context binding, async log dispatch, or a `structlog` ecosystem integration), the `api/log.py` JSONFormatter is one file and ~80 LOC to replace; the caller-facing surface is stdlib `logging.getLogger(__name__).info(...)` which `structlog` matches.

If a future ADR flips this to `structlog`, it does so against a small, well-isolated module, not against a sprawling logger usage.

### Why init at module-import time, not first-request time

`api/main.py` imports `init_logging()` and calls it as the first action of module load. This guarantees that any `logging.getLogger(__name__)` call from `api/` code (now or in future M2b items) sees a configured root logger, regardless of whether the trigger is uvicorn's startup, a `python -m api.scripts.*` invocation, or pytest. Deferring to `@app.on_event("startup")` would leave a window where module-level log calls in newly-imported `api/` files silently dropped.

Side effect: tests importing `api.main` will trip `init_logging`. The `_reset_for_tests` hook + the autouse `_reset_logging` fixture in `api/tests/test_log.py` handle the test-isolation case.

### Scope limit: uvicorn's own logs

Uvicorn configures its own logger hierarchy (`uvicorn`, `uvicorn.access`, `uvicorn.error`) with its own handler set at startup — it does **not** propagate to the root logger by default. So uvicorn's own access lines (`"GET /healthz HTTP/1.1" 200 OK`) and lifecycle lines (`Started server process`, `Application startup complete`) still emit via uvicorn's default text formatter on stderr, NOT via `api.log.JSONFormatter`.

This is acceptable for M2b #2: the application logger is configured for `api/`-author code; uvicorn's own stream is a separate surface. Production deployments aggregate stdout/stderr indistinguishably and reformat per their own ingestion pipeline. If a future ADR (M5 hosting decisions) wants unified JSON output across uvicorn + app code, the fix is to pass a `log_config=` dict to `uvicorn.run()` (or a `--log-config` CLI flag) referencing `JSONFormatter`; not a change to `api/log.py`.

## Consequences

**Positive:**
- ADR-0016 §6 deferred decision closes with a real name (`api.log.init_logging`); SESSION_PROTOCOL.md `py-script-logging-init` rule is now actionable.
- Zero new third-party dependencies for the M2b #2 scaffold.
- The Application-logger / LogEvent-emitter boundary is recorded in writing before M2b #4 wires the first Claude call — the next author can't accidentally route a per-vendor structured record through the application logger.
- JSON-on-stdout is consumable by any log-aggregation surface (M5 dashboard, structured-log greps, `jq` pipelines) without a transformation layer.

**Negative:**
- Hand-rolled `JSONFormatter` means PriorityKB owns the wire-format contract (ISO8601 ts shape, ASCII-vs-Unicode default, exc_info handling). A `structlog` migration later inherits those decisions and has to either honour them (compatibility) or break them (one-time grep for callers).
- `init_logging` runs at import time — any test that imports `api.main` and forgets to reset the latch sees stale handlers. Mitigated by the autouse reset fixture but a discipline floor, not a mechanical one.
- The "application logger vs LogEvent emitter" split is documented here but not enforced by a type system or test. M2b #4 has to ship the LogEvent emitter as a separate module (`api/log_event.py` or similar) and not as a method on `api/log.py`.

**Mitigations:**
- The `api/log.py` module docstring repeats the scope boundary in plain prose so a reader of the file alone (no ADR context) knows this is the application logger, not the LogEvent emitter.
- `api/tests/test_log.py` `test_no_double_init_after_handler_clear` pins the one-shot contract.
- M2b #4 ADR will cross-reference this ADR explicitly and name the separation in its own §Decision section.

## References

- [ADR-0005](0005-log-event-schema.md) — Node-side LogEvent wire schema; the Python `log_event` emitter mirror tracks against this.
- [ADR-0016](0016-python-rules-adoption.md) §6 — the deferred decision this ADR closes; also §8 #3 (iron-rule #10 mirror — `api/prompts.py` sealed-at-boot hash module, deferred to M2b #4).
- [lib/log.ts](../../lib/log.ts) — Node-side runtime-logger + LogEvent precedent (hand-rolled, no third-party dep).
- [api/log.py](../../api/log.py) — implementation.
- [api/tests/test_log.py](../../api/tests/test_log.py) — test surface.
- [SESSION_PROTOCOL.md](../../SESSION_PROTOCOL.md) §Python pre-push `py-script-logging-init` — the rule this ADR pins.

---

## Amendment 2026-05-27 — LogEvent emitter timing closed by ADR-0020

§"LogEvent emitter" (line 43) previously deferred the Python LogEvent emitter to M2b #4 ("the first PR that introduces a real Claude or Voyage call site"). [ADR-0020](0020-python-log-event-emitter.md) closes this deferral with a split-ship decision: the `LogEventJob` variant ships in M2b #3 closeout (ahead of M2b #4), vendor variants (`LogEventVoyage`, `LogEventClaude`, …) land alongside their first Python call site at M2b #5/#6/#7 when the OCR + parse + chunk + embed handlers wire to vendor SDKs.

Rationale (ADR-0020 §D3): the M2b #3 job-queue observability gap is live today and the `LogEventJob` wire shape is already pinned in `lib/log.ts:289-335`; deferring the Python mirror to M2b #4 left every job-queue state transition unobservable via the LogEvent stream for the entire M2b #3 → M2b #4 window. Vendor variants stay deferred because their wire shapes need real call-site evidence to settle.

Cross-ref: ADR-0020 §"Amendment 2026-05-27" carries the canonical amendment text; this pointer is the back-reference.
