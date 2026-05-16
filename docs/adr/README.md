# Architecture Decision Records

Numbered, monotonic. Each ADR captures a load-bearing decision and the reasoning behind it. **An ADR is written when** a decision shapes the system's structure, locks in a tool/vendor, or changes a contract between components.

## ADR-with-new-types sub-rule
ADRs that introduce frozen dataclasses / TypedDicts / Zod schemas with structural invariants include a **10-line type skeleton inline** in the Decision section *before* the prose.

## Test-helper-signature sub-rule
ADRs that prescribe a test-helper / fixture signature change include the **new signature as a code skeleton** in the Decision section.

## ADR/design-document timing sub-rule
For ADR-shaped focuses, the supporting reads (existing code, related ADRs, schema) happen *before* the Step 7 planning critique — not after. See `SESSION_PROTOCOL.md` Step 4b.

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
