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
