#!/usr/bin/env bash
# The production stack on the host (docs/DEPLOY.md section 8). Root, on the host, usually through SSM:
#
#   bash infra/vm/run-on-host.sh infra/vm/stack.sh -- <pull|up|down|ps|ready|stats> <IMAGE_TAG>
#
#   pull    ECR login with the instance role, pull every image of the tag (ops included)
#   up      refuses while a secret is still a placeholder; ECR login, sets IMAGE_TAG in .env.prod, up -d,
#           then ready
#   down    stops and removes the containers (never the volumes: the database stays)
#   ps      the containers and their state
#   ready   GET /health/ready inside every app container (docs/DEPLOY.md section 3) until all answer 200;
#           exits non-zero, naming the ones that don't, after 3 min
#   stats   memory per container (docker stats), Redis used_memory, the host's memory and swap
#
# IMAGE_TAG is the commit staged on the host by stage.sh/fetch.sh (/opt/forexedge/staged-commit): any other
# tag is refused, so the compose file and the images always come from the same commit.
# Layout (fetch.sh, make-env.sh): /opt/forexedge/infra/{docker-compose.prod.yml,caddy/Caddyfile,.env.prod,
# .env.demo-users}. Everything printed goes through redact (every secret value from the two env files
# becomes ***), because SSM keeps the output. The ECR token goes to a temporary DOCKER_CONFIG, deleted on exit.
#
# FOREXEDGE_ROOT, STACK_READY_SECONDS and STACK_READY_POLL_SECONDS override /opt/forexedge, 180 and 5 (tests).
set -euo pipefail

ROOT="${FOREXEDGE_ROOT:-/opt/forexedge}"
READY_SECONDS="${STACK_READY_SECONDS:-180}"
READY_POLL_SECONDS="${STACK_READY_POLL_SECONDS:-5}"
# The apps and the port each listens on inside its container (docs/DEPLOY.md section 3); the host tests
# check this list against the compose file
NODE_APPS=(auth-service:3000 market-service:3002 domain-service:3003 order-service:3004 ws-gateway:3005 replay-service:3008 frontend:3000)
PYTHON_APPS=(ml-service:3006 research-agent:3007)

# ── shared with bootstrap.sh (kept identical; the host tests compare the two blocks) ──────────────────
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

# One app's /health/ready from inside its container: prints "<app> <status> <body>", exits 0 on 200.
# (timeout runs an executable, so docker compose is spelled out instead of the compose function)
probe() {
  local app="${1%%:*}" port="${1##*:}" kind="$2"
  if [[ "$kind" == node ]]; then
    timeout 20 docker compose -p forexedge -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T "$app" node -e \
      "fetch('http://127.0.0.1:${port}/health/ready').then(async r=>{console.log('${app}',r.status,await r.text());process.exit(r.ok?0:1)},e=>{console.log('${app}','error',e.message);process.exit(1)})"
  else
    timeout 20 docker compose -p forexedge -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T "$app" python -c \
      "import sys, urllib.request as u
try:
    r = u.urlopen('http://127.0.0.1:${port}/health/ready', timeout=10); print('${app}', r.status, r.read().decode())
except Exception as e:
    print('${app}', 'error', getattr(e, 'code', '') or e); sys.exit(1)"
  fi
}

ready() {
  local deadline=$((SECONDS + READY_SECONDS)) sp out pending report
  while :; do
    pending=()
    report=""
    for sp in "${NODE_APPS[@]}"; do
      if ! out="$(probe "$sp" node 2>&1)"; then pending+=("${sp%%:*}"); report+="${out:-${sp%%:*} no answer}"$'\n'; fi
    done
    for sp in "${PYTHON_APPS[@]}"; do
      if ! out="$(probe "$sp" python 2>&1)"; then pending+=("${sp%%:*}"); report+="${out:-${sp%%:*} no answer}"$'\n'; fi
    done
    if ((${#pending[@]} == 0)); then
      echo "ready: all $((${#NODE_APPS[@]} + ${#PYTHON_APPS[@]})) apps answer /health/ready with 200"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      printf '%s' "$report" | redact >&2
      echo "not ready after ${READY_SECONDS} s: ${pending[*]}" >&2
      return 1
    fi
    echo "waiting for: ${pending[*]}"
    sleep "$READY_POLL_SECONDS"
  done
}

# IMAGE_TAG in .env.prod follows the running tag (only that line changes; mode and owner kept)
set_image_tag() {
  local tag="$1" current tmp
  current="$(env_value IMAGE_TAG "$ENV_FILE")"
  [[ "$current" != "$tag" ]] || return 0
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  awk -v t="$tag" 'index($0, "IMAGE_TAG=") == 1 { print "IMAGE_TAG=" t; next } { print }' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  echo "IMAGE_TAG in .env.prod: ${current:-(unset)} -> $tag"
}

stats() {
  local ids
  ids="$(docker ps -q --filter label=com.docker.compose.project=forexedge)"
  [[ -n "$ids" ]] || die "no container of the forexedge project is running"
  # shellcheck disable=SC2086  # one argument per container id
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' $ids
  echo
  # The password stays inside the container (its own REDIS_PASS, through REDISCLI_AUTH)
  # shellcheck disable=SC2016  # expanded by the container's shell
  compose exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASS" redis-cli INFO memory' |
    tr -d '\r' | grep -E '^(used_memory_human|used_memory_peak_human|maxmemory_human):'
  echo
  free -m
}

usage() {
  echo "usage: $0 <pull|up|down|ps|ready|stats> <IMAGE_TAG>" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
action="$1"
tag="$2"
case "$action" in pull | up | down | ps | ready | stats) ;; *) usage ;; esac
[[ "${EUID}" -eq 0 ]] || die "run as root"
check_tag "$tag"
check_env_files
# compose reads the tag from the environment before .env.prod
export IMAGE_TAG="$tag"

case "$action" in
  pull)
    ecr_login
    run compose --profile ops pull --quiet
    echo "pulled every image of $tag"
    ;;
  up)
    check_no_placeholders
    ecr_login
    set_image_tag "$tag"
    run compose up -d --remove-orphans --quiet-pull
    ready
    ;;
  down) run compose down ;;
  ps) run compose ps --all --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}' ;;
  ready) ready ;;
  stats) stats 2>&1 | redact ;;
esac
