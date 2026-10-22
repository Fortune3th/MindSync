#!/bin/sh
# Rebuild the published branch from the current commit and push it to a remote.
# Documentation, design prototypes, and local planning notes are never included.
#
#   sh scripts/release/publish-github.sh
#   MINDSYNC_RELEASE_REMOTE=gitlab sh scripts/release/publish-github.sh
set -eu
cd "$(dirname "$0")/../.."

REMOTE=${MINDSYNC_RELEASE_REMOTE:-origin}
TARGET=${MINDSYNC_RELEASE_BRANCH:-release}
VERSION=$(node -p "JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version")

WORKTREE=$(mktemp -d "${TMPDIR:-/tmp}/mindsync-release.XXXXXX")
cleanup() {
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
}
trap cleanup EXIT

git worktree add --detach "$WORKTREE" HEAD >/dev/null
cd "$WORKTREE"
git checkout --orphan "release-publish-$$" >/dev/null 2>&1
git rm -r --cached . -q
git add manifest.json package.json package-lock.json esbuild.config.mjs tsconfig.json \
        styles.css src tests assets server docker scripts dev \
        .github .gitea .woodpecker library/example.env \
        README.md LICENSE CHANGELOG.md .gitignore .dockerignore .env.example Tiltfile
git commit -q -m "release: $VERSION"
git push --force "$REMOTE" "HEAD:refs/heads/$TARGET"
echo "Published $VERSION to $REMOTE/$TARGET"
