#!/usr/bin/env bash
# Proves the instance metadata guard on the running host (docs/DEPLOY.md section 7.4): ws-gateway's
# container gets an IMDSv2 token; every other container is refused (TCP reset), whatever its image.
# Run as root after `docker compose up` (ws-gateway running):  bash check-imds-guard.sh
#
#   1. ws-gateway itself                                    -> token
#   2. a new container of ws-gateway's image, same network  -> refused (its network works: it reaches
#      ws-gateway's /health/live first, so a refusal is the guard, not a broken probe)
#   3. every other running compose container with node      -> refused
#   4. a container on Docker's default bridge               -> refused
#
# The token is never printed. Fails if any probe disagrees, or if no other container could be probed.
set -euo pipefail

PROJECT="${COMPOSE_PROJECT:-forexedge}"
NETWORK="${PROJECT}_default"

# Exit codes: 0 token received; 10 refused or unreachable; 11 timed out; 12 HTTP answer without a token;
# 20 the control request (argv[1]) failed. Nothing is printed.
# shellcheck disable=SC2016  # JavaScript, not shell
PROBE='
const control = process.argv[1];
(async () => {
  if (control) {
    const r = await fetch(control, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!r || !r.ok) process.exit(20);
  }
  try {
    const r = await fetch("http://169.254.169.254/latest/api/token", {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(5000),
    });
    const token = await r.text();
    process.exit(r.status === 200 && token.length > 0 ? 0 : 12);
  } catch (e) {
    process.exit(e.name === "TimeoutError" ? 11 : 10);
  }
})();'

failures=0
others=0
describe() {
  case "$1" in
    0) echo "token received" ;;
    10) echo "refused" ;;
    11) echo "timed out" ;;
    12) echo "answered without a token" ;;
    20) echo "control request failed (the probe's own network is broken)" ;;
    *) echo "exit $1" ;;
  esac
}
# expect WANT LABEL COMMAND...: runs the probe command and compares its exit code with WANT
expect() {
  local want="$1" label="$2" got=0
  shift 2
  "$@" >/dev/null 2>&1 || got=$?
  if [[ "$got" -eq "$want" ]]; then
    printf 'ok    %-52s %s\n' "$label" "$(describe "$got")"
  else
    printf 'FAIL  %-52s %s, expected: %s\n' "$label" "$(describe "$got")" "$(describe "$want")"
    failures=$((failures + 1))
  fi
}

ws="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter label=com.docker.compose.service=ws-gateway)"
[[ -n "$ws" && "$(wc -w <<<"$ws")" -eq 1 ]] || {
  echo "expected exactly one running ws-gateway container of project ${PROJECT}" >&2
  exit 1
}
image="$(docker inspect -f '{{.Config.Image}}' "$ws")"
ws_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${NETWORK}\").IPAddress}}" "$ws")"
echo "ws-gateway ${ws:0:12} at ${ws_ip} on ${NETWORK}, image ${image}"

expect 0 "ws-gateway (${ws_ip})" docker exec "$ws" node -e "$PROBE" ""

others=$((others + 1))
expect 10 "new container of ws-gateway's image on ${NETWORK}" \
  docker run --rm --network "$NETWORK" --entrypoint node "$image" -e "$PROBE" "http://ws-gateway:3005/health/live"

while read -r id service; do
  [[ "$service" == "ws-gateway" ]] && continue
  docker exec "$id" sh -c 'command -v node' >/dev/null 2>&1 || continue
  others=$((others + 1))
  expect 10 "${service}" docker exec "$id" node -e "$PROBE" ""
done < <(docker ps --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.ID}} {{.Label "com.docker.compose.service"}}')

others=$((others + 1))
expect 10 "new container on Docker's default bridge" \
  docker run --rm --network bridge --entrypoint node "$image" -e "$PROBE" ""

if [[ "$failures" -gt 0 || "$others" -lt 2 ]]; then
  echo "metadata guard check FAILED (${failures} wrong, ${others} other containers probed)" >&2
  exit 1
fi
echo "metadata guard: only ws-gateway reaches 169.254.169.254 (${others} other containers refused)"
