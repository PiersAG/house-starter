#!/usr/bin/env bash
# Regenerate deps-baseline.json from a checked-out house-starter package.json.
# Run this whenever house-starter's package.json changes and then rebuild the
# builder image so the new baseline is baked in.
#
# Usage:
#   ./regen-baseline.sh [path-to-house-starter-checkout]
#     default: ~/house-starter
#
# Spec: wiki/specs/stage0-deps-and-budget.md.

set -euo pipefail

HS="${1:-$HOME/house-starter}"
if [ ! -f "$HS/package.json" ]; then
    echo "ERROR: $HS/package.json not found. Point at your house-starter checkout." >&2
    exit 1
fi

OUT="$(dirname "$0")/deps-baseline.json"
COMMIT="$(git -C "$HS" rev-parse --short HEAD 2>/dev/null || echo unknown)"
NOW="$(date -u +%Y-%m-%d)"

python3 - "$HS/package.json" "$HS/package-lock.json" "$COMMIT" "$NOW" > "$OUT" <<'PY'
import json, sys
pkg_path, lock_path, commit, now = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
pkg = json.loads(open(pkg_path).read())
deps = sorted(set(list((pkg.get("dependencies") or {}).keys())
                  + list((pkg.get("devDependencies") or {}).keys())))
# #749: every name@version in house-starter's lockfile. The template's CI audits
# all of them on every run; the build loop's per-phase check audits only the
# entries an app adds (--lockfile new). A stale list only means more is audited.
lock = json.loads(open(lock_path).read()).get("packages") or {}
entries = sorted({
    f"{meta.get('name') or key.rsplit('node_modules/', 1)[1]}@{meta['version']}"
    for key, meta in lock.items()
    if "node_modules/" in key and not meta.get("link") and meta.get("version")
})
print(json.dumps({
    "source": "house-starter/package.json + package-lock.json",
    "generated_from_commit": commit,
    "generated_at": now,
    "note": "packages: union of dependencies + devDependencies names in house-starter's package.json. lock: every name@version in its package-lock.json, audited by house-starter's CI (#749). Regenerate via agents/build/docker/regen-baseline.sh whenever house-starter's package.json or lockfile changes.",
    "packages": deps,
    "lock": entries,
}, indent=2))
PY

echo "deps-baseline.json regenerated from $HS (commit $COMMIT):"
python3 -c "import json; d=json.load(open('$OUT')); print(f'  {len(d[\"packages\"])} package names, {len(d[\"lock\"])} lockfile entries')"
