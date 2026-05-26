# Python pre-push gate — mirrors `.github/workflows/ci.yml` `python` job.
# Sibling to `npm run check` for the Node side (see package.json `scripts.check`).
# See SESSION_PROTOCOL.md §Python pre-push + WORKFLOW.md §Pre-push gate.
#
# Python-side ruff / black / mypy / pytest configuration lives in pyproject.toml;
# this Makefile is just the orchestration layer so CI and local invocation share
# one entry point.

# Override locally if needed: `PY=python3.12 make py-check`.
PY ?= python

.PHONY: py-check py-lint py-format py-typecheck py-test

py-check: py-lint py-format py-typecheck py-test

py-lint:
	$(PY) -m ruff check api/

py-format:
	$(PY) -m black --check api/

py-typecheck:
	$(PY) -m mypy --strict api/

py-test:
	$(PY) -m pytest api/
