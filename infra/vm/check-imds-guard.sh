#!/usr/bin/env bash
# Proves the instance metadata guard on the running host (docs/DEPLOY.md section 7.4): ws-gateway's
# container gets an IMDSv2 token; every other container is refused (TCP reset), whatever its image.
# Run as root after `docker compose up` (ws-gateway running):  bash check-imds-guard.sh
#
#   1. ws-gateway itself                                    -> token
#   2. a new container of ws-gateway's image, same network  -> refused (its network works: it reaches
#      ws-gateway's /health/live first, so a refusal is the guard, not a broken probe)
#   3. every other running compose container with node      -> refused (node fetch)
#      or, without node, with python (ml-service,          -> refused (python urllib)
#      research-agent)
#   4. a container on Docker's default bridge               -> refused
#
# Containers with neither (the database, Redis, Kafka, Caddy) are listed as not probed. The token is never
# printed. Fails if any probe disagrees, if no other container could be probed, or if a running ml-service
# or research-agent container was not probed with python.
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

# The same request and exit codes in Python, for the containers without node
PY_PROBE='
import sys, urllib.error, urllib.request
req = urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT",
                             headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"})
try:
    r = urllib.request.urlopen(req, timeout=5)
    sys.exit(0 if r.status == 200 and len(r.read()) > 0 else 12)
except urllib.error.HTTPError:
    sys.exit(12)
except urllib.error.URLError as e:
    sys.exit(11 if isinstance(e.reason, TimeoutError) else 10)
except TimeoutError:
    sys.exit(11)
except OSError:
    sys.exit(10)'
# Each of these that is running must be probed with python
PYTHON_SERVICES=(ml-service research-agent)

failures=0
others=0
node_probed=0
python_probed=()
not_probed=()
running=()
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
  running+=("$service")
  [[ "$service" == "ws-gateway" ]] && continue
  if docker exec "$id" sh -c 'command -v node' >/dev/null 2>&1; then
    others=$((others + 1))
    node_probed=$((node_probed + 1))
    expect 10 "${service}" docker exec "$id" node -e "$PROBE" ""
  elif python="$(docker exec "$id" sh -c 'command -v python3 || command -v python' 2>/dev/null)" && [[ -n "$python" ]]; then
    others=$((others + 1))
    python_probed+=("$service")
    expect 10 "${service} (python)" docker exec "$id" "$python" -c "$PY_PROBE"
  else
    not_probed+=("$service")
  fi
done < <(docker ps --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.ID}} {{.Label "com.docker.compose.service"}}')

others=$((others + 1))
expect 10 "new container on Docker's default bridge" \
  docker run --rm --network bridge --entrypoint node "$image" -e "$PROBE" ""

for service in "${PYTHON_SERVICES[@]}"; do
  printf '%s\n' "${running[@]}" | grep -qx -- "$service" || continue
  if ! printf '%s\n' "${python_probed[@]}" | grep -qx -- "$service"; then
    printf 'FAIL  %-52s %s\n' "$service" "running, but not probed with python"
    failures=$((failures + 1))
  fi
done
((${#not_probed[@]} == 0)) || echo "not probed (neither node nor python): ${not_probed[*]}"

counts="${node_probed} node, ${#python_probed[@]} python"
if [[ "$failures" -gt 0 || "$others" -lt 2 ]]; then
  echo "metadata guard check FAILED (${failures} wrong, ${others} other containers probed: ${counts})" >&2
  exit 1
fi
echo "metadata guard: only ws-gateway reaches 169.254.169.254 (${others} other containers refused: ${counts})"
