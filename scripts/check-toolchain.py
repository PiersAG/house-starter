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

# --- G4: minimum-engine check ---------------------------------------------
# Fail if any dependency declares engines.node/npm requiring a major GREATER than
# the pin (a dependency that has outgrown our toolchain). Read from the lockfile,
# so no install needed. A dependency needing an OLDER engine is fine (not flagged).
NPM_PIN_MAJOR = 11

def _min_required_major(rng):
    toks = re.findall(r"\d+(?:\.\d+){0,2}", rng or "")
    majors = [int(t.split(".")[0]) for t in toks]
    return min(majors) if majors else None

for lf in glob.glob(os.path.join(REPO, "package-lock.json")) + glob.glob(os.path.join(REPO, "*/package-lock.json")):
    if "node_modules" in lf:
        continue
    rel = os.path.relpath(lf, REPO)
    try:
        pkgs = (json.load(open(lf)).get("packages") or {})
    except Exception as e:
        fail.append(f"{rel}: unreadable for engine check ({e})"); continue
    for path, meta in pkgs.items():
        if not path:                       # "" == the root package (ours) - skip
            continue
        eng = (meta or {}).get("engines")
        if not isinstance(eng, dict):
            continue
        dep = path.split("node_modules/")[-1]
        nr = eng.get("node")
        if nr:
            mn = _min_required_major(nr)
            if mn is not None and mn > int(CANON):
                fail.append(f"{rel}: dependency '{dep}' requires node '{nr}' (needs >= major {mn}) > pin {CANON}")
        npr = eng.get("npm")
        if npr:
            mn = _min_required_major(npr)
            if mn is not None and mn > NPM_PIN_MAJOR:
                fail.append(f"{rel}: dependency '{dep}' requires npm '{npr}' (needs >= major {mn}) > pin {NPM_PIN_MAJOR}")

if fail:
    print("HARD.06 toolchain guard: FAIL")
    for x in fail:
        print("  - " + x)
    sys.exit(1)
print(f"HARD.06 toolchain guard: PASS (canonical Node major {CANON})")
