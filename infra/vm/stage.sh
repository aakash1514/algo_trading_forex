#!/usr/bin/env bash
# Uploads what the host needs from the repository to the backups bucket, for fetch.sh (docs/DEPLOY.md
# section 8). On the laptop, from the repo root, with your AWS login (e.g. SSO):
#
#   bash infra/vm/stage.sh <IMAGE_TAG> [--history]
#
# IMAGE_TAG must be the full SHA of HEAD and the working tree clean (git status shows nothing), so the files
# staged are exactly the commit whose images build-images pushed. Uploads to
# s3://<backups bucket>/transfer/<UTC yyyymmddThhmmssZ>/ (bucket from `terraform output backups_bucket`):
#
#   infra/docker-compose.prod.yml, infra/caddy/Caddyfile, the host scripts of infra/vm (HOST_SCRIPTS below)
#   with --history: every file of data/history-transfer/ (npm run data:transfer -- export; manifest.json
#   required)
#   manifest.sha256, last: "# commit <sha>", then "<sha256>  <path>" per file
#
# Prints the prefix to give fetch.sh. Nothing secret is staged (the env files are made on the host).
# The backups bucket expires every object after 14 days.
set -euo pipefail

HOST_SCRIPTS=(stack.sh bootstrap.sh set-secret.sh check-imds-guard.sh)
HISTORY_DIR="data/history-transfer"

die() {
  printf 'stage.sh: %s\n' "$*" >&2
  exit 1
}
usage() {
  echo "usage: $0 <IMAGE_TAG> [--history]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
tag="$1"
history=false
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--history" ]] || usage
  history=true
fi
[[ -f infra/docker-compose.prod.yml ]] || die "run from the repo root"
[[ "$tag" =~ ^[0-9a-f]{40}$ ]] || die "IMAGE_TAG must be a full commit SHA (40 hex characters): '$tag'"
head="$(git rev-parse HEAD)"
[[ "$tag" == "$head" ]] || die "IMAGE_TAG $tag is not HEAD ($head): check out the commit whose images were built"
[[ -z "$(git status --porcelain)" ]] || die "the working tree has changes: commit or stash them first"

files=(infra/docker-compose.prod.yml infra/caddy/Caddyfile)
for s in "${HOST_SCRIPTS[@]}"; do files+=("infra/vm/$s"); done
if [[ "$history" == true ]]; then
  [[ -f "$HISTORY_DIR/manifest.json" ]] || die "$HISTORY_DIR/manifest.json is missing (npm run data:transfer -- export)"
  while IFS= read -r f; do files+=("$f"); done < <(find "$HISTORY_DIR" -maxdepth 1 -type f | sort)
fi
for f in "${files[@]}"; do
  [[ "$(basename "$f")" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || die "file name fetch.sh would refuse: $f"
done

bucket="$(terraform -chdir=infra/terraform output -raw backups_bucket | tr -d '\r')"
[[ "$bucket" =~ ^forexedge-backups-[0-9]{12}$ ]] || die "not the backups bucket: '$bucket'"
prefix="transfer/$(date -u +%Y%m%dT%H%M%SZ)/"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
manifest="$work/manifest.sha256"
{
  echo "# commit $tag"
  for f in "${files[@]}"; do sha256sum "$f" | sed 's/ \*/  /'; done
} >"$manifest"

# The Windows AWS CLI can't open an MSYS path such as /tmp/...
local_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

for f in "${files[@]}"; do
  aws s3 cp --only-show-errors "$(local_path "$f")" "s3://$bucket/$prefix$f"
done
# Last: fetch.sh starts from the manifest, so a half-finished upload has none
aws s3 cp --only-show-errors "$(local_path "$manifest")" "s3://$bucket/${prefix}manifest.sha256"

echo "staged ${#files[@]} files of commit $tag (history: $history)"
echo "prefix: $prefix"
echo "next:   bash infra/vm/run-on-host.sh infra/vm/fetch.sh --timeout 1800 -- $bucket $prefix <region>"
