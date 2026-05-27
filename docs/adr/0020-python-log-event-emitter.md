# ADR-0020 — Python LogEvent emitter: hand-rolled `api/log_event.py` mirror of `lib/log.ts`; `LogEventJob` ships ahead of vendor variants

**Status:** Accepted
**Date:** 2026-05-27
**Supersedes:** N/A
**Related:**
- [ADR-0005](0005-log-event-schema.md) (LogEvent wire schema — the Python emitter mirrors the variant carve-out invariant and the runtime guards)
- [ADR-0018](0018-python-logging-primitive.md) §"LogEvent emitter" (this ADR closes the explicit deferral and amends the timing — see Amendment 2026-05-27 below)
- [ADR-0019](0019-job-queue.md) §D7 (Python LogEvent emitter was named as M2b #4 work; amended below to land LogEventJob ahead of vendor variants)
- [ADR-0016](0016-python-rules-adoption.md) §8 #2/#3 (Python iron-rule mirrors — distinct from the LogEvent emitter; fire on M2b #5+ worker chunk-write + agent paths)

## Context

[ADR-0018](0018-python-logging-primitive.md) closed the M2b #2 deferral on the Python **application runtime logger** (`api/log.py`, stdlib `logging` + `JSONFormatter`) and explicitly carved out the LogEvent emitter as separate work: *"Lands in M2b #4 (the first PR that introduces a real Claude or Voyage call site) with its own ADR cross-referencing ADR-0005."* [ADR-0019](0019-job-queue.md) §D7 then introduced `LogEventJob` (kind: `"job"`) as a new sibling-of-`LogEventRoute`/`LogEventRetrievalPipeline` variant in `lib/log.ts`, and named the Python emitter mirror as M2b #4 work — *"Until then, … transitions are observable via `audit_log` discriminators."*

That timing was correct given the assumptions in 2026-05-26: M2b #3 (jobs queue) and M2b #4 (file upload + worker invocation of OCR/embed) were imagined as one continuous slice, with the worker's *first vendor call* (Voyage embedding for chunks of OCR'd text) being the natural moment to introduce the emitter. Once M2b #3 actually shipped (PRs #295–#298) and M2b #4 was scoped (this session), the assumption broke:

1. The job-queue observability gap is **live today**. Every `claim_one` / `mark_done` / `mark_failed` call writes an `audit_log` row but emits no `LogEventJob` line — so dashboards consuming the LogEvent NDJSON stream see the Node-side `transition: "enqueued"` event but no `claimed`/`done`/`failed`/`dead` events for the entire M2b #3 lifetime. The deferral was sized against an assumption that M2b #3 → M2b #4 would close in days, but the milestone separation makes that a real gap window.
2. M2b #4 (file upload + blob storage) does **not invoke Voyage or Claude directly** — vendor calls fire at M2b #5/#6/#7 (PDF/Word/OCR handlers that chunk + embed). Pinning the emitter to "first vendor call site" pushes it past M2b #4, deepening the observability gap.
3. The single-variant scope is narrow enough to ship cleanly today. `LogEventJob` already has a stable wire shape pinned in `lib/log.ts:289-335` + ADR-0019 §D7; the Python mirror is a port, not a design.

This ADR ratifies the split-ship: **LogEventJob ships now (M2b #3 closeout), vendor variants ship with their first Python call site (M2b #5/#6/#7).**

## Decision

ADR-with-new-types: applies (frozen-dataclass + module-level emitter function). Skeleton inline below. No test-helper signatures introduced beyond the canonical `set_sink` / `reset_sink` pair.

### D1 — Hand-rolled mirror of `lib/log.ts`; no third-party dep

Mirrors the same posture ADR-0018 took for `api/log.py`: zero new third-party dependencies, ~150 LOC of stdlib. Specifically rejects `structlog`, `python-json-logger`, and any "structured logging library" wrapper — the LogEvent emitter is a **typed NDJSON emitter with runtime guards**, not a logger. The Node precedent at `lib/log.ts` is also hand-rolled (no `winston`/`pino`); symmetry across the two halves of the codebase reduces cognitive load.

### D2 — Module location: `api/log_event.py` (NOT a method on `api/log.py`)

Per ADR-0018 §"Negative" line 78 (*"M2b #4 has to ship the LogEvent emitter as a separate module … and not as a method on `api/log.py`"*): the LogEvent emitter is structurally separate from the application runtime logger. `api/log.py` writes free-form messages with caller-controlled `extra={}`; `api/log_event.py` writes typed structured records with mandatory fields. Conflating them re-creates exactly the ambiguity ADR-0005 closed on the Node side.

### D3 — Variant scope: `LogEventJob` only in this PR; vendor variants ship per first Python call site

The Python `LogEvent` type alias today resolves to `LogEventJob`:

```python
LogEvent = LogEventJob
```

When M2b #5/#6/#7 wires the first Voyage embedding call from the Python worker, that PR widens the alias:

```python
LogEvent = LogEventJob | LogEventVoyage
```

…and adds a `LogEventVoyage` frozen-dataclass mirroring `lib/log.ts:122-124`. Same shape when `LogEventClaude` lands (the Retrieval Agent will not have a Python-side call site until M5+ if at all — Claude is currently Node-only). The forward-compatible alias means caller signatures (`log_event(event: LogEvent)`) stay stable across the variant widening; existing test mocks continue to work.

**Rejected alternative:** ship the full union with `NotImplementedError` construction paths for non-Job variants. Considered, rejected because (a) the placeholders would be dead code in M2b #3-#4, (b) Python's structural typing means the alias-widening approach captures the same forward-compatibility guarantee at lower cost, (c) the M2b #5/#6/#7 author still needs to consult `lib/log.ts` for the canonical variant shape regardless of whether Python has a placeholder — symmetric-port discipline is a SESSION_PROTOCOL.md rule, not an in-code prompt.

### D4 — Wire-point contract: emit AFTER `conn.commit()`, swallow sink errors silently

Every `LogEventJob` emission fires **after** the corresponding `audit_log` row commits to Postgres. The audit row is the durable record; the NDJSON line is an observability tee. This shape inherits two invariants from `lib/log.ts`:

1. **Observability MUST NOT break the API path.** [lib/log.ts:493-496](../../lib/log.ts) wraps `sink(line)` in try/catch and swallows all errors. The Python mirror does the same: `try: sink.write(line) except Exception: pass`. A misconfigured sink (e.g., a test that swaps in a sink and forgets to reset, an `os.write` failure, a stdout pipe close mid-line) MUST NOT raise out of `log_event`.
2. **Pre-emission runtime guards DO raise.** [lib/log.ts:450-459](../../lib/log.ts) raises `TypeError` on non-finite/negative `latency_ms` or non-`None`/non-number `cost_usd`. The Python mirror raises the same — the caller bug at the type level is fail-loudly, the sink error at the I/O level is swallow-silently. Emission-time JSON-serialization errors degrade to the minimal `{"ts":..,"kind":..,"status":"error","error":"log serialization failed"}` line (mirrors [lib/log.ts:480-490](../../lib/log.ts) try/except branch).

**Inside-the-transaction emission is rejected.** Both halves of "fire LogEvent inside the audit-row commit txn" fail: (a) if `log_event` raises (which the swallow contract prevents but a Python `except Exception` doesn't catch every signal — `KeyboardInterrupt`, `SystemExit`, `BaseException`), the audit row would roll back and we'd lose the durable transition record over an observability concern, which inverts the invariant; (b) the Python `psycopg.AsyncConnection.commit()` is the boundary between "queued in the tx buffer" and "visible to other readers" — emitting before the commit means the LogEvent line claims a transition that hasn't yet committed. Emission-after-commit is the only shape that satisfies both invariants.

### D5 — Sink contract

Module-level `_sink: Writer = _default_sink`, where `Writer = Callable[[str], None]`. Default sink writes one NDJSON-terminated line to `sys.stdout` via `sys.stdout.write(line)`; the line includes the trailing `\n`. Mirrors `lib/log.ts:362-381`.

Test seams:
- `set_sink(fn: Writer) -> None` — swap the sink. Used by `api/tests/test_jobs.py` to capture emitted lines for assertions.
- `reset_sink() -> None` — restore the default sink. MUST be called in test teardown to avoid leaking the swap into sibling tests.

### D6 — Fixture-recording tee deferred with explicit acknowledgment

[lib/log.ts:402-441](../../lib/log.ts) ships an opt-in fixture-recording tee (`enableFixtureRecording(path)`) per ADR-0005 Amendment 2026-05-30 + BACKLOG:94 — every emitted line is also appended to a file path for replay tooling. The Python mirror **does not ship this in M2b #3**.

Rationale: (a) no Python-side replay tooling exists yet (the Node fixture tee was added to support an `evals/`-adjacent replay workflow which has no Python consumer today), (b) the file-append codepath introduces a second I/O failure mode that needs the same swallow-errors discipline, (c) once a Python replay consumer lands (M3+ if at all), the surface is ~20 LOC to port.

BACKLOG entry filed (see `docs/BACKLOG.md` "Python fixture-recording tee for `api/log_event.py`") so this surface re-surfaces when the consumer ships. **This is a deliberate symmetric-drift point, not an oversight.**

### D7 — Secret redaction: not applicable to `LogEventJob`

`LogEventJob` declares `error?: never` and a sibling `error_class: string | None` field per `lib/log.ts:289-335`. `error_class` is **caller-controlled stable label**, not free text — by contract it does not pass through the secret-redaction pipeline. The Python mirror inherits this: no redaction layer in `api/log_event.py` for the LogEventJob variant.

When `LogEventVoyage` / `LogEventClaude` / `LogEventRoute` ship (M2b #5+), THAT PR ports the `redactSecrets` regex set from [lib/log.ts:347-360](../../lib/log.ts) and applies it to the `error` field on those variants. Until then, no redaction is needed and shipping a redaction primitive nobody calls is YAGNI.

### D8 — `error_class` value at the M2b #3 transition sites

`api/jobs.py mark_failed` receives a free-text `error: str` parameter (e.g., `"SIGTERM during in-flight job (worker shutting down)"`, `"no handler wired (M2b #4 deferred — _default_handler explicit fail)"`). These are **not** stable class labels; they describe one-off internal conditions today.

For M2b #3, ALL LogEventJob emissions at `failed`/`dead` transitions use **`error_class=None`**. The stable-enum taxonomy (`SigtermShutdown`, `NoHandlerWired`, `HandlerThrew`, `OcrTimeout`, `NetworkError`, …) lands when M2b #5/#6/#7 ships the first OCR handler whose failures are taxonomically meaningful. Dashboards seeing `error_class=None` today correctly read "no taxonomic class assigned"; the audit_log row's `last_error` field carries the free text for human inspection.

Cross-ref ADR-0019 §D7 + the [lib/log.ts:305-310](../../lib/log.ts) JSDoc on `LogEventJob.error_class`: *"caller-controlled stable identifier, not free-text. Callers MUST NOT stuff a raw error message in here."* The Python mirror enforces this by simply emitting `None` until the taxonomy exists.

### D9 — Cross-language structural alignment is an author-side discipline, not a mechanical floor

The Python `LogEventJob` field set and types must stay byte-equivalent to the Node `LogEventJob` interface at `lib/log.ts:289-335` so a dashboard consuming both NDJSON streams sees identical record shapes. There is no compile-time enforcement — Python doesn't see TypeScript and vice versa.

This ADR pins the discipline as a **session-protocol-level author-side check**, not a code-level mechanical floor. SESSION_PROTOCOL.md §Python pre-push `py-internal-type-grep` already requires reading the corresponding TS definition before constructing a Python mirror; this ADR cross-refs that rule. If drift becomes a recurring class (3+ recurrences per `feedback_prefer_mechanical_over_prose`), a mechanical floor — e.g., a script that compares the two declarations and fails the gate on shape mismatch — lands then.

### 10-line type skeleton (per ADR-with-new-types sub-rule)

```python
# api/log_event.py
from dataclasses import dataclass
from typing import Callable, Literal

JobTransition = Literal["enqueued", "claimed", "done", "failed", "dead"]

@dataclass(frozen=True)
class LogEventJob:
    kind: Literal["job"]
    queue_name: str
    job_id: str
    transition: JobTransition
    latency_ms: float
    cost_usd: float | None  # always None per ADR-0019 §D7 + ADR-0005 invariant
    attempts: int | None = None
    error_class: str | None = None  # caller-controlled stable label per D8
    status: Literal["ok", "error"] | None = None

LogEvent = LogEventJob  # union widens at M2b #5+ first vendor call site

Writer = Callable[[str], None]

def log_event(event: LogEvent) -> None: ...  # see D4 contract
def set_sink(fn: Writer) -> None: ...
def reset_sink() -> None: ...
```

### Wire-point matrix (per Test-helper-signature sub-rule)

| Caller site | Branch | Emits | `transition` | `attempts` value | `error_class` |
| --- | --- | --- | --- | --- | --- |
| `api/jobs.py:claim_one` | success (post-commit) | yes | `"claimed"` | `job.attempts` (pre-claim value) | `None` |
| `api/jobs.py:claim_one` | empty queue (returns `None`) | no | — | — | — |
| `api/jobs.py:mark_done` | success branch (post-commit) | yes | `"done"` | `None` | `None` |
| `api/jobs.py:mark_done` | lost-ownership branch (no audit row) | **no** | — | — | — |
| `api/jobs.py:mark_failed` | queued-retry branch (post-commit) | yes | `"failed"` | new `attempts` | `None` (D8) |
| `api/jobs.py:mark_failed` | dead branch (post-commit) | yes | `"dead"` | new `attempts` | `None` (D8) |
| `api/jobs.py:mark_failed` | lost-ownership/vanished branch (no audit row) | **no** | — | — | — |

Rule of thumb: **`audit_log` row written ⇔ `LogEventJob` line emitted**. Same condition gates both. The lost-ownership and empty-queue branches write no audit row and emit no LogEvent.

## Consequences

**Positive:**
- Closes ADR-0018 §"LogEvent emitter" explicit deferral with a concrete decision and a working implementation.
- M2b #3 observability gap closes today, not at M2b #5+ ship-time. Dashboards consuming the NDJSON stream see the full job lifecycle.
- Zero new third-party Python dependencies; module is ~150 LOC of stdlib mirroring the hand-rolled Node precedent.
- Variant-scope discipline ("ship only LogEventJob, widen the alias when vendor variants actually fire") matches the YAGNI posture of the rest of `api/`.
- Wire-point matrix is enumerated in writing — the M2b #4 reviewer doesn't have to re-derive which branches emit.

**Negative:**
- Single-variant scope means the M2b #5/#6/#7 author MUST consult `lib/log.ts` for the canonical `LogEventVoyage` / `LogEventClaude` shape when widening; there is no Python-side placeholder providing structural hints. SESSION_PROTOCOL.md `py-internal-type-grep` is the discipline floor (D9).
- The fixture-recording tee asymmetry (D6) is real: Node-side has it, Python-side does not. Replay tooling spanning both sides is partial until BACKLOG closes the gap.
- Hand-rolled `JSONFormatter`-equivalent serialization means PriorityKB owns the wire-format contract on the Python side (ISO8601 ts shape, `ensure_ascii=False` choice, attribute ordering). If `lib/log.ts` ever changes its wire shape, the Python mirror must follow in the same PR.

**Mitigations:**
- The module docstring repeats the variant-scope rule in plain prose so a reader of `api/log_event.py` alone (no ADR context) knows the alias widens at M2b #5+.
- `api/tests/test_log_event.py` covers the runtime guards + serialization fallback + sink-error swallow; `api/tests/test_jobs.py` extension covers the wire-point matrix.
- D9 names the author-side discipline + the 3-recurrence trigger for promoting to a mechanical floor.

## References

- [ROADMAP.md](../ROADMAP.md) M2b #3 (closes the LogEventJob gap retroactively) + M2b #4 (file upload + first real `enqueueJob` caller — separate PR, this ADR's sibling)
- [ADR-0005](0005-log-event-schema.md) — LogEvent wire schema + carve-out invariant
- [ADR-0018](0018-python-logging-primitive.md) §"LogEvent emitter" — the deferral this ADR closes (see Amendment 2026-05-27 below for cross-ADR text changes)
- [ADR-0019](0019-job-queue.md) §D7 — Python emitter timing (see Amendment 2026-05-27 below)
- [ADR-0016](0016-python-rules-adoption.md) §8 #2/#3 — Python iron-rule mirrors; distinct from this ADR but cross-reference the same SESSION_PROTOCOL.md author-side discipline floor.
- [lib/log.ts](../../lib/log.ts) — Node-side precedent + canonical `LogEventJob` shape (lines 289-335) + runtime guards + sink-error swallow (lines 449-507).
- [api/jobs.py](../../api/jobs.py) — Python wire-point consumer (see D4 + the wire-point matrix above).
- [api/log.py](../../api/log.py) — Python application runtime logger; distinct surface (ADR-0018).
- [api/log_event.py](../../api/log_event.py) — implementation.

---

## Amendment 2026-05-27 — Cross-ADR text changes recorded here

This ADR amends two prior ADRs in-place. Recorded here for traceability:

**ADR-0018 §"LogEvent emitter"** (lines 43): the original text deferred the LogEvent emitter to M2b #4 ("the first PR that introduces a real Claude or Voyage call site"). Amended 2026-05-27: the LogEventJob variant of the Python emitter lands ahead of M2b #4 per ADR-0020 §D3; vendor variants still land per first call site. The "with its own ADR cross-referencing ADR-0005" clause is satisfied by this ADR.

**ADR-0019 §D7** (lines 63 + 172): the original text named the Python LogEvent emitter as M2b #4 work. Amended 2026-05-27 per ADR-0020 §D3: LogEventJob ships in M2b #3 closeout (the same PR as this ADR); vendor variants land at M2b #5/#6/#7 worker handler ship-time.

Both ADRs receive a one-line `Amendment 2026-05-27` pointer to this ADR rather than full prose edits — the controlling text is here, the prior ADRs link in.
