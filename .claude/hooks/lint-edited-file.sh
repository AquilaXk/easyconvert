#!/usr/bin/env bash
# PostToolUse hook: lint the single TS/JS file Claude just edited.
# Exit 2 feeds ESLint errors back to Claude; other files pass through untouched.
set -euo pipefail

file_path="$(jq -r '.tool_input.file_path // empty')"

case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac

[ -f "$file_path" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}"

# Skip when dependencies are not installed yet (e.g. a fresh worktree).
[ -x node_modules/.bin/eslint ] || exit 0

if ! output="$(npx --no-install eslint --max-warnings=-1 "$file_path" 2>&1)"; then
  echo "ESLint failed for $file_path:" >&2
  echo "$output" >&2
  exit 2
fi
