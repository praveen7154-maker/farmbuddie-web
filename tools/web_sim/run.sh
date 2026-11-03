#!/usr/bin/env bash
# The whole web admin panel, end to end in Chromium, with no Firebase project
# and no VPS: the pages run as deployed, the server's own modules run on
# in-memory stores. Needs: node 20+, the server's node_modules
# (cd server && npm install), Playwright with Chromium.
#   bash tools/web_sim/run.sh       -> $WEB_SIM_OUT/report.txt (default /tmp/web_sim)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.."
export WEB_SIM_OUT="${WEB_SIM_OUT:-${TMPDIR:-/tmp}/web_sim}"
mkdir -p "$WEB_SIM_OUT"
node tools/web_sim/run.js
