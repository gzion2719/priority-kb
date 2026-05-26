"""CLAUDE.md non-negotiable #8 mechanical floor — Python mirror.

Scans every production ``api/`` module for direct imports of live API SDKs
(``voyageai``, ``anthropic``, ``openai``). Iron rule #8 requires that tests
never call live embedding / Claude APIs; the mechanical floor that backs
the rule on the Node side is the source-file-no-import scan at
``lib/embedding.test.ts`` (lines 217-251 — the
``non-negotiable #8 — no live API client imports in lib/embedding.ts``
describe block). This is the Python mirror — synthesized in ADR-0016 §8 #1
and shipped at M2b #2 against the first ``api/`` content, with
positive-control regex tests guarding against regex-rot per the Node
precedent's positive-control pattern at lines 232-250.

Coverage extends to any future ``api/`` library module as it lands. The
scan target list grows monotonically as M2b #3-#8 ship.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
API_DIR = REPO_ROOT / "api"

# Production modules to scan. Excludes ``api/tests/`` and symlinks (api/ is
# assumed to be first-party Python source — a stray symlink pointing into
# node_modules/ or .venv/ would silently extend the scan target otherwise).
PRODUCTION_MODULES: tuple[Path, ...] = tuple(
    sorted(
        p
        for p in API_DIR.rglob("*.py")
        if "tests" not in p.relative_to(API_DIR).parts and p.is_file() and not p.is_symlink()
    )
)

# Forbidden import patterns. Catches both ``import X`` and ``from X import Y`` shapes.
# Each pattern matches the literal SDK package name as a top-level (non-relative) module
# token, not inside another name. Out of scope by design:
#   - Relative imports (``from .voyageai import x``) — a hypothetical ``api/voyageai.py``
#     would be the stub-factory shim itself, not a live-SDK import. Negative-control tests
#     cover this case.
#   - Dynamic imports via ``__import__("voyageai")`` / ``importlib.import_module("voyageai")``
#     — adding a coarse ``/voyageai/`` substring guard would false-positive on docstring /
#     comment mentions of the package (the explicit no-overmatch design above). Filed to
#     BACKLOG for re-assessment at M2b #4 when the first real SDK call site lands.
FORBIDDEN_IMPORT_PATTERNS: dict[str, re.Pattern[str]] = {
    "voyageai": re.compile(r"^\s*(?:from\s+voyageai(?:\.|\s)|import\s+voyageai\b)", re.MULTILINE),
    "anthropic": re.compile(
        r"^\s*(?:from\s+anthropic(?:\.|\s)|import\s+anthropic\b)", re.MULTILINE
    ),
    "openai": re.compile(r"^\s*(?:from\s+openai(?:\.|\s)|import\s+openai\b)", re.MULTILINE),
}


@pytest.mark.parametrize("module", PRODUCTION_MODULES, ids=lambda p: str(p.relative_to(REPO_ROOT)))
@pytest.mark.parametrize("sdk", list(FORBIDDEN_IMPORT_PATTERNS.keys()))
def test_production_module_does_not_import_live_sdk(module: Path, sdk: str) -> None:
    """No api/ production module may import voyageai / anthropic / openai directly.

    Live API access flows only through a stub-by-default factory mirroring
    the Node precedent at ``lib/embedding.ts`` ``getEmbedder()``. When M2b #4
    lands ``api/embeddings.py``, the factory pattern lands with it; this scan
    extends automatically to cover the new module.
    """
    source = module.read_text(encoding="utf-8")
    pattern = FORBIDDEN_IMPORT_PATTERNS[sdk]
    match = pattern.search(source)
    assert match is None, (
        f"{module.relative_to(REPO_ROOT)} imports {sdk!r} directly at "
        f"{match.group(0)!r}; iron rule #8 forbids — route live API access "
        f"through a stub-by-default factory instead."
    )


# Positive controls: synthetic strings that MUST match each pattern. If a regex
# silently degrades (escape drift, MULTILINE flag dropped, etc.) the production
# scan above becomes a false-negative — these tests make the regression loud.
# Mirrors the Node precedent's positive-control pattern at
# ``lib/embedding.test.ts`` lines 232-250.


@pytest.mark.parametrize(
    "synthetic_line",
    [
        "import voyageai\n",
        "import voyageai.client\n",
        "from voyageai import Client\n",
        "from voyageai.errors import VoyageError\n",
        "    import voyageai\n",  # indented (inside function)
    ],
)
def test_voyageai_pattern_matches_positive_controls(synthetic_line: str) -> None:
    assert FORBIDDEN_IMPORT_PATTERNS["voyageai"].search(synthetic_line) is not None


@pytest.mark.parametrize(
    "synthetic_line",
    [
        "import anthropic\n",
        "from anthropic import Anthropic\n",
        "from anthropic.types import Message\n",
        "    from anthropic import AsyncAnthropic\n",
    ],
)
def test_anthropic_pattern_matches_positive_controls(synthetic_line: str) -> None:
    assert FORBIDDEN_IMPORT_PATTERNS["anthropic"].search(synthetic_line) is not None


@pytest.mark.parametrize(
    "synthetic_line",
    [
        "import openai\n",
        "from openai import OpenAI\n",
        "from openai.types.chat import ChatCompletion\n",
    ],
)
def test_openai_pattern_matches_positive_controls(synthetic_line: str) -> None:
    assert FORBIDDEN_IMPORT_PATTERNS["openai"].search(synthetic_line) is not None


# Negative controls: shapes that look like they MIGHT match but legitimately
# should not, so a too-eager pattern is caught early.


@pytest.mark.parametrize(
    "synthetic_line",
    [
        "# voyageai docs say to import via the factory\n",
        "VOYAGEAI_API_KEY = os.environ['VOYAGEAI_API_KEY']\n",  # constant, not import
        "import voyageai_stub  # type: ignore\n",  # a different package name
        '"""See voyageai docs at https://docs.voyageai.com"""\n',  # docstring
    ],
)
def test_voyageai_pattern_does_not_overmatch(synthetic_line: str) -> None:
    assert FORBIDDEN_IMPORT_PATTERNS["voyageai"].search(synthetic_line) is None


def test_production_modules_list_is_non_empty() -> None:
    """Guard against a discovery glob silently returning zero files — that would make every
    parametrized scan vacuously pass. Threshold matches the message's named files."""
    assert len(PRODUCTION_MODULES) >= 3, (
        f"Expected at least api/__init__.py + api/main.py + api/log.py in scan "
        f"target list; got {[str(p.relative_to(REPO_ROOT)) for p in PRODUCTION_MODULES]}"
    )
