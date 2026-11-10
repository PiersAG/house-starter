#!/usr/bin/env bash
# Installs the pinned k6 (app-business-core #356; tool: CEO ruling on #705). Free and
# open source, no account. Pinned by version and checksum like every scanner: a tool
# that changes changes what passes. Prints nothing secret; needs no key.
#
#   bash scripts/load/install-k6.sh [install folder, default .load-tools]
#
# Adds the folder to GITHUB_PATH when run on GitHub; elsewhere set K6_BIN.
set -euo pipefail

K6_VERSION="2.3.0"
K6_SHA256="39c3117b6af817592dcd0ce4242105c0a7af10948c2a425306f0be8f7a8a8ab1"

dir="${1:-.load-tools}"
name="k6-v${K6_VERSION}-linux-amd64"
mkdir -p "$dir"
curl -fsSL --retry 3 --max-time 120 -o "$dir/$name.tar.gz" \
  "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/$name.tar.gz" < /dev/null
echo "$K6_SHA256  $dir/$name.tar.gz" | sha256sum --check --strict
tar -xzf "$dir/$name.tar.gz" -C "$dir" --strip-components=1 "$name/k6"
rm "$dir/$name.tar.gz"
"$dir/k6" version
if [ -n "${GITHUB_PATH:-}" ]; then realpath "$dir" >> "$GITHUB_PATH"; fi
