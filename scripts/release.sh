#!/bin/sh
# Publishes the version in kelpi.plugin.json as a GitHub release that install.sh can fetch.
#
#   scripts/release.sh
#
# Bump "version" in kelpi.plugin.json and commit first. The package is built from the
# committed tree (git archive), so stray local files never end up in it.
set -eu

ASSET="kelpi-plugin-filetree.kelpi-plugin"

fail() { printf 'release: %s\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")/.."
for tool in git gh kelpi node shasum; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required."
done

version=$(node -p "require('./kelpi.plugin.json').version")
tag="v$version"

[ -z "$(git status --porcelain)" ] || fail "commit or stash your changes first."
git fetch --quiet --tags origin
if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
    fail "$tag already exists. Bump \"version\" in kelpi.plugin.json first."
fi
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || fail "push your commits first."

work=$(mktemp -d "${TMPDIR:-/tmp}/filetree-release.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
mkdir "$work/src" "$work/out"
git archive HEAD | tar -x -C "$work/src"

kelpi plugin validate "$work/src" >/dev/null || fail "the package does not validate."
kelpi plugin pack "$work/src" --out "$work/out/$ASSET" >/dev/null
(cd "$work/out" && shasum -a 256 "$ASSET" > "$ASSET.sha256")

git tag -a "$tag" -m "File Tree $version"
git push --quiet origin "$tag"
gh release create "$tag" "$work/out/$ASSET" "$work/out/$ASSET.sha256" \
    --verify-tag --title "File Tree $version" \
    --notes "Install with:

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/andymarcus/kelpi-plugin-filetree/main/install.sh | sh
\`\`\`

Or download \`$ASSET\` and run \`kelpi plugin install $ASSET --trust\`."

printf 'Released %s\n' "$tag"
