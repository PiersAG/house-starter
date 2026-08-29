#!/usr/bin/env python3
"""HARD.06 G2 - toolchain divergence guard.
Reads .node-version as the single source of truth and fails if any surface in the repo names a
divergent Node/npm version. Stdlib only. The build-container / NodeSource Dockerfile assertion is
intentionally NOT here - it is added by the sequenced container-bump step."""
import json, os, re, sys, glob

REPO = os.getcwd()
fail = []

nv_path = os.path.join(REPO, ".node-version")
if not os.path.isfile(nv_path):
    print("FAIL: .node-version missing (no canonical toolchain source)"); sys.exit(1)
nv = open(nv_path).read().strip()
m = re.match(r"^(\d+)\.\d+\.\d+$", nv)
if not m:
    print(f"FAIL: .node-version '{nv}' is not a full semver"); sys.exit(1)
CANON = m.group(1)

def pjs():
    for pj in glob.glob(os.path.join(REPO, "package.json")) + glob.glob(os.path.join(REPO, "*/package.json")):
        if "node_modules" not in pj:
            yield pj

for pj in pjs():
    rel = os.path.relpath(pj, REPO)
    d = json.load(open(pj))
    eng = d.get("engines") or {}
    node = eng.get("node")
    if node:
        majors = re.findall(r"(\d+)", node)
        if not majors or any(x != CANON for x in majors):
            fail.append(f"{rel}: engines.node '{node}' not locked to major {CANON}")
    npmv = eng.get("npm")
    if npmv:
        floor = re.findall(r"(\d+)", npmv)
        if floor and int(floor[0]) < 11:
            fail.append(f"{rel}: engines.npm '{npmv}' floor below 11")
    if d.get("volta"):
        fail.append(f"{rel}: volta block is a second source of truth - remove")
    if d.get("packageManager"):
        fail.append(f"{rel}: packageManager field is a second source of truth - remove")

for lf in glob.glob(os.path.join(REPO, "package-lock.json")) + glob.glob(os.path.join(REPO, "*/package-lock.json")):
    if "node_modules" in lf:
        continue
    try:
        lv = json.load(open(lf)).get("lockfileVersion")
        if lv != 3:
            fail.append(f"{os.path.relpath(lf, REPO)}: lockfileVersion {lv} != 3")
    except Exception as e:
        fail.append(f"{os.path.relpath(lf, REPO)}: unreadable ({e})")

wf = (glob.glob(os.path.join(REPO, ".github/workflows/*.yml")) +
      glob.glob(os.path.join(REPO, ".github/workflows/*.yaml")) +
      glob.glob(os.path.join(REPO, ".github/actions/**/action.yml"), recursive=True) +
      glob.glob(os.path.join(REPO, ".github/actions/**/action.yaml"), recursive=True))
for f in wf:
    rel = os.path.relpath(f, REPO)
    text = open(f).read()
    for i, ln in enumerate(text.splitlines(), 1):
        if re.search(r"^\s*node-version\s*:", ln):
            fail.append(f"{rel}:{i}: hardcoded 'node-version:' literal - use node-version-file: .node-version")
    if "actions/setup-node" in text and "node-version-file" not in text:
        fail.append(f"{rel}: uses actions/setup-node but never sets node-version-file")
    if re.search(r"\bnpm (ci|install|run|exec)\b|\bnpx \b", text) and "actions/setup-node" not in text:
        fail.append(f"{rel}: runs npm/npx with no actions/setup-node step (unpinned Node)")

for root, dirs, files in os.walk(REPO):
    dirs[:] = [d for d in dirs if d not in ("node_modules", ".git")]
    for f in files:
        rp = os.path.relpath(os.path.join(root, f), REPO)
        if re.search(r"(^|/)\.nvmrc$", rp):
            fail.append(f"{rp}: .nvmrc present - single source is .node-version, remove")
        if re.search(r"(^|/)\.tool-versions$", rp):
            fail.append(f"{rp}: .tool-versions present - remove")

planter = os.path.join(REPO, "scaffold/write-security-scan-workflow.sh")
if os.path.isfile(planter):
    for i, ln in enumerate(open(planter).read().splitlines(), 1):
        if re.search(r"node-version\s*:\s*['\"]?\d", ln):
            fail.append(f"scaffold/write-security-scan-workflow.sh:{i}: planter emits a hardcoded node-version - emit node-version-file: .node-version")

if fail:
    print("HARD.06 G2 toolchain guard: FAIL")
    for x in fail:
        print("  - " + x)
    sys.exit(1)
print(f"HARD.06 G2 toolchain guard: PASS (canonical Node major {CANON})")
