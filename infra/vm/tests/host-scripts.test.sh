#!/usr/bin/env bash
# The host scripts of infra/vm (fetch, make-env, set-secret, stack, bootstrap, deploy, restore-test) against
# stub `aws` and `docker` commands, as root in Ubuntu 24.04 (the host's OS: mawk, coreutils, real file modes).
# No AWS call, no container started. Part of npm run infra:check, which runs it in a container:
#
#   docker run --rm --mount type=bind,source=<repo>,target=/repo,readonly -w /repo <ubuntu:24.04 by digest> \
#     bash infra/vm/tests/host-scripts.test.sh
#
#   fetch       installs a good bundle as releases/<commit> (root, 600/700, the record last, links to the
#               shared secrets and data), the history shared (755/644, readable by uid 1000); refuses a sha256
#               mismatch, a file the manifest doesn't list, a path outside the allowed set, a manifest without
#               its commit, a changed release; again on the same prefix changes nothing
#   make-env    refuses a tag without a fetched release and bad arguments; writes every variable the compose
#               file requires, random distinct secrets, root 600, placeholders for GROQ_API_KEY and the demo
#               users; prints no value; a second run refuses and leaves both files as they were
#   set-secret  replaces only its own variable, single-quoted, root 600; refuses unknown names, a short or
#               weak password, two different entries, a bad email, a quote; never prints the value
#   stack       refuses a tag without a release (or a release recording another commit), placeholders, an env
#               file readable by others; up logs in with the token on stdin, redacts a secret the stack
#               prints, waits for /health/ready; a service that stays unready fails after the limit, named;
#               the apps it probes = compose
#   bootstrap   the whole sequence on an empty database; again on a loaded one (no import); stops at the
#               first failure with the step's last lines; prints no secret; --deploy: the ops image only,
#               --no-deps, no service touched
#   deploy      backup -> bootstrap --deploy -> switch -> up by the release's path; the drill and real
#               failures roll back with the previous release's compose file and tag (exit 3); a failed
#               rollback exits 4; a missing or mismatched release, a failed backup or bootstrap changes
#               nothing; adoption of the Phase 3 layout touches no container and is refused unless the
#               running tag is the staged one; legacy copies go once unmounted; the newest 5 releases kept
#   restore-test  the newest pre-deploy dump (or the given key) restored into a scratch database after the
#               live catalog's extensions and enum types; restored vs live rows; fails on no dump, bad gzip,
#               an incomplete dump, a restore error (quoted values masked), zero tables, a table missing
#               live, no users; the scratch database and the file are removed on every exit
#   shared      the blocks shared by stack.sh, bootstrap.sh, deploy.sh and restore-test.sh are identical
#   no secret   no secret value or ECR token appears in anything any script printed
#   no secret   no secret value or ECR token appears in anything any script printed
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VM="$REPO_DIR/infra/vm"
[[ "${EUID}" -eq 0 ]] || { echo "run as root (in the Ubuntu container of check.sh)" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export STUB="$work/stub"
mkdir -p "$work/bin" "$STUB/s3" "$STUB/ready"
export ECR_TOKEN="ecr-token-0123456789abcdefghij"
# What deploy.sh's prerequisites query returns for the app tables (the live catalog's, as Postgres prints them)
cat >"$STUB/prereqs" <<'EOF'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
DO $prereq$ BEGIN CREATE TYPE public.users_role_enum AS ENUM ('ADMIN', 'TRADER'); EXCEPTION WHEN duplicate_object THEN NULL; END $prereq$;
DO $prereq$ BEGIN CREATE TYPE public.users_status_enum AS ENUM ('ACTIVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $prereq$;
EOF
DUMP_HEADER="$(sed -n 's/^DUMP_HEADER="\(.*\)"$/\1/p' "$VM/deploy.sh")"
BUCKET="forexedge-backups-123456789012"
PREFIX="transfer/20261111T093000Z/"
COMMIT="0c2311f0123456789abcdef0123456789abcdef0"
OTHER="1111111111111111111111111111111111111111"
REGION="ap-south-1"

# ── stubs ────────────────────────────────────────────────────────────────────────────────────────────
cat >"$work/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "aws $*" >>"$STUB/calls.log"
pos=()
skip=false
for a in "$@"; do
  if [[ "$skip" == true ]]; then skip=false; continue; fi
  case "$a" in --region) skip=true ;; --only-show-errors | --recursive) ;; *) pos+=("$a") ;; esac
done
case "${pos[0]} ${pos[1]}" in
  "ecr get-login-password") printf '%s\n' "$ECR_TOKEN" ;;
  "s3 cp")
    src="${pos[2]}" dst="${pos[3]}"
    if [[ "$dst" == s3://* ]]; then
      # An upload (deploy.sh's pre-deploy dump)
      [[ ! -f "$STUB/fail-upload" ]] || { echo "upload failed: An error occurred (AccessDenied) when calling the PutObject operation" >&2; exit 1; }
      mkdir -p "$(dirname "$STUB/s3/${dst#s3://}")"
      cp "$src" "$STUB/s3/${dst#s3://}"
      exit 0
    fi
    [[ "$src" == s3://* && -f "$STUB/s3/${src#s3://}" ]] || { echo "fatal error: An error occurred (404) when calling the HeadObject operation: Key not found" >&2; exit 1; }
    cp "$STUB/s3/${src#s3://}" "$dst" ;;
  "s3 ls")
    p="${pos[2]#s3://}"
    (cd "$STUB/s3" && find "$p" -type f | sort) | while IFS= read -r f; do
      printf '2026-11-11 09:30:00 %10d %s\n' "$(stat -c %s "$STUB/s3/$f")" "${f#*/}"
    done ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
EOF
cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >>"$STUB/calls.log"
case "$1" in
  login) cat >"$STUB/login-stdin"; echo "WARNING! Your credentials are stored unencrypted"; echo "Login Succeeded" ;;
  ps)
    # The images of the running containers (deploy.sh's adoption), else container ids
    if [[ "$*" == *'{{.Image}}'* ]]; then cat "$STUB/running-images" 2>/dev/null || true; else printf 'c1\nc2\n'; fi ;;
  inspect) cat "$STUB/mounts" 2>/dev/null || echo "/opt/forexedge/releases/x/infra/caddy/Caddyfile" ;;
  image)
    case "$2" in
      ls) cat "$STUB/images" 2>/dev/null || true ;;
      rm) echo "$3" >>"$STUB/images-removed" ;;
    esac ;;
  stats) printf 'NAME MEM USAGE / LIMIT CPU %%\nforexedge-redis-1 11MiB / 160MiB 0.5%%\n' ;;
  compose)
    shift
    envf=""
    cf=""
    while [[ $# -gt 0 ]]; do
      case "$1" in -p | --profile) shift 2 ;; -f) cf="$2"; shift 2 ;; --env-file) envf="$2"; shift 2 ;; *) break ;; esac
    done
    sub="$1"
    shift
    secret() { sed -n "s/^$1=//p" "$envf"; }
    case "$sub" in
      pull | down | ps) echo "$sub: ok" ;;
      up)
        echo "up ${cf#"$FOREXEDGE_ROOT"/} ${IMAGE_TAG:-}" >>"$STUB/compose.log"
        [[ ! -f "$STUB/fail-up-${IMAGE_TAG:-}" ]] || { echo "Error response from daemon: manifest unknown"; exit 1; }
        # As a real stack can: a container's command line with a password in it
        echo "redis-1  redis-server --requirepass $(secret REDIS_PASS)"
        echo "up: ok" ;;
      exec)
        [[ "$1" == -T ]] && shift
        app="$1"
        if [[ "$app" == redis ]]; then printf 'used_memory_human:2.12M\r\nmaxmemory_human:96.00M\r\n'; exit 0; fi
        if [[ "$app" == timescaledb ]]; then
          # deploy.sh and restore-test.sh: timescaledb sh -c '<script>' sh <args>; databases in $STUB/pg
          script="$4"
          set -- "${@:6}"
          mkdir -p "$STUB/pg"
          case "$script" in
            pg_dump*)
              echo "$*" >"$STUB/pgdump.args"
              [[ ! -f "$STUB/fail-pgdump" ]] || { echo "pg_dump: error: query failed for password $(secret DB_PASS)" >&2; exit 1; }
              # One table that needs the prerequisites (an extension's function, an enum type)
              printf -- '-- PostgreSQL database dump\nCREATE TABLE public.users (\n    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,\n    role public.users_role_enum NOT NULL\n);\nCOPY public.users (email) FROM stdin;\nrow-only-in-the-dump@example.invalid\n\\.\n-- PostgreSQL database dump complete\n' ;;
            createdb*)
              echo "$1" >>"$STUB/pg/created"
              touch "$STUB/pg/db-$1" ;;
            dropdb*)
              [[ ! -f "$STUB/fail-dropdb" ]] || { echo "dropdb: error: database \"$1\" is being accessed by other users" >&2; exit 1; }
              echo "$1" >>"$STUB/pg/dropped"
              rm -f "$STUB/pg/db-$1" ;;
            *'-c "$2"'*)
              # restore-test.sh's queries: database $1 (empty: the live one), SQL $2. The live catalog's
              # prerequisites are asked for only by a restore-test.sh that copies them (a planted fault)
              case "$2" in
                *pg_enum*) cat "$STUB/prereqs" ;;
                *query_to_xml*)
                  if [[ -z "$1" ]]; then cat "$STUB/live-counts" 2>/dev/null || printf 'account_summary|1\norders|7\nusers|3\n'
                  else cat "$STUB/pg/db-$1"; fi ;;
                *) echo "unexpected query: $2" >&2; exit 1 ;;
              esac ;;
            *'-c "$1"'*)
              if [[ "$1" == *pg_enum* ]]; then
                # deploy.sh's prerequisites of the dumped tables
                echo "$1" >"$STUB/prereq.query"
                [[ ! -f "$STUB/fail-prereq" ]] || { echo "psql: error: permission denied for $(secret DB_PASS)" >&2; exit 1; }
                cat "$STUB/prereqs"
                exit 0
              fi
              # deploy.sh's table list
              [[ ! -f "$STUB/fail-psql" ]] || { echo "psql: error: connection refused" >&2; exit 2; }
              cat "$STUB/tables" 2>/dev/null || printf 'account_summary\norders\nusers\n' ;;
            *psql*)
              # restore-test.sh's restore from stdin into database $1, empty as createdb makes it: a table that
              # uses uuid_generate_v4() before the extension, or a *_enum type before its CREATE TYPE, is an
              # error; else the tables of its CREATE TABLEs and the rows of its COPY blocks (name|count, as
              # restore-test.sh's count query prints them)
              [[ -f "$STUB/pg/db-$1" ]] || { echo "psql: error: database \"$1\" does not exist" >&2; exit 2; }
              cat >"$STUB/pg/restore-stdin"
              if [[ -f "$STUB/fail-restore" ]]; then
                echo 'psql:<stdin>:41: ERROR:  invalid input syntax for type uuid: "row-only-in-the-dump@example.invalid" at character 9' >&2
                exit 3
              fi
              awk '/CREATE EXTENSION IF NOT EXISTS "uuid-ossp"/ { ext = 1 }
                /CREATE TYPE public\.[a-z_]+ / { ty = $0; sub(/.*CREATE TYPE public\./, "", ty); sub(/ .*/, "", ty); types[ty] = 1 }
                /^CREATE TABLE public\./ { t = $3; sub(/^public\./, "", t); n[t] += 0; table = 1 }
                table {
                  if ($0 ~ /uuid_generate_v4/ && !ext) { err = "function public.uuid_generate_v4() does not exist"; exit }
                  rest = $0
                  while (match(rest, /public\.[a-z_]+_enum/)) {
                    ty = substr(rest, RSTART + 7, RLENGTH - 7)
                    if (!(ty in types)) { err = "type \"public." ty "\" does not exist"; exit }
                    rest = substr(rest, RSTART + RLENGTH)
                  }
                  if ($0 ~ /^\);/) table = 0
                }
                /^COPY public\./ { t = $2; sub(/^public\./, "", t); copy = 1; next }
                copy && /^\\\.$/ { copy = 0; next }
                copy { n[t]++ }
                END {
                  if (err != "") { print "psql:<stdin>:" NR ": ERROR:  " err > "/dev/stderr"; exit 3 }
                  for (t in n) print t "|" n[t]
                }' "$STUB/pg/restore-stdin" >"$STUB/pg/restored" || exit 3
              sort "$STUB/pg/restored" >"$STUB/pg/db-$1" ;;
            *) echo "unexpected database command: $script" >&2; exit 1 ;;
          esac
          exit 0
        fi
        code="$(cat "$STUB/ready/$app" 2>/dev/null || echo 200)"
        [[ ! -f "$STUB/unready-${IMAGE_TAG:-}" ]] || code=503
        echo "$app $code {\"status\":\"ok\",\"checks\":[\"db\"]}"
        [[ "$code" == 200 ]] ;;
      run)
        flags=""
        while [[ "$1" == -* ]]; do flags+=" $1"; shift; done
        shift # ops
        cmd="$*"
        echo "$cmd" >>"$STUB/ops.log"
        echo "run$flags $cmd" >>"$STUB/run.log"
        case "$cmd" in
          *bootstrap-prod.ts)
            echo "[bootstrap] migrations ..."
            if [[ -f "$STUB/fail-migrations" ]]; then echo "[bootstrap] migrations failed (exit 1); stopped"; exit 1; fi
            echo "[bootstrap] migrations: ok (1.2 s)"
            echo "[bootstrap] instruments: ok (0.4 s)"
            if [[ ! -f "$STUB/loaded" ]]; then
              echo "The history is not loaded (no import-log rows or EUR/USD H1 bars)."
              echo "[bootstrap] history loaded failed (exit 1); stopped"
              exit 1
            fi
            echo "[bootstrap] history loaded: ok (0.3 s)"
            # A tool that echoes its connection settings
            echo "connecting as forexedge with password $(secret DB_PASS)"
            echo "[bootstrap] demo users: ok (2.0 s)"
            echo "[bootstrap] done" ;;
          *"data:transfer -- check"*)
            if [[ -f "$STUB/loaded" ]]; then echo "check: identical to the manifest"; else echo "check: the database differs from manifest.json: no rows"; exit 1; fi ;;
          *"data:transfer -- import"*) touch "$STUB/loaded"; echo "import: 19187987 minutes, identical to the export" ;;
          *--check-only*) echo "check-only: all checks pass" ;;
          *data:validate*)
            if [[ -f "$STUB/fail-validate" ]]; then printf 'line %s\n' $(seq 1 30); echo "validate: 1 check failed"; exit 1; fi
            echo "validate: all checks pass" ;;
          *) echo "unexpected ops command: $cmd" >&2; exit 1 ;;
        esac ;;
      *) echo "unexpected compose call: $sub $*" >&2; exit 1 ;;
    esac ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/aws" "$work/bin/docker"
export PATH="$work/bin:$PATH"
export STACK_READY_SECONDS=2 STACK_READY_POLL_SECONDS=1

failures=0
fail() { echo "FAIL  $1" >&2; failures=$((failures + 1)); }
pass() { echo "ok    $1"; }
# t <script> <args...>: runs infra/vm/<script> with ROOT=$ROOT, stdin from $INPUT (default empty); output in
# $work/out (and appended to $work/all-output), exit code in $rc
INPUT=/dev/null
t() {
  local script="$1"
  shift
  rc=0
  FOREXEDGE_ROOT="$ROOT" bash "$VM/$script" "$@" <"$INPUT" >"$work/out" 2>&1 || rc=$?
  cat "$work/out" >>"$work/all-output"
}
has() { grep -qF -- "$1" "$work/out"; }
show() { sed 's/^/        /' "$work/out" >&2; }
new_root() {
  ROOT="$work/root-$1"
  rm -rf "$ROOT"
  : >"$STUB/calls.log"
}

# A bundle in the fake bucket as stage.sh writes it: the files, then manifest.sha256 (commit $1)
make_bundle() {
  local commit="$1" dir="$STUB/s3/$BUCKET/$PREFIX"
  rm -rf "$STUB/s3/$BUCKET"
  mkdir -p "$dir/infra/caddy" "$dir/infra/vm" "$dir/data/history-transfer"
  cp "$REPO_DIR/infra/docker-compose.prod.yml" "$dir/infra/"
  cp "$REPO_DIR/infra/caddy/Caddyfile" "$dir/infra/caddy/"
  for s in stack.sh bootstrap.sh set-secret.sh check-imds-guard.sh; do cp "$VM/$s" "$dir/infra/vm/"; done
  echo '{"candles":[]}' >"$dir/data/history-transfer/manifest.json"
  head -c 2048 /dev/urandom >"$dir/data/history-transfer/historical_candles_EURUSD.csv.gz"
  (cd "$dir" && { echo "# commit $commit"; find infra data -type f | sort | xargs sha256sum; } >manifest.sha256)
}
manifest_edit() { sed -i "$1" "$STUB/s3/$BUCKET/${PREFIX}manifest.sha256"; }

# ── fetch ────────────────────────────────────────────────────────────────────────────────────────────
make_bundle "$COMMIT"
new_root fetch
t fetch.sh "$BUCKET" "$PREFIX" "$REGION"
REL="releases/$COMMIT"
if [[ $rc -eq 0 ]] && has "fetched 8 files of commit $COMMIT" && has "into $ROOT/$REL" \
  && [[ "$(stat -c '%U %a' "$ROOT/$REL/infra/docker-compose.prod.yml")" == "root 600" ]] \
  && [[ "$(stat -c '%U %a' "$ROOT/$REL/infra/vm/stack.sh")" == "root 700" ]] \
  && [[ "$(stat -c '%a' "$ROOT")" == 700 && "$(stat -c '%a' "$ROOT/releases")" == 700 && "$(stat -c '%a' "$ROOT/$REL")" == 700 ]] \
  && cmp -s "$REPO_DIR/infra/caddy/Caddyfile" "$ROOT/$REL/infra/caddy/Caddyfile" \
  && [[ -f "$ROOT/data/history-transfer/historical_candles_EURUSD.csv.gz" ]] \
  && [[ "$(readlink "$ROOT/$REL/infra/.env.prod")" == ../../../infra/.env.prod ]] \
  && [[ "$(readlink "$ROOT/$REL/infra/.env.demo-users")" == ../../../infra/.env.demo-users ]] \
  && [[ "$(readlink "$ROOT/$REL/data")" == ../../data && -f "$ROOT/$REL/data/history-transfer/manifest.json" ]] \
  && [[ "$(sed -n 1p "$ROOT/$REL/release")" == "commit $COMMIT" && "$(sed -n 2p "$ROOT/$REL/release")" == "prefix $PREFIX" ]] \
  && grep -qE '^fetched [0-9]{8}T[0-9]{6}Z$' "$ROOT/$REL/release" && [[ "$(stat -c '%a' "$ROOT/$REL/release")" == 600 ]] \
  && [[ ! -e "$ROOT/current" && ! -e "$ROOT/staged-commit" && ! -e "$ROOT/infra/docker-compose.prod.yml" ]] \
  && [[ ! -e "$ROOT/.incoming/20261111T093000Z" ]]; then
  pass "fetch: installs the config as releases/<commit> (root, 600/700, links to the shared secrets and data), the history shared"
else fail "fetch: good bundle (rc $rc)"; show; find "$ROOT" >&2; fi
# The ops container mounts data/history-transfer and reads it as `node` (uid 1000), never crossing the
# root-only parents: read from inside the directory, as that uid
ops_reads() { (cd "$ROOT/data/history-transfer" && setpriv --reuid=1000 --regid=1000 --clear-groups cat manifest.json) >/dev/null 2>&1; }
history_modes() {
  [[ "$(stat -c '%U %a' "$ROOT/data/history-transfer")" == "root 755" ]] &&
    [[ -z "$(find "$ROOT/data/history-transfer" -type f ! -perm 0644)" ]] &&
    [[ "$(stat -c '%a' "$ROOT/$REL/infra/caddy/Caddyfile")" == 600 && "$(stat -c '%a' "$ROOT/data")" == 700 ]]
}
if history_modes && ops_reads; then
  pass "fetch: history dir 755, files 644, readable by the ops user (uid 1000); config stays 600"
else fail "fetch: history modes"; ls -la "$ROOT/data/history-transfer" >&2; fi
# A history fetched by the Phase 3 fetch.sh (700/600) is corrected by the next fetch
chmod 700 "$ROOT/data/history-transfer"
chmod 600 "$ROOT"/data/history-transfer/*
t fetch.sh "$BUCKET" "$PREFIX" "$REGION"
if [[ $rc -eq 0 ]] && history_modes && ops_reads; then pass "fetch: corrects a history installed 700/600"
else fail "fetch: legacy history modes (rc $rc)"; show; fi
before="$(cd "$ROOT" && find . -type f -not -path './.incoming/*' | sort | xargs sha256sum)"
t fetch.sh "$BUCKET" "$PREFIX" "$REGION"
if [[ $rc -eq 0 && "$(cd "$ROOT" && find . -type f -not -path './.incoming/*' | sort | xargs sha256sum)" == "$before" ]]; then
  pass "fetch: again on the same prefix changes nothing"
else fail "fetch: idempotent (rc $rc)"; show; fi

# A release is never changed: the same commit with another config file is refused, the release untouched
dir="$STUB/s3/$BUCKET/$PREFIX"
printf '# changed\n' >>"$dir/infra/caddy/Caddyfile"
(cd "$dir" && { echo "# commit $COMMIT"; find infra data -type f | sort | xargs sha256sum; } >manifest.sha256)
t fetch.sh "$BUCKET" "$PREFIX" "$REGION"
if [[ $rc -ne 0 ]] && has "release $COMMIT exists with a different infra/caddy/Caddyfile" \
  && cmp -s "$REPO_DIR/infra/caddy/Caddyfile" "$ROOT/$REL/infra/caddy/Caddyfile"; then
  pass "fetch: refuses to change a fetched release"
else fail "fetch: changed release (rc $rc)"; show; fi

# Each refusal: on a fresh root nothing may be installed: no release, no history
refused() {
  local what="$1" expected="$2"
  new_root refused
  t fetch.sh "$BUCKET" "$PREFIX" "$REGION"
  if [[ $rc -ne 0 ]] && has "$expected" && [[ ! -e "$ROOT/releases" && ! -e "$ROOT/data" ]]; then
    pass "fetch: refuses $what, installs nothing"
  else fail "fetch: $what (rc $rc)"; show; fi
}
make_bundle "$COMMIT"
printf 'tampered' >>"$STUB/s3/$BUCKET/${PREFIX}infra/caddy/Caddyfile"
refused "a sha256 mismatch" "sha256 mismatch"
make_bundle "$COMMIT"
echo "extra" >"$STUB/s3/$BUCKET/${PREFIX}infra/vm/extra.sh"
refused "a file the manifest doesn't list" "files the manifest doesn't list: infra/vm/extra.sh"
make_bundle "$COMMIT"
mkdir -p "$STUB/s3/$BUCKET/${PREFIX}infra" && echo "DB_PASS=x" >"$STUB/s3/$BUCKET/${PREFIX}infra/.env.prod"
echo "$(sha256sum <"$STUB/s3/$BUCKET/${PREFIX}infra/.env.prod" | cut -d' ' -f1)  infra/.env.prod" >>"$STUB/s3/$BUCKET/${PREFIX}manifest.sha256"
refused "a path outside the allowed set (.env.prod)" "path not allowed: infra/.env.prod"
make_bundle "$COMMIT"
manifest_edit 's|  infra/caddy/Caddyfile|  ../../etc/cron.d/x|'
refused "a path that leaves the root" "path not allowed: ../../etc/cron.d/x"
make_bundle "$COMMIT"
manifest_edit '/^# commit /d'
refused "a manifest without its commit" "no single '# commit <sha>' line"
make_bundle "$COMMIT"
manifest_edit '/infra\/caddy\/Caddyfile/d'
rm "$STUB/s3/$BUCKET/${PREFIX}infra/caddy/Caddyfile"
refused "a bundle without the Caddyfile" "infra/caddy/Caddyfile is missing"
new_root args
bad=0
for args in "other-bucket $PREFIX $REGION" "$BUCKET transfer/../x/ $REGION" "$BUCKET $PREFIX nowhere" "$BUCKET $PREFIX"; do
  # shellcheck disable=SC2086  # the words of each case are its arguments
  t fetch.sh $args
  [[ $rc -ne 0 && ! -s "$STUB/calls.log" ]] || bad=1
done
if [[ $bad -eq 0 ]]; then pass "fetch: bad bucket, prefix, region or argument count refused before any AWS call"
else fail "fetch: bad arguments"; fi

# ── make-env ─────────────────────────────────────────────────────────────────────────────────────────
make_bundle "$COMMIT"
new_root env
t fetch.sh "$BUCKET" "$PREFIX" "$REGION"
ENV_ARGS=(DOMAIN=forexedge.tech IMAGE_REGISTRY=123456789012.dkr.ecr.ap-south-1.amazonaws.com/forexedge
  S3_BUCKET=forexedge-results-123456789012 AWS_REGION=ap-south-1 "DEMO_USERS=demo,demo_two")
t make-env.sh "${ENV_ARGS[@]}" "IMAGE_TAG=$OTHER"
if [[ $rc -ne 0 ]] && has "has no fetched release" && [[ ! -e "$ROOT/infra/.env.prod" ]]; then
  pass "make-env: refuses a tag without a fetched release"
else fail "make-env: other tag (rc $rc)"; show; fi
bad=0
for a in DOMAIN=forexedge DEMO_USERS=de "DEMO_USERS=demo,DEMO" IMAGE_REGISTRY=evil.example.com/forexedge S3_BUCKET=other NOPE=1; do
  t make-env.sh "${ENV_ARGS[@]}" "IMAGE_TAG=$COMMIT" "$a"
  [[ $rc -ne 0 && ! -e "$ROOT/infra/.env.prod" ]] || { bad=1; echo "  not refused: $a" >&2; }
done
t make-env.sh DOMAIN=forexedge.tech "IMAGE_TAG=$COMMIT"
[[ $rc -ne 0 ]] || bad=1
if [[ $bad -eq 0 ]]; then pass "make-env: refuses bad, repeated, unknown or missing arguments"; else fail "make-env: bad arguments"; fi

t make-env.sh "${ENV_ARGS[@]}" "IMAGE_TAG=$COMMIT"
E="$ROOT/infra/.env.prod"
D="$ROOT/infra/.env.demo-users"
val() { sed -n "s/^$1=//p" "$2"; }
ok=true
[[ $rc -eq 0 && "$(stat -c '%U %a' "$E")" == "root 600" && "$(stat -c '%U %a' "$D")" == "root 600" ]] || ok=false
for v in DB_PASS ML_DB_PASS RESEARCH_DB_PASS REPLAY_DB_PASS REDIS_PASS; do
  [[ "$(val "$v" "$E")" =~ ^[A-Za-z0-9]{40}$ ]] || { ok=false; echo "  $v is not 40 of [A-Za-z0-9]" >&2; }
done
for v in JWT_ACCESS_SECRET JWT_REFRESH_SECRET; do
  [[ "$(val "$v" "$E")" =~ ^[A-Za-z0-9]{64}$ ]] || { ok=false; echo "  $v is not 64 of [A-Za-z0-9]" >&2; }
done
secrets_written="$(grep -E '^[A-Z_]+(_PASS|_SECRET)=' "$E" | cut -d= -f2-)"
[[ "$(sort <<<"$secrets_written" | uniq -d)" == "" && "$(wc -l <<<"$secrets_written")" -eq 7 ]] || { ok=false; echo "  secrets not 7 distinct values" >&2; }
for v in $(grep -oE '\$\{[A-Z0-9_]+:\?\}' "$REPO_DIR/infra/docker-compose.prod.yml" | sed 's/^..//; s/:?}$//' | sort -u) \
  IMAGE_REGISTRY IMAGE_TAG STORAGE AWS_REGION S3_BUCKET GROQ_API_KEY DEMO_USERS; do
  [[ -n "$(val "$v" "$E")" ]] || { ok=false; echo "  $v missing from .env.prod" >&2; }
done
[[ "$(val GROQ_API_KEY "$E")" == __SET_WITH_SET_SECRET__ && "$(val STORAGE "$E")" == s3 && "$(val IMAGE_TAG "$E")" == "$COMMIT" ]] || ok=false
[[ "$(grep -c '=__SET_WITH_SET_SECRET__$' "$D")" -eq 4 ]] && grep -q '^DEMO_DEMO_TWO_PASS=' "$D" || ok=false
for s in $secrets_written; do has "$s" && { ok=false; echo "  a secret value was printed" >&2; }; done
has "DB_PASS                set" && has "GROQ_API_KEY           placeholder (set-secret.sh)" && has "DEMO_DEMO_EMAIL        placeholder" || ok=false
if [[ "$ok" == true ]]; then pass "make-env: every compose variable, random distinct secrets, root 600, names only printed"
else fail "make-env: files (rc $rc)"; show; fi
sums="$(sha256sum "$E" "$D")"
t make-env.sh "${ENV_ARGS[@]}" "IMAGE_TAG=$COMMIT"
if [[ $rc -ne 0 ]] && has "refusing to overwrite" && [[ "$(sha256sum "$E" "$D")" == "$sums" ]]; then
  pass "make-env: a second run refuses and leaves .env.prod and .env.demo-users as they were"
else fail "make-env: second run overwrote (rc $rc)"; show; fi

# ── set-secret ───────────────────────────────────────────────────────────────────────────────────────
GROQ="gsk_TestKey0123456789abcdefghijklmnop"
# shellcheck disable=SC2016  # a literal $ in the password
PASS1='DemoPass$12xyz'
PASS2='Other!Pass99Ab'
EMAIL1="demo@forexedge.tech"
secret_in() { printf '%s\n' "$@" >"$work/input"; INPUT="$work/input"; }
before="$(sha256sum "$E" "$D")"
secret_in 'short1A$'  'short1A$'
t set-secret.sh DEMO_DEMO_PASS
r1=$rc
secret_in 'alllowercase1234$'  'alllowercase1234$'
t set-secret.sh DEMO_DEMO_PASS
r2=$rc
secret_in "$PASS1" "${PASS1}x"
t set-secret.sh DEMO_DEMO_PASS
r3=$rc
secret_in "it's-Pass12\$ab" "it's-Pass12\$ab"
t set-secret.sh DEMO_DEMO_PASS
r4=$rc
secret_in "not-an-email"
t set-secret.sh DEMO_DEMO_EMAIL
r5=$rc
secret_in "$PASS1" "$PASS1"
t set-secret.sh DEMO_NOBODY_PASS
r6=$rc
t set-secret.sh DB_PASS
r7=$rc
if [[ $r1 -ne 0 && $r2 -ne 0 && $r3 -ne 0 && $r4 -ne 0 && $r5 -ne 0 && $r6 -ne 0 && $r7 -ne 0 && "$(sha256sum "$E" "$D")" == "$before" ]]; then
  pass "set-secret: refuses a short or weak password, two different entries, a quote, a bad email, unknown names"
else fail "set-secret: refusals ($r1 $r2 $r3 $r4 $r5 $r6 $r7)"; fi

others="$(grep -v '^GROQ_API_KEY=' "$E")"
secret_in "$GROQ"
t set-secret.sh GROQ_API_KEY
if [[ $rc -eq 0 ]] && has "GROQ_API_KEY set" && has "replaced the placeholder" && ! has "$GROQ" \
  && grep -qx "GROQ_API_KEY='$GROQ'" "$E" && [[ "$(grep -v '^GROQ_API_KEY=' "$E")" == "$others" ]] \
  && [[ "$(stat -c '%U %a' "$E")" == "root 600" ]]; then
  pass "set-secret: GROQ_API_KEY replaced (single-quoted, root 600), nothing else changed, value not printed"
else fail "set-secret: GROQ_API_KEY (rc $rc)"; show; fi
ok=true
for pair in "DEMO_DEMO_EMAIL=$EMAIL1" "DEMO_DEMO_TWO_EMAIL=two@forexedge.tech"; do
  secret_in "${pair#*=}"
  t set-secret.sh "${pair%%=*}"
  [[ $rc -eq 0 ]] && ! has "${pair#*=}" || ok=false
done
for pair in "DEMO_DEMO_PASS=$PASS1" "DEMO_DEMO_TWO_PASS=$PASS2"; do
  secret_in "${pair#*=}" "${pair#*=}"
  t set-secret.sh "${pair%%=*}"
  [[ $rc -eq 0 ]] && ! has "${pair#*=}" || ok=false
done
grep -qx "DEMO_DEMO_PASS='$PASS1'" "$D" && ! grep -q __SET_WITH_SET_SECRET__ "$D" || ok=false
secret_in "$GROQ"
t set-secret.sh GROQ_API_KEY
has "replaced an earlier value" || ok=false
INPUT=/dev/null
if [[ "$ok" == true ]]; then pass "set-secret: demo emails and passwords set (asked twice), a second set replaces the earlier value"
else fail "set-secret: demo users"; show; fi

# ── stack ────────────────────────────────────────────────────────────────────────────────────────────
# shellcheck disable=SC2016  # literal ${...} in the pattern
compose_apps="$(sed -n 's|^ *image: \${IMAGE_REGISTRY:-forexedge}/\([a-z-]*\):\${IMAGE_TAG:-local}$|\1|p' "$REPO_DIR/infra/docker-compose.prod.yml" | grep -vx ops | sort)"
apps_of() { sed -n 's/^\(NODE_APPS\|PYTHON_APPS\)=(\(.*\))$/\2/p' "$1" | tr ' ' '\n' | sort; }
stack_apps="$(apps_of "$VM/stack.sh" | cut -d: -f1)"
if [[ -n "$compose_apps" && "$compose_apps" == "$stack_apps" ]]; then pass "stack: probes every app of the compose file ($(wc -l <<<"$stack_apps"))"
else fail "stack: apps differ from compose"; diff <(echo "$compose_apps") <(echo "$stack_apps") >&2 || true; fi
if [[ -n "$(apps_of "$VM/deploy.sh")" && "$(apps_of "$VM/deploy.sh")" == "$(apps_of "$VM/stack.sh")" ]]; then
  pass "deploy: probes the same apps and ports as stack.sh"
else fail "deploy: apps differ from stack.sh"; diff <(apps_of "$VM/stack.sh") <(apps_of "$VM/deploy.sh") >&2 || true; fi

# The blocks each self-contained script copies (the first line names the other files, so it is left out)
shared() { sed -n '/^# ── shared with /,/^# ── end of the shared block/p' "$1" | sed 1d; }
readiness() { sed -n '/^# ── readiness, shared with /,/^# ── end of the readiness block/p' "$1" | sed 1d; }
if [[ -n "$(shared "$VM/stack.sh")" && "$(shared "$VM/stack.sh")" == "$(shared "$VM/bootstrap.sh")" \
  && "$(shared "$VM/stack.sh")" == "$(shared "$VM/deploy.sh")" \
  && "$(shared "$VM/stack.sh")" == "$(shared "$VM/restore-test.sh")" ]]; then
  pass "shared block identical in stack.sh, bootstrap.sh, deploy.sh and restore-test.sh"
else
  fail "shared block of stack.sh, bootstrap.sh, deploy.sh and restore-test.sh differs"
  diff <(shared "$VM/stack.sh") <(shared "$VM/bootstrap.sh") >&2 || true
  diff <(shared "$VM/stack.sh") <(shared "$VM/deploy.sh") >&2 || true
  diff <(shared "$VM/stack.sh") <(shared "$VM/restore-test.sh") >&2 || true
fi
if [[ -n "$(readiness "$VM/stack.sh")" && "$(readiness "$VM/stack.sh")" == "$(readiness "$VM/deploy.sh")" ]]; then
  pass "readiness block identical in stack.sh and deploy.sh"
else fail "readiness block of stack.sh and deploy.sh differs"; diff <(readiness "$VM/stack.sh") <(readiness "$VM/deploy.sh") >&2 || true; fi

: >"$STUB/calls.log"
t stack.sh up "$OTHER"
if [[ $rc -ne 0 ]] && has "no release for $OTHER" && ! grep -q '^docker' "$STUB/calls.log"; then
  pass "stack: refuses a tag without a release, before any docker call"
else fail "stack: other tag (rc $rc)"; show; fi
t bootstrap.sh "$OTHER"
if [[ $rc -ne 0 ]] && has "no release for $OTHER" && ! grep -q '^docker' "$STUB/calls.log"; then
  pass "bootstrap: refuses a tag without a release, before any docker call"
else fail "bootstrap: other tag (rc $rc)"; show; fi
# A release directory whose record names another commit (copied by hand, say) is refused too
mkdir -p "$ROOT/releases/$OTHER"
printf 'commit %s\nprefix x\n' "$COMMIT" >"$ROOT/releases/$OTHER/release"
t stack.sh ps "$OTHER"
if [[ $rc -ne 0 ]] && has "release $OTHER records commit $COMMIT" && ! grep -q '^docker' "$STUB/calls.log"; then
  pass "stack: refuses a release whose record names another commit"
else fail "stack: release record (rc $rc)"; show; fi
rm -rf "${ROOT:?}/releases/$OTHER"

cp "$E" "$work/env.saved"
sed -i "s|^GROQ_API_KEY=.*|GROQ_API_KEY=__SET_WITH_SET_SECRET__|" "$E"
t stack.sh up "$COMMIT"
if [[ $rc -ne 0 ]] && has "still placeholders (set them with set-secret.sh): GROQ_API_KEY" && ! grep -q '^docker' "$STUB/calls.log"; then
  pass "stack: up refuses while a secret is a placeholder (names it)"
else fail "stack: placeholders (rc $rc)"; show; fi
cp "$work/env.saved" "$E"
chmod 644 "$E"
t stack.sh ps "$COMMIT"
if [[ $rc -ne 0 ]] && has "must be owned by root with mode 600"; then pass "stack: refuses an env file others can read"
else fail "stack: env file mode (rc $rc)"; show; fi
chmod 600 "$E"

t stack.sh up "$COMMIT"
redis_pass="$(val REDIS_PASS "$E")"
if [[ $rc -eq 0 ]] && has "ready: all 9 apps answer /health/ready with 200" && has "redis-server --requirepass ***" \
  && ! has "$redis_pass" && ! has "$ECR_TOKEN" && [[ "$(cat "$STUB/login-stdin")" == "$ECR_TOKEN" ]] \
  && grep -q "docker login --username AWS --password-stdin 123456789012.dkr.ecr.ap-south-1.amazonaws.com" "$STUB/calls.log" \
  && ! grep -qF "$ECR_TOKEN" "$STUB/calls.log"; then
  pass "stack: up logs in (token on stdin only), redacts a secret the stack prints, waits until ready"
else fail "stack: up (rc $rc)"; show; fi
# The first up on a fresh host makes its release current; after that up accepts only current's tag, and a
# Phase 3 layout without current is left to deploy.sh's adoption
first_ok=false
if has "current -> $COMMIT (first start)" && [[ "$(readlink "$ROOT/current")" == "releases/$COMMIT" ]]; then first_ok=true; fi
mkdir -p "$ROOT/releases/$OTHER"
cp -a "$ROOT/releases/$COMMIT/infra" "$ROOT/releases/$OTHER/"
printf 'commit %s\nprefix x\nfetched 20261111T000000Z\n' "$OTHER" >"$ROOT/releases/$OTHER/release"
: >"$STUB/calls.log"
t stack.sh up "$OTHER"
r1=$rc
other_ok=false
if has "current is $COMMIT, not $OTHER: change releases with deploy.sh" && ! grep -q '^docker' "$STUB/calls.log"; then other_ok=true; fi
rm -rf "${ROOT:?}/releases/$OTHER"
mv "$ROOT/current" "$work/current.saved"
cp "$ROOT/releases/$COMMIT/infra/docker-compose.prod.yml" "$ROOT/infra/docker-compose.prod.yml"
t stack.sh up "$COMMIT"
rm -f "$ROOT/infra/docker-compose.prod.yml"
mv "$work/current.saved" "$ROOT/current"
if [[ "$first_ok" == true && $r1 -ne 0 && "$other_ok" == true && $rc -ne 0 ]] && has "the Phase 3 layout is still in place"; then
  pass "stack: the first up makes its release current; then only current's tag; a Phase 3 layout is left to deploy.sh"
else fail "stack: current release ($first_ok $r1 $other_ok $rc)"; show; fi

echo 503 >"$STUB/ready/ml-service"
t stack.sh ready "$COMMIT"
if [[ $rc -ne 0 ]] && has "not ready after 2 s: ml-service" && has "ml-service 503"; then
  pass "stack: an app that stays unready fails after the limit, named"
else fail "stack: unready (rc $rc)"; show; fi
rm -f "$STUB/ready/ml-service"
t stack.sh stats "$COMMIT"
if [[ $rc -eq 0 ]] && has "forexedge-redis-1" && has "used_memory_human:2.12M" && has "Swap:"; then pass "stack: stats"
else fail "stack: stats (rc $rc)"; show; fi

# ── bootstrap ────────────────────────────────────────────────────────────────────────────────────────
rm -f "$STUB/loaded" "$STUB/ops.log"
t bootstrap.sh "$COMMIT"
db_pass="$(val DB_PASS "$E")"
if [[ $rc -eq 0 ]] && has "stopped at the history check, as expected" && has "importing" \
  && has "check-only: ok" && has "validate: ok" && has "bootstrap-2: ok" && has "bootstrap: done" \
  && [[ "$(grep -c 'data:transfer -- import' "$STUB/ops.log")" -eq 1 ]] && ! has "$db_pass" \
  && grep -q 'password \*\*\*' "$ROOT"/logs/bootstrap-*-bootstrap-2.log && ! grep -rqF "$db_pass" "$ROOT/logs" \
  && [[ "$(stat -c '%a' "$ROOT/logs")" == 700 ]]; then
  pass "bootstrap: the whole sequence on an empty database, logs redacted"
else fail "bootstrap: fresh (rc $rc)"; show; fi
: >"$STUB/ops.log"
t bootstrap.sh "$COMMIT"
if [[ $rc -eq 0 ]] && has "already loaded and identical" && ! grep -q 'data:transfer -- import' "$STUB/ops.log"; then
  pass "bootstrap: again on a loaded database, no import"
else fail "bootstrap: rerun (rc $rc)"; show; fi
touch "$STUB/fail-validate"
: >"$STUB/ops.log"
t bootstrap.sh "$COMMIT"
if [[ $rc -ne 0 ]] && has "data:validate failed" && has "validate: 1 check failed" && has "line 30" && ! has "line 5" \
  && [[ "$(grep -c bootstrap-prod "$STUB/ops.log")" -eq 1 ]]; then
  pass "bootstrap: stops at the first failure, with the step's last 20 lines"
else fail "bootstrap: failing step (rc $rc)"; show; fi
rm -f "$STUB/fail-validate"
touch "$STUB/fail-migrations"
: >"$STUB/ops.log"
t bootstrap.sh "$COMMIT"
if [[ $rc -ne 0 ]] && has "bootstrap failed before the history check" && [[ "$(wc -l <"$STUB/ops.log")" -eq 1 ]]; then
  pass "bootstrap: a failure before the history check stops everything"
else fail "bootstrap: migrations failing (rc $rc)"; show; fi
rm -f "$STUB/fail-migrations"

# bootstrap --deploy (deploy.sh, before the switch): the ops image only, bootstrap-prod.ts once with
# --no-deps, nothing started, recreated or stopped, no history step
touch "$STUB/loaded"
: >"$STUB/calls.log"
rm -f "$STUB/run.log" "$STUB/compose.log"
t bootstrap.sh "$COMMIT" --deploy
if [[ $rc -eq 0 ]] && has "deploy: ok" && has "bootstrap --deploy: done" \
  && [[ "$(cat "$STUB/run.log")" == "run --rm -T --no-deps npx ts-node --transpile-only tools/ops/bootstrap-prod.ts" ]] \
  && grep -qE '^docker compose .* pull --quiet ops$' "$STUB/calls.log" && [[ ! -e "$STUB/compose.log" ]] \
  && ! grep -qE '^docker compose .* (up|down|stop|restart|rm)( |$)' "$STUB/calls.log"; then
  pass "bootstrap --deploy: pulls ops, runs bootstrap-prod.ts once with --no-deps, touches no service"
else fail "bootstrap --deploy (rc $rc)"; show; cat "$STUB/run.log" >&2 || true; fi
rm -f "$STUB/loaded"
t bootstrap.sh "$COMMIT" --deploy
r1=$rc
touch "$STUB/loaded"
t bootstrap.sh "$COMMIT" --history
if [[ $r1 -ne 0 && $rc -eq 2 ]]; then pass "bootstrap --deploy: fails when bootstrap-prod.ts fails; an unknown flag is a usage error"
else fail "bootstrap --deploy failure/usage ($r1 $rc)"; fi

# ── deploy ───────────────────────────────────────────────────────────────────────────────────────────
PREV="2222222222222222222222222222222222222222"
REGISTRY="123456789012.dkr.ecr.ap-south-1.amazonaws.com/forexedge"
ENV_ROOT="$ROOT" # every secret set, $COMMIT fetched
# make_release ROOT TAG FETCHED: a release as fetch.sh leaves it, with $COMMIT's config
make_release() {
  local r="$1/releases/$2"
  mkdir -p "$r"
  cp -a "$ENV_ROOT/releases/$COMMIT/infra" "$r/"
  ln -sfn ../../data "$r/data"
  printf 'commit %s\nprefix transfer/20261101T000000Z/\nfetched %s\n' "$2" "$3" >"$r/release"
}
# deploy_root NAME: $PREV runs (current, IMAGE_TAG), $COMMIT is fetched; every injected failure cleared
deploy_root() {
  new_root "deploy-$1"
  install -d -m 0700 "$ROOT" "$ROOT/infra" "$ROOT/releases"
  install -m 0600 "$ENV_ROOT/infra/.env.prod" "$ENV_ROOT/infra/.env.demo-users" "$ROOT/infra/"
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$PREV/" "$ROOT/infra/.env.prod"
  cp -a "$ENV_ROOT/releases/$COMMIT" "$ROOT/releases/"
  make_release "$ROOT" "$PREV" 20261101T000000Z
  ln -s "releases/$PREV" "$ROOT/current"
  rm -f "$STUB"/fail-* "$STUB"/unready-* "$STUB/compose.log" "$STUB/run.log" "$STUB/images" "$STUB/images-removed" \
    "$STUB/mounts" "$STUB/running-images" "$STUB/tables" "$STUB/pgdump.args" "$STUB/prereq.query"
  rm -rf "$STUB/s3/$BUCKET/predeploy"
  touch "$STUB/loaded"
}
current_is() { [[ "$(readlink "$ROOT/current")" == "releases/$1" ]]; }
env_tag() { sed -n 's/^IMAGE_TAG=//p' "$ROOT/infra/.env.prod"; }
up_line() { echo "up releases/$1/infra/docker-compose.prod.yml $1"; }
no_switch() { current_is "$PREV" && [[ ! -e "$STUB/compose.log" ]] && [[ "$(env_tag)" == "$PREV" ]]; }

deploy_root ok
t deploy.sh "$COMMIT" "$BUCKET"
dump="$(find "$STUB/s3/$BUCKET/predeploy" -name "*-$COMMIT.sql.gz" 2>/dev/null)"
n_dump="$(grep -n 'timescaledb sh -c pg_dump' "$STUB/calls.log" | cut -d: -f1 | head -1)"
n_boot="$(grep -n ' run --rm -T --no-deps ops' "$STUB/calls.log" | cut -d: -f1 | head -1)"
n_up="$(grep -n ' up -d ' "$STUB/calls.log" | cut -d: -f1 | head -1)"
if [[ $rc -eq 0 ]] && has "deploy-result: deployed" && has "deploy-tag: $COMMIT" && has "deploy-previous: $PREV" \
  && current_is "$COMMIT" && [[ "$(cat "$STUB/compose.log")" == "$(up_line "$COMMIT")" ]] \
  && [[ "$(env_tag)" == "$COMMIT" && "$(stat -c '%U %a' "$ROOT/infra/.env.prod")" == "root 600" ]] \
  && grep -q " $COMMIT deployed (previous $PREV)$" "$ROOT/deploys.log" \
  && [[ -n "$dump" && "$(wc -l <<<"$dump")" -eq 1 ]] && gzip -dc "$dump" | grep -q 'PostgreSQL database dump complete' \
  && has "backup: s3://$BUCKET/predeploy/" && has "bytes gzip, 3 tables: account_summary orders users" \
  && ! has "row-only-in-the-dump" \
  && [[ "$(cat "$STUB/pgdump.args")" == "-t public.account_summary -t public.orders -t public.users" ]] \
  && [[ -n "$n_dump" && -n "$n_boot" && -n "$n_up" ]] && ((n_dump < n_boot && n_boot < n_up)); then
  pass "deploy: backup, then bootstrap --deploy, then up of the new release by its path; IMAGE_TAG and deploys.log"
else fail "deploy: success (rc $rc; order $n_dump $n_boot $n_up)"; show; fi
# The dump stands alone: the header, then the extension and every enum type before the first table
first_line() { { gzip -dc "$dump" 2>/dev/null || true; } | grep -n -m 1 -E "$1" | cut -d: -f1 || true; }
n_ext="$(first_line '^CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')"
n_role="$(first_line 'CREATE TYPE public\.users_role_enum ')"
n_status="$(first_line 'CREATE TYPE public\.users_status_enum ')"
n_table="$(first_line '^CREATE TABLE ')"
if [[ -n "$DUMP_HEADER" && "$({ gzip -dc "$dump" 2>/dev/null || true; } | head -n 1)" == "$DUMP_HEADER" ]] \
  && [[ -n "$n_ext" && -n "$n_role" && -n "$n_status" && -n "$n_table" ]] && ((n_ext < n_table && n_role < n_table && n_status < n_table)) \
  && grep -q "^SET search_path = ''; " "$STUB/prereq.query" && grep -qF "IN ('account_summary','orders','users')" "$STUB/prereq.query" \
  && has "backup: self-contained: 1 extensions, 2 enum types and domains before the tables"; then
  pass "deploy: the dump is self-contained (header, then the extensions and enum types of the dumped tables, then pg_dump)"
else fail "deploy: self-contained dump (ext $n_ext, types $n_role $n_status, first table $n_table)"; show; fi

deploy_root drill
t deploy.sh "$COMMIT" "$BUCKET" --simulate-failure
if [[ $rc -eq 3 ]] && has "simulated failure" && has "rolled back to $PREV" && has "deploy-result: rolled-back" \
  && current_is "$PREV" && [[ "$(cat "$STUB/compose.log")" == "$(up_line "$COMMIT")"$'\n'"$(up_line "$PREV")" ]] \
  && [[ "$(env_tag)" == "$PREV" ]] && grep -q " $COMMIT rolled back to $PREV$" "$ROOT/deploys.log"; then
  pass "deploy --simulate-failure: real up, then the previous release up with ITS compose file and tag; exit 3"
else fail "deploy: simulated failure (rc $rc)"; show; cat "$STUB/compose.log" >&2; fi

deploy_root unready
touch "$STUB/unready-$COMMIT"
t deploy.sh "$COMMIT" "$BUCKET"
r1=$rc
ok1=false
if has "not ready after 2 s" && current_is "$PREV"; then ok1=true; fi
deploy_root upfails
touch "$STUB/fail-up-$COMMIT"
t deploy.sh "$COMMIT" "$BUCKET"
if [[ $r1 -eq 3 && "$ok1" == true && $rc -eq 3 ]] && has "up of $COMMIT failed" && has "rolled back to $PREV" \
  && current_is "$PREV" && [[ "$(tail -n 1 "$STUB/compose.log")" == "$(up_line "$PREV")" ]]; then
  pass "deploy: a release that stays unready, or whose up fails, is rolled back (exit 3)"
else fail "deploy: real failures ($r1 $rc)"; show; fi

deploy_root rollbackfails
touch "$STUB/unready-$COMMIT" "$STUB/unready-$PREV"
t deploy.sh "$COMMIT" "$BUCKET"
if [[ $rc -eq 4 ]] && has "ROLLBACK FAILED" && has "deploy-result: rollback-failed" && current_is "$PREV" \
  && grep -q " $COMMIT ROLLBACK FAILED (previous $PREV)$" "$ROOT/deploys.log" \
  && [[ "$(grep -c '^up ' "$STUB/compose.log")" -eq 2 ]]; then
  pass "deploy: a rollback that fails too exits 4 with ROLLBACK FAILED and tries nothing more"
else fail "deploy: rollback failure (rc $rc)"; show; fi

deploy_root refused
t deploy.sh "$OTHER" "$BUCKET"
r1=$rc
ok1=false
if has "no release for $OTHER"; then ok1=true; fi
mkdir -p "$ROOT/releases/$OTHER"
printf 'commit %s\nprefix x\nfetched 20261111T000000Z\n' "$COMMIT" >"$ROOT/releases/$OTHER/release"
t deploy.sh "$OTHER" "$BUCKET"
if [[ $r1 -eq 1 && "$ok1" == true && $rc -eq 1 ]] && has "release $OTHER records commit $COMMIT" && no_switch \
  && ! grep -q '^docker' "$STUB/calls.log"; then
  pass "deploy: refuses a tag without a release, or whose release records another commit, before any docker call"
else fail "deploy: refusals ($r1 $rc)"; show; fi

bad=0
for failure in fail-psql fail-prereq fail-pgdump fail-upload empty-tables; do
  deploy_root "backup-$failure"
  if [[ "$failure" == empty-tables ]]; then : >"$STUB/tables"; else touch "$STUB/$failure"; fi
  t deploy.sh "$COMMIT" "$BUCKET"
  case "$failure" in
    fail-psql) expected="could not list the app tables" ;;
    fail-prereq) expected="could not read the prerequisites of the app tables" ;;
    fail-pgdump) expected="pg_dump failed" ;;
    fail-upload) expected="upload to s3://$BUCKET/predeploy/" ;;
    empty-tables) expected="no app table found" ;;
  esac
  if [[ $rc -ne 1 ]] || ! has "$expected" || ! no_switch || [[ -e "$STUB/run.log" ]]; then
    bad=1
    echo "  $failure: rc $rc" >&2
    show
  fi
done
if [[ $bad -eq 0 ]] && grep -q 'query failed for password \*\*\*' "$work/all-output"; then
  pass "deploy: a failed backup (tables, prerequisites, pg_dump, upload, no table) stops before bootstrap and the switch; stderr redacted"
else fail "deploy: backup failures"; fi

deploy_root bootstrapfails
rm -f "$STUB/loaded"
t deploy.sh "$COMMIT" "$BUCKET"
if [[ $rc -eq 1 ]] && has "bootstrap --deploy failed: nothing switched, $PREV still runs" && no_switch; then
  pass "deploy: a failed bootstrap --deploy stops before the switch"
else fail "deploy: bootstrap failure (rc $rc)"; show; fi

deploy_root args
t deploy.sh "$COMMIT" forexedge-results-123456789012
r1=$rc
t deploy.sh "$COMMIT" "$BUCKET" --simulate
if [[ $r1 -eq 1 && $rc -eq 2 ]] && no_switch && ! grep -q '^docker' "$STUB/calls.log"; then
  pass "deploy: another bucket refused, an unknown flag is a usage error"
else fail "deploy: arguments ($r1 $rc)"; fi

# Adoption: the Phase 3 layout (config in /opt/forexedge/infra, staged-commit) with $PREV running
legacy_root() {
  deploy_root "$1"
  rm -rf "${ROOT:?}/current" "${ROOT:?}/releases/$PREV"
  mkdir -p "$ROOT/infra/caddy" "$ROOT/infra/vm"
  cp "$ENV_ROOT/releases/$COMMIT/infra/docker-compose.prod.yml" "$ROOT/infra/"
  cp "$ENV_ROOT/releases/$COMMIT/infra/caddy/Caddyfile" "$ROOT/infra/caddy/"
  cp "$ENV_ROOT/releases/$COMMIT"/infra/vm/*.sh "$ROOT/infra/vm/"
  printf 'commit %s\nprefix transfer/20261111T093000Z/\n' "$PREV" >"$ROOT/staged-commit"
  printf '%s\n' "$REGISTRY/auth-service:$PREV" "$REGISTRY/frontend:$PREV" timescale/timescaledb:2.27.0-pg16 caddy:2.10.2-alpine \
    >"$STUB/running-images"
  echo "$ROOT/infra/caddy/Caddyfile" >"$STUB/mounts"
}
legacy_root adopt
touch "$STUB/fail-pgdump"
t deploy.sh "$COMMIT" "$BUCKET"
if [[ $rc -eq 1 ]] && has "adopted the running deployment $PREV as releases/$PREV (no container touched)" && current_is "$PREV" \
  && [[ "$(sed -n 1p "$ROOT/releases/$PREV/release")" == "commit $PREV" ]] \
  && cmp -s "$ROOT/infra/docker-compose.prod.yml" "$ROOT/releases/$PREV/infra/docker-compose.prod.yml" \
  && cmp -s "$ROOT/infra/caddy/Caddyfile" "$ROOT/releases/$PREV/infra/caddy/Caddyfile" \
  && [[ "$(readlink "$ROOT/releases/$PREV/infra/.env.prod")" == ../../../infra/.env.prod ]] \
  && grep -q " $PREV adopted$" "$ROOT/deploys.log" \
  && ! grep -qE '^docker compose .* (up|down|stop|restart|rm|run)( |$)' "$STUB/calls.log"; then
  pass "deploy: adopts the running Phase 3 deployment as a release (copies, no container touched)"
else fail "deploy: adoption (rc $rc)"; show; fi
rm -f "$STUB/fail-pgdump"
t deploy.sh "$COMMIT" "$BUCKET"
r1=$rc
ok1=false
if has "deploy-result: deployed" && has "legacy files kept: a container still mounts" && [[ -f "$ROOT/infra/caddy/Caddyfile" ]]; then ok1=true; fi
echo "$ROOT/releases/$COMMIT/infra/caddy/Caddyfile" >"$STUB/mounts"
t deploy.sh "$COMMIT" "$BUCKET"
if [[ $r1 -eq 0 && "$ok1" == true && $rc -eq 0 ]] && has "deploy-previous: $COMMIT" && has "removed the Phase 3 copies" \
  && [[ ! -e "$ROOT/infra/docker-compose.prod.yml" && ! -e "$ROOT/infra/caddy" && ! -e "$ROOT/infra/vm" && ! -e "$ROOT/staged-commit" ]] \
  && [[ -f "$ROOT/infra/.env.prod" && -f "$ROOT/infra/.env.demo-users" && -d "$ROOT/releases/$PREV" ]]; then
  pass "deploy: the legacy copies stay while mounted, then go; the same tag again rolls forward onto itself"
else fail "deploy: legacy removal ($r1 $rc)"; show; fi

legacy_root adopt-refused
printf '%s\n' "$REGISTRY/auth-service:$PREV" "$REGISTRY/frontend:$OTHER" >"$STUB/running-images"
t deploy.sh "$COMMIT" "$BUCKET"
r1=$rc
ok1=false
if has "cannot adopt: running images are not all $PREV: $REGISTRY/frontend:$OTHER"; then ok1=true; fi
legacy_root adopt-refused-tag
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$OTHER/" "$ROOT/infra/.env.prod"
t deploy.sh "$COMMIT" "$BUCKET"
if [[ $r1 -eq 1 && "$ok1" == true && $rc -eq 1 ]] && has "is not IMAGE_TAG $OTHER" && [[ ! -e "$ROOT/current" && ! -e "$ROOT/releases/$PREV" ]] \
  && ! grep -qE '^docker compose .* (up|down|stop|restart|rm|run)( |$)' "$STUB/calls.log"; then
  pass "deploy: refuses to adopt when the running images or IMAGE_TAG are not the staged commit"
else fail "deploy: adoption refusals ($r1 $rc)"; show; fi

# Pruning: the newest 5 by fetch time, and always current and the previous release, however old
deploy_root prune
rm -rf "${ROOT:?}/releases/$PREV"
make_release "$ROOT" "$PREV" 20250101T000000Z
olds=()
for i in 1 2 3 4 5 6; do
  t_old="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$i"
  olds+=("$t_old")
  make_release "$ROOT" "$t_old" "2026100${i}T000000Z"
  printf '%s\n' "$REGISTRY/auth-service:$t_old" "$REGISTRY/ops:$t_old" >>"$STUB/images"
done
t deploy.sh "$COMMIT" "$BUCKET"
kept="$(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)"
expected="$(printf '%s\n' "$COMMIT" "${olds[5]}" "${olds[4]}" "${olds[3]}" "${olds[2]}" "$PREV" | sort)"
removed="$(sort "$STUB/images-removed" 2>/dev/null || true)"
expected_removed="$(printf '%s\n' "$REGISTRY/auth-service:${olds[0]}" "$REGISTRY/ops:${olds[0]}" "$REGISTRY/auth-service:${olds[1]}" "$REGISTRY/ops:${olds[1]}" | sort)"
if [[ $rc -eq 0 && "$kept" == "$expected" && "$removed" == "$expected_removed" ]] && has "releases: 6 kept, 2 pruned"; then
  pass "deploy: keeps the newest 5 releases plus the previous one, removes the others and their images"
else fail "deploy: pruning (rc $rc)"; show; echo "kept: $kept" >&2; echo "removed: $removed" >&2; fi

# ── restore-test ─────────────────────────────────────────────────────────────────────────────────────
OLD_KEY="predeploy/20261101T120000Z-$PREV.sql.gz"
NEW_KEY="predeploy/20261111T120000Z-$COMMIT.sql.gz"
# dump_sql [users rows] [kind]: a dump of three tables (account_summary 2 rows, orders 2, users $1, default
# 2; row values that must never be printed) as deploy.sh writes it: kind "full" (default) the header and the
# prerequisites first, "no-prereq" the header without them, "old" neither (a dump made before both)
dump_sql() {
  local users="${1:-2}" kind="${2:-full}" i
  if [[ "$kind" != old ]]; then printf '%s\n' "$DUMP_HEADER"; fi
  if [[ "$kind" == full ]]; then cat "$STUB/prereqs"; fi
  printf -- '-- PostgreSQL database dump\nSELECT pg_catalog.set_config('\''search_path'\'', '\'''\'', false);\n'
  printf 'CREATE TABLE public.%s (\n    id uuid DEFAULT public.uuid_generate_v4() NOT NULL\n);\n' account_summary orders
  printf 'CREATE TABLE public.users (\n    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,\n    role public.users_role_enum NOT NULL\n);\n'
  printf 'COPY public.account_summary (id) FROM stdin;\nrow-a1\nrow-a2\n\\.\n'
  printf 'COPY public.orders (id) FROM stdin;\nrow-only-in-the-dump-o1\nrow-only-in-the-dump-o2\n\\.\n'
  printf 'COPY public.users (email) FROM stdin;\n'
  for ((i = 1; i <= users; i++)); do printf 'row-only-in-the-dump-%d@example.invalid\n' "$i"; done
  printf '\\.\n-- PostgreSQL database dump complete\n'
}
# restore_root NAME: deploy_root's host ($PREV current) with an older and a newer dump and a stray object
restore_root() {
  deploy_root "restore-$1"
  rm -rf "$STUB/pg" "$STUB/live-counts"
  mkdir -p "$STUB/s3/$BUCKET/predeploy"
  dump_sql | gzip >"$STUB/s3/$BUCKET/$OLD_KEY"
  dump_sql | gzip >"$STUB/s3/$BUCKET/$NEW_KEY"
  echo "not a dump" >"$STUB/s3/$BUCKET/predeploy/zz-notes.txt"
}
created_db() { cat "$STUB/pg/created" 2>/dev/null || true; }
# Every scratch database created was dropped, and the temporary directory is gone
cleaned_up() {
  [[ "$(created_db)" == "$(cat "$STUB/pg/dropped" 2>/dev/null || true)" ]] && ! compgen -G "$STUB/pg/db-*" >/dev/null &&
    ! compgen -G "$ROOT/.restore-test.*" >/dev/null
}

restore_root ok
t restore-test.sh "$BUCKET"
restored_first="$(head -n 1 "$STUB/pg/restore-stdin" 2>/dev/null || true)"
if [[ $rc -eq 0 ]] && has "dump: s3://$BUCKET/$NEW_KEY" && has "restore-test-result: ok" && has "self-contained dump" \
  && [[ "$(created_db)" =~ ^restore_test_[0-9]{8}_[0-9]{6}$ ]] && has "dropped the scratch database $(created_db)" && cleaned_up \
  && [[ -n "$DUMP_HEADER" && "$restored_first" == "$DUMP_HEADER" ]] && ! grep -q pg_enum "$STUB/calls.log" \
  && grep -qE '^table +rows in dump-restore +rows live now$' "$work/out" \
  && grep -qE '^account_summary +2 +1  \(fewer live rows now\)$' "$work/out" \
  && grep -qE '^orders +2 +7$' "$work/out" && grep -qE '^users +2 +3$' "$work/out" \
  && has "restore test: 3 tables restored from s3://$BUCKET/$NEW_KEY, users 2 rows" && ! has "row-only-in-the-dump" \
  && grep -q "^aws s3 cp --only-show-errors --region $REGION s3://$BUCKET/$NEW_KEY $ROOT/.restore-test." "$STUB/calls.log"; then
  pass "restore-test: newest dump, only the dump restored (nothing from the live catalog), table of restored vs live rows, scratch DB and file removed"
else fail "restore-test: success (rc $rc)"; show; fi

restore_root key
t restore-test.sh "$BUCKET" "$OLD_KEY"
if [[ $rc -eq 0 ]] && has "dump: s3://$BUCKET/$OLD_KEY" && has "restore-test-result: ok" && cleaned_up; then
  pass "restore-test: restores the given key"
else fail "restore-test: given key (rc $rc)"; show; fi

bad=0
for failure in no-dump not-gzip incomplete old-dump no-prerequisites restore-error zero-tables missing-live no-users drop-fails; do
  restore_root "$failure"
  case "$failure" in
    no-dump) rm -f "$STUB/s3/$BUCKET/$OLD_KEY" "$STUB/s3/$BUCKET/$NEW_KEY"; expected="no pre-deploy dump in s3://$BUCKET/predeploy/" ;;
    not-gzip) dump_sql >"$STUB/s3/$BUCKET/$NEW_KEY"; expected="$NEW_KEY is not a valid gzip file" ;;
    incomplete) dump_sql | head -n -1 | gzip >"$STUB/s3/$BUCKET/$NEW_KEY"; expected="$NEW_KEY is incomplete" ;;
    old-dump)
      dump_sql 2 old | gzip >"$STUB/s3/$BUCKET/$NEW_KEY"
      expected="$NEW_KEY: dump is not self-contained (made before commit \"feat(step-7): self-contained pre-deploy dumps\")" ;;
    no-prerequisites)
      # The header without the prerequisites: the empty scratch database must refuse it (no copy from live)
      dump_sql 2 no-prereq | gzip >"$STUB/s3/$BUCKET/$NEW_KEY"
      expected='function public.uuid_generate_v4() does not exist' ;;
    restore-error) touch "$STUB/fail-restore"; expected='invalid input syntax for type uuid: "..." at character 9' ;;
    zero-tables)
      printf -- '%s\n-- PostgreSQL database dump\n-- PostgreSQL database dump complete\n' "$DUMP_HEADER" | gzip >"$STUB/s3/$BUCKET/$NEW_KEY"
      expected="no table restored from $NEW_KEY" ;;
    missing-live) printf 'account_summary|1\nusers|3\n' >"$STUB/live-counts"; expected="restored tables missing from the live database: orders" ;;
    no-users) dump_sql 0 | gzip >"$STUB/s3/$BUCKET/$NEW_KEY"; expected="users has no rows in the restored dump" ;;
    drop-fails) touch "$STUB/fail-dropdb"; expected="COULD NOT DROP the scratch database restore_test_" ;;
  esac
  t restore-test.sh "$BUCKET"
  # A database that could not be dropped stays (the stub keeps it); every other failure leaves nothing
  clean=true
  if [[ "$failure" != drop-fails ]] && ! cleaned_up; then clean=false; fi
  if [[ $rc -ne 1 ]] || ! has "$expected" || ! has "restore-test-result: failed" || [[ "$clean" != true ]] \
    || has "restore-test-result: ok" || has "row-only-in-the-dump" || compgen -G "$ROOT/.restore-test.*" >/dev/null; then
    bad=1
    echo "  $failure: rc $rc, clean $clean, created '$(created_db)', dropped '$(cat "$STUB/pg/dropped" 2>/dev/null || true)'" >&2
    show
  fi
done
if [[ $bad -eq 0 ]]; then
  pass "restore-test: fails on no dump, bad gzip, incomplete, not self-contained (old, or no prerequisites into the empty DB), restore error (masked), zero tables, missing live, no users, drop failure; always cleans up"
else fail "restore-test: failures"; fi

# deploy.sh's own dump, restored by restore-test.sh into an empty database
restore_root chain
rm -f "$STUB/s3/$BUCKET/$OLD_KEY" "$STUB/s3/$BUCKET/$NEW_KEY"
t deploy.sh "$COMMIT" "$BUCKET"
r1=$rc
t restore-test.sh "$BUCKET"
if [[ $r1 -eq 0 && $rc -eq 0 ]] && has "dump: s3://$BUCKET/predeploy/" && has "-$COMMIT.sql.gz" && has "self-contained dump"   && grep -qE '^users +1 +3$' "$work/out" && has "restore-test-result: ok" && cleaned_up; then
  pass "restore-test: restores the dump deploy.sh wrote into an empty database"
else fail "restore-test: deploy's dump ($r1 $rc)"; show; fi
if [[ -n "$DUMP_HEADER" && "$(grep '^DUMP_HEADER=' "$VM/deploy.sh")" == "$(grep '^DUMP_HEADER=' "$VM/restore-test.sh")" ]]; then
  pass "restore-test: the dump header is deploy.sh's"
else fail "restore-test: DUMP_HEADER differs from deploy.sh's"; fi

restore_root args
t restore-test.sh forexedge-results-123456789012
r1=$rc
t restore-test.sh "$BUCKET" "predeploy/../../etc/passwd"
r2=$rc
t restore-test.sh
if [[ $r1 -eq 1 && $r2 -eq 1 && $rc -eq 2 ]] && ! grep -qE '^(docker|aws)' "$STUB/calls.log"; then
  pass "restore-test: another bucket or a key that isn't a pre-deploy dump refused before any aws or docker call"
else fail "restore-test: arguments ($r1 $r2 $rc)"; show; fi

# ── nothing secret printed, by any script ────────────────────────────────────────────────────────────
leaks=0
while IFS= read -r s; do
  [[ -n "$s" ]] || continue
  if grep -qF -- "$s" "$work/all-output"; then leaks=$((leaks + 1)); fi
done < <(grep -hE '^[A-Z0-9_]+(_PASS|_SECRET|_KEY|_EMAIL)=' "$E" "$D" | cut -d= -f2- | tr -d "'"; echo "$ECR_TOKEN")
if [[ $leaks -eq 0 && -s "$work/all-output" ]]; then pass "no secret value or ECR token in anything printed"
else fail "$leaks secret value(s) printed"; fi

if ((failures > 0)); then echo "host scripts: $failures failed" >&2; exit 1; fi
echo "host scripts: all checks passed"
