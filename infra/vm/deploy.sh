#!/usr/bin/env bash
# Deploys a fetched release on the host, and rolls back to the running one if the new one isn't ready
# (docs/DEPLOY.md section 10). Root, on the host, through SSM (deploy.yml, or by hand from the laptop):
#
#   bash infra/vm/run-on-host.sh infra/vm/deploy.sh --timeout 1800 -- <IMAGE_TAG> <backups-bucket> [--simulate-failure]
#
#   adopt     first run only: the Phase 3 layout (/opt/forexedge/infra/docker-compose.prod.yml with its staged
#             commit running) becomes releases/<that tag> and current. Copies only; no container is touched
#   refuse    unless releases/<IMAGE_TAG>/release (fetch.sh) records commit <IMAGE_TAG>
#   backup    the app tables (public, not historical_*, not hypertables; aggregates are views and not dumped):
#             self-contained: a header line, the extensions, enum types and domains the tables use (from the
#             live catalog; pg_dump -t leaves them out), then pg_dump in the database container; gzip,
#             s3://<backups>/predeploy/<UTC>-<tag>.sql.gz with the instance role. Prints the size and the
#             table names, never the content
#   migrate   releases/<tag>/infra/vm/bootstrap.sh <tag> --deploy (migrations, logins, demo users) while the
#             running release still serves: migrations must be backward compatible (CLAUDE.md)
#   switch    current -> releases/<tag>, up -d with that release's compose file, ready within 3 min
#   rollback  if up or ready fails: current -> the previous release, up with ITS compose file and tag, ready
#   success   IMAGE_TAG in .env.prod, a line in deploys.log, the newest 5 releases kept (with current and the
#             previous one; the local images of the others removed)
#
# --simulate-failure (the rollback drill): after a real up, the ready check counts as failed.
#
# Exit codes: 0 deployed; 1 refused, or failed before the switch (nothing changed); 2 usage; 3 rolled back
# to the previous release; 4 ROLLBACK FAILED (nothing more is tried: the stack is in an unknown state).
# The last lines are for deploy.yml: "deploy-result: deployed|rolled-back|rollback-failed",
# "deploy-tag: <tag>", "deploy-previous: <tag>". Everything printed is redacted, as in stack.sh.
#
# Self-contained (run-on-host.sh sends one file): the shared blocks are copies, and the host tests fail if
# they differ from stack.sh's and bootstrap.sh's. FOREXEDGE_ROOT, STACK_READY_SECONDS and
# STACK_READY_POLL_SECONDS override /opt/forexedge, 180 and 5 (tests).
set -euo pipefail

ROOT="${FOREXEDGE_ROOT:-/opt/forexedge}"
CURRENT="$ROOT/current"
DEPLOYS_LOG="$ROOT/deploys.log"
KEEP_RELEASES=5
READY_SECONDS="${STACK_READY_SECONDS:-180}"
READY_POLL_SECONDS="${STACK_READY_POLL_SECONDS:-5}"
NODE_APPS=(auth-service:3000 market-service:3002 domain-service:3003 order-service:3004 ws-gateway:3005 replay-service:3008 frontend:3000)
PYTHON_APPS=(ml-service:3006 research-agent:3007)

# ── shared with stack.sh and bootstrap.sh (kept identical; the host tests compare the three) ───────────
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

# ── readiness, shared with stack.sh (kept identical; the host tests compare the two) ───────────────────
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
# ── end of the readiness block ─────────────────────────────────────────────────────────────────────────

usage() {
  echo "usage: $0 <IMAGE_TAG> <backups-bucket> [--simulate-failure]" >&2
  exit 2
}

# The tag current points to (empty when there is no current release)
current_tag() {
  local target
  target="$(readlink "$CURRENT" 2>/dev/null || true)"
  target="${target##*/}"
  if [[ "$target" =~ ^[0-9a-f]{40}$ ]]; then printf '%s' "$target"; fi
}

# current -> releases/<tag>, atomically (a relative link: the tests move the root)
point_current() {
  ln -sfn "releases/$1" "$ROOT/current.tmp"
  mv -Tf "$ROOT/current.tmp" "$CURRENT"
}

log_deploy() { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >>"$DEPLOYS_LOG"; }

# The images of the stack's running containers that come from IMAGE_REGISTRY
running_app_images() {
  local registry
  registry="$(env_value IMAGE_REGISTRY "$ENV_FILE")"
  docker ps --filter label=com.docker.compose.project=forexedge --format '{{.Image}}' | grep -F "$registry/" || true
}

# First run only: the Phase 3 deployment (compose file, Caddyfile and scripts in /opt/forexedge/infra,
# /opt/forexedge/staged-commit) becomes a release, as long as its commit is the tag that is running. The
# legacy files are copied, not moved: the running Caddy bind-mounts the legacy Caddyfile until the next up
# recreates it from a release path. Nothing is started, stopped or recreated.
adopt_legacy() {
  local legacy_compose="$ROOT/infra/docker-compose.prod.yml" tag running images release
  if [[ -L "$CURRENT" ]]; then return 0; fi
  [[ -f "$legacy_compose" && -f "$ROOT/staged-commit" ]] ||
    die "no current release and no Phase 3 deployment to adopt ($legacy_compose, $ROOT/staged-commit)"
  tag="$(sed -n 's/^commit \([0-9a-f]\{40\}\)$/\1/p' "$ROOT/staged-commit")"
  running="$(env_value IMAGE_TAG "$ENV_FILE")"
  [[ -n "$tag" && "$tag" == "$running" ]] ||
    die "cannot adopt: the staged commit ${tag:-(none)} is not IMAGE_TAG ${running:-(unset)} of .env.prod"
  images="$(running_app_images)"
  [[ -n "$images" ]] || die "cannot adopt: no container of the stack runs an image of IMAGE_REGISTRY"
  if grep -qv ":$tag\$" <<<"$images"; then
    die "cannot adopt: running images are not all $tag: $(grep -v ":$tag\$" <<<"$images" | paste -sd ' ' -)"
  fi
  release="$ROOT/releases/$tag"
  install -d -o root -g root -m 0700 "$ROOT/releases"
  if [[ ! -f "$release/release" ]]; then
    install -d -o root -g root -m 0700 "$release" "$release/infra" "$release/infra/caddy" "$release/infra/vm"
    install -o root -g root -m 0600 "$legacy_compose" "$release/infra/docker-compose.prod.yml"
    install -o root -g root -m 0600 "$ROOT/infra/caddy/Caddyfile" "$release/infra/caddy/Caddyfile"
    install -o root -g root -m 0700 "$ROOT"/infra/vm/*.sh "$release/infra/vm/"
    ln -sfn ../../../infra/.env.prod "$release/infra/.env.prod"
    ln -sfn ../../../infra/.env.demo-users "$release/infra/.env.demo-users"
    ln -sfn ../../data "$release/data"
    printf 'commit %s\nprefix adopted\nfetched %s\n' "$tag" "$(date -u +%Y%m%dT%H%M%SZ)" >"$release/release.tmp"
    chmod 600 "$release/release.tmp"
    mv "$release/release.tmp" "$release/release"
  fi
  point_current "$tag"
  log_deploy "$tag" adopted
  echo "adopted the running deployment $tag as releases/$tag (no container touched)"
}

# The Phase 3 copies go once no container mounts them any more (an up from a release path recreated Caddy)
remove_legacy() {
  local ids
  [[ -f "$ROOT/infra/docker-compose.prod.yml" ]] || return 0
  ids="$(docker ps -q --filter label=com.docker.compose.project=forexedge)"
  # shellcheck disable=SC2086  # one argument per container id
  if [[ -n "$ids" ]] && docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' $ids | grep -qF "$ROOT/infra/caddy/"; then
    echo "legacy files kept: a container still mounts $ROOT/infra/caddy"
    return 0
  fi
  rm -rf "$ROOT/infra/docker-compose.prod.yml" "$ROOT/infra/caddy" "$ROOT/infra/vm" "$ROOT/staged-commit"
  echo "removed the Phase 3 copies (infra/docker-compose.prod.yml, infra/caddy, infra/vm, staged-commit)"
}

# The newest KEEP_RELEASES releases by fetch time stay, and always current and the previous one; the
# others go with their local images
prune_releases() {
  local keep="$1" previous="$2" dir tag fetched registry pruned=0
  registry="$(env_value IMAGE_REGISTRY "$ENV_FILE")"
  while read -r fetched tag; do
    [[ "$tag" == "$keep" || "$tag" == "$previous" ]] && continue
    rm -rf "${ROOT:?}/releases/$tag"
    docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -F "$registry/" | grep ":$tag\$" |
      while read -r image; do docker image rm "$image" >/dev/null 2>&1 || true; done
    echo "pruned release $tag (fetched $fetched) and its images"
    pruned=$((pruned + 1))
  done < <(
    for dir in "$ROOT"/releases/*/; do
      tag="$(basename "$dir")"
      [[ "$tag" =~ ^[0-9a-f]{40}$ && -f "$dir/release" ]] || continue
      fetched="$(sed -n 's/^fetched \([0-9TZ]*\)$/\1/p' "$dir/release")"
      printf '%s %s\n' "${fetched:-00000000T000000Z}" "$tag"
    done | sort -r | tail -n +$((KEEP_RELEASES + 1))
  )
  echo "releases: $(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | wc -l) kept, $pruned pruned"
}

# The app tables to dump: ordinary tables of public, without the history (historical_*: data:transfer
# restores it) and without hypertables (live ticks; continuous aggregates are views). One name per line.
APP_TABLES_SQL="SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'historical\\_%'
AND NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables h
                WHERE h.hypertable_schema = 'public' AND h.hypertable_name = c.relname)
ORDER BY 1"

# The first line of every pre-deploy dump that holds its prerequisites (restore-test.sh refuses a dump
# without it)
DUMP_HEADER="-- ForexEdge pre-deploy dump: self-contained (prerequisites from the live catalog, then pg_dump -t)"

# What pg_dump -t leaves out but the dumped tables (__TABLES__) need, one statement per line: the
# extensions their column types and defaults come from (uuid-ossp: uuid_generate_v4()), then their enum
# types, then their domains, the deepest base first. Run with an empty search_path, so every name is
# qualified. A type is created only if missing, so the same dump also restores over the live database (the
# full undo of docs/DEPLOY.md section 10.4 drops the tables, not the types).
PREREQ_SQL="$(cat <<'SQL'
WITH RECURSIVE dumped AS (
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN (__TABLES__)
), types(oid, depth) AS (
  SELECT CASE WHEN t.typcategory = 'A' THEN t.typelem ELSE t.oid END, 0
  FROM pg_attribute a JOIN dumped d ON d.oid = a.attrelid JOIN pg_type t ON t.oid = a.atttypid
  WHERE a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT CASE WHEN b.typcategory = 'A' THEN b.typelem ELSE b.oid END, types.depth + 1
  FROM types JOIN pg_type t ON t.oid = types.oid JOIN pg_type b ON b.oid = t.typbasetype
  WHERE t.typtype = 'd'
), members AS (
  SELECT classid, objid, refobjid AS ext FROM pg_depend WHERE deptype = 'e' AND refclassid = 'pg_extension'::regclass
), exts AS (
  SELECT m.ext FROM types JOIN members m ON m.classid = 'pg_type'::regclass AND m.objid = types.oid
  UNION
  SELECT m.ext FROM pg_attrdef ad JOIN dumped d ON d.oid = ad.adrelid
  JOIN pg_depend p ON p.classid = 'pg_attrdef'::regclass AND p.objid = ad.oid AND p.refclassid = 'pg_proc'::regclass
  JOIN members m ON m.classid = 'pg_proc'::regclass AND m.objid = p.refobjid
), own_types AS (
  SELECT t.oid, t.typname, t.typtype, n.nspname, max(types.depth) AS depth
  FROM types JOIN pg_type t ON t.oid = types.oid JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE t.typtype IN ('e', 'd') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND NOT EXISTS (SELECT 1 FROM members m WHERE m.classid = 'pg_type'::regclass AND m.objid = t.oid)
  GROUP BY t.oid, t.typname, t.typtype, n.nspname
)
SELECT stmt FROM (
  SELECT 0 AS k, 0 AS depth, x.extname AS name,
         format('CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I;', x.extname, n.nspname) AS stmt
  FROM (SELECT DISTINCT ext FROM exts) e JOIN pg_extension x ON x.oid = e.ext JOIN pg_namespace n ON n.oid = x.extnamespace
  UNION ALL
  SELECT 1, o.depth, o.typname,
         format('DO $prereq$ BEGIN CREATE TYPE %I.%I AS ENUM (%s); EXCEPTION WHEN duplicate_object THEN NULL; END $prereq$;',
                o.nspname, o.typname,
                (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = o.oid))
  FROM own_types o WHERE o.typtype = 'e'
  UNION ALL
  SELECT 2, o.depth, o.typname,
         format('DO $prereq$ BEGIN CREATE DOMAIN %I.%I AS %s%s%s%s; EXCEPTION WHEN duplicate_object THEN NULL; END $prereq$;',
                o.nspname, o.typname, format_type(t.typbasetype, t.typtypmod),
                CASE WHEN t.typdefault IS NOT NULL THEN ' DEFAULT ' || t.typdefault ELSE '' END,
                CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END,
                coalesce((SELECT string_agg(format(' CONSTRAINT %I %s', c.conname, pg_get_constraintdef(c.oid)), '' ORDER BY c.conname)
                          FROM pg_constraint c WHERE c.contypid = o.oid), ''))
  FROM own_types o JOIN pg_type t ON t.oid = o.oid WHERE o.typtype = 'd'
) s
ORDER BY k, depth DESC, name
SQL
)"

backup() {
  local tag="$1" bucket="$2" region work tables=() dump_args=() name key size names
  region="$(env_value AWS_REGION "$ENV_FILE")"
  [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "AWS_REGION is not a region: '$region'"
  work="$(mktemp -d)"
  # shellcheck disable=SC2016  # expanded by the container's shell (its own POSTGRES_USER and POSTGRES_DB)
  if ! compose exec -T timescaledb sh -c 'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' \
    sh "$APP_TABLES_SQL" >"$work/tables" 2>"$work/err"; then
    redact <"$work/err" >&2
    rm -rf "$work"
    die "backup: could not list the app tables"
  fi
  while IFS= read -r name; do
    name="${name%$'\r'}"
    [[ "$name" =~ ^[a-z_][a-z0-9_]*$ ]] || { rm -rf "$work"; die "backup: unexpected table name '$name'"; }
    tables+=("$name")
    dump_args+=(-t "public.$name")
  done <"$work/tables"
  # An empty list would dump nothing and look like a backup
  ((${#tables[@]} > 0)) || { rm -rf "$work"; die "backup: no app table found"; }
  names="$(printf "'%s'," "${tables[@]}")"
  # shellcheck disable=SC2016  # expanded by the container's shell
  if ! compose exec -T timescaledb sh -c 'psql -X -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' \
    sh "SET search_path = ''; ${PREREQ_SQL//__TABLES__/${names%,}}" >"$work/prereq.sql" 2>"$work/err"; then
    redact <"$work/err" >&2
    rm -rf "$work"
    die "backup: could not read the prerequisites of the app tables"
  fi
  # Only the statements the query writes (a stray line, e.g. a command tag, would break the restore)
  # shellcheck disable=SC2016  # a literal $prereq$ (SQL dollar quote)
  if grep -qvE '^(CREATE EXTENSION IF NOT EXISTS |DO \$prereq\$ BEGIN CREATE (TYPE|DOMAIN) )' "$work/prereq.sql"; then
    rm -rf "$work"
    die "backup: unexpected line in the prerequisites"
  fi
  # One gzip file: the header, the prerequisites, then pg_dump's output
  # shellcheck disable=SC2016  # expanded by the container's shell
  if ! {
    printf '%s\n' "$DUMP_HEADER"
    tr -d '\r' <"$work/prereq.sql"
    compose exec -T timescaledb sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges "$@"' \
      sh "${dump_args[@]}"
  } 2>"$work/err" | gzip -9 >"$work/dump.sql.gz"; then
    redact <"$work/err" >&2
    rm -rf "$work"
    die "backup: pg_dump failed"
  fi
  if ! gzip -dc "$work/dump.sql.gz" | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
    rm -rf "$work"
    die "backup: the dump is incomplete"
  fi
  key="predeploy/$(date -u +%Y%m%dT%H%M%SZ)-$tag.sql.gz"
  size="$(stat -c %s "$work/dump.sql.gz")"
  if ! aws s3 cp --only-show-errors --region "$region" "$work/dump.sql.gz" "s3://$bucket/$key" 2>"$work/err"; then
    redact <"$work/err" >&2
    rm -rf "$work"
    die "backup: upload to s3://$bucket/$key failed"
  fi
  echo "backup: s3://$bucket/$key ($size bytes gzip, ${#tables[@]} tables: ${tables[*]})"
  echo "backup: self-contained: $(grep -c '^CREATE EXTENSION' "$work/prereq.sql" || true) extensions," \
    "$(grep -cE 'CREATE (TYPE|DOMAIN)' "$work/prereq.sql" || true) enum types and domains before the tables"
  rm -rf "$work"
}

# Up with a release's compose file and tag; returns non-zero if up or the ready check fails
up_release() {
  local tag="$1"
  check_tag "$tag"
  export IMAGE_TAG="$tag"
  run compose up -d --remove-orphans --quiet-pull || return 1
}

result() {
  printf 'deploy-result: %s\ndeploy-tag: %s\ndeploy-previous: %s\n' "$1" "$2" "$3"
}

[[ $# -ge 2 && $# -le 3 ]] || usage
tag="$1"
bucket="$2"
simulate=false
if [[ $# -eq 3 ]]; then
  [[ "$3" == "--simulate-failure" ]] || usage
  simulate=true
fi
[[ "${EUID}" -eq 0 ]] || die "run as root"
[[ "$bucket" =~ ^forexedge-backups-[0-9]{12}$ ]] || die "not the backups bucket: '$bucket'"
check_tag "$tag"
check_env_files
check_no_placeholders

adopt_legacy
previous="$(current_tag)"
[[ -n "$previous" ]] || die "current is not a release: $(readlink "$CURRENT" || echo missing)"
check_tag "$previous"
check_tag "$tag"
echo "deploying $tag (running: $previous)"

backup "$tag" "$bucket"

# Migrations with the new release's ops image, the running stack untouched (--deploy: no up, no history)
FOREXEDGE_ROOT="$ROOT" bash "$ROOT/releases/$tag/infra/vm/bootstrap.sh" "$tag" --deploy ||
  die "bootstrap --deploy failed: nothing switched, $previous still runs"

ecr_login
point_current "$tag"
echo "current -> $tag"
ok=true
if ! up_release "$tag"; then
  echo "up of $tag failed"
  ok=false
elif [[ "$simulate" == true ]]; then
  echo "simulated failure (--simulate-failure): the ready check of $tag counts as failed"
  ok=false
elif ! ready; then
  ok=false
fi

if [[ "$ok" == true ]]; then
  set_image_tag "$tag"
  log_deploy "$tag" "deployed (previous $previous)"
  remove_legacy
  prune_releases "$tag" "$previous"
  echo "deployed $tag"
  result deployed "$tag" "$previous"
  exit 0
fi

echo "deploy of $tag failed: rolling back to $previous"
point_current "$previous"
echo "current -> $previous"
if up_release "$previous" && ready; then
  set_image_tag "$previous"
  log_deploy "$tag" "rolled back to $previous"
  echo "rolled back to $previous"
  result rolled-back "$tag" "$previous"
  exit 3
fi
log_deploy "$tag" "ROLLBACK FAILED (previous $previous)"
echo "ROLLBACK FAILED: $previous is not ready either; nothing more is tried (docs/DEPLOY.md section 10)" >&2
result rollback-failed "$tag" "$previous"
exit 4
