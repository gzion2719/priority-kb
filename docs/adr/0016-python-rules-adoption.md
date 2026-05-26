# ADR-0016 — Python rules adoption from PYTHON_RULES_DRAFT.md (M2b #1)

**Status:** Accepted
**Date:** 2026-05-26
**Supersedes:** N/A
**Related:** [ADR-0006](0006-process-alignment-with-external-audit.md) (parent — deferred this import to M2b)

## Context

ADR-0006 imported the operationally-tight rules from the YuTom Trading Bot audit that generalised across projects, but deferred the ~40 Python-stack rules (Rule 5 sub-rules, Rule 7 C-extension coverage, Rule 8 Code Writing Protocol, Rule 9 Script Logging Initialisation, plus a "Migrated WORKFLOW.md sections" block) to M2b import time. The parked source lives at [docs/PYTHON_RULES_DRAFT.md](../PYTHON_RULES_DRAFT.md) with a three-bucket review procedure spelled out in its §"How to use this file at M2b import time."

[ROADMAP.md](../ROADMAP.md) M2b checklist item #1 is the trigger: *"Review and adapt Python rules from `docs/PYTHON_RULES_DRAFT.md` — three-bucket sort (adopt / adapt / reject) per the file's 'How to use this file at M2b import time' section. Land the adopted rules in `SESSION_PROTOCOL.md` under a `Python pre-push` sub-section + write an M2b ADR documenting bucket assignments."*

This ADR closes that loop: every rule in the DRAFT gets a recorded disposition; the adopted set lands in `SESSION_PROTOCOL.md` §Python pre-push (and 4 already-relevant operating rules in `WORKFLOW.md` instead); the DRAFT flips to imported-for-archaeology status so a future reader can reconstruct decisions from this ADR alone without re-running the audit.

Iron-rule context: PriorityKB's CLAUDE.md non-negotiables 1–13 have no YuTom equivalents — the DRAFT therefore lacks Python-side mechanical-floor mirrors for #8 (tests never call live embedding/Claude APIs), #9 (`embedding_model` + `embedding_version` per chunks row), and #10 (prompts hashed, hash stored with every agent response). The Node side has those floors today (`lib/embedding.test.ts:161-175` source-file-no-import scan; `lib/prompts.ts` sealed-at-boot hash + DB CHECK `audit_log_prompt_hash_required_for_agent`). The Python side will need parallel floors when M2b #2 onward lands the `api/` scaffold; §8 below synthesizes them in this ADR.

File-size context: `SESSION_PROTOCOL.md` is ~42KB pre-import. ADR-0006 §Deliberately-not-done flagged a 14KB audit threshold and a deferred three-file split (navigation stub + Open + Close + Rules). The audit was overdue at session-start; this ADR adds ~11KB more, pushing the file to ~55KB. The three-file split is filed to BACKLOG as a near-term protocol-hygiene PR rather than bundled here — keeps the M2b #1 unlock separable from the split design (which is itself ADR-worthy work).

## Decision

ADR-with-new-types: vacuous (documentation only, no types introduced).
Test-helper-signature: vacuous (no test helpers introduced).

Path-adaptation convention applied throughout: `src/` → `api/`; `tests/` unchanged; `requirements-dev.txt` → `pyproject.toml [project.optional-dependencies].dev`. Each adopted rule carries the lineage pointer `Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016)` in its `SESSION_PROTOCOL.md` entry. Each rule gets an explicit `<a name="py-<slug>"></a>` HTML anchor so this ADR's anchor column stays linkable across future copy-edits (markdown auto-anchors drift).

### §1 — Bucket 1 (adopt verbatim with path adaptation): 14 rules

| # | Lead phrase | SESSION_PROTOCOL.md anchor |
|---|---|---|
| 1 | Immediate black after each edit | `py-immediate-black` |
| 2 | `zip()` strict parameter at write time | `py-zip-strict` |
| 3 | Nested-`with` SIM117 flatten at write time | `py-nested-with-flatten` |
| 4 | `# type: ignore` code verification | `py-type-ignore-code` |
| 5 | Trailing-whitespace grep on text edits | `py-trailing-whitespace` |
| 6 | PEP-563 unquoted-annotation check | `py-pep563-unquoted` |
| 7 | Black line-length sync | `py-black-linelength-sync` |
| 8 | Black version sync | `py-black-version-sync` |
| 9 | Black `--diff` first diagnostic | `py-black-diff-first` |
| 10 | I001 repair: always `ruff --fix` first | `py-i001-ruff-fix` |
| 11 | Smoke-test fidelity | `py-smoke-test-fidelity` |
| 12 | Untyped-library call annotation | `py-untyped-library-call` |
| 13 | Sandbox ruff pre-handoff sweep | `py-sandbox-ruff-sweep` |
| 14 | Registry test sweep (DRAFT-named `EVENT_PAYLOAD_TYPES`; adapted to "any registry-style dict whose keys are mirrored by a test assertion") | `py-registry-test-sweep` |

### §2 — Bucket 2 (adopt with YuTom-naming stripped): 16 rules

Imperative kept; YuTom-specific class/field names (`IndicatorSnapshot`, `EVENT_PAYLOAD_TYPES`, `OrderSpec`, `BacktestEngine`, `bus.publish`, `make_xxx_agent`, etc.) replaced with PriorityKB-generic phrasing ("any class defined under `api/`", "any constructor under `api/`", "any module-internal dict registered for outbound events"). Where the trigger names a surface not yet present, the rule carries `Trigger fires from M2b #2 onward (when api/ lands)` so the dead-letter window is explicit.

| # | Adapted lead phrase | SESSION_PROTOCOL.md anchor |
|---|---|---|
| 1 | Third-party-library special case + first-call extension | `py-third-party-special` |
| 2 | Sibling-bug sweep | `py-sibling-bug-sweep` |
| 3 | Unsupported-to-supported promotion sweep | `py-unsupported-promotion` |
| 4 | `api/`-internal type construction grep + `__post_init__` validator scan + attribute-access extension (compound) | `py-internal-type-grep` |
| 5 | Production-call-site kwarg sweep | `py-prod-kwarg-sweep` |
| 6 | Composite-field string assertion | `py-composite-string-assert` |
| 7 | Test-helper constructor-completeness check (adapted from `make_xxx_agent`) | `py-helper-completeness` |
| 8 | `Test*`-class import alias | `py-test-class-alias` |
| 9 | Autouse-fixture patch-mechanism consistency | `py-autouse-patch-consistency` |
| 10 | Periodic-counter race isolation + wall-clock-triggered reset extension (compound) | `py-counter-race-isolation` |
| 11 | UTC/local timezone mismatch in test anchors | `py-utc-test-anchor` |
| 12 | Filter-kwarg default alignment across helper + factory (adapted from "bus-citizen filter parameter alignment") | `py-filter-kwarg-alignment` |
| 13 | Side-effect addition grep | `py-side-effect-grep` |
| 14 | Cross-cutting reconciliation file-enumeration sweep | `py-cross-cutting-recon` |
| 15 | Wall-clock → deterministic transition grep | `py-wallclock-deterministic` |
| 16 | Silent-zero-result guard in smoke tests (reframed from "backtest zero-trade guard") | `py-silent-zero-guard` |

### §3 — Bucket 3 (rejection / partial promotion / defer): 7 DRAFT line items

| DRAFT entry | Status | Reason |
|---|---|---|
| Oracle-cross-check convention-verification | **Reject** | Trading-indicator oracle has no PriorityKB analogue across M1–M3 surfaces (no oracle pattern in retrieval / ingestion / chunking). |
| Smoke-battery coverage-parity (`py_compile` substitution for blocked pytest) | **Defer** | Sandbox-version-specific; re-assess when M2b `api/` sandbox interaction is observed. |
| Indicator-period field-exposure | **Reject** | Trading-strategy specific; no PriorityKB equivalent. |
| Schema-propagation two-pattern sweep (`IndicatorSnapshot` + `indicator_params=`) | **Reject** | YuTom-snapshot-shape has no analogue. The generic version is covered by §2 #14 (cross-cutting reconciliation file-enumeration sweep). |
| Mock call-count sweep for `bus.publish` | **Reject** | Event-bus pattern not used by PriorityKB; the M2b worker is HTTP-request-response, not pub/sub. |
| Sandbox-disk CHATLOG pre-check + sandbox-black-skip + post-handoff black failure escalation (compound) | **Promote 1, defer 2** | Sandbox-disk CHATLOG pre-check is **relevant today** (`CHATLOG.md` exists at repo root, is read every session) — promoted to a new §3 sub-section in [SESSION_PROTOCOL.md](../../SESSION_PROTOCOL.md#python-pre-push) (Bucket 3 partial promotion) at anchor `py-sandbox-disk-chatlog`, adapted to "sandbox-disk text-edit close-time verify" since today's surface is non-Python. Sandbox-black-skip + post-handoff black escalation remain **deferred** — both require a black runtime to disagree about, not present pre-M2b. Note: the promoted rule's placement-by-origin (under Python pre-push) rather than placement-by-applicability (under Closing ritual) is a deliberate scope call to keep the lineage chain atomic; reorganization is candidate work for the BACKLOG three-file SESSION_PROTOCOL split. |
| Sandbox `src/`-import stub requirement | **Defer** | Python-version specific (3.10 vs 3.11 `from datetime import UTC`); re-assess when `api/` Python version is pinned in M2b #2. |

### §4 — Rule 7 (C-extension coverage)

**Reject as not-applicable.** Per DRAFT §M2b assessment: Voyage SDK and Anthropic SDK are pure-Python wheels; `pgvector`'s Python bindings are pure-Python wrappers around the server-side C extension. No C-extension import surface emerges in M2b through M5 by the current ROADMAP. **Re-assess** if a Python image-processing / OCR dependency (`cv2`, Pillow C bits, or a Tesseract Python binding) lands in M2b's image processing checklist item.

### §5 — Rule 8 (Code Writing Protocol)

**Not carried** — already adjudicated in DRAFT §Rule 8 (lines 84–88). YuTom's `Spec → Critic-mode → Code → Critic-mode → QA → Deploy` self-critique loop is directly superseded by [SESSION_PROTOCOL.md](../../SESSION_PROTOCOL.md) Step 7b (Unbiased-review sub-rule + Amplified-covers-review-induced-plan-changes sub-rule), which uses an independent subagent (no shared context, no rationalising rejections) rather than self-critique. This ADR records the disposition; no `SESSION_PROTOCOL.md` edit required.

### §6 — Rule 9 (Script logging initialisation)

**Adopt in Python form** — `SESSION_PROTOCOL.md` §Python pre-push anchor `py-script-logging-init`: any `api/scripts/*.py` that imports a logger must call the project's chosen log-init function (TBD; named in M2b #2 when the FastAPI worker logging primitive is chosen) as the first line of `main()`, before any log call.

**Node-analogue queued to BACKLOG** — the existing `scripts/*.mjs` hook scripts (`hook-gh-pr-create-precheck.mjs`, `hook-gh-pr-merge-block.mjs`, `precheck-pr-title.mjs`, `verify-roadmap-tickboxes.mjs`, etc.) do not have a parallel rule. DRAFT §Rule 9 line 96 explicitly flagged this gap as a candidate for a future protocol-slimming pass. Net-new BACKLOG entry filed with this ADR.

### §7 — Migrated WORKFLOW.md sections (9 sub-rules from DRAFT lines 98–110)

These are not Python pre-push rules but operating-discipline rules ported alongside. Disposition:

| Sub-rule | Status | Destination |
|---|---|---|
| External version lookups (`WebSearch` over `web_fetch`) | **Adopt now** | [WORKFLOW.md](../../WORKFLOW.md) §Operating discipline (imported 2026-05-26) |
| Egress allowlist (Cowork sandbox blocks `web_fetch` on non-allowlisted domains) | **Adopt now** | Same |
| Never keyword-filter output when assessing process health | **Adopt now** | Same |
| Sequenced-instruction confirmation discipline | **Adopt now** | Same |
| New-test publish-signature check | **Defer** | Python-specific (event-bus `publish` signature); re-assess at M2b |
| Interactive secrets via `!` are unreliable | **Defer** | Claude Code worktree-mode specific; re-assess when worktree mode is in wider use |
| Touch ID over CLI sudo on Tom's Mac | **Reject** | Mac-specific, environment-specific; no PriorityKB applicability |
| Cowork within-import alphabetization | **Defer** | Python+Cowork specific; re-assess at M2b |
| Stub-to-real transport swap requires producer audit | **Defer** | Generic for any transport swap; re-assess when M2b ingest worker lands |

### §8 — Iron-rule synthesis: 3 net-new rules (not in DRAFT)

The DRAFT carries YuTom's discipline; YuTom has no iron-rule equivalents to PriorityKB's CLAUDE.md non-negotiables 1–13. Three mechanical-floor mirrors are net-new in this ADR and land in `SESSION_PROTOCOL.md` §Python pre-push under the explicit lineage `Synthesized 2026-05-26 in ADR-0016 — not present in PYTHON_RULES_DRAFT.md; mirrors CLAUDE.md non-negotiable #N for the Python side.` Trigger fires from M2b #2 onward (when `api/` lands).

1. **Non-negotiable #8 mirror — Python source-file-no-import scan for live API SDKs.** Mirrors the Node precedent at [lib/embedding.test.ts:217-251](../../lib/embedding.test.ts) (the `non-negotiable #8 — no live API client imports in lib/embedding.ts` describe block). The Node precedent scans the *production library module* (`lib/embedding.ts`) for SDK imports — keeping the library clean ensures tests that transitively import it cannot reach live APIs. The Python mirror does the same: any `api/`-side production module that participates in the embedding / agent path MUST NOT import `voyageai`, `anthropic`, or `openai` directly; live API access flows only through a stub-by-default factory mirroring `getEmbedder()`. A source-file-no-import scan test ships against the first `api/` library module (likely `api/embeddings.py` or analogue), with positive-control regex tests guarding against regex-rot per the Node precedent's positive-control pattern at lines 232-250. Anchor: `py-iron-rule-8-no-live-api-imports`.
2. **Non-negotiable #9 mirror — Python `chunks` write-path column-assertion.** Any Python ingest path that writes a `chunks` row MUST populate `embedding_model` + `embedding_version`. Enforced by the existing schema NOT NULL constraints (server-side floor) plus a unit-level assertion in the Python ingest helper that constructs the row (client-side floor — surfaces the mismatch at test time rather than waiting for the SQL error). Anchor: `py-iron-rule-9-embedding-version-pinned`.
3. **Non-negotiable #10 mirror — Python prompts loaded via sealed-at-boot helper.** Any Python invocation of a Claude agent MUST load the prompt via the Python analog of [lib/prompts.ts](../../lib/prompts.ts), which enforces three invariants the Python mirror must also satisfy: (a) sealed at process boot via a top-level synchronous file-read (Node precedent: `readFileSync` at [lib/prompts.ts:77](../../lib/prompts.ts)); (b) hash never supplied by caller — the audit-row writer pins the hash to the boot-time constant, not to a request-time argument; (c) byte-roundtrip assertion at module init refuses to boot on mismatch — the precedent at [lib/prompts.ts:79-89](../../lib/prompts.ts) (ingestion) and [lib/prompts.ts:134-146](../../lib/prompts.ts) (retrieval) recomputes the hash from the in-memory string after the buffer-side hash is sealed, and throws if the two diverge (catches encoding-drift attacks where the buffer hash is correct but the string-decoded prompt was altered). The Python mirror mirrors all three, plus the DB CHECK `audit_log_prompt_hash_required_for_agent` server-side floor that the audit-row writer satisfies on both Node and Python ingest paths. Anchor: `py-iron-rule-10-prompt-hash-sealed`.

## Consequences

**Positive:**
- Every rule in `docs/PYTHON_RULES_DRAFT.md` has a recorded disposition; the DRAFT honestly flips to imported-for-archaeology status as part of this PR.
- M2b #2 onward inherits a discipline floor that matches Node-side rigor — including iron-rule mirrors for #8/#9/#10 (§8) that the YuTom source did not provide.
- 4 already-relevant rules port to `WORKFLOW.md` and close real protocol gaps that existed today, not waiting for Python.
- Lineage chain (ADR-0006 → DRAFT → ADR-0016 → SESSION_PROTOCOL.md / WORKFLOW.md) is self-contained; future readers reconstruct decisions from this ADR alone.

**Negative:**
- `SESSION_PROTOCOL.md` crosses ~55KB after this PR — well past the 14KB audit threshold ADR-0006 set and the ~20KB split trigger informally tracked. **Three-file split is filed to BACKLOG** as a near-term protocol-hygiene PR; treating it as separable from the rule-import unlock keeps M2b #1 from blocking on split design.
- A large block of rules (most of §2, plus §6 and §8) cannot fire until M2b #2 lands the `api/` scaffold. ADR-0006 §Negative already named this dead-letter risk for prior imports; this ADR adds ~24 such rules.
- The §8 iron-rule mirror rules are synthesized here — they do not carry YuTom origin-incidents like the DRAFT rules do. Less battle-tested; first-fire validation will happen during M2b #2 implementation.

**Mitigations:**
- **M2b #2 first-Python-PR walks the imported list.** The first substantive Python-touching PR after the FastAPI worker scaffolds explicitly checks which rules fired and which silently passed; rules that don't fire on a substantive Python touch get demoted to BACKLOG with a recorded reason. This is the dead-letter audit ADR-0006 §Mitigations originally envisioned for 5-session intervals, made specific to the Python rules and time-anchored to the first concrete Python work.
- **Three-file SESSION_PROTOCOL.md split BACKLOG entry** carries the post-PR size measurement and the audit trigger; next-session candidate.
- **No `docs/AGENTS.md` or `prompts/*.md` updates required** — all imported rules are session-protocol or operating-discipline, not user-facing or agent-prompt content.

## Amendment 2026-05-26 — M2b #2 scaffold floor walk + §6 logging primitive pinned

Closes the §Mitigations #1 "first Python-touching PR walks the imported list" obligation in the form it can actually take on a scaffold-only PR. The substantive walk — where §2 rules either fire on real Python work or are demoted to BACKLOG — is deferred to M2b #3 (job queue + first real class definitions); see §2 sub-section below.

### §3 deferred-UTC-import check closed

[Bucket 3](#§3---bucket-3-rejection--partial-promotion--defer) "Sandbox `src/`-import stub requirement" was deferred pending the Python version pinned at M2b #2. `pyproject.toml` `[project] requires-python = ">=3.12"` resolves the question: `from datetime import UTC` is stable in stdlib since 3.11, so the version-conditional stub the DRAFT named is not needed. **Status flipped to "rejected as not-applicable; floor satisfied by `requires-python = ">=3.12"`."**

### §6 log-init function name pinned

The TBD log-init function name is now `api.log.init_logging`, pinned in [ADR-0018](0018-python-logging-primitive.md). The SESSION_PROTOCOL.md `py-script-logging-init` rule body is updated in the same PR to name the function explicitly rather than carrying TBD.

### §Mitigations #1 floor walk (this PR)

Scaffold-only PRs have very little surface for the §2 rules to fire against; an honest fired-or-silently-passed audit per rule would demote ~80% of §2 prematurely (the surfaces the rules name — `__post_init__` validators, registry-style dicts, side-effect-method greps, Test* class imports, periodic counters — don't exist yet because the worker has no real classes yet). Therefore this PR records the **floor walk**: machinery-and-anchors integrity, not surface-applied audit.

| Class | Status this PR |
|---|---|
| §1 anchors (`py-immediate-black`, `py-zip-strict`, `py-nested-with-flatten`, `py-type-ignore-code`, `py-trailing-whitespace`, `py-pep563-unquoted`, `py-black-linelength-sync`, `py-black-version-sync`, `py-black-diff-first`, `py-i001-ruff-fix`, `py-smoke-test-fidelity`, `py-untyped-library-call`, `py-sandbox-ruff-sweep`, `py-registry-test-sweep`) | All resolvable in SESSION_PROTOCOL.md. `py-immediate-black` fired during this PR's implementation on every `.py` Edit/Write. `py-black-version-sync` ran (`python -m black --version` = 26.3.1 vs `black>=24.0` pin → satisfied). `py-black-linelength-sync` ran (`pyproject.toml [tool.black] line-length = 100`). `py-sandbox-ruff-sweep` fired (`python -m ruff check api/` after all edits). Remaining §1 rules silently passed — surface not present (no `zip()` calls, no nested `with`, no `# type: ignore` suppressions, no `from __future__ import annotations` in a file with quoted annotations, no I001 import-sort issue, no smoke-test fallback, no untyped-library call). |
| §2 anchors | All resolvable. None fired — the surfaces they name (`api/`-defined dataclass, periodic counter, autouse fixture mixed-mode, third-party-library special case, sibling-bug sweep, unsupported-to-supported promotion, internal type construction grep, production-call-site kwarg sweep, composite-field string assertion, test-helper completeness check, `Test*` import alias, UTC test anchor, filter-kwarg alignment, side-effect addition, cross-cutting reconciliation, wall-clock → deterministic transition, silent-zero guard) do not exist on this PR. **Deferred to M2b #3 substantive walk.** |
| §3 anchor (`py-sandbox-disk-chatlog`) | Resolvable. Implicitly applies to this session — CHATLOG.md is being written via the sandbox; close-time verify still ships per CLOSE_SESSION_PROTOCOL.md. |
| §4 anchor (`py-script-logging-init`) | Resolvable. Name pinned this PR. |
| §5 anchors (iron-rule mirrors) | `py-iron-rule-8-no-live-api-imports` **shipped this PR** as `api/tests/test_iron_rule_8_no_live_api_imports.py` — scans `api/__init__.py` + `api/log.py` + `api/main.py`; positive-control regex tests against synthetic `voyageai`/`anthropic`/`openai` import strings prevent regex-rot. `py-iron-rule-9-embedding-version-pinned` and `py-iron-rule-10-prompt-hash-sealed` deferred to M2b #4 (their surfaces — `chunks` row writes, Claude agent calls — don't exist yet). |

### Trigger for the substantive walk (M2b #3)

When M2b #3 (job queue) lands an actual `api/`-defined class with `__post_init__` validators or a registry-style dict mirrored by a test assertion, the substantive walk fires: each §2 rule gets a fired-or-demoted-to-BACKLOG audit recorded in another ADR-0016 Amendment. The dead-letter window is the M2b #2 → #3 gap and is bounded by the next ROADMAP item, not by a calendar threshold.

## References

- [docs/PYTHON_RULES_DRAFT.md](../PYTHON_RULES_DRAFT.md) — the source rules.
- [docs/ROADMAP.md](../ROADMAP.md) M2b checklist #1 — the trigger.
- [ADR-0006](0006-process-alignment-with-external-audit.md) — the parent ADR that deferred this import; gains a trailing `Amendment 2026-05-26` pointer in the same PR.
- [ADR-0018](0018-python-logging-primitive.md) — pins §6 log-init function name to `api.log.init_logging`.
- [SESSION_PROTOCOL.md](../../SESSION_PROTOCOL.md) §Python pre-push — the new section housing the adopted rules.
- [WORKFLOW.md](../../WORKFLOW.md) §Operating discipline (imported 2026-05-26) — the 4 newly-promoted operating-discipline rules from §7.
- [CLAUDE.md](../../CLAUDE.md) non-negotiables 1–13 — the iron-rule surface §8 synthesizes mirrors for.
- [lib/embedding.test.ts](../../lib/embedding.test.ts) lines 217–251 — Node-side source-file-no-import precedent for §8 #1 (scans the production library `lib/embedding.ts` for SDK imports + positive-control regex anti-rot tests).
- [lib/prompts.ts](../../lib/prompts.ts) — Node-side sealed-at-boot precedent for §8 #3 (top-level `readFileSync` at line 77/132 + byte-roundtrip assertion at lines 79-89 / 134-146).
- [api/tests/test_iron_rule_8_no_live_api_imports.py](../../api/tests/test_iron_rule_8_no_live_api_imports.py) — Python mirror of §8 #1 shipped at M2b #2.
