#!/usr/bin/env bash
# Creates the production settings on the host, once: /opt/forexedge/infra/.env.prod and
# /opt/forexedge/infra/.env.demo-users (root, 600). Root, on the host, through SSM (docs/DEPLOY.md section 8):
#
#   bash infra/vm/run-on-host.sh infra/vm/make-env.sh -- DOMAIN=forexedge.tech \
#     IMAGE_REGISTRY=<account>.dkr.ecr.ap-south-1.amazonaws.com/forexedge IMAGE_TAG=<fetched commit> \
#     S3_BUCKET=forexedge-results-<account> AWS_REGION=ap-south-1 DEMO_USERS=demo
#
# Refuses if either file exists (it never overwrites: a second run would change every password the database
# already uses). The arguments are the non-secret values, all six required (SSM stores them). The DB, ML,
# research, replay and Redis passwords (40 characters) and the two JWT secrets (64, different) are random,
# from /dev/urandom, [A-Za-z0-9] (nothing a URL, compose or a shell would interpret), and are never printed.
# GROQ_API_KEY and each demo user's DEMO_<NAME>_EMAIL / _PASS are placeholders, set afterwards with
# set-secret.sh in a Session Manager shell (they never pass through SSM Run Command). Prints only the
# variable names and whether each is set or a placeholder.
#
# FOREXEDGE_ROOT overrides /opt/forexedge (tests).
set -euo pipefail

ROOT="${FOREXEDGE_ROOT:-/opt/forexedge}"
ENV_FILE="$ROOT/infra/.env.prod"
DEMO_ENV_FILE="$ROOT/infra/.env.demo-users"
RELEASES="$ROOT/releases"
PLACEHOLDER="__SET_WITH_SET_SECRET__"

die() {
  printf 'make-env.sh: %s\n' "$*" >&2
  exit 1
}

# N random characters from [A-Za-z0-9]
random_string() {
  local n="$1" s=""
  while ((${#s} < n)); do
    s+="$(head -c 96 /dev/urandom | base64 -w0 | tr -d '+/=')"
  done
  printf '%s' "${s:0:n}"
}

usage() {
  echo "usage: $0 DOMAIN=... IMAGE_REGISTRY=... IMAGE_TAG=... S3_BUCKET=... AWS_REGION=... DEMO_USERS=..." >&2
  exit 2
}

declare -A arg=()
for a in "$@"; do
  [[ "$a" =~ ^(DOMAIN|IMAGE_REGISTRY|IMAGE_TAG|S3_BUCKET|AWS_REGION|DEMO_USERS)=(.*)$ ]] || usage
  [[ -z "${arg[${BASH_REMATCH[1]}]+x}" ]] || die "${BASH_REMATCH[1]} given twice"
  arg[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
done
for k in DOMAIN IMAGE_REGISTRY IMAGE_TAG S3_BUCKET AWS_REGION DEMO_USERS; do
  [[ -n "${arg[$k]:-}" ]] || die "$k is required"
done
[[ "${arg[DOMAIN]}" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "DOMAIN is not a domain name: ${arg[DOMAIN]}"
[[ "${arg[IMAGE_REGISTRY]}" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/forexedge$ ]] ||
  die "IMAGE_REGISTRY must be <account>.dkr.ecr.<region>.amazonaws.com/forexedge: ${arg[IMAGE_REGISTRY]}"
[[ "${arg[S3_BUCKET]}" =~ ^forexedge-results-[0-9]{12}$ ]] || die "S3_BUCKET is not the results bucket: ${arg[S3_BUCKET]}"
[[ "${arg[AWS_REGION]}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "AWS_REGION is not a region: ${arg[AWS_REGION]}"
# Demo usernames: registration's rules (3-20 of [A-Za-z0-9_]), each once (case-insensitive)
IFS=, read -r -a demo_users <<<"${arg[DEMO_USERS]}"
((${#demo_users[@]} > 0)) || die "DEMO_USERS lists no user"
for u in "${demo_users[@]}"; do
  [[ "$u" =~ ^[A-Za-z0-9_]{3,20}$ ]] || die "DEMO_USERS: '$u' is not a valid username (3-20 of A-Z a-z 0-9 _)"
done
[[ -z "$(printf '%s\n' "${demo_users[@]}" | tr '[:upper:]' '[:lower:]' | sort | uniq -d)" ]] || die "DEMO_USERS lists a user twice"

[[ "${EUID}" -eq 0 ]] || die "run as root"
[[ "${arg[IMAGE_TAG]}" =~ ^[0-9a-f]{40}$ ]] || die "IMAGE_TAG must be a full commit SHA: '${arg[IMAGE_TAG]}'"
release_file="$RELEASES/${arg[IMAGE_TAG]}/release"
[[ -f "$release_file" ]] || die "IMAGE_TAG ${arg[IMAGE_TAG]} has no fetched release ($release_file is missing; run fetch.sh first)"
recorded="$(sed -n 's/^commit \([0-9a-f]\{40\}\)$/\1/p' "$release_file")"
[[ "${arg[IMAGE_TAG]}" == "$recorded" ]] || die "release ${arg[IMAGE_TAG]} records commit ${recorded:-(none)}"
for f in "$ENV_FILE" "$DEMO_ENV_FILE"; do
  [[ ! -e "$f" ]] || die "$f exists: refusing to overwrite it (its passwords are in use; change single values with set-secret.sh)"
done

umask 077
install -d -o root -g root -m 0700 "$ROOT/infra"

jwt_access="$(random_string 64)"
jwt_refresh="$(random_string 64)"
[[ "$jwt_access" != "$jwt_refresh" ]] || die "the JWT secrets came out equal"

env_tmp="$(mktemp "$ENV_FILE.XXXXXX")"
demo_tmp="$(mktemp "$DEMO_ENV_FILE.XXXXXX")"
trap 'rm -f "$env_tmp" "$demo_tmp"' EXIT
cat >"$env_tmp" <<EOF
# ForexEdge production settings, written by infra/vm/make-env.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Root only. Change a secret with set-secret.sh; never paste a value into a command line.
DOMAIN=${arg[DOMAIN]}
IMAGE_REGISTRY=${arg[IMAGE_REGISTRY]}
IMAGE_TAG=${arg[IMAGE_TAG]}
DB_NAME=forexedge_db
DB_USER=forexedge
DB_PASS=$(random_string 40)
ML_DB_USER=forexedge_ml
ML_DB_PASS=$(random_string 40)
RESEARCH_DB_USER=forexedge_research
RESEARCH_DB_PASS=$(random_string 40)
REPLAY_DB_USER=forexedge_replay
REPLAY_DB_PASS=$(random_string 40)
REDIS_PASS=$(random_string 40)
JWT_ACCESS_SECRET=${jwt_access}
JWT_REFRESH_SECRET=${jwt_refresh}
STORAGE=s3
AWS_REGION=${arg[AWS_REGION]}
S3_BUCKET=${arg[S3_BUCKET]}
MARKET_FEED=none
REGISTRATION_ENABLED=false
GROQ_API_KEY=${PLACEHOLDER}
DEMO_USERS=${arg[DEMO_USERS]}
EOF
{
  echo "# ForexEdge demo users (DEMO_USERS in .env.prod), written by infra/vm/make-env.sh. Root only."
  echo "# Set each value with set-secret.sh (passwords: 12-32 characters and the sign-up rules)."
  for u in "${demo_users[@]}"; do
    key="DEMO_$(tr '[:lower:]' '[:upper:]' <<<"$u")"
    echo "${key}_EMAIL=${PLACEHOLDER}"
    echo "${key}_PASS=${PLACEHOLDER}"
  done
} >"$demo_tmp"
chown root:root "$env_tmp" "$demo_tmp"
chmod 600 "$env_tmp" "$demo_tmp"
# ln fails if the target appeared meanwhile: never an overwrite, even in a race
ln "$env_tmp" "$ENV_FILE" || die "$ENV_FILE appeared while writing it"
ln "$demo_tmp" "$DEMO_ENV_FILE" || die "$DEMO_ENV_FILE appeared while writing it"

for f in "$ENV_FILE" "$DEMO_ENV_FILE"; do
  echo "$f ($(stat -c '%U %a' "$f")):"
  awk -F= -v p="$PLACEHOLDER" '/^[A-Z]/ { printf "  %-22s %s\n", $1, (index($0, "=" p) ? "placeholder (set-secret.sh)" : "set") }' "$f"
done
