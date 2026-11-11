#!/usr/bin/env bash
# infra/vm/stage.sh against stub `aws` and `terraform` commands in a throwaway git repository (no AWS call;
# part of npm run infra:check; Git Bash or Linux):
#
#   bash infra/vm/tests/stage.test.sh
#
#   wrong tag      a SHA other than HEAD, a short SHA: refused before any upload
#   dirty tree     a modified or an untracked file: refused before any upload
#   bundle         the compose file, the Caddyfile and the host scripts, then manifest.sha256 last, with the
#                  commit and a sha256 per file that matches what was uploaded; prints the prefix
#   --history      adds every file of data/history-transfer; refused without its manifest.json
#   --bucket       uploads there without calling terraform (deploy.yml); another bucket or a bad flag refused
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export STUB_DIR="$work/stub"
mkdir -p "$work/bin" "$STUB_DIR/s3"

cat >"$work/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == "s3 cp" ]] || { echo "unexpected aws call: $*" >&2; exit 1; }
pos=()
for a in "${@:3}"; do [[ "$a" == --only-show-errors ]] || pos+=("$a"); done
[[ "${pos[1]}" == s3://* ]] || { echo "not an upload: $*" >&2; exit 1; }
key="${pos[1]#s3://}"
mkdir -p "$(dirname "$STUB_DIR/s3/$key")"
cp "${pos[0]}" "$STUB_DIR/s3/$key"
echo "$key" >>"$STUB_DIR/uploads"
EOF
cat >"$work/bin/terraform" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/terraform.calls"
[[ "$*" == "-chdir=infra/terraform output -raw backups_bucket" ]] || { echo "unexpected terraform call: $*" >&2; exit 1; }
printf 'forexedge-backups-123456789012\r\n'
EOF
chmod +x "$work/bin/aws" "$work/bin/terraform"
export PATH="$work/bin:$PATH"

# A repository with the files stage.sh sends (copies of the real ones) and a history export
repo="$work/repo"
mkdir -p "$repo/infra/caddy" "$repo/infra/vm" "$repo/data/history-transfer"
cp "$REPO_DIR/infra/docker-compose.prod.yml" "$repo/infra/"
cp "$REPO_DIR/infra/caddy/Caddyfile" "$repo/infra/caddy/"
cp "$REPO_DIR"/infra/vm/*.sh "$repo/infra/vm/"
printf 'data/\n' >"$repo/.gitignore"
echo '{"candles":[]}' >"$repo/data/history-transfer/manifest.json"
printf 'csv' >"$repo/data/history-transfer/historical_candles_EURUSD.csv.gz"
# In the repository itself, not git -C: with MSYS_NO_PATHCONV=1 (check.sh) Git for Windows gets /tmp/... unconverted
cd "$repo"
git init -q
git -c core.autocrlf=false -c user.name=t -c user.email=t@example.invalid add -A
git -c core.autocrlf=false -c user.name=t -c user.email=t@example.invalid commit -q -m bundle
HEAD_SHA="$(git rev-parse HEAD)"

failures=0
fail() { echo "FAIL  $1" >&2; failures=$((failures + 1)); }
pass() { echo "ok    $1"; }
run() {
  rm -rf "$STUB_DIR/s3" "$STUB_DIR/uploads"
  mkdir -p "$STUB_DIR/s3"
  rc=0
  (cd "$repo" && bash infra/vm/stage.sh "$@") >"$work/out" 2>&1 || rc=$?
}
has() { grep -qF -- "$1" "$work/out"; }
no_upload() { [[ ! -s "$STUB_DIR/uploads" ]]; }

run 1111111111111111111111111111111111111111
if [[ $rc -ne 0 ]] && has "is not HEAD" && no_upload; then pass "a tag other than HEAD refused"
else fail "other tag (rc $rc)"; cat "$work/out" >&2; fi
run "${HEAD_SHA:0:7}"
if [[ $rc -ne 0 ]] && has "full commit SHA" && no_upload; then pass "a short SHA refused"
else fail "short SHA (rc $rc)"; fi

echo "# changed" >>"$repo/infra/caddy/Caddyfile"
run "$HEAD_SHA"
git checkout -q -- infra/caddy/Caddyfile
r1=$rc
touch "$repo/infra/vm/new.sh"
run "$HEAD_SHA"
rm "$repo/infra/vm/new.sh"
if [[ $r1 -ne 0 && $rc -ne 0 ]] && has "the working tree has changes" && no_upload; then pass "a modified or untracked file refused"
else fail "dirty tree ($r1 $rc)"; fi

run "$HEAD_SHA"
prefix="$(sed -n 's/^prefix: //p' "$work/out")"
dir="$STUB_DIR/s3/forexedge-backups-123456789012/$prefix"
ok=true
[[ $rc -eq 0 && "$prefix" =~ ^transfer/[0-9]{8}T[0-9]{6}Z/$ ]] || ok=false
[[ "$(tail -n 1 "$STUB_DIR/uploads" 2>/dev/null)" == "forexedge-backups-123456789012/${prefix}manifest.sha256" ]] || ok=false
if [[ "$ok" == true ]]; then
  [[ "$(sed -n 1p "$dir/manifest.sha256")" == "# commit $HEAD_SHA" ]] || ok=false
  listed="$(grep -v '^#' "$dir/manifest.sha256" | sed 's/^[0-9a-f]\{64\}  //' | sort)"
  expected="$(printf '%s\n' infra/docker-compose.prod.yml infra/caddy/Caddyfile infra/vm/stack.sh infra/vm/bootstrap.sh \
    infra/vm/set-secret.sh infra/vm/check-imds-guard.sh | sort)"
  [[ "$listed" == "$expected" ]] || { ok=false; echo "  listed: $listed" >&2; }
  (cd "$dir" && grep -v '^#' manifest.sha256 | sha256sum --check --quiet --strict -) || ok=false
  (cd "$repo" && grep -v '^#' "$dir/manifest.sha256" | sha256sum --check --quiet --strict -) || ok=false
fi
if [[ "$ok" == true ]] && has "staged 6 files of commit $HEAD_SHA (history: false)"; then
  pass "bundle: the files, then the manifest last, with the commit and matching sha256"
else fail "bundle (rc $rc)"; cat "$work/out" >&2; fi

run "$HEAD_SHA" --history
prefix="$(sed -n 's/^prefix: //p' "$work/out")"
dir="$STUB_DIR/s3/forexedge-backups-123456789012/$prefix"
if [[ $rc -eq 0 ]] && has "staged 8 files" && grep -q '  data/history-transfer/manifest.json$' "$dir/manifest.sha256" \
  && grep -q '  data/history-transfer/historical_candles_EURUSD.csv.gz$' "$dir/manifest.sha256" \
  && cmp -s "$repo/data/history-transfer/historical_candles_EURUSD.csv.gz" "$dir/data/history-transfer/historical_candles_EURUSD.csv.gz"; then
  pass "--history adds data/history-transfer"
else fail "--history (rc $rc)"; cat "$work/out" >&2; fi
mv "$repo/data/history-transfer/manifest.json" "$work/manifest.json"
run "$HEAD_SHA" --history
mv "$work/manifest.json" "$repo/data/history-transfer/manifest.json"
if [[ $rc -ne 0 ]] && has "manifest.json is missing" && no_upload; then pass "--history without manifest.json refused"
else fail "--history without manifest (rc $rc)"; fi

# deploy.yml has no Terraform state: --bucket names the bucket, and terraform is never called
rm -f "$STUB_DIR/terraform.calls"
run "$HEAD_SHA" --bucket forexedge-backups-999999999999
prefix="$(sed -n 's/^prefix: //p' "$work/out")"
if [[ $rc -eq 0 && -f "$STUB_DIR/s3/forexedge-backups-999999999999/${prefix}manifest.sha256" && ! -e "$STUB_DIR/terraform.calls" ]] \
  && has "staged 6 files of commit $HEAD_SHA (history: false)"; then
  pass "--bucket: uploads to that bucket, no terraform call"
else fail "--bucket (rc $rc)"; cat "$work/out" >&2; fi
run "$HEAD_SHA" --bucket forexedge-results-999999999999
if [[ $rc -ne 0 ]] && has "not the backups bucket" && no_upload; then pass "--bucket: another bucket refused"
else fail "--bucket other bucket (rc $rc)"; fi
run "$HEAD_SHA" --bucket
r1=$rc
run "$HEAD_SHA" --history --history
if [[ $r1 -eq 2 && $rc -eq 2 ]] && no_upload; then pass "--bucket without a name, a repeated flag: usage"
else fail "bad flags ($r1 $rc)"; fi

if ((failures > 0)); then echo "stage: $failures failed" >&2; exit 1; fi
echo "stage: all checks passed"
