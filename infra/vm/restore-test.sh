#!/usr/bin/env bash
# Restores a pre-deploy dump into a scratch database and compares its row counts with the live database
# (docs/DEPLOY.md sections 7.6 and 10.4). Root, on the host, through SSM (by hand from the laptop):
#
#   bash infra/vm/run-on-host.sh infra/vm/restore-test.sh --timeout 900 -- <backups-bucket> [predeploy/<UTC>-<tag>.sql.gz]
#
#   pick      the given key, else the newest s3://<backups>/predeploy/<UTC>-<tag>.sql.gz (deploy.sh's backup)
#   download  with the instance role into a temporary file under /opt/forexedge (root, 600); gzip -t,
#             pg_dump's completion line, and deploy.sh's self-contained header as the first line (a dump
#             made before that commit lacks its extensions and enum types and is refused)
#   create    restore_test_<UTC>, an empty database, in the timescaledb container (its own POSTGRES_USER):
#             nothing is copied from the live catalog, the dump must stand alone
#   restore   psql with ON_ERROR_STOP; errors are shown with every quoted value masked (an error can quote
#             a row)
#   compare   table | rows in dump-restore | rows live now. Restored <= live is expected: the live database
#             has grown since the dump (fewer live rows is marked, not a failure: rows can be deleted)
#   cleanup   the scratch database is dropped and the file deleted on every exit, failures included
#
# Fails (exit 1) on: no dump found, a dump that isn't gzip, is incomplete or not self-contained, a restore
# error, zero tables restored, a restored table missing from the live database, a users table with no rows,
# a scratch database that could not be dropped. 2: usage. The last line is "restore-test-result: ok|failed".
# Prints names and counts only, never a row or a secret; what other programs print goes through the same
# redact as deploy.sh.
#
# Self-contained (run-on-host.sh sends one file): the shared block is a copy, and the host tests fail if it
# differs from stack.sh's. FOREXEDGE_ROOT overrides /opt/forexedge (tests).
set -euo pipefail

ROOT="${FOREXEDGE_ROOT:-/opt/forexedge}"
CURRENT="$ROOT/current"

# ── shared with stack.sh, bootstrap.sh and deploy.sh (kept identical; the host tests compare them) ────
# The secrets are shared by every release; each release has its own config (fetch.sh)
ENV_FILE="$ROOT/infra/.env.prod"
DEMO_ENV_FILE="$ROOT/infra/.env.demo-users"
RELEASES="$ROOT/releases"
PLACEHOLDER="__SET_WITH_SET_SECRET__"
COMPOSE_FILE=""
DOCKER_CONFIG=""

die() {
  printf '%s: %s\n' "$(basename "$0")" "$*" >&2
  exit 1
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
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

# The tag must be a full commit SHA whose release fetch.sh installed (releases/<tag>/release records it).
# COMPOSE_FILE becomes that release's compose file, always by its real path (never through current), so a
# new release's bind mounts differ and compose recreates what changed.
check_tag() {
  local tag="$1" recorded
  [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || die "IMAGE_TAG must be a full commit SHA (40 hex characters): '$tag'"
  [[ -f "$RELEASES/$tag/release" ]] || die "no release for $tag: $RELEASES/$tag/release is missing (stage and fetch that commit first)"
  recorded="$(sed -n 's/^commit \([0-9a-f]\{40\}\)$/\1/p' "$RELEASES/$tag/release")"
  [[ "$tag" == "$recorded" ]] || die "release $tag records commit ${recorded:-(none)}: fetch that commit again"
  COMPOSE_FILE="$RELEASES/$tag/infra/docker-compose.prod.yml"
}

# The env files exist, belong to root and only root can read them
check_env_files() {
  local f
  for f in "$ENV_FILE" "$DEMO_ENV_FILE"; do
    [[ -f "$f" ]] || die "$f is missing (run make-env.sh first)"
    [[ "$(stat -c '%U %a' "$f")" == "root 600" ]] || die "$f must be owned by root with mode 600, is $(stat -c '%U %a' "$f")"
  done
  [[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]] || die "compose file ${COMPOSE_FILE:-(none)} is missing (run fetch.sh first)"
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

usage() {
  echo "usage: $0 <backups-bucket> [predeploy/<UTC>-<tag>.sql.gz]" >&2
  exit 2
}

# deploy.sh's first line of a self-contained dump (kept identical; the host tests compare the two)
DUMP_HEADER="-- ForexEdge pre-deploy dump: self-contained (prerequisites from the live catalog, then pg_dump -t)"
KEY_RE='^predeploy/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}\.sql\.gz$'
WORK=""
SCRATCH_DB=""

# The tag current points to (empty when there is no current release)
current_tag() {
  local target
  target="$(readlink "$CURRENT" 2>/dev/null || true)"
  target="${target##*/}"
  if [[ "$target" =~ ^[0-9a-f]{40}$ ]]; then printf '%s' "$target"; fi
}

# One query in the database container as its superuser: database $1 (the live POSTGRES_DB when empty),
# SQL $2; rows on stdout, unaligned (name|value)
pg_query() {
  # shellcheck disable=SC2016  # expanded by the container's shell
  compose exec -T timescaledb sh -c 'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${1:-$POSTGRES_DB}" -c "$2"' sh "$1" "$2"
}

# Exact row counts of the ordinary tables of public (name|count); a filter may follow
COUNT_SQL="SELECT c.relname || '|' || (xpath('/row/n/text()',
  query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')"

# name|count lines of a file into the associative array named $2
read_counts() {
  local -n counts="$2"
  local name rows
  while IFS='|' read -r name rows; do
    rows="${rows%$'\r'}"
    [[ "$name" =~ ^[a-z_][a-z0-9_]*$ && "$rows" =~ ^[0-9]+$ ]] || die "unexpected count line for table '$name'"
    # shellcheck disable=SC2034,SC2004  # counts is a nameref to the caller's associative array
    counts[$name]="$rows"
  done <"$1"
}

# Drops the scratch database; SCRATCH_DB is cleared only once it is gone
drop_scratch() {
  [[ -n "$SCRATCH_DB" ]] || return 0
  # shellcheck disable=SC2016  # expanded by the container's shell
  if run compose exec -T timescaledb sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' sh "$SCRATCH_DB" >&2; then
    echo "dropped the scratch database $SCRATCH_DB"
    SCRATCH_DB=""
    return 0
  fi
  echo "COULD NOT DROP the scratch database $SCRATCH_DB: drop it by hand (docs/DEPLOY.md section 10.4)" >&2
  return 1
}

# shellcheck disable=SC2329  # invoked by the EXIT trap
restore_cleanup() {
  local status=$?
  drop_scratch || status=1
  if [[ -n "$WORK" ]]; then rm -rf "$WORK"; fi
  cleanup
  if ((status != 0)); then echo "restore-test-result: failed"; fi
  exit "$status"
}
trap restore_cleanup EXIT

[[ $# -ge 1 && $# -le 2 ]] || usage
bucket="$1"
key="${2:-}"
[[ "${EUID}" -eq 0 ]] || die "run as root"
[[ "$bucket" =~ ^forexedge-backups-[0-9]{12}$ ]] || die "not the backups bucket: '$bucket'"
if [[ -n "$key" && ! "$key" =~ $KEY_RE ]]; then die "not a pre-deploy dump key (predeploy/<UTC>-<tag>.sql.gz): '$key'"; fi
tag="$(current_tag)"
[[ -n "$tag" ]] || die "current is not a release: $(readlink "$CURRENT" || echo missing)"
check_tag "$tag"
check_env_files
region="$(env_value AWS_REGION "$ENV_FILE")"
[[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "AWS_REGION is not a region: '$region'"

umask 077
WORK="$(mktemp -d "$ROOT/.restore-test.XXXXXX")"

if [[ -z "$key" ]]; then
  if ! aws s3 ls --region "$region" --recursive "s3://$bucket/predeploy/" >"$WORK/listing" 2>"$WORK/err"; then
    redact <"$WORK/err" >&2
    die "could not list s3://$bucket/predeploy/"
  fi
  # The keys start with their UTC time, so the newest sorts last
  key="$(awk '{ print $4 }' "$WORK/listing" | grep -E "$KEY_RE" | sort | tail -n 1 || true)"
  [[ -n "$key" ]] || die "no pre-deploy dump in s3://$bucket/predeploy/"
fi
echo "dump: s3://$bucket/$key"

if ! aws s3 cp --only-show-errors --region "$region" "s3://$bucket/$key" "$WORK/dump.sql.gz" 2>"$WORK/err"; then
  redact <"$WORK/err" >&2
  die "download of s3://$bucket/$key failed"
fi
chmod 600 "$WORK/dump.sql.gz"
[[ "$(stat -c '%U %a' "$WORK/dump.sql.gz")" == "root 600" ]] || die "the downloaded dump is not root 600"
gzip -t "$WORK/dump.sql.gz" 2>/dev/null || die "$key is not a valid gzip file"
gzip -dc "$WORK/dump.sql.gz" | tail -n 5 | grep -q 'PostgreSQL database dump complete' ||
  die "$key is incomplete (no completion line)"
echo "downloaded $(stat -c %s "$WORK/dump.sql.gz") bytes gzip; gzip and completion line ok"

first="$(gzip -dc "$WORK/dump.sql.gz" | head -n 1 || true)"
[[ "$first" == "$DUMP_HEADER" ]] ||
  die "$key: dump is not self-contained (made before commit \"feat(step-7): self-contained pre-deploy dumps\"): it lacks its extensions and enum types; see docs/DEPLOY.md section 10.4"
echo "self-contained dump (deploy.sh's header)"

SCRATCH_DB="restore_test_$(date -u +%Y%m%d_%H%M%S)"
# shellcheck disable=SC2016  # expanded by the container's shell
if ! compose exec -T timescaledb sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$SCRATCH_DB" 2>"$WORK/err"; then
  redact <"$WORK/err" >&2
  die "could not create the scratch database $SCRATCH_DB"
fi
echo "created the scratch database $SCRATCH_DB"

# shellcheck disable=SC2016  # expanded by the container's shell
if ! gzip -dc "$WORK/dump.sql.gz" |
  compose exec -T timescaledb sh -c 'psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse -U "$POSTGRES_USER" -d "$1"' sh "$SCRATCH_DB" \
    >/dev/null 2>"$WORK/err"; then
  # The error lines only, every quoted value masked: an error can quote a row's data
  { grep -E 'ERROR|FATAL' "$WORK/err" || true; } | sed -E "s/\"[^\"]*\"/\"...\"/g; s/'[^']*'/'...'/g" | head -n 5 | redact >&2
  die "restore into $SCRATCH_DB failed (ON_ERROR_STOP)"
fi

if ! pg_query "$SCRATCH_DB" "$COUNT_SQL ORDER BY 1" >"$WORK/restored" 2>"$WORK/err"; then
  redact <"$WORK/err" >&2
  die "could not count the restored rows"
fi
declare -A restored_rows=() live_rows=()
read_counts "$WORK/restored" restored_rows
mapfile -t restored < <(cut -d'|' -f1 "$WORK/restored")
((${#restored[@]} > 0)) || die "no table restored from $key"

names="$(printf "'%s'," "${restored[@]}")"
if ! pg_query "" "$COUNT_SQL AND c.relname IN (${names%,}) ORDER BY 1" >"$WORK/live" 2>"$WORK/err"; then
  redact <"$WORK/err" >&2
  die "could not count the live rows"
fi
read_counts "$WORK/live" live_rows

missing=()
for name in "${restored[@]}"; do [[ -n "${live_rows[$name]:-}" ]] || missing+=("$name"); done
{
  printf '%-24s %20s %16s\n' table "rows in dump-restore" "rows live now"
  for name in "${restored[@]}"; do
    note=""
    if [[ -z "${live_rows[$name]:-}" ]]; then
      note="  (missing live)"
    elif ((restored_rows[$name] > live_rows[$name])); then
      note="  (fewer live rows now)"
    fi
    printf '%-24s %20s %16s%s\n' "$name" "${restored_rows[$name]}" "${live_rows[$name]:--}" "$note"
  done
} | redact
((${#missing[@]} == 0)) || die "restored tables missing from the live database: ${missing[*]}"
((${restored_rows[users]:-0} > 0)) || die "users has no rows in the restored dump"

drop_scratch
echo "restore test: ${#restored[@]} tables restored from s3://$bucket/$key, users ${restored_rows[users]} rows"
echo "restore-test-result: ok"
