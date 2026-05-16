# PYTHON_RULES_DRAFT.md — parked Python rules for M2b

**Status:** Draft. Parked 2026-05-16 from the external operating-rules audit (see ADR-0006). **Not active.** Each rule is reviewed and adapted at M2b import time, when the FastAPI worker scaffolds at `api/` and `pyproject.toml` is activated (see `docs/ROADMAP.md` M2b checklist).

## Why this file exists

The audit-source (YuTom Trading Bot) had ~40 Python-stack sub-rules under its `Rule 5 — Pre-push verification`, plus `Rule 7 — C-Extension Coverage Strategy` and `Rule 9 — Script Logging Initialisation`. Each one was codified from a specific bug in YuTom's Python codebase. Importing them all into PriorityKB now would:

1. Be dead weight (PriorityKB has no Python code yet).
2. Anchor PriorityKB on YuTom-specific class names (`IndicatorSnapshot`, `BacktestEngine`, `OrderSpec`, `EVENT_PAYLOAD_TYPES`) that have no analogue here.
3. Skip the review-each-rule discipline that PriorityKB has applied to other imports (Pass 1, Pass 2a, Pass 2b, ADR-0006).

So they're parked here verbatim. At M2b — when Python actually lands — each rule is reviewed in three buckets:

- **Adopt as-written** — generic Python rules with PriorityKB applicability (e.g. trailing-whitespace grep, `zip()` strict parameter, immediate black after each edit, `# type: ignore` code verification).
- **Adapt** — strip YuTom-specific class names, keep the imperative + concrete trigger.
- **Reject** — YuTom-codebase-specific patterns that don't generalise (e.g. `IndicatorSnapshot` schema-propagation sweep).

Each rule that lands in PriorityKB's `SESSION_PROTOCOL.md` at M2b carries a `Codified 2026-MM-DD from PYTHON_RULES_DRAFT.md (see ADR-0006)` pointer so the lineage is traceable.

## Bucket 1 — likely adopt as-written (Python generic)

Likely-adopt candidates that probably need only PriorityKB-path adaptation (e.g. `api/` instead of `src/`):

- **Immediate black after each edit.** After every `Edit` / `Write` on a `.py` file, run `python -m black --fast <file>` in the same message.
- **`zip()` strict parameter at write time.** Every `zip()` call must include `strict=True` or `strict=False`. Ruff B905 fires deterministically on bare `zip(a, b)`.
- **Nested-`with` SIM117 flatten at write time.** When the outer `with` block's body is only an inner `with` statement, flatten to `with A, B:` immediately.
- **`# type: ignore` code verification.** Read mypy's exact error code from output; never guess `[return-value]` vs `[no-any-return]`.
- **Trailing-whitespace grep on text edits.** Before declaring any `Edit` to a non-`.py` file done, `grep -n " $" <file>`. (Already implicitly applies to PriorityKB's `.md` edits today; codify when Python lands.)
- **PEP-563 unquoted-annotation check.** When a file opens with `from __future__ import annotations`, never quote forward-reference annotations (ruff UP037).
- **Black line-length sync.** Before any manual line-length check, `grep "line-length" pyproject.toml` (project default may differ from black's 88).
- **Black version sync.** Run `python3 -m black --version` and compare against the pin in `requirements-dev.txt` before sandbox black checks.
- **Black `--diff` first diagnostic.** When pre-push fails on black, first action is `python -m black --diff <file>` — never read the file and guess.
- **I001 repair: always `ruff --fix` first.** Never manually re-sort imports; ruff's isort rules are not reliably hand-reproducible.
- **Smoke-test fidelity.** When pytest can't run in the sandbox and you fall back to a stdlib mirror, the mirror MUST use the same assertion mode as the real test (e.g. `re.search(PATTERN, str(e))` not substring `in`).
- **Untyped-library call annotation.** Before annotating direct method calls with `# type: ignore[no-untyped-call]` on a `[[tool.mypy.overrides]] ignore_missing_imports = true` library, verify the method actually is untyped via the installed source.
- **Sandbox ruff pre-handoff sweep.** When a session touches 4+ Python files, run `python3 -m ruff check <all-edited-files>` after all edits.
- **EVENT_PAYLOAD_TYPES registry test sweep.** *YuTom-named; adapt:* whenever a registry-style dict's keys are mirrored by an `assert set(...).keys()) == ...` test assertion, grep the test file before declaring done.

## Bucket 2 — adapt (imperative kept, YuTom-naming stripped)

These name YuTom-specific classes / fields / commands in their trigger, but the imperative is generic:

- **Third-party-library special case + first-call extension.** Before patching against a third-party lib (or making the first call to any newly-added library), inspect installed source. `pip show <pkg>` finds the path.
- **Sibling-bug sweep.** When a Rule 5 check catches a bug, grep sibling files (same directory, same module pattern) for the same bug shape and fix in the same commit.
- **Unsupported-to-supported promotion sweep.** When a value is promoted from "raises ValueError" to "fully supported," grep the entire test suite for the literal.
- **Project-internal type construction grep + Stub-does-not-substitute-for-grep + `__post_init__` validator scan + Attribute-access extension.** Before constructing any `api/`-defined class in a test, grep its `__init__` / dataclass field list to verify exact kwarg names AND its `__post_init__` for value-range validators AND its attribute fields for any `obj.field` assertion in tests.
- **Production-call-site kwarg sweep.** When adding new kwargs to an existing class `__init__`, grep ALL constructor call sites (including `scripts/`).
- **Composite-field string assertion.** Before asserting `payload[field] == "exact_string"`, read the composite's source for string transformation.
- **make_xxx_agent helper completeness check.** When writing a new test helper that wraps a class constructor, read the class's `__init__` signature and verify every kwarg is either forwarded or intentionally omitted with a comment.
- **`Test*`-class import alias.** When a test file imports a class whose name starts with `Test`, alias it at import to avoid pytest collection.
- **Autouse-fixture patch-mechanism consistency.** Mixed-mode (fixture via `patch`, override via `monkeypatch.setattr`) produces unclear teardown ordering.
- **Periodic-counter race isolation + Wall-clock-triggered reset extension.** Tests asserting accumulated counter state must set reset interval to a safely long value; tests of UTC-hour-triggered resets must use a trigger hour that doesn't fire during typical test runs.
- **UTC/local timezone mismatch in test anchors.** Tests setting a date/time anchor that pairs with UTC-using production code MUST use `datetime.now(UTC).date()`, never `date.today()`.
- **Bus-citizen filter parameter alignment.** *YuTom-named; adapt:* when adding a filter kwarg that gates which events reach an inner domain object, verify defaults align across the test helper and the snapshot factory before writing tests.
- **Side-effect addition grep.** When a previously-pure method gains a state-mutating side effect, grep existing tests for equality assertions on its return value.
- **Cross-cutting reconciliation file-enumeration sweep.** For any reconciliation spanning multiple files of the same shape, run a structural grep across each candidate directory; don't rely on prior enumerations.
- **Wall-clock→deterministic transition grep.** When changing a function from wall-clock-dependent to deterministic, grep the test file for `datetime.now` near the affected class.
- **Backtest zero-trade guard.** *Trading-specific; reframe as "silent-zero-result" guard:* when running any function that produces a count/metric in a smoke test, assert `count > 0` (or the expected non-zero) before reading derived metrics.

## Bucket 3 — likely reject (YuTom-codebase-specific)

These reference YuTom internals that won't have a PriorityKB analogue:

- **Oracle-cross-check convention-verification.** Trading-indicator oracle tests.
- **Smoke-battery coverage-parity.** Python `py_compile` substitution for blocked pytest — sandbox-version-specific.
- **Indicator-period field-exposure.** Trading-strategy specific.
- **Schema-propagation two-pattern sweep (`IndicatorSnapshot` + `indicator_params=`).** Trading-snapshot-specific.
- **Mock call-count sweep for `bus.publish`.** Event-bus-specific.
- **Sandbox-disk CHATLOG pre-check + Sandbox-black-skip mandatory pre-step + Post-handoff black failure immediate escalation.** Sandbox-disk-state dependent; may not apply in Cowork.
- **Sandbox src/-import stub requirement.** Python-3.10-vs-3.11 `from datetime import UTC` issue — sandbox-Python-version specific; verify when M2b lands.

## Rule 7 — C-Extension Coverage Strategy (parked verbatim)

When a new module imports a C-extension (e.g. TA-Lib, OpenCV) or optional dependency that won't be present in the pre-push test environment, the test plan MUST specify a stub/mock strategy BEFORE writing the first line of the module.

Concrete recipe:
1. Soft-import the library: `try: import lib except ImportError: lib = None`
2. Raise at instantiation, not at import time: check `if lib is None: raise ImportError(...)` in `__init__`
3. Inject a `sys.modules` stub in the test file before the first import of the module

**M2b assessment:** Voyage SDK and Anthropic SDK are both pure-Python wheels; unlikely to need C-extension treatment. `pgvector`'s Python bindings are pure-Python wrappers around the server-side C extension. May be reject-as-not-applicable.

## Rule 8 — Code Writing Protocol (NOT carried; superseded by Step 7b)

YuTom's Rule 8 (`Spec → Critic-mode → Code → Critic-mode → QA → Deploy`) used self-critique passes labeled `## Unbiased Review — Critic Mode`. PriorityKB's `SESSION_PROTOCOL.md` Step 7b uses the `review-loop` skill which spawns an independent subagent with no conversation context — explicitly because self-critique was rationalising skips (CHATLOG 2026-05-16 "Step 7b dogfood failure"). Rule 8 as written contradicts Step 7b and is **not** carried into M2b.

The intent of Rule 8 (formalised review at multiple gates: spec → code → QA) is partially covered by Step 7b's "amplified covers review-induced plan changes" sub-rule, which requires a second review on the implemented code when the first review's BLOCKING findings materially changed the plan.

## Rule 9 — Script Logging Initialisation (parked verbatim)

Any script under `scripts/` that calls `get_logger()` MUST also call `init_logging(console=True)` as the first line of its `main()` function — before any log call, before loading config. Without this, all log output is silently discarded (no terminal output, no file write).

**Trigger:** any new or modified `scripts/*.py` file that imports `get_logger` → verify `init_logging(console=True)` is called at the top of `main()`. If it's missing, add it before declaring the script done.

**M2b assessment:** PriorityKB already has `scripts/*.mjs` files (Node, not Python) — `hook-gh-pr-create-precheck.mjs`, `precheck-pr-title.mjs`. A Node analog of this rule may be worth lifting earlier; not currently in BACKLOG, candidate for a future protocol-slimming pass. Re-check at M2b for the Python-specific shape.

## Migrated WORKFLOW.md sections (parked verbatim — review at M2b)

The audit-source also had a "Claude Sandbox Notes" section that includes some rules potentially relevant to Cowork now, not just M2b. These need separate review:

- **External version lookups (`WebSearch` over `web_fetch`).** PriorityKB-relevant already; consider lifting to `WORKFLOW.md` outside the M2b deferral.
- **Egress allowlist rule (Cowork sandbox blocks `web_fetch` on non-allowlisted domains).** PriorityKB-relevant already; same.
- **New-test publish-signature check.** Python-specific (event_bus.publish signature).
- **Interactive secrets via `!` are unreliable.** Claude Code specific; review when Claude Code worktree mode is in wider use.
- **Never keyword-filter output when assessing process health.** Generic; reviewable now.
- **Touch ID over CLI sudo on Tom's Mac.** Mac-specific, environment-specific; reject for PriorityKB.
- **Sequenced-instruction confirmation discipline.** Generic; reviewable now.
- **Cowork within-import alphabetization.** Python+Cowork specific; review at M2b.
- **Stub-to-real transport swap requires producer audit.** Generic for any transport swap; reviewable at M2b when ingest worker lands.

## How to use this file at M2b import time

1. Read this file end-to-end.
2. For each Bucket 1 rule: copy verbatim into `SESSION_PROTOCOL.md` under a `Python pre-push` sub-section, adapt paths (`api/` for source, `tests/` for tests).
3. For each Bucket 2 rule: rewrite the imperative without YuTom names; verify the trigger maps to a PriorityKB surface; add to `SESSION_PROTOCOL.md`.
4. For each Bucket 3 rule: confirm rejection by checking if a PriorityKB analogue surface emerged during M1–M3 work; if yes, adapt; if no, leave rejected with a one-line note.
5. Write an M2b ADR (next-free number at the time) that records the bucket assignments and any rejections, so the next reader can audit the decisions.
6. Update this file's status to "Imported into SESSION_PROTOCOL.md per ADR-NNNN; retained for archaeology."
