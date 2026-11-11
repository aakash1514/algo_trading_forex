#!/usr/bin/env bash
# The host scripts of infra/vm (fetch, make-env, set-secret, stack, bootstrap) against stub `aws` and `docker`
# commands, as root in Ubuntu 24.04 (the host's OS: mawk, coreutils, real file modes). No AWS call, no
# container started. Part of npm run infra:check, which runs it in a container:
#
#   docker run --rm --mount type=bind,source=<repo>,target=/repo,readonly -w /repo <ubuntu:24.04 by digest> \
#     bash infra/vm/tests/host-scripts.test.sh
#
#   fetch       installs a good bundle (root, 600/700, staged-commit); refuses a sha256 mismatch, a file the
#               manifest doesn't list, a path outside the allowed set, a manifest without its commit; again
#               on the same prefix changes nothing
#   make-env    refuses a tag other than the staged one and bad arguments; writes every variable the compose
#               file requires, random distinct secrets, root 600, placeholders for GROQ_API_KEY and the demo
#               users; prints no value; a second run refuses and leaves both files as they were
#   set-secret  replaces only its own variable, single-quoted, root 600; refuses unknown names, a short or
#               weak password, two different entries, a bad email, a quote; never prints the value
#   stack       refuses a tag other than the staged one, placeholders, an env file readable by others; up
#               logs in with the token on stdin, redacts a secret the stack prints, waits for /health/ready;
#               a service that stays unready fails after the limit, named; the apps it probes = compose
#   bootstrap   the whole sequence on an empty database; again on a loaded one (no import); stops at the
#               first failure with the step's last lines; prints no secret
#   shared      the block shared by stack.sh and bootstrap.sh is identical in both
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
  ps) printf 'c1\nc2\n' ;;
  stats) printf 'NAME MEM USAGE / LIMIT CPU %%\nforexedge-redis-1 11MiB / 160MiB 0.5%%\n' ;;
  compose)
    shift
    envf=""
    while [[ $# -gt 0 ]]; do
      case "$1" in -p | -f | --profile) shift 2 ;; --env-file) envf="$2"; shift 2 ;; *) break ;; esac
    done
    sub="$1"
    shift
    secret() { sed -n "s/^$1=//p" "$envf"; }
    case "$sub" in
      pull | down | ps) echo "$sub: ok" ;;
      up)
        # As a real stack can: a container's command line with a password in it
        echo "redis-1  redis-server --requirepass $(secret REDIS_PASS)"
        echo "up: ok" ;;
      exec)
        [[ "$1" == -T ]] && shift
        app="$1"
        if [[ "$app" == redis ]]; then printf 'used_memory_human:2.12M\r\nmaxmemory_human:96.00M\r\n'; exit 0; fi
        code="$(cat "$STUB/ready/$app" 2>/dev/null || echo 200)"
        echo "$app $code {\"status\":\"ok\",\"checks\":[\"db\"]}"
        [[ "$code" == 200 ]] ;;
      run)
        while [[ "$1" == --rm || "$1" == -T ]]; do shift; done
        shift # ops
        cmd="$*"
        echo "$cmd" >>"$STUB/ops.log"
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
if [[ $rc -eq 0 ]] && has "fetched 8 files of commit $COMMIT" \
  && [[ "$(stat -c '%U %a' "$ROOT/infra/docker-compose.prod.yml")" == "root 600" ]] \
  && [[ "$(stat -c '%U %a' "$ROOT/infra/vm/stack.sh")" == "root 700" ]] \
  && [[ "$(stat -c '%a' "$ROOT")" == 700 ]] \
  && cmp -s "$REPO_DIR/infra/caddy/Caddyfile" "$ROOT/infra/caddy/Caddyfile" \
  && [[ -f "$ROOT/data/history-transfer/historical_candles_EURUSD.csv.gz" ]] \
  && [[ "$(sed -n 1p "$ROOT/staged-commit")" == "commit $COMMIT" ]] && [[ ! -e "$ROOT/.incoming/20261111T093000Z" ]]; then
  pass "fetch: installs a good bundle (root, 600/700) and records the commit"
else fail "fetch: good bundle (rc $rc)"; show; fi
# The ops container mounts data/history-transfer and reads it as `node` (uid 1000), never crossing the
# root-only parents: read from inside the directory, as that uid
ops_reads() { (cd "$ROOT/data/history-transfer" && setpriv --reuid=1000 --regid=1000 --clear-groups cat manifest.json) >/dev/null 2>&1; }
history_modes() {
  [[ "$(stat -c '%U %a' "$ROOT/data/history-transfer")" == "root 755" ]] &&
    [[ -z "$(find "$ROOT/data/history-transfer" -type f ! -perm 0644)" ]] &&
    [[ "$(stat -c '%a' "$ROOT/infra/caddy/Caddyfile")" == 600 && "$(stat -c '%a' "$ROOT/data")" == 700 ]]
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

# Each refusal: on a fresh root nothing may be installed, and staged-commit must not exist
refused() {
  local what="$1" expected="$2"
  new_root refused
  t fetch.sh "$BUCKET" "$PREFIX" "$REGION"
  if [[ $rc -ne 0 ]] && has "$expected" && [[ ! -e "$ROOT/staged-commit" && ! -e "$ROOT/infra" ]]; then
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
if [[ $rc -ne 0 ]] && has "is not the staged commit" && [[ ! -e "$ROOT/infra/.env.prod" ]]; then
  pass "make-env: refuses a tag other than the staged commit"
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
stack_apps="$(sed -n 's/^\(NODE_APPS\|PYTHON_APPS\)=(\(.*\))$/\2/p' "$VM/stack.sh" | tr ' ' '\n' | cut -d: -f1 | sort)"
if [[ -n "$compose_apps" && "$compose_apps" == "$stack_apps" ]]; then pass "stack: probes every app of the compose file ($(wc -l <<<"$stack_apps"))"
else fail "stack: apps differ from compose"; diff <(echo "$compose_apps") <(echo "$stack_apps") >&2 || true; fi

shared() { sed -n '/^# ── shared with /,/^# ── end of the shared block/p' "$1" | sed 1d; }
if [[ -n "$(shared "$VM/stack.sh")" && "$(shared "$VM/stack.sh")" == "$(shared "$VM/bootstrap.sh")" ]]; then
  pass "shared block identical in stack.sh and bootstrap.sh"
else fail "shared block of stack.sh and bootstrap.sh differs"; diff <(shared "$VM/stack.sh") <(shared "$VM/bootstrap.sh") >&2 || true; fi

: >"$STUB/calls.log"
t stack.sh up "$OTHER"
if [[ $rc -ne 0 ]] && has "is not the staged commit" && ! grep -q '^docker' "$STUB/calls.log"; then
  pass "stack: refuses a tag other than the staged commit, before any docker call"
else fail "stack: other tag (rc $rc)"; show; fi
t bootstrap.sh "$OTHER"
if [[ $rc -ne 0 ]] && has "is not the staged commit" && ! grep -q '^docker' "$STUB/calls.log"; then
  pass "bootstrap: refuses a tag other than the staged commit, before any docker call"
else fail "bootstrap: other tag (rc $rc)"; show; fi

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
