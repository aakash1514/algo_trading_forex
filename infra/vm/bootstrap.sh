#!/usr/bin/env bash
# A fresh production database: the sequence of docs/DEPLOY.md section 4 with the ops image of the tag.
# Root, on the host, through SSM (the history import alone takes 10+ minutes):
#
#   bash infra/vm/run-on-host.sh infra/vm/bootstrap.sh --timeout 7200 -- <IMAGE_TAG>
#
#   1. bootstrap        migrations, instruments; stops at "history loaded" on an empty database (expected)
#   2. history          data:transfer check; only if that fails, data:transfer import from
#                       /opt/forexedge/data/history-transfer (fetch.sh --history), which refuses a partial target
#   3. check            data:import --check-only (rows per pair-year, aggregates vs M1)
#   4. validate         data:validate (FRED fixings, gold extremes)
#   5. bootstrap        every step: the ML, research and replay logins, the demo users
#
# Stops at the first failure. Idempotent: on a database that is already complete every step passes and
# changes nothing. Refuses a tag other than the staged commit and any secret still a placeholder (the demo
# users need theirs). Each step's full output goes to /opt/forexedge/logs/bootstrap-<time>-<step>.log (root
# only), redacted like everything printed; the output shows one line per step (the [bootstrap] lines for
# steps 1 and 5, the last 3 lines for the others) and the last 20 lines of a step that fails.
#
# Self-contained (run-on-host.sh sends one file): the block shared with stack.sh is a copy, and the host
# tests fail if the two differ. FOREXEDGE_ROOT overrides /opt/forexedge (tests).
set -euo pipefail

ROOT="${FOREXEDGE_ROOT:-/opt/forexedge}"
HISTORY_DIR="$ROOT/data/history-transfer"
LOG_DIR="$ROOT/logs"

# ── shared with stack.sh (kept identical; the host tests compare the two blocks) ──────────────────
COMPOSE_FILE="$ROOT/infra/docker-compose.prod.yml"
ENV_FILE="$ROOT/infra/.env.prod"
DEMO_ENV_FILE="$ROOT/infra/.env.demo-users"
STAGED_FILE="$ROOT/staged-commit"
PLACEHOLDER="__SET_WITH_SET_SECRET__"
DOCKER_CONFIG=""

die() {
  printf '%s: %s\n' "$(basename "$0")" "$*" >&2
  exit 1
}
cleanup() { if [[ -n "$DOCKER_CONFIG" ]]; then rm -rf "$DOCKER_CONFIG"; fi; }
trap cleanup EXIT

# The value of NAME in an env file (make-env.sh / set-secret.sh format: NAME=value or NAME='value')
env_value() {
  awk -v n="$1" 'index($0, n "=") == 1 { v = substr($0, length(n) + 2); if (v ~ /^\x27.*\x27$/) v = substr(v, 2, length(v) - 2); print v; exit }' "$2"
}

# Every secret value of the env files (names ending in _PASS, _SECRET, _KEY, _EMAIL), longest first,
# placeholders and empty values left out
secret_values() {
  local f
  for f in "$ENV_FILE" "$DEMO_ENV_FILE"; do
    [[ -f "$f" ]] || continue
    awk -F= '$1 ~ /^[A-Z][A-Z0-9_]*(_PASS|_SECRET|_KEY|_EMAIL)$/ { v = substr($0, length($1) + 2); if (v ~ /^\x27.*\x27$/) v = substr(v, 2, length(v) - 2); print v }' "$f"
  done | awk -v p="$PLACEHOLDER" 'length($0) > 0 && $0 != p { print length($0) "\t" $0 }' | sort -rn | cut -f2-
}

# stdin to stdout with every secret value replaced by *** (literal matching, no regex)
redact() {
  local secrets
  secrets="$(mktemp)"
  secret_values >"$secrets"
  awk 'FNR == NR { s[++n] = $0; next }
    { line = $0
      for (i = 1; i <= n; i++) {
        out = ""
        while ((p = index(line, s[i])) > 0) { out = out substr(line, 1, p - 1) "***"; line = substr(line, p + length(s[i])) }
        line = out line
      }
      print line; fflush() }' "$secrets" -
  rm -f "$secrets"
}

# Runs a command with its stdout and stderr redacted; keeps its exit status
run() { "$@" 2>&1 | redact; }

compose() { docker compose -p forexedge -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# The tag must be a full commit SHA and the one fetch.sh staged
check_tag() {
  local tag="$1" staged
  [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || die "IMAGE_TAG must be a full commit SHA (40 hex characters): '$tag'"
  [[ -f "$STAGED_FILE" ]] || die "nothing staged: $STAGED_FILE is missing (run fetch.sh first)"
  staged="$(sed -n 's/^commit \([0-9a-f]\{40\}\)$/\1/p' "$STAGED_FILE")"
  [[ "$tag" == "$staged" ]] || die "IMAGE_TAG $tag is not the staged commit ${staged:-(none)}: stage and fetch that commit first"
}

# The env files exist, belong to root and only root can read them
check_env_files() {
  local f
  for f in "$ENV_FILE" "$DEMO_ENV_FILE"; do
    [[ -f "$f" ]] || die "$f is missing (run make-env.sh first)"
    [[ "$(stat -c '%U %a' "$f")" == "root 600" ]] || die "$f must be owned by root with mode 600, is $(stat -c '%U %a' "$f")"
  done
  [[ -f "$COMPOSE_FILE" ]] || die "$COMPOSE_FILE is missing (run fetch.sh first)"
}

# Refuses while any variable of the env files is still a placeholder (names only)
check_no_placeholders() {
  local left
  left="$(cat "$ENV_FILE" "$DEMO_ENV_FILE" | awk -F= -v p="$PLACEHOLDER" 'index($0, p) > 0 { print $1 }' | paste -sd ' ' -)"
  [[ -z "$left" ]] || die "still placeholders (set them with set-secret.sh): $left"
}

# Logs Docker in to the registry of IMAGE_REGISTRY with the instance role, into a temporary DOCKER_CONFIG
ecr_login() {
  local registry region host out
  registry="$(env_value IMAGE_REGISTRY "$ENV_FILE")"
  region="$(env_value AWS_REGION "$ENV_FILE")"
  host="${registry%%/*}"
  [[ "$host" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$ ]] || die "IMAGE_REGISTRY is not an ECR registry: '$registry'"
  [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "AWS_REGION is not a region: '$region'"
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
  # The token goes through the pipe only (never an argument), and docker login's output is dropped
  if ! out="$(aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$host" 2>&1)"; then
    printf '%s\n' "$out" | redact >&2
    die "ECR login failed"
  fi
}
# ── end of the shared block ──────────────────────────────────────────────────────────────────────────

# One step in the ops container: full output (redacted) to its log, a summary to stdout. Returns the
# command's exit status.
LOG_STAMP=""
step() {
  local name="$1" summary="$2" log status started
  shift 2
  log="$LOG_DIR/bootstrap-${LOG_STAMP}-${name}.log"
  started=$SECONDS
  status=0
  compose --profile ops run --rm -T ops "$@" 2>&1 | redact >"$log" || status=$?
  if [[ "$summary" == bootstrap ]]; then
    grep '^\[bootstrap\]' "$log" | sed "s/^/  /" || true
  else
    tail -n 3 "$log" | sed "s/^/  /"
  fi
  if ((status == 0)); then
    echo "$name: ok ($((SECONDS - started)) s)"
  else
    echo "$name: exit $status ($((SECONDS - started)) s), log $log"
  fi
  return "$status"
}

fail_with_log() {
  echo "--- last 20 lines of $1" >&2
  tail -n 20 "$1" >&2
  die "$2"
}

[[ $# -eq 1 ]] || {
  echo "usage: $0 <IMAGE_TAG>" >&2
  exit 2
}
[[ "${EUID}" -eq 0 ]] || die "run as root"
check_tag "$1"
check_env_files
check_no_placeholders
[[ -f "$HISTORY_DIR/manifest.json" ]] || die "$HISTORY_DIR/manifest.json is missing (stage.sh --history, then fetch.sh)"
export IMAGE_TAG="$1"
install -d -o root -g root -m 0700 "$LOG_DIR"
LOG_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

ecr_login
run compose --profile ops pull --quiet ops timescaledb redis kafka
run compose up -d --wait --quiet-pull timescaledb redis kafka
echo "timescaledb, redis, kafka: healthy"

# 1. On an empty database the bootstrap stops at "history loaded" with exit 1: expected before the import
if ! step bootstrap-1 bootstrap npx ts-node --transpile-only tools/ops/bootstrap-prod.ts; then
  log="$LOG_DIR/bootstrap-${LOG_STAMP}-bootstrap-1.log"
  if ! grep -q '^\[bootstrap\] instruments: ok' "$log" || ! grep -q '^\[bootstrap\] history loaded failed' "$log"; then
    fail_with_log "$log" "bootstrap failed before the history check"
  fi
  echo "bootstrap-1: stopped at the history check, as expected on an empty database"
fi

# 2. The history: nothing to do when the database already matches the manifest
if step history-check tail npm run data:transfer -- check --dir /repo/data/history-transfer; then
  echo "history: already loaded and identical to the manifest"
else
  echo "history: not loaded (or not identical): importing"
  step history-import tail npm run data:transfer -- import --dir /repo/data/history-transfer ||
    fail_with_log "$LOG_DIR/bootstrap-${LOG_STAMP}-history-import.log" "history import failed"
fi

step check-only tail npm run data:import -- --check-only ||
  fail_with_log "$LOG_DIR/bootstrap-${LOG_STAMP}-check-only.log" "data:import --check-only failed"
step validate tail npm run data:validate ||
  fail_with_log "$LOG_DIR/bootstrap-${LOG_STAMP}-validate.log" "data:validate failed"
step bootstrap-2 bootstrap npx ts-node --transpile-only tools/ops/bootstrap-prod.ts ||
  fail_with_log "$LOG_DIR/bootstrap-${LOG_STAMP}-bootstrap-2.log" "bootstrap failed"
echo "bootstrap: done (logs in $LOG_DIR)"
