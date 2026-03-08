#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="wayland-autoclicker@anotherone"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
BUNDLE_DIR="${ROOT_DIR}/build"
BUNDLE_PATH="${BUNDLE_DIR}/${UUID}.shell-extension.zip"
SCHEMA_PATH="schemas/org.gnome.shell.extensions.wayland-autoclicker.gschema.xml"

glib-compile-schemas "${ROOT_DIR}/schemas"

mkdir -p "${BUNDLE_DIR}"

if [[ -L "${TARGET_DIR}" && "$(realpath "${TARGET_DIR}")" == "${ROOT_DIR}" ]]; then
    rm "${TARGET_DIR}"
fi

(
    cd "${ROOT_DIR}"
    gnome-extensions pack . \
        --force \
        --quiet \
        --out-dir "${BUNDLE_DIR}" \
        --schema "${SCHEMA_PATH}"
)

gnome-extensions install --force "${BUNDLE_PATH}"
gnome-extensions disable "${UUID}" >/dev/null 2>&1 || true

if gnome-extensions enable "${UUID}" >/dev/null 2>&1; then
    echo "Installed and enabled ${UUID}"
    exit 0
fi

CURRENT_ENABLED="$(gsettings get org.gnome.shell enabled-extensions)"

if [[ "${CURRENT_ENABLED}" != *"'${UUID}'"* ]]; then
    if [[ "${CURRENT_ENABLED}" == "[]" || "${CURRENT_ENABLED}" == "@as []" ]]; then
        UPDATED_ENABLED="['${UUID}']"
    else
        UPDATED_ENABLED="${CURRENT_ENABLED%]}"
        UPDATED_ENABLED="${UPDATED_ENABLED}, '${UUID}']"
    fi

    gsettings set org.gnome.shell enabled-extensions "${UPDATED_ENABLED}"
fi

echo "Installed ${UUID}. GNOME Shell did not rescan extensions in the current session, so it was queued for the next login."
