#!/usr/bin/env bash
# Sets one secret in the host's settings, typed by you, never echoed, never on a command line. Only in an
# interactive Session Manager shell (docs/DEPLOY.md section 8), never through SSM Run Command (which stores
# its parameters and output):
#
#   aws ssm start-session --target <instance-id>
#   sudo -i
#   bash /opt/forexedge/infra/vm/set-secret.sh GROQ_API_KEY
#   bash /opt/forexedge/infra/vm/set-secret.sh DEMO_DEMO_EMAIL
#   bash /opt/forexedge/infra/vm/set-secret.sh DEMO_DEMO_PASS          (asked twice)
#
#   GROQ_API_KEY       in .env.prod; 20-200 of [A-Za-z0-9_-]
#   DEMO_<NAME>_EMAIL  in .env.demo-users; an email address
#   DEMO_<NAME>_PASS   in .env.demo-users; the sign-up rules for demo users: 12-32 characters, a lower- and an
#                      uppercase letter, a digit and one of @$!%*?& (apps/auth-service demo-users.ts)
#
# The name must already be in its file (make-env.sh writes every one as a placeholder), so a typo can't add
# a variable. The value is written single-quoted (compose takes it literally, $ included), so it can't contain
# ' or whitespace. The file is replaced atomically, root 600. Prints the name and whether it replaced the
# placeholder or an earlier value; never the value or its length.
#
# FOREXEDGE_ROOT overrides /opt/forexedge (tests).
set -euo pipefail

ROOT="${FOREXEDGE_ROOT:-/opt/forexedge}"
PLACEHOLDER="__SET_WITH_SET_SECRET__"

die() {
  printf 'set-secret.sh: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || {
  echo "usage: $0 <GROQ_API_KEY | DEMO_<NAME>_EMAIL | DEMO_<NAME>_PASS>" >&2
  exit 2
}
name="$1"
case "$name" in
  GROQ_API_KEY) file="$ROOT/infra/.env.prod" ;;
  DEMO_*_EMAIL | DEMO_*_PASS)
    [[ "$name" =~ ^DEMO_[A-Z0-9_]{3,20}_(EMAIL|PASS)$ ]] || die "not a demo user variable: $name"
    file="$ROOT/infra/.env.demo-users"
    ;;
  *) die "$name can't be set here (GROQ_API_KEY, DEMO_<NAME>_EMAIL, DEMO_<NAME>_PASS)" ;;
esac
[[ "${EUID}" -eq 0 ]] || die "run as root (sudo -i)"
[[ -f "$file" ]] || die "$file is missing (run make-env.sh first)"
[[ "$(grep -c "^${name}=" "$file")" -eq 1 ]] || die "$name is not in $file (check the name against DEMO_USERS)"

# Reads one value without echo; from a terminal the prompt goes to stderr
read_secret() {
  local v
  IFS= read -r -s -p "$1" v || die "no value read"
  echo >&2
  printf '%s' "$v"
}

value="$(read_secret "$name: ")"
case "$name" in
  GROQ_API_KEY)
    [[ "$value" =~ ^[A-Za-z0-9_-]{20,200}$ ]] || die "GROQ_API_KEY must be 20-200 of [A-Za-z0-9_-]"
    ;;
  *_EMAIL)
    [[ ${#value} -le 254 && "$value" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$ ]] ||
      die "$name is not an email address"
    ;;
  *_PASS)
    [[ ${#value} -ge 12 && ${#value} -le 32 ]] || die "$name must be 12-32 characters"
    [[ "$value" =~ [a-z] && "$value" =~ [A-Z] && "$value" =~ [0-9] && "$value" =~ [@\$!%*?\&] ]] ||
      die "$name needs a lowercase letter, an uppercase letter, a digit and one of @\$!%*?&"
    [[ "$value" =~ ^[A-Za-z0-9@\$!%*?\&]+$ ]] || die "$name may contain only letters, digits and @\$!%*?&"
    again="$(read_secret "$name again: ")"
    [[ "$value" == "$again" ]] || die "the two entries differ"
    ;;
esac
[[ "$value" != *"'"* && "$value" != *[[:space:]]* ]] || die "$name can't contain ' or whitespace"

previous="an earlier value"
grep -qx "${name}=${PLACEHOLDER}" "$file" && previous="the placeholder"

umask 077
tmp="$(mktemp "$file.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
# The value reaches awk on a file descriptor, never in its arguments or environment
awk -v n="$name" 'FNR == NR { v = $0; next } index($0, n "=") == 1 { print n "=\x27" v "\x27"; next } { print }' \
  <(printf '%s\n' "$value") "$file" >"$tmp"
chown root:root "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$file"
echo "$name set in $file (replaced $previous)"
