#!/usr/bin/env bash
# Offline checks for the AWS infrastructure code (npm run infra:check). Nothing here calls AWS or needs
# credentials: init skips the backend, terraform test runs against a mocked provider, tflint runs without
# deep_check. Fails on the first failing check.
#
#   fmt -check, source rules (compose images = ECR, check-compose.mjs, no key pair, no inline SG rules),
#   init (lock file read-only), validate, terraform test, tflint + AWS ruleset, shellcheck
#
# The metadata guard's end-to-end test (Docker-in-Docker) is separate: npm run infra:imds-test
#
# Terraform is the exact version of versions.tf (TERRAFORM=/path/to/terraform to use another binary of that
# version). tflint and shellcheck run from images pinned by digest, so Docker must be running.
set -euo pipefail

TERRAFORM_VERSION="1.16.7"
TFLINT_IMAGE="ghcr.io/terraform-linters/tflint:v0.65.0@sha256:2788f4d4fc663c0e953b011b01bf443fe5bfce7587ee916e588e6057b85d6359"
SHELLCHECK_IMAGE="koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d"
TFLINT_PLUGIN_VOLUME="forexedge-tflint-plugins"

TF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$TF_DIR")"
TERRAFORM="${TERRAFORM:-terraform}"

# Docker Desktop on Windows needs a Windows path for a bind mount, and Git Bash must not rewrite the
# container-side paths
host_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
export MSYS_NO_PATHCONV=1

step() { printf '\n== %s\n' "$1"; }

step "terraform version"
actual="$("$TERRAFORM" version -json | sed -n 's/.*"terraform_version": *"\([^"]*\)".*/\1/p')"
if [[ "$actual" != "$TERRAFORM_VERSION" ]]; then
  echo "terraform $actual found, $TERRAFORM_VERSION required (versions.tf)" >&2
  exit 1
fi
echo "terraform $actual"

cd "$TF_DIR"

step "terraform fmt -check"
"$TERRAFORM" fmt -check -recursive -diff

step "compose images = ECR repositories"
# shellcheck disable=SC2016  # literal ${...} in the pattern
compose_images="$(sed -n 's|^ *image: \${IMAGE_REGISTRY:-forexedge}/\([a-z-]*\):\${IMAGE_TAG:-local}$|\1|p' "$INFRA_DIR/docker-compose.prod.yml" | sort)"
ecr_images="$(sed -n '/^  images = toset(\[/,/^  \])/s/^ *"\([a-z-]*\)",$/\1/p' "$TF_DIR/locals.tf" | sort)"
if [[ -z "$compose_images" || "$compose_images" != "$ecr_images" ]]; then
  echo "docker-compose.prod.yml images and locals.tf images differ:" >&2
  diff <(echo "$compose_images") <(echo "$ecr_images") >&2 || true
  exit 1
fi
echo "$(wc -l <<<"$compose_images") images, same in both"

step "compose rules (check-compose.mjs: ports, limits, the metadata guard's network)"
(cd "$INFRA_DIR/.." && node infra/check-compose.mjs)

# Attributes a mocked provider fills with random values when they are left unset, so terraform test
# can't see them: checked in the source instead
step "no key pair, no inline security group rules"
if grep -nE '^\s*(key_name|ingress|egress)\s*(=|\{)' ./*.tf >&2; then
  echo "key pairs and inline security group rules are not allowed (SSM only; rules are separate resources)" >&2
  exit 1
fi
echo "none"

step "terraform init -backend=false"
"$TERRAFORM" init -backend=false -input=false -lockfile=readonly >/dev/null
echo "providers installed from .terraform.lock.hcl"

step "terraform validate"
"$TERRAFORM" validate

step "terraform test"
test_log="$(mktemp)"
"$TERRAFORM" test | tee "$test_log"
# A filter or layout mistake can run zero tests, which terraform reports as success
if ! grep -qE 'Success!.* [1-9][0-9]* passed, 0 failed' "$test_log"; then
  rm -f "$test_log"
  echo "terraform test ran no test" >&2
  exit 1
fi
rm -f "$test_log"

step "tflint (AWS ruleset)"
tf_mount="$(host_path "$TF_DIR")"
docker run --rm -e TFLINT_PLUGIN_DIR=/plugins -v "$TFLINT_PLUGIN_VOLUME:/plugins" \
  --mount "type=bind,source=$tf_mount,target=/data" -w /data "$TFLINT_IMAGE" --init >/dev/null
docker run --rm -e TFLINT_PLUGIN_DIR=/plugins -v "$TFLINT_PLUGIN_VOLUME:/plugins" \
  --mount "type=bind,source=$tf_mount,target=/data,readonly" -w /data "$TFLINT_IMAGE" --format compact
echo "tflint: no issues"

step "shellcheck"
mapfile -t scripts < <(cd "$INFRA_DIR" && find vm terraform -name '*.sh' -not -path '*/.terraform/*' | sort)
docker run --rm --mount "type=bind,source=$(host_path "$INFRA_DIR"),target=/mnt,readonly" -w /mnt \
  "$SHELLCHECK_IMAGE" "${scripts[@]}"
printf 'shellcheck: %s\n' "${scripts[@]}"

printf '\nAll infrastructure checks passed.\n'
