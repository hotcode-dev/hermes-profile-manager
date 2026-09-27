#!/usr/bin/env bash
# Zero Factory precommit — hermes-profile-manager
# TypeScript monorepo: formats with Prettier, typechecks with tsc, runs the
# Node built-in test suite (npm test). Build target is tsup (npm run build).
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Prettier is not a project dependency, so npx -y fetches it on demand.
# Format only the files staged for this commit (standard pre-commit behavior)
# so unrelated history is never drive-by reformatted. The .prettierrc.json
# pins the repo's existing style (single quotes, semicolons, trailing commas).
run_format() {
  echo "▶ Format (prettier, staged files only)"
  local staged
  staged="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null \
    | grep -E '\.(ts|tsx|js|jsx|json|md|yml|yaml|css)$' || true)"
  if [ -z "$staged" ]; then
    echo "  (no staged files to format)"
    return 0
  fi
  # shellcheck disable=SC2086
  npx -y prettier --write --ignore-unknown $staged
  # shellcheck disable=SC2086
  git add $staged
}

run_build() {
  echo "▶ Build/typecheck"
  if [ -d node_modules ] && [ -x node_modules/.bin/tsc ]; then
    # tsc --noEmit: project-level strict typecheck (tsconfig covers src + test).
    node_modules/.bin/tsc --noEmit
  else
    echo "  (typescript not installed — running npm install)"
    npm install
    node_modules/.bin/tsc --noEmit
  fi
}

run_test() {
  echo "▶ Tests"
  npm test
}

install_hook() {
  HOOK_DIR="$(git rev-parse --git-path hooks 2>/dev/null || echo ".git/hooks")"
  mkdir -p "$HOOK_DIR"
  # In a linked worktree, hooks live in the shared main .git directory (an
  # absolute path); a relative link from there would resolve to the main
  # checkout instead of this worktree, so link by absolute path in that case.
  case "$HOOK_DIR" in
    /*) TARGET="$ROOT_DIR/.zerofactory/precommit.sh" ;;
    *)  TARGET="../../.zerofactory/precommit.sh" ;;
  esac
  ln -sf "$TARGET" "$HOOK_DIR/pre-commit"
  chmod +x "$HOOK_DIR/pre-commit"
  echo "✓ Linked .zerofactory/precommit.sh -> $HOOK_DIR/pre-commit"
}

case "${1:-all}" in
  format)       run_format ;;
  build)        run_build ;;
  test)         run_test ;;
  install-hook) install_hook ;;
  all|*)
    run_format
    run_build
    run_test
    ;;
esac

echo "✓ Zero Factory precommit checks passed!"
