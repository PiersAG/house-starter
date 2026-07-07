#!/usr/bin/env python3
"""
deps:existence — Stage 0 anti-slopsquatting check.

Reads the target workspace's package.json. For every dependency (deps +
devDeps) that is NOT in the trusted house-starter baseline, verifies:

    1. registry.npmjs.org has a document for the package (404 = FAIL).
    2. Age cooldown — the resolved version's `time` entry is >= AGE_MIN_DAYS
       old. Catches typosquats published hours before an attack and
       hallucinated-then-registered names.
    3. Establishment — the package was created >= ESTABLISHED_MIN_DAYS ago
       OR the weekly download count is >= WEEKLY_DL_FLOOR (npm downloads
       API). Both missing = FAIL.
    4. Lockfile — package-lock.json exists AND `npm ci --dry-run` exits 0.

Baseline lookup order:
    1. --baseline explicit path.
    2. /opt/build/deps-baseline.json (in-container path baked by the
       builder Dockerfile).
    3. <repo>/agents/build/docker/deps-baseline.json (host fallback for
       standalone runs from the app-business-core checkout).

Exit code 0 = PASS; 1 = FAIL (offending package + rule named). Emits a
JSON summary to stdout when --json is passed.

Deterministic, no LLM, no network beyond the two npm HTTPS endpoints.
Spec: wiki/specs/stage0-deps-and-budget.md.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

AGE_MIN_DAYS = 14
ESTABLISHED_MIN_DAYS = 90
WEEKLY_DL_FLOOR = 1000
REGISTRY_TIMEOUT_S = 20

_HERE = Path(__file__).resolve().parent
# Baseline candidates in resolution order (first hit wins):
#   1. --baseline explicit path.
#   2. /opt/build/deps-baseline.json (baked into the builder image).
#   3. <script>/deps-baseline.json  (colocated — the app-repo layout under
#      scripts/, and the pattern used when this script ships inside a
#      scaffolded app).
#   4. <script>/docker/deps-baseline.json (mothership host layout under
#      agents/build/docker/).
_IN_CONTAINER_BASELINE = Path("/opt/build/deps-baseline.json")
_COLOCATED_BASELINE    = _HERE / "deps-baseline.json"
_HOST_BASELINE         = _HERE / "docker" / "deps-baseline.json"


class DepsCheckError(Exception):
    """Named failure with the offending package and rule."""


def _load_baseline(explicit: Path | None) -> set[str]:
    candidates = [explicit] if explicit else []
    candidates += [_IN_CONTAINER_BASELINE, _COLOCATED_BASELINE, _HOST_BASELINE]
    for path in candidates:
        if path and path.exists():
            data = json.loads(path.read_text())
            names = data.get("packages") or data.get("baseline") or []
            return {str(n) for n in names}
    raise DepsCheckError(
        "deps-baseline.json not found — expected at /opt/build/deps-baseline.json "
        f"(in-container), {_COLOCATED_BASELINE} (colocated), or {_HOST_BASELINE} "
        "(mothership host). The baseline is the union of house-starter's "
        "dependencies + devDependencies at image build time."
    )


def _load_pkg_json(workspace: Path) -> dict:
    p = workspace / "package.json"
    if not p.exists():
        raise DepsCheckError(f"{p} not found")
    return json.loads(p.read_text())


def _http_get_json(url: str) -> dict | None:
    """GET a URL and return parsed JSON. Returns None on 404; raises on other errors."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=REGISTRY_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def _resolved_version(name: str, spec: str) -> str:
    """Best-effort resolution of a range spec against the registry's dist-tags/latest.

    For pinned specs (no leading ^~>=< etc.) return as-is. For ranges, we look up
    the latest published version — good enough for the establishment/age checks.
    """
    trimmed = spec.strip().lstrip("v")
    if trimmed and trimmed[0].isdigit():
        return trimmed
    return "latest"


def _parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _age_days(ts: str) -> int:
    return (datetime.now(timezone.utc) - _parse_iso(ts)).days


def _check_package(name: str, spec: str) -> str | None:
    """Return None on PASS, or a named-rule failure string."""
    meta = _http_get_json(f"https://registry.npmjs.org/{name}")
    if meta is None:
        return f"{name}: not present on registry.npmjs.org (rule: existence)"

    time_map = meta.get("time") or {}
    created_iso = time_map.get("created")
    if not created_iso:
        return f"{name}: registry document has no `time.created` (rule: establishment)"

    versions = meta.get("versions") or {}
    resolved = _resolved_version(name, spec)
    if resolved == "latest":
        resolved = (meta.get("dist-tags") or {}).get("latest")
    if not resolved or resolved not in versions:
        return f"{name}: resolved version {resolved!r} not found in registry versions (rule: existence)"

    version_iso = time_map.get(resolved)
    if not version_iso:
        return f"{name}@{resolved}: registry document has no `time.{resolved}` (rule: age)"

    version_age = _age_days(version_iso)
    if version_age < AGE_MIN_DAYS:
        return (
            f"{name}@{resolved}: published {version_age}d ago, "
            f"< {AGE_MIN_DAYS}d minimum (rule: age cooldown)"
        )

    created_age = _age_days(created_iso)
    weekly_dl = 0
    dl = _http_get_json(f"https://api.npmjs.org/downloads/point/last-week/{name}")
    if dl and isinstance(dl.get("downloads"), int):
        weekly_dl = int(dl["downloads"])
    if created_age < ESTABLISHED_MIN_DAYS and weekly_dl < WEEKLY_DL_FLOOR:
        return (
            f"{name}: created {created_age}d ago (< {ESTABLISHED_MIN_DAYS}d) "
            f"AND weekly downloads {weekly_dl} (< {WEEKLY_DL_FLOOR}) — "
            "both establishment signals missing (rule: establishment)"
        )
    return None


def _check_lockfile(workspace: Path) -> str | None:
    lock = workspace / "package-lock.json"
    if not lock.exists():
        return "package-lock.json missing (rule: lockfile)"
    try:
        r = subprocess.run(
            ["npm", "ci", "--dry-run"],
            cwd=workspace,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError:
        return "npm not installed on PATH (rule: lockfile — cannot verify sync)"
    except subprocess.TimeoutExpired:
        return "`npm ci --dry-run` timed out after 120s (rule: lockfile)"
    if r.returncode != 0:
        tail = (r.stdout + "\n" + r.stderr).strip().splitlines()[-5:]
        return "`npm ci --dry-run` exit " + str(r.returncode) + " — lockfile out of sync:\n    " + "\n    ".join(tail)
    return None


def run(workspace: Path, baseline_path: Path | None = None) -> dict:
    workspace = Path(workspace).resolve()
    baseline = _load_baseline(baseline_path)
    pkg = _load_pkg_json(workspace)

    deps: dict[str, str] = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    new_deps = {name: spec for name, spec in deps.items() if name not in baseline}

    failures: list[str] = []

    lock_fail = _check_lockfile(workspace)
    if lock_fail:
        failures.append(lock_fail)

    for name, spec in sorted(new_deps.items()):
        try:
            fail = _check_package(name, spec)
        except urllib.error.URLError as exc:
            fail = f"{name}: registry lookup failed — {exc.reason} (rule: existence)"
        if fail:
            failures.append(fail)

    result = {
        "workspace":       str(workspace),
        "baseline_size":   len(baseline),
        "total_deps":      len(deps),
        "new_deps":        len(new_deps),
        "checked_at":      datetime.now(timezone.utc).isoformat(),
        "failures":        failures,
        "status":          "fail" if failures else "pass",
    }
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", default=".", help="Path to the workspace (contains package.json)")
    ap.add_argument("--baseline", default=None, help="Path to deps-baseline.json (override lookup)")
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON to stdout")
    args = ap.parse_args()

    try:
        result = run(Path(args.workspace), Path(args.baseline) if args.baseline else None)
    except DepsCheckError as exc:
        msg = f"deps:existence — SETUP ERROR: {exc}"
        if args.json:
            print(json.dumps({"status": "error", "error": str(exc)}))
        else:
            print(msg, file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["status"] == "pass":
            print(
                f"deps:existence PASS — {result['new_deps']} new package(s) "
                f"outside baseline ({result['baseline_size']} baseline)"
            )
        else:
            print(f"deps:existence FAIL — {len(result['failures'])} issue(s):")
            for f in result["failures"]:
                print(f"  - {f}")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
