#!/usr/bin/env bash
# The instance metadata guard end to end, on the laptop (Docker running; no AWS call):
#
#   bash infra/vm/tests/imds-guard.test.sh
#
# A privileged Docker-in-Docker container stands in for the EC2 host:
#   - a fake metadata service at 169.254.169.254 in its own network namespace, one routed hop away, so
#     container traffic to it crosses FORWARD (and Docker's DOCKER-USER chain) as it does on EC2
#   - the compose network exactly as infra/docker-compose.prod.yml declares it (name, bridge name, subnet,
#     dynamic range) and ws-gateway's fixed address, read with `docker compose config`
#   - stand-ins labelled like compose's containers: ws-gateway (answers /health/live on 3005) at its fixed
#     address, auth-service at a dynamic one, ml-service and research-agent from the Python image (no node)
#   - the guard exactly as setup.sh installs it (setup.sh --print-imds-guard)
# and runs infra/vm/check-imds-guard.sh in it. Scenarios (the last four are planted faults):
#   guarded                        check passes (5 refused, 2 with python); applying the guard again
#                                  changes no rule
#   no guard                       check fails: other containers get a token
#   guard admits another address   check fails: ws-gateway is refused
#   ws-gateway off its address     check fails: ws-gateway is refused
#   python containers skipped      a copy of the check without its python probe fails: ml-service and
#                                  research-agent run but were not probed
set -euo pipefail

DIND_IMAGE="docker:29.9.2-dind@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977"
NODE_TAG="node:24.11.0-alpine3.22"
NODE_DIGEST="sha256:f36fed0b2129a8492535e2853c64fbdbd2d29dc1219ee3217023ca48aebd3787"
# The Python services' base image (infra/docker/python.Dockerfile)
PYTHON_TAG="python:3.12.10-slim-bookworm"
PYTHON_DIGEST="sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db"
HOST="forexedge-imds-guard-test"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_DIR"
export MSYS_NO_PATHCONV=1
host_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
in_host() { docker exec "$HOST" sh -c "$1"; }

# ── The compose network and ws-gateway's address, from the compose file itself ──
placeholders=()
for k in DOMAIN DB_NAME DB_USER DB_PASS REDIS_PASS JWT_ACCESS_SECRET JWT_REFRESH_SECRET REPLAY_DB_USER REPLAY_DB_PASS \
  ML_DB_USER ML_DB_PASS RESEARCH_DB_USER RESEARCH_DB_PASS; do
  placeholders+=("$k=check-placeholder")
done
# (exported in a subshell: through `env`, Git Bash's docker.exe prints nothing)
read -r NETWORK BRIDGE SUBNET RANGE WS_IP < <(
  (export "${placeholders[@]}" && docker compose -f infra/docker-compose.prod.yml config --format json) |
    node -e '
      const c = JSON.parse(require("fs").readFileSync(0, "utf8")); const n = c.networks.default;
      const ipam = n.ipam.config[0];
      console.log(n.name, n.driver_opts["com.docker.network.bridge.name"], ipam.subnet, ipam.ip_range,
        c.services["ws-gateway"].networks.default.ipv4_address);'
)
[[ -n "${WS_IP:-}" ]] || {
  echo "could not read the network from infra/docker-compose.prod.yml" >&2
  exit 1
}
echo "compose: network ${NETWORK}, bridge ${BRIDGE}, subnet ${SUBNET}, dynamic ${RANGE}, ws-gateway ${WS_IP}"

# ── The stand-in host ──
for pinned in "$NODE_TAG@$NODE_DIGEST" "$PYTHON_TAG@$PYTHON_DIGEST"; do
  docker pull -q "$pinned" >/dev/null
  docker image inspect -f '{{join .RepoDigests " "}}' "${pinned%@*}" | grep -q "${pinned#*@}" || {
    echo "${pinned%@*} is not ${pinned#*@}" >&2
    exit 1
  }
done
docker rm -f "$HOST" >/dev/null 2>&1 || true
trap 'docker rm -f "$HOST" >/dev/null 2>&1 || true' EXIT
docker run -d --privileged --name "$HOST" -e DOCKER_TLS_CERTDIR= \
  --mount "type=bind,source=$(host_path infra),target=/work,readonly" "$DIND_IMAGE" >/dev/null
for _ in $(seq 60); do
  in_host 'docker info >/dev/null 2>&1' && break
  sleep 1
done
in_host 'docker info >/dev/null 2>&1' || {
  echo "Docker-in-Docker did not start" >&2
  exit 1
}
docker save "$NODE_TAG" "$PYTHON_TAG" | docker exec -i "$HOST" docker load -q >/dev/null
in_host 'apk add --no-cache -q bash iproute2 python3 >/dev/null'

# The fake metadata service: answers the IMDSv2 token PUT only, in namespace "imds" behind a veth pair
docker exec -i "$HOST" sh -c 'cat > /tmp/fake-imds.py' <<'EOF'
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_PUT(self):
        ok = self.path == "/latest/api/token" and self.headers.get("X-aws-ec2-metadata-token-ttl-seconds")
        body = b"fake-token-for-tests" if ok else b""
        self.send_response(200 if ok else 400)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

HTTPServer(("169.254.169.254", 80), Handler).serve_forever()
EOF
in_host '
  set -e
  ip netns add imds
  ip link add imds-host type veth peer name imds-ns
  ip link set imds-ns netns imds
  ip addr add 10.255.255.1/30 dev imds-host
  ip link set imds-host up
  ip netns exec imds ip link set lo up
  ip netns exec imds ip link set imds-ns up
  ip netns exec imds ip addr add 10.255.255.2/30 dev imds-ns
  ip netns exec imds ip addr add 169.254.169.254/32 dev imds-ns
  ip netns exec imds ip route add default via 10.255.255.1
  ip route add 169.254.169.254/32 via 10.255.255.2
  (ip netns exec imds python3 /tmp/fake-imds.py >/tmp/fake-imds.log 2>&1 &)
'
for _ in $(seq 20); do
  in_host 'ip netns exec imds python3 -c "import socket; socket.create_connection((\"169.254.169.254\", 80), 1)"' 2>/dev/null && break
  sleep 0.5
done
in_host "docker network create --driver bridge --subnet ${SUBNET} --ip-range ${RANGE} \
  -o com.docker.network.bridge.name=${BRIDGE} ${NETWORK} >/dev/null"

GUARD="$(bash infra/vm/setup.sh --print-imds-guard)"

# ── Scenario helpers ──
standins() { # standins [--ip ADDRESS]: ws-gateway (at ADDRESS if given), auth-service, the Python services
  in_host "docker rm -f forexedge-ws-gateway-1 forexedge-auth-service-1 forexedge-ml-service-1     forexedge-research-agent-1 >/dev/null 2>&1 || true"
  in_host "docker run -d --name forexedge-ws-gateway-1 --network ${NETWORK} $* --network-alias ws-gateway \
    -l com.docker.compose.project=forexedge -l com.docker.compose.service=ws-gateway ${NODE_TAG} \
    node -e \"require('http').createServer((q, s) => s.end('ok')).listen(3005)\" >/dev/null"
  in_host "docker run -d --name forexedge-auth-service-1 --network ${NETWORK} \
    -l com.docker.compose.project=forexedge -l com.docker.compose.service=auth-service ${NODE_TAG} \
    node -e 'setInterval(() => {}, 1 << 30)' >/dev/null"
  for service in ml-service research-agent; do
    in_host "docker run -d --name forexedge-${service}-1 --network ${NETWORK}       -l com.docker.compose.project=forexedge -l com.docker.compose.service=${service} ${PYTHON_TAG}       sleep infinity >/dev/null"
  done
}
unguard() {
  in_host 'iptables -w -D DOCKER-USER -j FOREXEDGE-IMDS 2>/dev/null || true
    iptables -w -F FOREXEDGE-IMDS 2>/dev/null || true
    iptables -w -X FOREXEDGE-IMDS 2>/dev/null || true'
}
guard() { # guard SCRIPT
  printf '%s\n' "$1" | docker exec -i "$HOST" sh -c 'cat > /tmp/guard.sh'
  in_host 'bash /tmp/guard.sh'
}
rules() { in_host 'iptables -w -S DOCKER-USER; iptables -w -S FOREXEDGE-IMDS'; }

passed=0
failed=0
out="$(mktemp)"
# scenario NAME WANT EXPECTED: runs the check; WANT pass|fail; EXPECTED is text its output must contain
# CHECK is the script run in the stand-in host (default: the repository's, mounted read-only)
CHECK=/work/vm/check-imds-guard.sh
scenario() {
  local name="$1" want="$2" expected="$3" status=0
  docker exec "$HOST" bash "$CHECK" >"$out" 2>&1 || status=$?
  if { [[ "$want" == pass && "$status" -eq 0 ]] || [[ "$want" == fail && "$status" -ne 0 ]]; } && grep -qF -- "$expected" "$out"; then
    printf 'ok    %-40s check %s as expected (%s)\n' "$name" "${want}ed" "$expected"
    [[ "$want" == fail ]] || sed 's/^/        /' "$out"
    passed=$((passed + 1))
  else
    printf 'FAIL  %-40s check exit %s, expected to %s with "%s":\n' "$name" "$status" "$want" "$expected"
    sed 's/^/        /' "$out"
    failed=$((failed + 1))
  fi
}

echo "== guarded"
standins --ip "$WS_IP"
guard "$GUARD"
scenario "guarded" pass "only ws-gateway reaches 169.254.169.254 (5 other containers refused: 1 node, 2 python)"
before="$(rules)"
guard "$GUARD"
if [[ "$(rules)" == "$before" ]] && [[ "$(grep -c -- '-j FOREXEDGE-IMDS' <<<"$before")" -eq 1 ]]; then
  echo "ok    guard applied twice: same rules, one jump from DOCKER-USER"
  passed=$((passed + 1))
else
  printf 'FAIL  guard applied twice changed the rules:\n%s\n---\n%s\n' "$before" "$(rules)"
  failed=$((failed + 1))
fi

echo "== planted faults"
unguard
scenario "no guard" fail "token received, expected: refused"

other_guard="${GUARD//${WS_IP}\/32/172.30.0.11/32}"
[[ "$other_guard" != "$GUARD" ]] || {
  echo "fault not planted: ${WS_IP}/32 not in the guard" >&2
  exit 1
}
guard "$other_guard"
scenario "guard admits another address" fail "refused, expected: token received"
unguard

guard "$GUARD"
standins
scenario "ws-gateway off its fixed address" fail "refused, expected: token received"

standins --ip "$WS_IP"
in_host "sed 's/command -v python3 || command -v python/false/' /work/vm/check-imds-guard.sh >/tmp/check-no-python.sh"
in_host "! cmp -s /work/vm/check-imds-guard.sh /tmp/check-no-python.sh" || {
  echo "fault not planted: the python probe was not found in check-imds-guard.sh" >&2
  exit 1
}
CHECK=/tmp/check-no-python.sh
scenario "python containers skipped" fail "running, but not probed with python"
CHECK=/work/vm/check-imds-guard.sh

rm -f "$out"
printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 && "$passed" -eq 6 ]]
