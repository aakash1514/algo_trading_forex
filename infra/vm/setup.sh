#!/usr/bin/env bash
# ForexEdge host setup: Ubuntu 24.04 LTS (x86_64) on the EC2 instance of infra/terraform. Run as root
# through Session Manager (docs/DEPLOY.md section 7). Idempotent: every step looks at the current state
# first, so a second run changes nothing and restarts nothing. Reads and writes no secret.
#
#   1. Docker Engine + Compose plugin, exact versions, from Docker's apt repository (key fingerprint checked)
#   2. Docker's default log rotation: json-file, 3 x 10 MB
#   3. 4 GB swap file, swappiness 10
#   4. unattended-upgrades: Ubuntu security updates only, never an automatic reboot
#   5. CloudWatch agent (exact version, sha256 and AWS signature checked): mem_used_percent and
#      disk_used_percent for /, with the dimensions of the alarms in infra/terraform/monitoring.tf
#   6. /opt/forexedge, owned by root, mode 700
#   7. Instance metadata guard: only ws-gateway's container reaches 169.254.169.254 (right after step 1,
#      so it is in place before any container runs)
#   8. AWS CLI v2, exact version (sha256 and AWS's signature checked): the host-side tools of infra/vm
#      (ECR login, S3 downloads) run on the host with the instance role, never in a container (step 7)
#
#   bash setup.sh                       as root, on the host
#   bash setup.sh --print-imds-guard    prints the guard script it installs (tests; no root needed)
#
# Upgrades are deliberate (docs/DEPLOY.md, monthly check): change a version below and run the script again.
set -euo pipefail

# Docker packages: Docker Engine 29.9.2, containerd 2.4.2, Compose 5.6.1 (each >= 14 days old when pinned)
DOCKER_VERSION="5:29.9.2-1~ubuntu.24.04~noble"
CONTAINERD_VERSION="2.4.2-3~ubuntu.24.04~noble"
COMPOSE_VERSION="5.6.1-1~ubuntu.24.04~noble"
DOCKER_KEY_URL="https://download.docker.com/linux/ubuntu/gpg"
DOCKER_KEY_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

# CloudWatch agent 1.300073.2 (build b1889, published 2026-09-29)
CWAGENT_BUILD="1.300073.2b1889"
CWAGENT_PACKAGE_VERSION="1.300073.2b1889-1"
CWAGENT_SHA256="f25c81f42627ac481b51215e8e6f989208ab266f8b224ffd66a208061e790f1c"
CWAGENT_BASE_URL="https://amazoncloudwatch-agent.s3.amazonaws.com"
CWAGENT_KEY_FINGERPRINT="937616F3450B7D806CBD9725D58167303B789C72"
CWAGENT_CONFIG="/opt/aws/amazon-cloudwatch-agent/etc/forexedge.json"
CWAGENT_CTL="/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl"

# AWS CLI 2.39.1 (released 2026-10-28). The signing key is the one AWS publishes in the CLI install guide
# ("Verify the integrity and authenticity of the downloaded zip file"), valid until 2027-07-02: AWS extends
# it before then, and the monthly check (docs/DEPLOY.md 7.6) replaces it with the guide's new copy
AWSCLI_VERSION="2.39.1"
AWSCLI_SHA256="5b6c10e0a8ccdcf30c84bd643fea511f103d257a4787a7cef878691d63169804"
AWSCLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip"
AWSCLI_KEY_FINGERPRINT="FB5DB77FD5C118B80511ADA8A6310ACC4672475C"

SWAP_FILE="/swapfile"
SWAP_SIZE_MB=4096
APP_DIR="/opt/forexedge"

# The compose bridge and ws-gateway's fixed address (infra/docker-compose.prod.yml; check-compose.mjs
# fails if they differ)
IMDS_GUARD_BRIDGE="fxedge0"
IMDS_GUARD_WS_GATEWAY_IP="172.30.0.10"
IMDS_GUARD_PATH="/usr/local/sbin/forexedge-imds-guard"

log() { printf '[setup] %s\n' "$*"; }
die() {
  printf '[setup] ERROR: %s\n' "$*" >&2
  exit 1
}

# Writes stdin to a root-owned file only when the content differs. Returns 0 when it wrote, 1 when the
# file was already identical (callers restart a service only on 0).
write_if_changed() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  install -D -m "$mode" -o root -g root "$tmp" "$path"
  rm -f "$tmp"
  log "wrote $path"
  return 0
}

# Primary key fingerprint of an OpenPGP key file, without touching any keyring
key_fingerprint() {
  local home
  home="$(mktemp -d)"
  GNUPGHOME="$home" gpg --batch --quiet --with-colons --show-keys "$1" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }'
  rm -rf "$home"
}

installed_version() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null || true; }

# The guard installed as ${IMDS_GUARD_PATH}. Docker's systemd unit runs it before and after dockerd
# starts (drop-in below), so it holds across reboots and Docker restarts. The role's credentials are for
# ws-gateway (backtest results in S3); with the hop limit at 2 every container could otherwise read them.
print_imds_guard() {
  cat <<EOF
#!/usr/bin/env bash
# ForexEdge instance metadata guard (installed by infra/vm/setup.sh; do not edit here).
# Only ws-gateway (${IMDS_GUARD_WS_GATEWAY_IP}, from the compose bridge ${IMDS_GUARD_BRIDGE}) may reach
# 169.254.169.254; any other container gets a TCP reset (other protocols: ICMP unreachable). The host's own
# processes (SSM and CloudWatch agents) are not affected: their traffic doesn't cross FORWARD.
# A spoofed source address gets nowhere: the answer goes to the real ws-gateway, so no TCP handshake.
set -euo pipefail
chain=FOREXEDGE-IMDS
# DOCKER-USER is Docker's chain for user rules: Docker creates it if missing and never flushes it
iptables -w -N DOCKER-USER 2>/dev/null || true
# One atomic replace of this chain (--noflush leaves every other chain as it is)
iptables-restore -w --noflush <<RULES
*filter
:\${chain} - [0:0]
-A \${chain} -s ${IMDS_GUARD_WS_GATEWAY_IP}/32 -d 169.254.169.254/32 -i ${IMDS_GUARD_BRIDGE} -p tcp --dport 80 -j RETURN
-A \${chain} -d 169.254.169.254/32 -p tcp -j REJECT --reject-with tcp-reset
-A \${chain} -d 169.254.169.254/32 -j REJECT --reject-with icmp-port-unreachable
COMMIT
RULES
iptables -w -C DOCKER-USER -j "\${chain}" 2>/dev/null || iptables -w -I DOCKER-USER 1 -j "\${chain}"
EOF
}

case "${1:-}" in
  --print-imds-guard)
    print_imds_guard
    exit 0
    ;;
  "") ;;
  *) die "usage: setup.sh [--print-imds-guard]" ;;
esac

[[ "${EUID}" -eq 0 ]] || die "run as root (sudo bash setup.sh)"
# shellcheck source=/dev/null
. /etc/os-release
[[ "${ID}" == "ubuntu" && "${VERSION_ID}" == "24.04" ]] || die "Ubuntu 24.04 required, found ${ID} ${VERSION_ID}"
[[ "$(dpkg --print-architecture)" == "amd64" ]] || die "amd64 required"
export DEBIAN_FRONTEND=noninteractive

apt_updated=false
apt_update() {
  if [[ "$apt_updated" == false ]]; then
    apt-get update -q
    apt_updated=true
  fi
}

# ── 1. Docker Engine and the Compose plugin ─────────────────────────────────
install -d -m 0755 /etc/apt/keyrings
if [[ "$(key_fingerprint /etc/apt/keyrings/docker.asc 2>/dev/null)" != "$DOCKER_KEY_FINGERPRINT" ]]; then
  key="$(mktemp)"
  curl -fsSL "$DOCKER_KEY_URL" -o "$key"
  fingerprint="$(key_fingerprint "$key")"
  [[ "$fingerprint" == "$DOCKER_KEY_FINGERPRINT" ]] || die "Docker's key has fingerprint '${fingerprint}', expected ${DOCKER_KEY_FINGERPRINT}"
  install -m 0644 -o root -g root "$key" /etc/apt/keyrings/docker.asc
  rm -f "$key"
  log "installed Docker's apt key ${DOCKER_KEY_FINGERPRINT}"
fi

if write_if_changed /etc/apt/sources.list.d/docker.sources 0644 <<EOF; then
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt_updated=false
fi

docker_packages=(
  "docker-ce=${DOCKER_VERSION}"
  "docker-ce-cli=${DOCKER_VERSION}"
  "containerd.io=${CONTAINERD_VERSION}"
  "docker-compose-plugin=${COMPOSE_VERSION}"
)
docker_current=true
for spec in "${docker_packages[@]}"; do
  [[ "$(installed_version "${spec%%=*}")" == "${spec#*=}" ]] || docker_current=false
done
if [[ "$docker_current" == false ]]; then
  apt_update
  apt-get install -y -q --no-install-recommends --allow-downgrades --allow-change-held-packages "${docker_packages[@]}"
  log "installed ${docker_packages[*]}"
fi
# Held: nothing but this script (a changed version above) moves them
for spec in "${docker_packages[@]}"; do
  pkg="${spec%%=*}"
  if ! apt-mark showhold "$pkg" | grep -qx "$pkg"; then
    apt-mark hold "$pkg" >/dev/null
  fi
done

# ── 7. Instance metadata guard (before anything restarts Docker) ────────────
print_imds_guard | write_if_changed "$IMDS_GUARD_PATH" 0755 || true
if write_if_changed /etc/systemd/system/docker.service.d/forexedge-imds-guard.conf 0644 <<EOF; then
# ForexEdge: the metadata guard before dockerd starts (no container runs unguarded, also at boot) and
# again once it is up (in case Docker rebuilt its chains). Installed by infra/vm/setup.sh.
[Service]
ExecStartPre=${IMDS_GUARD_PATH}
ExecStartPost=${IMDS_GUARD_PATH}
EOF
  systemctl daemon-reload
fi
# Applied now as well (idempotent: the same rules replace themselves)
"$IMDS_GUARD_PATH"

# ── 2. Docker log rotation ──────────────────────────────────────────────────
# Compose sets the same per service; this covers any container started by hand
if write_if_changed /etc/docker/daemon.json 0644 <<'EOF'; then
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
  systemctl restart docker
  log "restarted Docker for the new daemon.json"
fi
systemctl is-enabled --quiet docker || systemctl enable docker
systemctl is-active --quiet docker || systemctl start docker

# ── 3. Swap ─────────────────────────────────────────────────────────────────
if [[ -e "$SWAP_FILE" ]]; then
  size_mb=$(($(stat -c %s "$SWAP_FILE") / 1024 / 1024))
  [[ "$size_mb" -eq "$SWAP_SIZE_MB" ]] || die "${SWAP_FILE} is ${size_mb} MB, expected ${SWAP_SIZE_MB} (resize it by hand)"
else
  fallocate -l "${SWAP_SIZE_MB}M" "$SWAP_FILE"
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE" >/dev/null
  log "created ${SWAP_FILE} (${SWAP_SIZE_MB} MB)"
fi
if ! swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
  swapon "$SWAP_FILE"
  log "swap on"
fi
if ! grep -qE "^${SWAP_FILE}[[:space:]]" /etc/fstab; then
  printf '%s none swap sw 0 0\n' "$SWAP_FILE" >>/etc/fstab
  log "added ${SWAP_FILE} to /etc/fstab"
fi
write_if_changed /etc/sysctl.d/99-forexedge.conf 0644 <<<"vm.swappiness = 10" || true
if [[ "$(sysctl -n vm.swappiness)" != "10" ]]; then
  sysctl -q -w vm.swappiness=10
  log "swappiness 10"
fi

# ── 4. Security updates ─────────────────────────────────────────────────────
if [[ "$(installed_version unattended-upgrades)" == "" ]]; then
  apt_update
  apt-get install -y -q unattended-upgrades
fi
write_if_changed /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Kernel and library updates that need a reboot wait for the monthly check (docs/DEPLOY.md)
write_if_changed /etc/apt/apt.conf.d/52forexedge-unattended-upgrades 0644 <<'EOF' || true
// ForexEdge: never reboot by itself; reboots are manual (docs/DEPLOY.md, monthly check)
Unattended-Upgrade::Automatic-Reboot "false";
EOF
# Ubuntu's defaults allow the security pockets only; refuse to run if -updates was enabled
if grep -E '^[[:space:]]*"\$\{distro_id\}:\$\{distro_codename\}-updates"' /etc/apt/apt.conf.d/50unattended-upgrades >/dev/null; then
  die "50unattended-upgrades allows ${VERSION_CODENAME}-updates; security updates only are expected"
fi

# ── 5. CloudWatch agent ─────────────────────────────────────────────────────
if [[ "$(installed_version amazon-cloudwatch-agent)" != "$CWAGENT_PACKAGE_VERSION" ]]; then
  work="$(mktemp -d)"
  url="${CWAGENT_BASE_URL}/ubuntu/amd64/${CWAGENT_BUILD}/amazon-cloudwatch-agent.deb"
  curl -fsSL "$url" -o "$work/agent.deb"
  curl -fsSL "$url.sig" -o "$work/agent.deb.sig"
  curl -fsSL "${CWAGENT_BASE_URL}/assets/amazon-cloudwatch-agent.gpg" -o "$work/agent-key.asc"
  echo "${CWAGENT_SHA256}  $work/agent.deb" | sha256sum -c --quiet - || die "CloudWatch agent package checksum mismatch"
  fingerprint="$(key_fingerprint "$work/agent-key.asc")"
  [[ "$fingerprint" == "$CWAGENT_KEY_FINGERPRINT" ]] || die "CloudWatch agent key has fingerprint '${fingerprint}', expected ${CWAGENT_KEY_FINGERPRINT}"
  gpg --batch --quiet --yes --dearmor -o "$work/agent-key.gpg" "$work/agent-key.asc"
  gpgv --quiet --keyring "$work/agent-key.gpg" "$work/agent.deb.sig" "$work/agent.deb" 2>/dev/null || die "CloudWatch agent signature check failed"
  dpkg -i "$work/agent.deb" >/dev/null
  rm -rf "$work"
  log "installed amazon-cloudwatch-agent ${CWAGENT_PACKAGE_VERSION}"
fi

# Metrics only (no logs). omit_hostname drops the "host" dimension and drop_device the "device" one, so
# the metrics carry exactly the alarms' dimensions: mem_used_percent {InstanceId},
# disk_used_percent {InstanceId, path, fstype}
cwagent_changed=false
if write_if_changed "$CWAGENT_CONFIG" 0644 <<'EOF'; then
{
  "agent": {
    "metrics_collection_interval": 60,
    "omit_hostname": true,
    "run_as_user": "cwagent"
  },
  "metrics": {
    "namespace": "CWAgent",
    "append_dimensions": {
      "InstanceId": "${aws:InstanceId}"
    },
    "metrics_collected": {
      "mem": {
        "measurement": ["mem_used_percent"]
      },
      "disk": {
        "measurement": ["used_percent"],
        "resources": ["/"],
        "drop_device": true
      }
    }
  }
}
EOF
  cwagent_changed=true
fi
if [[ "$cwagent_changed" == true ]] || ! "$CWAGENT_CTL" -a status | grep -q '"status": "running"'; then
  "$CWAGENT_CTL" -a fetch-config -m ec2 -s -c "file:${CWAGENT_CONFIG}" >/dev/null
  log "CloudWatch agent configured and running"
fi

# ── 8. AWS CLI v2 ────────────────────────────────────────────────────────────
if [[ "$(/usr/local/bin/aws --version 2>/dev/null | cut -d" " -f1)" != "aws-cli/${AWSCLI_VERSION}" ]]; then
  if [[ "$(installed_version unzip)" == "" ]]; then
    apt_update
    apt-get install -y -q unzip
  fi
  work="$(mktemp -d)"
  curl -fsSL "$AWSCLI_URL" -o "$work/awscli.zip"
  curl -fsSL "$AWSCLI_URL.sig" -o "$work/awscli.zip.sig"
  cat >"$work/awscli-key.asc" <<'EOF'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBF2Cr7UBEADJZHcgusOJl7ENSyumXh85z0TRV0xJorM2B/JL0kHOyigQluUG
ZMLhENaG0bYatdrKP+3H91lvK050pXwnO/R7fB/FSTouki4ciIx5OuLlnJZIxSzx
PqGl0mkxImLNbGWoi6Lto0LYxqHN2iQtzlwTVmq9733zd3XfcXrZ3+LblHAgEt5G
TfNxEKJ8soPLyWmwDH6HWCnjZ/aIQRBTIQ05uVeEoYxSh6wOai7ss/KveoSNBbYz
gbdzoqI2Y8cgH2nbfgp3DSasaLZEdCSsIsK1u05CinE7k2qZ7KgKAUIcT/cR/grk
C6VwsnDU0OUCideXcQ8WeHutqvgZH1JgKDbznoIzeQHJD238GEu+eKhRHcz8/jeG
94zkcgJOz3KbZGYMiTh277Fvj9zzvZsbMBCedV1BTg3TqgvdX4bdkhf5cH+7NtWO
lrFj6UwAsGukBTAOxC0l/dnSmZhJ7Z1KmEWilro/gOrjtOxqRQutlIqG22TaqoPG
fYVN+en3Zwbt97kcgZDwqbuykNt64oZWc4XKCa3mprEGC3IbJTBFqglXmZ7l9ywG
EEUJYOlb2XrSuPWml39beWdKM8kzr1OjnlOm6+lpTRCBfo0wa9F8YZRhHPAkwKkX
XDeOGpWRj4ohOx0d2GWkyV5xyN14p2tQOCdOODmz80yUTgRpPVQUtOEhXQARAQAB
tCFBV1MgQ0xJIFRlYW0gPGF3cy1jbGlAYW1hem9uLmNvbT6JAlQEEwEIAD4CGwMF
CwkIBwIGFQoJCAsCBBYCAwECHgECF4AWIQT7Xbd/1cEYuAURraimMQrMRnJHXAUC
akV0ygUJDqP4lQAKCRCmMQrMRnJHXFHjD/9eyZLYcKuQOlLvtqSDtUBiEZf6ZZjM
i3ygYH8rJNtuToUH+HvSpe819urJCquXhDrlK6N+aqW0hCLtNABJG/vsafIgvIYJ
hSGgpgtNnQyMV1jViRWqPjbouw8OkYKBThUfT1i2Y+wn58ifs6ODBCmTexWtXspA
Si+Gt49xDOW0APmbOPnI+a4HJW6tVEo6MWS0WjzpiBayR3d1A4pt4YrPfSdDgpLo
h2SLQqlRqvvVZJaWBjhkErNFpfsBA06sDcPEOb0G8LBUbR4WOcdvhe5LubJbZuxC
AG9kNPCVeQP1ixwjgjXKysaxeQ6rv0VzIQgRp6tLVLWhy6AKDNvLjFSsmXZ1Wl08
Y/RlOHXlzLuQMRE6sR1wOdRxc9TsrNWTGiBK65cvSWOy03JeBkQQ8pesqltiyxI9
U21kkgiXtTSKNGfKK8pO27D81YANhRqPK7iTp6kuFiY2WtOg90KTMNlIT+Ff85Y2
b1rHj6Z0SrCkJujhWk3IBPic/wJgz01LEc/OAdUPlby90RJZcIBhSlWhT7mXnXIO
c0HWlNQrns2s3CTyYwZSiSlYe9ApeLwhjDo8NhbFuCAy61l6O5UsR4AfZxx/rGKv
2wFb1/RN/P4gNe6vmxZAPjR0AQcwD3tc2McimOLr/22kmPz8IH3I0X7WoSFr0Biz
E91G7bb0hOb/cA==
=knv7
-----END PGP PUBLIC KEY BLOCK-----
EOF
  echo "${AWSCLI_SHA256}  $work/awscli.zip" | sha256sum -c --quiet - || die "AWS CLI package checksum mismatch"
  fingerprint="$(key_fingerprint "$work/awscli-key.asc")"
  [[ "$fingerprint" == "$AWSCLI_KEY_FINGERPRINT" ]] || die "AWS CLI key has fingerprint '${fingerprint}', expected ${AWSCLI_KEY_FINGERPRINT}"
  gpg --batch --quiet --yes --dearmor -o "$work/awscli-key.gpg" "$work/awscli-key.asc"
  gpgv --quiet --keyring "$work/awscli-key.gpg" "$work/awscli.zip.sig" "$work/awscli.zip" 2>/dev/null || die "AWS CLI signature check failed"
  unzip -q "$work/awscli.zip" -d "$work"
  # --update replaces an older version in place; the first install creates /usr/local/aws-cli
  "$work/aws/install" --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli --update >/dev/null
  rm -rf "$work"
  log "installed $(/usr/local/bin/aws --version | cut -d" " -f1)"
fi

# ── 6. Application directory ────────────────────────────────────────────────
install -d -o root -g root -m 0700 "$APP_DIR"
[[ "$(stat -c '%U:%G %a' "$APP_DIR")" == "root:root 700" ]] || {
  chown root:root "$APP_DIR"
  chmod 0700 "$APP_DIR"
}

log "done: $(docker --version), $(docker compose version), swap $(swapon --show=SIZE --noheadings "$SWAP_FILE" | tr -d ' '), swappiness $(sysctl -n vm.swappiness), agent ${CWAGENT_PACKAGE_VERSION}, $(/usr/local/bin/aws --version | cut -d" " -f1), ${APP_DIR} $(stat -c '%U:%G %a' "$APP_DIR"), metadata for ${IMDS_GUARD_WS_GATEWAY_IP} only"
