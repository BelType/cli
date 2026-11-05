#!/bin/sh
# Release this package: sh scripts/release.sh [dir]   (dir only in a repository of several packages, as common's packages/<dir>)
# Checks that package.json and CHANGELOG.md agree, then tags and pushes. The workflow publishes with the repository's NPM_TOKEN secret.
set -eu
dir="${1:-}"; base="${dir:+packages/$dir/}"
cd "$(git rev-parse --show-toplevel)"
name=$(node -p "require('./${base}package.json').name")
v=$(node -p "require('./${base}package.json').version")
tag="${dir:+$dir-}v$v"
git diff --quiet && git diff --cached --quiet || { echo "uncommitted changes"; exit 1; }
grep -q "^## $v " "${base}CHANGELOG.md" || { echo "${base}CHANGELOG.md has no heading for $v"; exit 1; }
git rev-parse "$tag" >/dev/null 2>&1 && { echo "tag $tag exists"; exit 1; }
npm view "$name@$v" version >/dev/null 2>&1 && { echo "$name@$v is on npm already"; exit 1; }
git tag "$tag"
git push origin HEAD "$tag"
echo "pushed $tag: the workflow publishes $name@$v in a minute or two"
