#!/bin/sh
# Release this package: sh scripts/release.sh [dir]   (dir only in a repository of several packages, as common's packages/<dir>)
# Egildo runs this himself, signed in to npm with his security key: codeberg.org/BelType/decisions, project/a-release-moves-three-remotes-at-once.md, amended 2026-11-07.
# From a clean checkout of HEAD it installs, tests and publishes, then tags and pushes. The tag comes last, so a failed publish leaves no public tag with nothing on npm behind it.
set -eu
dir="${1:-}"; base="${dir:+packages/$dir/}"
cd "$(git rev-parse --show-toplevel)"
name=$(node -p "require('./${base}package.json').name")
v=$(node -p "require('./${base}package.json').version")
tag="${dir:+$dir-}v$v"
[ -z "$(git status --porcelain)" ] || { echo "uncommitted changes"; exit 1; }
grep -q "^## $v " "${base}CHANGELOG.md" || { echo "${base}CHANGELOG.md has no heading for $v"; exit 1; }
git rev-parse "$tag" >/dev/null 2>&1 && { echo "tag $tag exists"; exit 1; }
npm view "$name@$v" version >/dev/null 2>&1 && { echo "$name@$v is on npm already"; exit 1; }
npm whoami >/dev/null || { echo "not signed in to npm: npm login"; exit 1; }
root=$(pwd)
clean=$(mktemp -d)
trap 'cd "$root"; git worktree remove --force "$clean"' EXIT
git worktree add --detach --quiet "$clean" HEAD
cd "$clean"
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else npm ci; fi
pnpm licenses list --prod --json | grep -q '"AGPL' && { echo "a production dependency is under the AGPL"; exit 1; }
npm test
npm run --if-present test:browser
(cd "./$base" && npm publish --access public)
cd "$root"
git tag "$tag"
git push origin HEAD "$tag" || { echo "$name@$v is on npm, and the push failed: git push origin HEAD $tag"; exit 1; }
echo "published $name@$v and pushed $tag"
