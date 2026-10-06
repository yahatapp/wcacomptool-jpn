#!/usr/bin/env bash
set -euo pipefail

task_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$task_project_dir"

# Use the project's pinned tools when Nix is installed. This also works without
# Nix (for example, Git Bash on Windows) when Node.js and pnpm are on PATH.
if command -v nix >/dev/null 2>&1 && [[ -z "${IN_NIX_SHELL:-}" ]]; then
  exec nix develop --no-update-lock-file --command bash "$task_project_dir/setup.sh" "$@"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  echo 'Node.js 22.12以上とpnpmを用意するか、Nixをインストールしてください。' >&2
  exit 1
fi

pnpm --dir web install --frozen-lockfile
# Playwright keeps the version-matched browser in its persistent OS cache.
# Re-running setup reuses an installed browser and installs a new version after
# a Playwright upgrade. Use the default cache, also used by test:browser and CI.
pnpm --dir web exec playwright install chromium

echo 'セットアップが完了しました。pnpm --dir web dev で起動できます。'
echo 'ブラウザ検証: pnpm --dir web test:browser'
