#!/bin/sh
# Release this package: sh scripts/release.sh [dir]   (dir only in a repository of several packages, as common's packages/<dir>)
# Checks that package.json and CHANGELOG.md agree, makes sure npm trusts release.yml (npm drops an unvalidated trusted publisher after 48 hours, so register it only now), then tags and pushes. The workflow publishes.
set -eu
dir="${1:-}"; base="${dir:+packages/$dir/}"
cd "$(git rev-parse --show-toplevel)"
name=$(node -p "require('./${base}package.json').name")
v=$(node -p "require('./${base}package.json').version")
slug=$(node -p "require('./${base}package.json').repository.url.replace(/^.*github.com\//,'').replace(/\.git\$/,'')")
tag="${dir:+$dir-}v$v"
git diff --quiet && git diff --cached --quiet || { echo "uncommitted changes"; exit 1; }
grep -q "^## $v " "${base}CHANGELOG.md" || { echo "${base}CHANGELOG.md has no heading for $v"; exit 1; }
git rev-parse "$tag" >/dev/null 2>&1 && { echo "tag $tag exists"; exit 1; }
npm view "$name@$v" version >/dev/null 2>&1 && { echo "$name@$v is on npm already"; exit 1; }
if npm view "$name" version >/dev/null 2>&1; then
  npm="npx -y npm@12 --loglevel=error"
  if ! $npm trust list "$name" 2>&1 | grep -q "$slug"; then
    echo "registering the trusted publisher for $name (2FA)"
    $npm trust github "$name" --file release.yml --repo "$slug" --allow-publish
  fi
else
  echo "$name is not on npm yet: publish $v by hand once (npm publish --access public), then use this script for the next version"; exit 1
fi
git tag "$tag"
git push origin HEAD "$tag"
echo "pushed $tag: the workflow publishes $name@$v in a minute or two"
