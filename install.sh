#!/bin/sh
# Installs the File Tree plugin into the running Kelpi.
#
#   curl -fsSL https://raw.githubusercontent.com/andymarcus/kelpi-plugin-filetree/main/install.sh | sh
#
# Set FILETREE_VERSION=v1.0.0 to install a specific release instead of the latest.
#
# Everything is wrapped in main() and only called on the last line, so a download cut off
# halfway runs nothing.
set -eu

REPO="andymarcus/kelpi-plugin-filetree"
ASSET="kelpi-plugin-filetree.kelpi-plugin"

say() { printf '%s\n' "$*"; }
fail() { printf 'File Tree install: %s\n' "$*" >&2; exit 1; }

sha256() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
    else fail "shasum or sha256sum is required to check the download."
    fi
}

main() {
    version="${FILETREE_VERSION:-latest}"
    if [ "$version" = "latest" ]; then
        base="https://github.com/$REPO/releases/latest/download"
    else
        base="https://github.com/$REPO/releases/download/$version"
    fi

    command -v curl >/dev/null 2>&1 || fail "curl is required."
    command -v kelpi >/dev/null 2>&1 || fail "the kelpi command was not found. Install Kelpi first: https://github.com/benfriebe/kelpi"
    # Commands read from /dev/null: under `curl | sh` the script itself is on stdin.
    kelpi plugin list </dev/null >/dev/null 2>&1 || fail "could not reach Kelpi. Start Kelpi, then run this again."

    tmp=$(mktemp -d "${TMPDIR:-/tmp}/kelpi-filetree.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT INT TERM

    say "Downloading File Tree ($version)..."
    curl -fsSL "$base/$ASSET" -o "$tmp/$ASSET" </dev/null || fail "download failed: $base/$ASSET"
    curl -fsSL "$base/$ASSET.sha256" -o "$tmp/$ASSET.sha256" </dev/null || fail "download failed: $base/$ASSET.sha256"

    expected=$(awk '{print $1}' "$tmp/$ASSET.sha256")
    actual=$(sha256 "$tmp/$ASSET")
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "the download does not match its checksum. Try again."

    kelpi plugin validate "$tmp/$ASSET" </dev/null >/dev/null || fail "the downloaded package is not a valid Kelpi plugin."

    say "Installing. Plugins run with your account's access; see the README for what this one reads."
    kelpi plugin install "$tmp/$ASSET" --trust </dev/null >/dev/null || fail "kelpi plugin install failed."

    say ""
    say "File Tree is installed."
    say "To show it: Settings > Plugins > Workbench views, then set a sidebar to File Tree."
}

main "$@"
