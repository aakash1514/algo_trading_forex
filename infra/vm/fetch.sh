#!/usr/bin/env bash
# Downloads a bundle staged by stage.sh and puts it in place on the host, only if every file matches the
# manifest. Root, on the host, through SSM (docs/DEPLOY.md section 8):
#
#   bash infra/vm/run-on-host.sh infra/vm/fetch.sh --timeout 1800 -- <backups-bucket> <prefix> <region>
#   e.g. ... -- forexedge-backups-805496480789 transfer/20261111T093000Z/ ap-south-1
#
# The bundle goes to /opt/forexedge/.incoming/<stamp>/ first. It is refused, and nothing is moved, when the
# manifest (manifest.sha256: "# commit <sha>", then "<sha256>  <path>" lines) is malformed, lists a path
# outside the allowed set (the compose file, the Caddyfile, infra/vm/*.sh, data/history-transfer/*) or a
# path twice, lacks the compose file or the Caddyfile, when the prefix holds a file the manifest doesn't
# list, or when any file's sha256 differs. Then each file is installed under /opt/forexedge at its path
# (root, 600; scripts 700) and staged-commit records the commit, which stack.sh, bootstrap.sh and
# make-env.sh require as IMAGE_TAG. Never touches .env.prod or .env.demo-users. Running it again on the same
# prefix changes nothing.
#
# Uses the AWS CLI with the instance role (s3:ListBucket and s3:GetObject on the backups bucket).
# FOREXEDGE_ROOT overrides /opt/forexedge (tests).
set -euo pipefail

ROOT="${FOREXEDGE_ROOT:-/opt/forexedge}"
ALLOWED='^(infra/docker-compose\.prod\.yml|infra/caddy/Caddyfile|infra/vm/[a-z0-9-]+\.sh|data/history-transfer/[A-Za-z0-9_][A-Za-z0-9_.-]*)$'

die() {
  printf 'fetch.sh: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 3 ]] || {
  echo "usage: $0 <backups-bucket> <prefix> <region>" >&2
  exit 2
}
bucket="$1"
prefix="$2"
region="$3"
[[ "$bucket" =~ ^forexedge-backups-[0-9]{12}$ ]] || die "not the backups bucket: '$bucket'"
[[ "$prefix" =~ ^transfer/([0-9]{8}T[0-9]{6}Z)/$ ]] || die "prefix must be transfer/<yyyymmddThhmmssZ>/: '$prefix'"
stamp="${BASH_REMATCH[1]}"
[[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "not a region: '$region'"
[[ "${EUID}" -eq 0 ]] || die "run as root"

umask 077
incoming="$ROOT/.incoming/$stamp"
rm -rf "$incoming"
install -d -o root -g root -m 0700 "$ROOT" "$ROOT/.incoming" "$incoming"
trap 'rm -rf "$incoming"' EXIT
src="s3://$bucket/$prefix"

aws s3 cp --only-show-errors --region "$region" "${src}manifest.sha256" "$incoming/manifest.sha256"
manifest="$incoming/manifest.sha256"

# The manifest: exactly one commit line, then entries; every path allowed and listed once
commit="$(sed -n 's/^# commit \([0-9a-f]\{40\}\)$/\1/p' "$manifest")"
[[ "$commit" =~ ^[0-9a-f]{40}$ && "$(grep -c '^# commit ' "$manifest")" -eq 1 ]] || die "manifest: no single '# commit <sha>' line"
entries="$incoming/entries"
grep -v '^#' "$manifest" >"$entries" || die "manifest lists no file"
paths=()
while IFS= read -r line; do
  [[ "$line" =~ ^[0-9a-f]{64}\ \ (.+)$ ]] || die "manifest: malformed line: $line"
  path="${BASH_REMATCH[1]}"
  [[ "$path" =~ $ALLOWED ]] || die "manifest: path not allowed: $path"
  paths+=("$path")
done <"$entries"
((${#paths[@]} > 0)) || die "manifest lists no file"
[[ "$(printf '%s\n' "${paths[@]}" | sort | uniq -d)" == "" ]] || die "manifest: a path is listed twice"
for required in infra/docker-compose.prod.yml infra/caddy/Caddyfile; do
  printf '%s\n' "${paths[@]}" | grep -qx "$required" || die "manifest: $required is missing"
done

# Nothing in the prefix that the manifest doesn't list
listed="$(printf '%s\n' manifest.sha256 "${paths[@]}" | sort)"
present="$(aws s3 ls --region "$region" --recursive "$src" | awk '{ $1 = $2 = $3 = ""; sub(/^ +/, ""); print }' | sed "s|^${prefix}||" | sort)"
extra="$(comm -13 <(echo "$listed") <(echo "$present"))"
[[ -z "$extra" ]] || die "the prefix holds files the manifest doesn't list: $(paste -sd ' ' - <<<"$extra")"

for path in "${paths[@]}"; do
  mkdir -p "$(dirname "$incoming/$path")"
  aws s3 cp --only-show-errors --region "$region" "${src}${path}" "$incoming/$path"
done
(cd "$incoming" && sha256sum --check --quiet --strict entries) || die "sha256 mismatch: nothing was installed"

for path in "${paths[@]}"; do
  mode=0600
  [[ "$path" == *.sh ]] && mode=0700
  install -D -o root -g root -m "$mode" "$incoming/$path" "$ROOT/$path"
done
printf 'commit %s\nprefix %s\n' "$commit" "$prefix" >"$ROOT/staged-commit.tmp"
chmod 600 "$ROOT/staged-commit.tmp"
mv "$ROOT/staged-commit.tmp" "$ROOT/staged-commit"

history="$(printf '%s\n' "${paths[@]}" | grep -c '^data/history-transfer/' || true)"
echo "fetched ${#paths[@]} files of commit $commit (sha256 verified; $history history files) into $ROOT"
