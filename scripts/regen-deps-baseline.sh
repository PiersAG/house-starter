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

python3 - "$HS/package.json" "$COMMIT" "$NOW" > "$OUT" <<'PY'
import json, sys
pkg_path, commit, now = sys.argv[1], sys.argv[2], sys.argv[3]
pkg = json.loads(open(pkg_path).read())
deps = sorted(set(list((pkg.get("dependencies") or {}).keys())
                  + list((pkg.get("devDependencies") or {}).keys())))
print(json.dumps({
    "source": "house-starter/package.json",
    "generated_from_commit": commit,
    "generated_at": now,
    "note": "Union of dependencies + devDependencies names in house-starter's package.json at generation time. Regenerate via agents/build/docker/regen-baseline.sh whenever house-starter's package.json changes.",
    "packages": deps,
}, indent=2))
PY

echo "deps-baseline.json regenerated from $HS (commit $COMMIT):"
python3 -c "import json; d=json.load(open('$OUT')); print(f'  {len(d[\"packages\"])} package names')"
