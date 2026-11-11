#!/usr/bin/env bash
# What the deploy workflow asks of a commit and of an image (docs/policy-decisions.md, entry 243): the required check `verify` of CI
# succeeded for the commit, and the files shipped with an image are those of the commit the image was built from.
#
#   ci-commit-gate.sh state <commit>               success | skipped | failure | pending | none: CI for the commit (see `state` below)
#   ci-commit-gate.sh wait <commit>                wait until CI for the commit finishes; exit 0 only for success
#   ci-commit-gate.sh image-commit <repo> <ref>    the commit recorded in the image's revision label (empty for an image without one)
#   ci-commit-gate.sh verified-by <commit>         the commit whose `verify` success covers the image of <commit>: itself, or a later commit
#                                                  of the current branch whose image contents are the same (a push that changes only
#                                                  documentation or tests builds no image, so the fix of a failing test never gets one)
#   ci-commit-gate.sh deploy-commit <web repo> <worker repo> <ref>
#                                                  what the deploy job checks out: prints commit=<commit the images were built from> and
#                                                  verified_by=<commit whose CI succeeded>, or exits 1 with the reason
#   ci-commit-gate.sh current-main <repo>          the commit of the build the main tag names; empty when there is no main tag, an error otherwise
#   ci-commit-gate.sh is-behind <commit> <other>   exit 0 when <other> is a later commit than <commit> on the same history, 1 when not, 2 when a commit is missing
#
# The check is the latest `verify` run recorded by GitHub Actions for the commit (the required check of CI, .github/workflows/ci.yml).
# `gh` reads it with GH_TOKEN (the job needs `checks: read`); the later-commit search needs a clone with its history.
#
# Environment: GITHUB_REPOSITORY (owner/name), GH_TOKEN; GATE_POLL_SECONDS (30) and GATE_TIMEOUT_SECONDS (5400) for `wait`;
#              GATE_MAX_LOOKUPS (40) bounds the check runs `verified-by` reads.
set -euo pipefail

REVISION_LABEL='org.opencontainers.image.revision'
CHECK_NAME='verify'
POLL_SECONDS="${GATE_POLL_SECONDS:-30}"
TIMEOUT_SECONDS="${GATE_TIMEOUT_SECONDS:-5400}"
MAX_LOOKUPS="${GATE_MAX_LOOKUPS:-40}"
COMMIT_PATTERN='^[0-9a-f]{40}$'
IMAGE_REF_PATTERN='^(main|sha-[0-9a-f]{40})$'

die() { printf 'ci-commit-gate: %s\n' "$*" >&2; exit 1; }
need_commit() { [[ "${1:-}" =~ $COMMIT_PATTERN ]] || die "'${1:-}' is not a full 40 character commit"; }

# The state of CI for a commit, from the latest check runs of GitHub Actions:
#   success   `verify` succeeded AND the heavy jobs ran and passed: checks, integration, every tests (i/n) and conformance (i/n) job (at
#             least one of each). `verify` alone is not enough: for a push that changes documentation only, ci.yml skips every heavy job
#             and `verify` succeeds with all of them skipped, which says nothing about code.
#   skipped   `verify` succeeded but a heavy job is missing, skipped or did not succeed
#   failure   `verify` finished without success
#   pending   `verify` has not finished
#   none      no `verify` run yet
state() { # state <commit>
  local commit="$1" url
  need_commit "$commit"
  url="repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY}/commits/$commit/check-runs?filter=latest&per_page=100"
  gh api "$url" | jq -r --arg check "$CHECK_NAME" '
    [.check_runs[] | select(.app.slug == "github-actions")] as $runs
    | ($runs | map(select(.name == $check)) | sort_by(.started_at) | last) as $verify
    | ($runs | map(select(.name == "checks" or .name == "integration" or (.name | startswith("tests (")) or (.name | startswith("conformance ("))))) as $heavy
    | if $verify == null then "none"
      elif $verify.status != "completed" then "pending"
      elif $verify.conclusion != "success" then "failure"
      elif ([$heavy[] | select(.name == "checks")] | length) >= 1
        and ([$heavy[] | select(.name == "integration")] | length) >= 1
        and ([$heavy[] | select(.name | startswith("tests ("))] | length) >= 1
        and ([$heavy[] | select(.name | startswith("conformance ("))] | length) >= 1
        and ($heavy | all(.status == "completed" and .conclusion == "success")) then "success"
      else "skipped" end'
}

wait_for() { # wait_for <commit>
  local commit="$1" waited=0 current
  need_commit "$commit"
  while :; do
    current="$(state "$commit")"
    case "$current" in
      success) echo "CI: the check $CHECK_NAME of $commit succeeded and its heavy jobs passed"; return 0 ;;
      failure) die "the check $CHECK_NAME of $commit did not succeed: nothing is promoted" ;;
      skipped) die "the check $CHECK_NAME of $commit succeeded but CI ran no successful heavy job (checks, tests, conformance, integration) for it: nothing is promoted" ;;
    esac
    if [ "$waited" -ge "$TIMEOUT_SECONDS" ]; then
      die "the check $CHECK_NAME of $commit was still $current after ${TIMEOUT_SECONDS}s: run this job again once CI has finished"
    fi
    echo "CI: the check $CHECK_NAME of $commit is $current; waiting"
    sleep "$POLL_SECONDS"
    waited=$((waited + POLL_SECONDS))
  done
}

image_commit() { # image_commit <repo> <ref>
  local repo="$1" ref="$2"
  [[ "$ref" =~ $IMAGE_REF_PATTERN ]] || die "the image ref must be main or sha-<40 hex characters>"
  docker buildx imagetools inspect --format '{{json .Image}}' "$repo:$ref" \
    | jq -r --arg label "$REVISION_LABEL" '.config.Labels[$label] // empty'
}

# True when the two commits differ in a file an image contains: the files of the `paths` filter of the push trigger in
# .github/workflows/deploy-oci.yml (everything but docs/, tests/ and Markdown; THIRD_PARTY_NOTICES.md, which the worker image copies, and
# docs/legal/, which the web image copies and src/lib/legal/texts.ts imports, are taken back in). tests/ci-commit-gate.test.ts keeps
# this list and that filter in step.
image_differs() { # image_differs <commit> <commit>
  ! git diff --quiet "$1" "$2" -- . ':(exclude,glob)docs/**' ':(exclude,glob)tests/**' ':(exclude,glob)**/*.md' \
    || ! git diff --quiet "$1" "$2" -- THIRD_PARTY_NOTICES.md docs/legal
}

# The commit of the build that `main` names, empty when the repository has no `main` tag yet. Any other failure (credentials, the
# registry) is an error, never "no main": a promote that believed it had no main could move the tag back over a newer build.
current_main() { # current_main <repo>
  local repo="$1" output
  if output="$(docker buildx imagetools inspect --format '{{json .Image}}' "$repo:main" 2>&1)"; then
    printf '%s\n' "$output" | jq -r --arg label "$REVISION_LABEL" '.config.Labels[$label] // empty'
    return 0
  fi
  case "$output" in
    *': not found'* | *MANIFEST_UNKNOWN* | *NAME_UNKNOWN*) return 0 ;;
  esac
  printf '%s\n' "$output" >&2
  die "could not read the main tag of $repo"
}

verified_by() { # verified_by <commit>
  local commit="$1" candidate lookups=0
  need_commit "$commit"
  git cat-file -e "$commit^{commit}" 2> /dev/null || die "the commit $commit is not in this clone (fetch with the full history)"
  # The commit itself first, then the later ones newest first: the first success among the commits with the same image contents is
  # the one that vouches for the image.
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ "$candidate" != "$commit" ] && image_differs "$commit" "$candidate"; then continue; fi
    lookups=$((lookups + 1))
    [ "$lookups" -le "$MAX_LOOKUPS" ] || break
    if [ "$(state "$candidate")" = success ]; then printf '%s\n' "$candidate"; return 0; fi
  done < <(printf '%s\n' "$commit"; git rev-list --first-parent HEAD "^$commit" 2> /dev/null || true)
  return 1
}

deploy_commit() { # deploy_commit <web repo> <worker repo> <ref>
  local web="$1" worker="$2" ref="$3" commit web_commit worker_commit verified
  [[ "$ref" =~ $IMAGE_REF_PATTERN ]] || die "the image ref must be main or sha-<40 hex characters>"
  web_commit="$(image_commit "$web" "$ref")"
  worker_commit="$(image_commit "$worker" "$ref")"
  if [[ "$ref" == sha-* ]]; then
    commit="${ref#sha-}"
    # An image built before the label existed has none; the commit named by its tag is then the only record.
    for recorded in "$web_commit" "$worker_commit"; do
      [ -z "$recorded" ] || [ "$recorded" = "$commit" ] || die "the image $ref records the commit $recorded: the tag was moved"
    done
  else
    commit="$web_commit"
    [ -n "$commit" ] || die "the web image main records no commit (it predates the revision label): deploy it as sha-<commit>"
    [ "$worker_commit" = "$commit" ] || die "the web image main was built from $commit but the worker image main from ${worker_commit:-no recorded commit}"
  fi
  need_commit "$commit"
  verified="$(verified_by "$commit")" \
    || die "no successful $CHECK_NAME check covers the image built from $commit: the images are not deployed until CI succeeds for it"
  printf 'commit=%s\nverified_by=%s\n' "$commit" "$verified"
}

# Exit 0 when <other> is a later commit than <commit>, 1 when it is not, 2 when either commit is not in this clone.
is_behind() { # is_behind <commit> <other>
  need_commit "$1"
  need_commit "$2"
  local commit
  for commit in "$1" "$2"; do
    git cat-file -e "$commit^{commit}" 2> /dev/null || { printf 'ci-commit-gate: the commit %s is not in this clone\n' "$commit" >&2; exit 2; }
  done
  [ "$1" != "$2" ] && git merge-base --is-ancestor "$1" "$2"
}

case "${1:-}" in
  state) state "${2:-}" ;;
  wait) wait_for "${2:-}" ;;
  image-commit) image_commit "${2:?repo}" "${3:?ref}" ;;
  verified-by) verified_by "${2:-}" ;;
  deploy-commit) deploy_commit "${2:?web repo}" "${3:?worker repo}" "${4:?ref}" ;;
  current-main) current_main "${2:?repo}" ;;
  is-behind) is_behind "${2:-}" "${3:-}" ;;
  *) die "usage: ci-commit-gate.sh state|wait|image-commit|current-main|verified-by|deploy-commit|is-behind ..." ;;
esac
