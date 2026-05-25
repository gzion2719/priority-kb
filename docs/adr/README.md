# Architecture Decision Records

Numbered, monotonic. Each ADR captures a load-bearing decision and the reasoning behind it. **An ADR is written when** a decision shapes the system's structure, locks in a tool/vendor, or changes a contract between components.

## ADR-with-new-types sub-rule
ADRs that introduce frozen dataclasses / TypedDicts / Zod schemas with structural invariants include a **10-line type skeleton inline** in the Decision section *before* the prose.

## Test-helper-signature sub-rule
ADRs that prescribe a test-helper / fixture signature change include the **new signature as a code skeleton** in the Decision section.

## ADR/design-document timing sub-rule
For ADR-shaped focuses, the supporting reads (existing code, related ADRs, schema) happen *before* the Step 7 planning critique — not after. See `SESSION_PROTOCOL.md` Step 4b.

## Context-section discipline sub-rule
The Context section describes the world the ADR addresses (what the spec requires, what's already built, what's deferred), not the meta of how the ADR was authored. Plan-CR / code-CR findings, reviewer telemetry, "two BLOCKING issues that reshaped the plan" — all belong in the commit message or PR body, not in the ADR. Future readers consume the ADR cold; session-process narration is noise. Codified 2026-05-18 after ADR-0010's draft Context included a reshape-narrative paragraph that the code-CR correctly flagged as out of place.

---

## Index

| #    | Title                                                                              | Status   |
|------|------------------------------------------------------------------------------------|----------|
| 0001 | [Bootstrap-time decisions: stack, hosting, repo location, sequencing](0001-bootstrap.md) | Accepted |
| 0002 | [Branching and merge policy](0002-branching-and-merge-policy.md)                   | Accepted |
| 0003 | [CI security gates baseline](0003-ci-security-gates-baseline.md)                   | Accepted |
| 0004 | [PR-title mechanical floor](0004-pr-title-mechanical-floor.md)                     | Accepted |
| 0005 | [Log event schema (structured JSON observability)](0005-log-event-schema.md)       | Accepted |
| 0006 | [Process alignment with external operating-rules audit](0006-process-alignment-with-external-audit.md) | Accepted |
| 0007 | [Language policy: agent replies always in English](0007-language-policy-always-english.md) | Accepted |
| 0008 | [ORM + migration ownership (Drizzle replaces Alembic for schema; SQL-first migrations)](0008-orm-and-migration-ownership.md) | Accepted |
| 0009 | [Chunking strategy (sizes, boundaries, metadata, lifecycle)](0009-chunking-strategy.md) | Accepted |
| 0010 | [Admin ingestion agent chat UI: architecture](0010-admin-ingestion-agent-chat-ui.md) | Accepted |
| 0011 | [Repo visibility: public until first real KB content lands](0011-repo-visibility.md) | Accepted |
| 0012 | [Retrieval pipeline architecture (M3 item 3)](0012-retrieval-pipeline.md)           | Accepted |
| 0013 | [Hybrid keyword lane + RRF fusion + Hebrew tsvector tokenization (M3 item 4)](0013-hybrid-rrf-tsvector.md) | Accepted |
| 0014 | [End-to-end page-status testing: vitest + fetch + `next start` subprocess](0014-e2e-page-status-tests.md) | Accepted |
| 0015 | [Browser-mediated e2e runtime: Playwright (BACKLOG:77 back-nav)](0015-back-nav-e2e-runner.md) | Accepted |
