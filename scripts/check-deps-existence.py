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

Then the whole-lockfile audit (#749): EVERY package in package-lock.json —
transitive as well as direct — is checked for:

    5. Existence — the locked name@version is on registry.npmjs.org, and the
       lockfile fetches it from there (rule: lockfile source).
    6. Downloads — fewer than LOCK_DL_FLOOR (100) weekly downloads is flagged
       (rule: low downloads), whatever the package's age.
    7. Maintainers — anyone added to the package's maintainers (or a new
       publisher) on a version published in the last MAINTAINER_WINDOW_DAYS
       (90) days is flagged (rule: maintainer change); a package created
       inside the window has no history and is flagged too (rule: new package).
    8. Install scripts — a package that runs a script when installed is
       flagged (rule: install script).

A flag (rules 6–8) passes only when deps-reviewed.json records a review of
that exact flag; an existence or source failure never does. The reviewed
file is looked up like the baseline (explicit, /opt/build, colocated,
docker/) and never in the workspace, so the build assistant cannot review
its own packages. `--lockfile new` audits only the lock entries that are
not in the baseline's `lock` list (the build loop's per-phase check; the
template's CI audits them all); `--lockfile all` is the default.

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
import http.client
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

AGE_MIN_DAYS = 14
ESTABLISHED_MIN_DAYS = 90
WEEKLY_DL_FLOOR = 1000
REGISTRY_TIMEOUT_S = 20
LOCK_DL_FLOOR = 100            # #749 R0393: fewer than 100 weekly downloads
MAINTAINER_WINDOW_DAYS = 90    # #749 R0394: maintainer change in the last 90 days
LOCK_WORKERS = 16
REGISTRY_ATTEMPTS = 6        # backoff 2, 4, 8, 16, 32 s
DL_ATTEMPTS = 9              # npm's downloads service rate-limits shared CI addresses hard:
                             # backoff 2, 4, 8, 16, 32, 60, 60, 60 s per lookup
REVIEWABLE_RULES = ("low downloads", "maintainer change", "new package", "install script")

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
_REVIEWED_CANDIDATES   = (
    Path("/opt/build/deps-reviewed.json"),
    _HERE / "deps-reviewed.json",
    _HERE / "docker" / "deps-reviewed.json",
)


class DepsCheckError(Exception):
    """Named failure with the offending package and rule."""


def _load_baseline_doc(explicit: Path | None) -> dict:
    candidates = [explicit] if explicit else []
    candidates += [_IN_CONTAINER_BASELINE, _COLOCATED_BASELINE, _HOST_BASELINE]
    for path in candidates:
        if path and path.exists():
            return json.loads(path.read_text())
    raise DepsCheckError(
        "deps-baseline.json not found — expected at /opt/build/deps-baseline.json "
        f"(in-container), {_COLOCATED_BASELINE} (colocated), or {_HOST_BASELINE} "
        "(mothership host). The baseline is the union of house-starter's "
        "dependencies + devDependencies at image build time."
    )


def _load_baseline(explicit: Path | None) -> set[str]:
    data = _load_baseline_doc(explicit)
    names = data.get("packages") or data.get("baseline") or []
    return {str(n) for n in names}


def _load_reviewed(explicit: Path | None) -> list[dict]:
    """The reviewed flags. Never read from the workspace (see module docstring)."""
    candidates = [explicit] if explicit else list(_REVIEWED_CANDIDATES)
    for path in candidates:
        if path and path.exists():
            return list(json.loads(path.read_text()).get("reviewed") or [])
    if explicit:
        raise DepsCheckError(f"{explicit} not found (--reviewed)")
    return []


def _load_pkg_json(workspace: Path) -> dict:
    p = workspace / "package.json"
    if not p.exists():
        raise DepsCheckError(f"{p} not found")
    return json.loads(p.read_text())


def _http_get_json(url: str, attempts: int = 0) -> dict | None:
    """GET a URL and return parsed JSON. Returns None on 404; raises on other errors.

    The registry's own errors (429, 5xx) and network drops are retried with a
    short backoff; the last one is raised, never read as a pass.
    """
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    attempts = attempts or REGISTRY_ATTEMPTS
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(req, timeout=REGISTRY_TIMEOUT_S * 3) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            if (exc.code != 429 and exc.code < 500) or attempt == attempts:
                raise
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            if retry_after and retry_after.isdigit() and int(retry_after) > 2 ** attempt:
                time.sleep(min(int(retry_after), 60))
                continue
        except (OSError, http.client.HTTPException):
            if attempt == attempts:
                raise
        time.sleep(min(2 ** attempt, 60))
    return None  # unreachable


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


# ── whole-lockfile audit (#749) ─────────────────────────────────────────────

def _lock_entries(workspace: Path) -> dict[tuple[str, str], dict]:
    """Every installed package in package-lock.json, keyed (name, version)."""
    lock = json.loads((workspace / "package-lock.json").read_text())
    entries: dict[tuple[str, str], dict] = {}
    for key, meta in (lock.get("packages") or {}).items():
        if not key or "node_modules/" not in key or meta.get("link"):
            continue
        name = meta.get("name") or key.rsplit("node_modules/", 1)[1]
        version = meta.get("version")
        if not version:
            continue
        e = entries.setdefault((name, version), {
            "name": name, "version": version, "install_script": False,
            "resolved": set(), "in_bundle": True,
        })
        e["install_script"] |= bool(meta.get("hasInstallScript"))
        e["in_bundle"] &= bool(meta.get("inBundle"))
        if meta.get("resolved"):
            e["resolved"].add(meta["resolved"])
    return entries


def _people(version_doc: dict) -> set[str]:
    """Maintainers on a version plus the person who published it. A trusted
    publish (npm OIDC from a CI run) is recorded as the CI identity, not a
    person; the human who approved it is counted instead."""
    names = {str(m.get("name")) for m in (version_doc.get("maintainers") or []) if m.get("name")}
    user = version_doc.get("_npmUser") or {}
    if user.get("trustedPublisher"):
        user = user.get("approver") or {}
    if user.get("name"):
        names.add(str(user["name"]))
    return names


def _maintainer_flag(name: str, meta: dict, now: datetime) -> dict | None:
    """Rule 7. People on a version published inside the window who are on no
    version published before it. npm records maintainers per published version
    only, so a maintainer added without publishing shows up at their first
    publish — the moment their code could reach a lockfile."""
    time_map = meta.get("time") or {}
    versions = meta.get("versions") or {}
    window_start = now - timedelta(days=MAINTAINER_WINDOW_DAYS)
    dated = sorted(
        (_parse_iso(time_map[v]), v) for v in versions if isinstance(time_map.get(v), str)
    )
    before = [v for t, v in dated if t < window_start]
    recent = [(t, v) for t, v in dated if t >= window_start]
    if not before:
        created = time_map.get("created")
        age = _age_days(created) if created else 0
        people = sorted(set().union(*(_people(versions[v]) for _, v in recent))) if recent else []
        return {
            "rule": "new package", "detail": ",".join(people),
            "message": f"{name}: created {age}d ago (< {MAINTAINER_WINDOW_DAYS}d) — no maintainer history to compare (rule: new package)",
        }
    known = set().union(*(_people(versions[v]) for v in before))
    added: set[str] = set()
    first_seen: dict[str, str] = {}
    for _, v in recent:
        for person in sorted(_people(versions[v]) - known - added):
            first_seen[person] = v
        added |= _people(versions[v]) - known
    if not added:
        return None
    where = ", ".join(f"{p} (first on {first_seen[p]})" for p in sorted(added))
    return {
        "rule": "maintainer change", "detail": ",".join(sorted(added)),
        "message": f"{name}: maintainer added in the last {MAINTAINER_WINDOW_DAYS}d — {where} (rule: maintainer change)",
    }


DL_CACHE_DAYS = 7
DL_CACHE_MIN = LOCK_DL_FLOOR * 10   # only counts far above the floor are reused


def _weekly_downloads(names: list[str], cache_dir: Path | None = None) -> dict[str, int]:
    """npm's last-week download counts. Unscoped names go 128 to a request (the
    bulk endpoint); scoped names one each (the bulk endpoint refuses them), one
    request at a time because npm's downloads service rate-limits hard.

    With a cache directory, a count of at least DL_CACHE_MIN is reused for
    DL_CACHE_DAYS days; a count near or under the floor is always asked again,
    so the cache can only save lookups, never pass a low-download package.
    """
    out: dict[str, int] = {}
    cache: dict[str, dict] = {}
    cache_file = cache_dir / "weekly-downloads.json" if cache_dir else None
    if cache_file and cache_file.exists():
        try:
            cache = json.loads(cache_file.read_text())
        except ValueError:
            cache = {}
    now = datetime.now(timezone.utc)
    for n in names:
        hit = cache.get(n) or {}
        try:
            # 7 to 13 days, spread by name, so the whole cache never expires in one run
            fresh = (now - _parse_iso(hit["at"])).days < DL_CACHE_DAYS + sum(n.encode()) % 7
        except (KeyError, ValueError, TypeError):
            fresh = False
        if fresh and int(hit.get("weekly") or 0) >= DL_CACHE_MIN:
            out[n] = int(hit["weekly"])

    todo = [n for n in names if n not in out]
    base = "https://api.npmjs.org/downloads/point/last-week/"
    unscoped = sorted(n for n in todo if not n.startswith("@"))
    scoped = sorted(n for n in todo if n.startswith("@"))
    chunks = [unscoped[i:i + 128] for i in range(0, len(unscoped), 128)]

    def bulk(chunk: list[str]) -> dict[str, int]:
        doc = _http_get_json(base + ",".join(chunk), DL_ATTEMPTS) or {}
        if len(chunk) == 1:  # one name returns the single-package shape
            doc = {chunk[0]: doc}
        return {n: int((doc.get(n) or {}).get("downloads") or 0) for n in chunk}

    def single(n: str) -> dict[str, int]:
        doc = _http_get_json(base + n, DL_ATTEMPTS) or {}
        return {n: int(doc.get("downloads") or 0)}

    # One request at a time, and every count is cached as it arrives (also when a
    # later lookup gives up), so a rate-limited run still saves its progress and
    # the next run carries on from there.
    fetched: dict[str, int] = {}
    try:
        for chunk in chunks:
            fetched.update(bulk(chunk))
        for n in scoped:
            fetched.update(single(n))
    finally:
        out.update(fetched)
        if cache_file:
            stamp = now.isoformat()
            for n, weekly in fetched.items():
                cache[n] = {"weekly": weekly, "at": stamp}
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(cache, indent=0, sort_keys=True))
    return out


def _is_reviewed(flag: dict, reviewed: list[dict]) -> bool:
    for r in reviewed:
        if r.get("package") != flag["package"] or r.get("rule") != flag["rule"]:
            continue
        if flag["rule"] in ("maintainer change", "new package") and r.get("detail") != flag["detail"]:
            continue
        if r.get("reason") and r.get("reviewed_on"):
            return True
    return False


def audit_lockfile(
    workspace: Path,
    reviewed: list[dict],
    skip: set[str] | None = None,
    now: datetime | None = None,
    cache_dir: Path | None = None,
) -> dict:
    """Rules 5–8 over every package in the lockfile (minus `skip`, "name@version")."""
    now = now or datetime.now(timezone.utc)
    entries = {k: e for k, e in _lock_entries(workspace).items()
               if f"{k[0]}@{k[1]}" not in (skip or set())}
    failures: list[str] = []
    flags: list[dict] = []
    for e in entries.values():
        bad = sorted(u for u in e["resolved"] if not u.startswith("https://registry.npmjs.org/"))
        if bad or (not e["resolved"] and not e["in_bundle"]):
            failures.append(
                f"{e['name']}@{e['version']}: lockfile fetches it from "
                f"{bad[0] if bad else 'no recorded address'}, not registry.npmjs.org (rule: lockfile source)"
            )
        if e["install_script"]:
            flags.append({"package": e["name"], "version": e["version"], "rule": "install script",
                          "detail": "", "message": f"{e['name']}@{e['version']}: runs a script when installed (rule: install script)"})

    names = sorted({n for n, _ in entries})

    def fetch(n: str):
        return n, _http_get_json(f"https://registry.npmjs.org/{urllib.parse.quote(n, safe='@')}")

    try:
        with ThreadPoolExecutor(max_workers=LOCK_WORKERS) as pool:
            docs = dict(pool.map(fetch, names))
        downloads = _weekly_downloads(names, cache_dir)
    except (OSError, http.client.HTTPException) as exc:
        reason = getattr(exc, "reason", None) or type(exc).__name__
        failures.append(f"lockfile audit: registry lookup failed — {reason} (rule: existence)")
        return {"audited": len(entries), "failures": failures, "flags": [], "unreviewed": []}

    for (name, version), e in sorted(entries.items()):
        meta = docs.get(name)
        if meta is None:
            failures.append(f"{name}@{version}: not present on registry.npmjs.org (rule: existence)")
            continue
        if version not in (meta.get("versions") or {}):
            failures.append(f"{name}@{version}: version not found on registry.npmjs.org (rule: existence)")
    for name in names:
        meta = docs.get(name)
        if meta is None:
            continue
        weekly = downloads.get(name, 0)
        if weekly < LOCK_DL_FLOOR:
            flags.append({"package": name, "version": "", "rule": "low downloads", "detail": "",
                          "message": f"{name}: {weekly} weekly downloads (< {LOCK_DL_FLOOR}) (rule: low downloads)"})
        mflag = _maintainer_flag(name, meta, now)
        if mflag:
            flags.append({"package": name, "version": "", **mflag})

    unreviewed = [f for f in flags if not _is_reviewed(f, reviewed)]
    for f in unreviewed:
        failures.append(f["message"] + " — not in deps-reviewed.json")
    return {"audited": len(entries), "failures": failures, "flags": flags, "unreviewed": unreviewed}


def run(
    workspace: Path,
    baseline_path: Path | None = None,
    lockfile: str = "all",
    reviewed_path: Path | None = None,
    cache_dir: Path | None = None,
    lockfile_only: bool = False,
) -> dict:
    workspace = Path(workspace).resolve()
    baseline_doc = _load_baseline_doc(baseline_path)
    baseline = {str(n) for n in (baseline_doc.get("packages") or baseline_doc.get("baseline") or [])}
    pkg = _load_pkg_json(workspace)

    deps: dict[str, str] = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    new_deps = {} if lockfile_only else {name: spec for name, spec in deps.items() if name not in baseline}

    failures: list[str] = []

    lock_fail = None if lockfile_only else _check_lockfile(workspace)
    if lock_fail:
        failures.append(lock_fail)

    for name, spec in sorted(new_deps.items()):
        try:
            fail = _check_package(name, spec)
        except urllib.error.URLError as exc:
            fail = f"{name}: registry lookup failed — {exc.reason} (rule: existence)"
        if fail:
            failures.append(fail)

    lock_audit: dict = {"audited": 0, "flags": [], "unreviewed": []}
    if lockfile != "off" and (workspace / "package-lock.json").exists():
        skip = {str(x) for x in (baseline_doc.get("lock") or [])} if lockfile == "new" else set()
        lock_audit = audit_lockfile(workspace, _load_reviewed(reviewed_path), skip, cache_dir=cache_dir)
        failures.extend(lock_audit["failures"])

    result = {
        "workspace":       str(workspace),
        "baseline_size":   len(baseline),
        "total_deps":      len(deps),
        "new_deps":        len(new_deps),
        "lockfile_scope":  lockfile,
        "lock_audited":    lock_audit["audited"],
        "lock_flags":      [f["message"] for f in lock_audit["flags"]],
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
    ap.add_argument("--lockfile", choices=("all", "new", "off"), default="all",
                    help="Whole-lockfile audit: every entry (all), entries not in the baseline's lock list (new), or none")
    ap.add_argument("--lockfile-only", action="store_true",
                    help="Skip rules 1-4 (the build's direct-dependency checks); for the factory's own dashboard")
    ap.add_argument("--reviewed", default=None, help="Path to deps-reviewed.json (override lookup)")
    ap.add_argument("--cache-dir", default=None,
                    help="Directory for the 7-day download-count cache (keep it outside the workspace)")
    args = ap.parse_args()

    try:
        result = run(
            Path(args.workspace),
            Path(args.baseline) if args.baseline else None,
            lockfile=args.lockfile,
            reviewed_path=Path(args.reviewed) if args.reviewed else None,
            cache_dir=Path(args.cache_dir) if args.cache_dir else None,
            lockfile_only=args.lockfile_only,
        )
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
                f"outside baseline ({result['baseline_size']} baseline); "
                f"lockfile audit ({result['lockfile_scope']}): {result['lock_audited']} package(s), "
                f"{len(result['lock_flags'])} reviewed flag(s)"
            )
        else:
            print(f"deps:existence FAIL — {len(result['failures'])} issue(s):")
            for f in result["failures"]:
                print(f"  - {f}")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
