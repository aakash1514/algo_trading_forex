#!/usr/bin/env bash
# Offline checks for the AWS infrastructure code (npm run infra:check). Nothing here calls AWS or needs
# credentials: init skips the backend, terraform test runs against a mocked provider, tflint runs without
# deep_check. Fails on the first failing check.
#
#   fmt -check, source rules (compose images = ECR, check-compose.mjs, no key pair, no inline SG rules,
#   no owned OIDC provider, the instance ignores AMI and public IP drift),
#   init (lock file read-only), validate, terraform test, tflint + AWS ruleset, shellcheck,
#   infra/vm/run-on-host.sh and stage.sh against stub aws/terraform commands, the host scripts in Ubuntu
#   24.04 against stub aws/docker, the GitHub workflows (actionlint, pinned actions, the image matrix = compose,
#   the rules for ci.yml and deploy.yml)
#
# The metadata guard's end-to-end test (Docker-in-Docker) is separate: npm run infra:imds-test
#
# Terraform is the exact version of versions.tf (TERRAFORM=/path/to/terraform to use another binary of that
# version). tflint and shellcheck run from images pinned by digest, so Docker must be running.
set -euo pipefail

TERRAFORM_VERSION="1.16.7"
TFLINT_IMAGE="ghcr.io/terraform-linters/tflint:v0.65.0@sha256:2788f4d4fc663c0e953b011b01bf443fe5bfce7587ee916e588e6057b85d6359"
ACTIONLINT_IMAGE="rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667"
UBUNTU_IMAGE="ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852"
SHELLCHECK_IMAGE="koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d"
TFLINT_PLUGIN_VOLUME="forexedge-tflint-plugins"

TF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$TF_DIR")"
TERRAFORM="${TERRAFORM:-terraform}"

# Docker Desktop on Windows needs a Windows path for a bind mount, and Git Bash must not rewrite the
# container-side paths
host_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
# Terraform and tflint run on a copy of the configuration in .terraform-check/ (git-ignored), never in
# this directory: .terraform/ may hold the owner's real S3 backend (an init there, even -backend=false,
# looks for credentials), and terraform.tfvars, which terraform test and tflint load by themselves, would
# replace the defaults the checks are about. The copy has the .tf files, the lock file, .tflint.hcl and
# the tests, nothing else.
CHECK_DIR="$TF_DIR/.terraform-check/config"
export TF_DATA_DIR="$TF_DIR/.terraform-check/data"
stage_config() {
  rm -rf "$CHECK_DIR"
  mkdir -p "$CHECK_DIR/tests/mocks"
  cp "$TF_DIR"/*.tf "$TF_DIR/.terraform.lock.hcl" "$TF_DIR/.tflint.hcl" "$CHECK_DIR/"
  cp "$TF_DIR"/tests/*.tftest.hcl "$CHECK_DIR/tests/"
  cp "$TF_DIR"/tests/mocks/*.tfmock.hcl "$CHECK_DIR/tests/mocks/"
}
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
stage_config

step "terraform fmt -check"
(cd "$CHECK_DIR" && "$TERRAFORM" fmt -check -recursive -diff)

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

# GitHub's OIDC provider is shared with other projects: read with a data source, never owned (a destroy
# would delete it)
step "GitHub OIDC provider not owned by this stack"
if grep -nE '^\s*resource\s+"aws_iam_openid_connect_provider"' ./*.tf >&2; then
  echo "the GitHub OIDC provider is shared: reference it with data \"aws_iam_openid_connect_provider\", never a resource" >&2
  exit 1
fi
echo "data source only"

# lifecycle is not in the plan, so terraform test can't see it. Without ami a newer Ubuntu image replaces the
# instance; without associate_public_ip_address (true in AWS once the Elastic IP is associated) every plan
# after the first apply replaces it. Either way the database on its root volume goes with it.
step "aws_instance.app ignores AMI and public IP drift"
instance_ignored="$(sed -n '/^resource "aws_instance" "app" {/,/^}/s/^ *ignore_changes *= *\[\(.*\)\] *$/\1/p' ec2.tf | tr -d ' ' | tr ',' '\n')"
for attribute in ami associate_public_ip_address; do
  if ! grep -qx "$attribute" <<<"$instance_ignored"; then
    echo "aws_instance.app must have $attribute in lifecycle ignore_changes (a change to it replaces the host and its database)" >&2
    exit 1
  fi
done
echo "ami, associate_public_ip_address"

cd "$CHECK_DIR"

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
tf_mount="$(host_path "$CHECK_DIR")"
docker run --rm -e TFLINT_PLUGIN_DIR=/plugins -v "$TFLINT_PLUGIN_VOLUME:/plugins" \
  --mount "type=bind,source=$tf_mount,target=/data" -w /data "$TFLINT_IMAGE" --init >/dev/null
docker run --rm -e TFLINT_PLUGIN_DIR=/plugins -v "$TFLINT_PLUGIN_VOLUME:/plugins" \
  --mount "type=bind,source=$tf_mount,target=/data,readonly" -w /data "$TFLINT_IMAGE" --format compact
echo "tflint: no issues"

step "shellcheck"
mapfile -t scripts < <(cd "$INFRA_DIR" && find vm terraform -name '*.sh' -not -path '*/.terraform/*' -not -path '*/.terraform-check/*' | sort)
docker run --rm --mount "type=bind,source=$(host_path "$INFRA_DIR"),target=/mnt,readonly" -w /mnt \
  "$SHELLCHECK_IMAGE" "${scripts[@]}"
printf 'shellcheck: %s\n' "${scripts[@]}"

# actionlint also runs shellcheck (bundled in its image) over every run: block
step "GitHub workflows: actionlint"
docker run --rm --mount "type=bind,source=$(host_path "$INFRA_DIR/.."),target=/repo,readonly" -w /repo \
  "$ACTIONLINT_IMAGE" -no-color
echo "actionlint: no issues"

step "GitHub workflows: pinned actions, permissions, image matrix = compose"
(cd "$INFRA_DIR/.." && node infra/check-workflows.mjs)

step "run-on-host.sh (stub aws and terraform)"
bash "$INFRA_DIR/vm/tests/run-on-host.test.sh"

step "stage.sh (stub aws and terraform, a throwaway git repository)"
bash "$INFRA_DIR/vm/tests/stage.test.sh"

# As root in the host's OS (file modes, mawk), from an image pinned by digest
step "host scripts: fetch, make-env, set-secret, stack, bootstrap, deploy, restore-test (Ubuntu 24.04, stub aws and docker)"
docker run --rm --mount "type=bind,source=$(host_path "$INFRA_DIR/.."),target=/repo,readonly" -w /repo \
  "$UBUNTU_IMAGE" bash infra/vm/tests/host-scripts.test.sh

printf '\nAll infrastructure checks passed.\n'
