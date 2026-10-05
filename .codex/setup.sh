#!/usr/bin/env bash

set -euo pipefail

readonly NIX_INSTALLER_VERSION="v3.21.0"
readonly NIX_INSTALLER_SHA256="c3cf066a28941e89fa1e38ed36f2acfc7479f9b088ddcf35160362a5ee89bd43"
readonly NIX_INSTALLER_URL="https://install.determinate.systems/nix/tag/${NIX_INSTALLER_VERSION}/nix-installer.sh"
REPO_ROOT="$(git rev-parse --show-toplevel)"
readonly REPO_ROOT
readonly NIX_ENV_FILE="${HOME}/.cache/wcacomptool-jpn-nix-env.sh"
cd "${REPO_ROOT}"
trap 'rm -f "${NIX_INSTALLER:-}" "${NIX_ENV_TMP:-}"' EXIT

# Nix can already be installed while missing from PATH in a fresh Codex shell.
if ! command -v nix >/dev/null 2>&1 && [[ -r /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]]; then
  # shellcheck disable=SC1091
  source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

if ! command -v nix >/dev/null 2>&1; then
  if [[ "$(uname -s)" != "Linux" || "$(id -u)" -ne 0 ]]; then
    echo "Automatic Nix installation is supported only in the root Linux environment used by Codex Cloud." >&2
    echo "Install Nix for this host, then run this setup script again." >&2
    exit 1
  fi

  NIX_INSTALLER="$(mktemp)"
  readonly NIX_INSTALLER

  echo "Nix was not found; installing it with installer ${NIX_INSTALLER_VERSION} for Codex Cloud."
  curl -fsSL "${NIX_INSTALLER_URL}" -o "${NIX_INSTALLER}"
  printf '%s  %s\n' "${NIX_INSTALLER_SHA256}" "${NIX_INSTALLER}" | sha256sum -c -
  bash "${NIX_INSTALLER}" install linux \
    --no-confirm \
    --prefer-upstream-nix \
    --diagnostic-endpoint "" \
    --init none \
    --extra-conf "experimental-features = nix-command flakes" \
    --extra-conf "sandbox = false"

  # shellcheck disable=SC1091
  source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

# Setup and agent commands run in separate shells. Save the pinned dev-shell
# environment before dependency installation so it survives interrupted setup.
mkdir -p "$(dirname "${NIX_ENV_FILE}")"
NIX_ENV_TMP="$(mktemp "${NIX_ENV_FILE}.XXXXXX")"
readonly NIX_ENV_TMP
nix print-dev-env --no-update-lock-file > "${NIX_ENV_TMP}"
# Make Web tools available in later shells without depending on a shellHook.
# Keep $PATH literal until the saved environment is sourced by a later shell.
# shellcheck disable=SC2016
printf 'export PATH=%q:$PATH\n' "${REPO_ROOT}/web/node_modules/.bin" >> "${NIX_ENV_TMP}"
chmod 0600 "${NIX_ENV_TMP}"
mv -f "${NIX_ENV_TMP}" "${NIX_ENV_FILE}"

touch "${HOME}/.bashrc"
readonly SOURCE_LINE="source \"${NIX_ENV_FILE}\""
grep -qxF "${SOURCE_LINE}" "${HOME}/.bashrc" || printf '%s\n' "${SOURCE_LINE}" >> "${HOME}/.bashrc"

# Match the toolchain and locked dependencies used by local development and CI.
nix develop --no-update-lock-file --command pnpm --dir web install --frozen-lockfile
nix develop --no-update-lock-file --command uv sync --project backend --locked
nix develop --no-update-lock-file --command pnpm --dir web exec playwright install --with-deps chromium

nix develop --no-update-lock-file --command node --version
nix develop --no-update-lock-file --command pnpm --version
nix develop --no-update-lock-file --command python --version
nix develop --no-update-lock-file --command uv --version
nix develop --no-update-lock-file --command uv run --project backend --locked python -c 'from ortools.sat.python import cp_model; print("OR-Tools import succeeded.")'
nix develop --no-update-lock-file --command pnpm --dir web exec playwright --version
nix develop --no-update-lock-file --command pnpm --dir web exec node --input-type=module -e 'import { chromium } from "@playwright/test"; const browser = await chromium.launch({ headless: true }); await browser.close(); console.log("Chromium headless launch succeeded.");'

echo "Codex Cloud setup complete."
