#!/usr/bin/env python3
"""Infrastructure pin guard (app-business-core #750).

"Pin every infrastructure dependency to a specific version so a deployment
cannot silently pull a different release through package-manager defaults."

Run from a repository root. Fails (exit 1) on any of:

  actions     a `uses:` that is not a full 40-character commit SHA. Exceptions:
              local actions (`./...`) and PiersAG's own reusable workflows,
              which are called at their release tags and moved only by the
              shared-workflow procedure (operating contract § Shared workflow
              versioning).
  runner      `runs-on: <name>-latest` — the image moves under the job.
  python      `python-version:` that is not an exact X.Y.Z release.
  pip         a `pip install` of a package by name without `==X.Y.Z`
              (installing from a requirements file is checked by `requirements`).
  npm-global  `npm install -g <pkg>` without an exact `@X.Y.Z`.
  npm         a package.json dependency, devDependency or override that is not an
              exact version (no ^ ~ > < * x, ranges or tags).
  docker      a Dockerfile `FROM` without an `@sha256:` digest.
  requirements  a requirements*.txt line without `==`, or (when the file is
              hashed) without a `--hash`.

Usage: check-pins.py [--root DIR] [--skip PATH ...]
Stdlib only. house-starter scripts/check-pins.py and app-business-core
scripts/check_pins.py are the same file.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{40}$")
EXACT = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
OWN = re.compile(r"^PiersAG/[\w.-]+/\.github/workflows/[\w.-]+\.ya?ml$")
SKIP_DIRS = {"node_modules", ".git", ".next", "dist", "build", "coverage"}


def _files(root: Path, pattern: str):
    for p in sorted(root.rglob(pattern)):
        if not SKIP_DIRS.intersection(p.relative_to(root).parts):
            yield p


def check_workflow_text(rel: str, text: str) -> list[str]:
    out: list[str] = []
    for i, line in enumerate(text.splitlines(), 1):
        code = line.split(" #", 1)[0]
        m = re.match(r"\s*(?:-\s+)?uses:\s*['\"]?([^\s'\"]+)", code)
        if m:
            ref = m.group(1)
            if not ref.startswith("./") and not ref.startswith("docker://"):
                target, _, version = ref.partition("@")
                if not version:
                    out.append(f"{rel}:{i}: actions: `{ref}` has no version")
                elif not SHA.match(version) and not OWN.match(target):
                    out.append(f"{rel}:{i}: actions: `{ref}` is not pinned to a commit SHA")
            elif ref.startswith("docker://") and "@sha256:" not in ref:
                out.append(f"{rel}:{i}: docker: `{ref}` has no @sha256 digest")
        m = re.search(r"\bruns-on:\s*['\"]?([\w.-]+)", code)
        if m and m.group(1).endswith("-latest"):
            out.append(f"{rel}:{i}: runner: `runs-on: {m.group(1)}` moves under the job — name the image")
        m = re.search(r"\bpython-version:\s*['\"]?([^\s'\"]+)", code)
        if m and not re.fullmatch(r"\d+\.\d+\.\d+", m.group(1)):
            out.append(f"{rel}:{i}: python: `python-version: {m.group(1)}` is not an exact release")
        out += check_command(rel, i, code)
    return out


def check_command(rel: str, i: int, code: str) -> list[str]:
    out: list[str] = []
    for m in re.finditer(r"\bpip3?\s+install\b([^\n;&|<>]*)", code):
        args = m.group(1).split()
        skip_next = False
        for a in args:
            if skip_next:
                skip_next = False
                continue
            if a in ("-r", "--requirement", "-c", "--constraint"):
                skip_next = True
                continue
            if a.startswith("-") or a.startswith("$"):
                continue
            if not re.fullmatch(r"[A-Za-z0-9_.\[\]-]+==\d[\w.]*", a.strip("'\"")):
                out.append(f"{rel}:{i}: pip: `{a}` is installed without an exact ==version")
    for m in re.finditer(r"\bnpm\s+(?:install|i)\s+(?:-g|--global)\b([^\n;&|<>]*)", code):
        for a in m.group(1).split():
            if a.startswith("-"):
                continue
            at = a.rfind("@")
            version = a[at + 1:] if at > 0 else ""
            if not EXACT.match(version):
                out.append(f"{rel}:{i}: npm-global: `{a}` is installed without an exact @version")
    return out


def check_package_json(rel: str, data: dict) -> list[str]:
    out: list[str] = []
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        for name, spec in (data.get(section) or {}).items():
            if not EXACT.match(str(spec)):
                out.append(f"{rel}: npm: {section}.{name} = `{spec}` is not an exact version")

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, f"{path}.{k}")
        elif not EXACT.match(str(node)) and not str(node).startswith("$"):
            out.append(f"{rel}: npm: {path} = `{node}` is not an exact version")

    walk(data.get("overrides") or {}, "overrides")
    return out


def check_dockerfile(rel: str, text: str) -> list[str]:
    out: list[str] = []
    stages: set[str] = set()
    for i, line in enumerate(text.splitlines(), 1):
        m = re.match(r"\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?", line, re.I)
        if m:
            image = m.group(1)
            if image.lower() not in stages and image != "scratch" and "@sha256:" not in image:
                out.append(f"{rel}:{i}: docker: `FROM {image}` has no @sha256 digest")
            if m.group(2):
                stages.add(m.group(2).lower())
        out += check_command(rel, i, line)
    return out


def check_requirements(rel: str, text: str) -> list[str]:
    out: list[str] = []
    hashed = "--hash=" in text
    lines = text.replace("\\\n", " ").splitlines()
    for i, line in enumerate(lines, 1):
        req = line.split("#", 1)[0].strip()
        if not req or req.startswith("-"):
            continue
        if not re.match(r"^[A-Za-z0-9_.\[\]-]+==\d", req):
            out.append(f"{rel}: requirements: `{req.split()[0]}` is not pinned with ==")
        elif hashed and "--hash=" not in req:
            out.append(f"{rel}: requirements: `{req.split()[0]}` has no --hash in a hashed file")
    return out


def run(root: Path, skip: set[str]) -> list[str]:
    failures: list[str] = []

    def rel(p: Path) -> str:
        return p.relative_to(root).as_posix()

    workflows = [*_files(root / ".github", "*.yml"), *_files(root / ".github", "*.yaml")] if (root / ".github").is_dir() else []
    for p in workflows:
        if rel(p) not in skip:
            failures += check_workflow_text(rel(p), p.read_text())
    for p in _files(root, "package.json"):
        if rel(p) not in skip:
            failures += check_package_json(rel(p), json.loads(p.read_text()))
    for p in _files(root, "*Dockerfile*"):
        if rel(p) not in skip and p.is_file():
            failures += check_dockerfile(rel(p), p.read_text())
    for p in _files(root, "*requirements*.txt"):
        if rel(p) not in skip:
            failures += check_requirements(rel(p), p.read_text())
    return failures


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--skip", nargs="*", default=[], help="Repo-relative files not checked (with the reason in the caller)")
    args = ap.parse_args()
    failures = run(Path(args.root).resolve(), set(args.skip))
    if failures:
        print(f"Infrastructure pins: FAIL — {len(failures)} unpinned:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("Infrastructure pins: PASS (actions by commit, runners named, exact Python/npm/pip versions, image digests)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
