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
# list, or when any file's sha256 differs. Then:
#
#   infra/...                 -> /opt/forexedge/releases/<commit>/infra/... (root, 600; scripts 700), with
#                                links infra/.env.prod, infra/.env.demo-users -> the shared ones in
#                                /opt/forexedge/infra, and data -> /opt/forexedge/data
#   data/history-transfer/*   -> /opt/forexedge/data/history-transfer/ (shared; directory 755, files 644, for
#                                the ops container's non-root user)
#   releases/<commit>/release -> "commit <sha>", "prefix <prefix>", "fetched <UTC>", written last: stack.sh,
#                                bootstrap.sh, make-env.sh and deploy.sh accept only a tag with this record
#
# A release already fetched is never changed: the same commit with different config files is refused.
# Never touches .env.prod, .env.demo-users or /opt/forexedge/current (deploy.sh switches releases). Running
# it again on the same prefix changes nothing.
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

release="$ROOT/releases/$commit"
# A release is never changed once fetched (current may be running it): the same commit again must bring
# the same config files, byte for byte
if [[ -f "$release/release" ]]; then
  for path in "${paths[@]}"; do
    [[ "$path" == infra/* ]] || continue
    cmp -s "$incoming/$path" "$release/$path" || die "release $commit exists with a different $path: nothing was installed"
  done
fi

# The history is public market data that the ops container reads as its non-root user (`node`) through a
# bind mount of data/history-transfer: that directory 755, its files 644. Shared by every release.
if printf '%s\n' "${paths[@]}" | grep -q '^data/history-transfer/'; then
  install -d -o root -g root -m 0700 "$ROOT/data"
  install -d -o root -g root -m 0755 "$ROOT/data/history-transfer"
fi
install -d -o root -g root -m 0700 "$ROOT/releases" "$release" "$ROOT/infra"
for path in "${paths[@]}"; do
  if [[ "$path" == data/history-transfer/* ]]; then
    install -D -o root -g root -m 0644 "$incoming/$path" "$ROOT/$path"
    continue
  fi
  mode=0600
  [[ "$path" == *.sh ]] && mode=0700
  install -D -o root -g root -m "$mode" "$incoming/$path" "$release/$path"
done
# The secrets and the data are shared, linked from each release where compose's relative paths look for
# them (.env.demo-users next to the compose file, ../data/history-transfer)
ln -sfn ../../../infra/.env.prod "$release/infra/.env.prod"
ln -sfn ../../../infra/.env.demo-users "$release/infra/.env.demo-users"
ln -sfn ../../data "$release/data"
# Last: a release without this file doesn't exist for stack.sh, bootstrap.sh and deploy.sh
if [[ ! -f "$release/release" ]]; then
  printf 'commit %s\nprefix %s\nfetched %s\n' "$commit" "$prefix" "$(date -u +%Y%m%dT%H%M%SZ)" >"$release/release.tmp"
  chmod 600 "$release/release.tmp"
  mv "$release/release.tmp" "$release/release"
fi

history="$(printf '%s\n' "${paths[@]}" | grep -c '^data/history-transfer/' || true)"
echo "fetched ${#paths[@]} files of commit $commit (sha256 verified; $history history files) into $release"
