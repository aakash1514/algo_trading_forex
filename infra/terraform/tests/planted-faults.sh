#!/usr/bin/env bash
# Proves the offline checks catch what they claim to: plants one fault at a time, runs the check that
# must catch it, and fails if that check passes (or fails for a different reason). Each fault is an exact
# text replacement that must match exactly once, and the file is restored from git after every fault.
#
#   bash infra/terraform/tests/planted-faults.sh        (Docker running; TERRAFORM as in check.sh)
#
# Refuses to start with unstaged changes under infra/ or .github/: every fault is undone with git checkout,
# which restores the staged (or committed) version.
# The fault strings are literal Terraform and shell text: ${...} must not expand (SC2016 throughout)
# shellcheck disable=SC2016
set -euo pipefail

TF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$(dirname "$TF_DIR")"
REPO_DIR="$(dirname "$INFRA_DIR")"
TERRAFORM="${TERRAFORM:-terraform}"
TFLINT_IMAGE="$(sed -n 's/^TFLINT_IMAGE="\(.*\)"$/\1/p' "$TF_DIR/check.sh")"
UBUNTU_IMAGE="$(sed -n 's/^UBUNTU_IMAGE="\(.*\)"$/\1/p' "$TF_DIR/check.sh")"
ACTIONLINT_IMAGE="$(sed -n 's/^ACTIONLINT_IMAGE="\(.*\)"$/\1/p' "$TF_DIR/check.sh")"
SHELLCHECK_IMAGE="$(sed -n 's/^SHELLCHECK_IMAGE="\(.*\)"$/\1/p' "$TF_DIR/check.sh")"
TFLINT_PLUGIN_VOLUME="$(sed -n 's/^TFLINT_PLUGIN_VOLUME="\(.*\)"$/\1/p' "$TF_DIR/check.sh")"
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
host_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
# terraform test -filter takes the platform's path: with "/" on Windows it finds no file, warns, and passes
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) SEP="\\" ;;
  *) SEP='/' ;;
esac

cd "$REPO_DIR"
if ! git diff --quiet -- infra/ .github/; then
  echo "unstaged changes under infra/ or .github/: stage or commit them first (faults are undone with git checkout)" >&2
  exit 1
fi
trap 'git checkout -q -- infra/ .github/' EXIT

out="$(mktemp)"
passed=0
failed=0

# A fault's FILE is relative to infra/, except .github/... and .nvmrc (relative to the repository)
repo_path() {
  case "$1" in
    .github/* | .nvmrc) printf '%s' "$1" ;;
    *) printf 'infra/%s' "$1" ;;
  esac
}

# plant FILE OLD NEW: replace the single occurrence of OLD
plant() {
  OLD="$2" NEW="$3" node -e '
    const fs = require("fs"); const f = process.argv[1]; const s = fs.readFileSync(f, "utf8");
    const n = s.split(process.env.OLD).length - 1;
    if (n !== 1) { console.error(`fault not planted: ${n} matches in ${f}`); process.exit(2); }
    fs.writeFileSync(f, s.replace(process.env.OLD, () => process.env.NEW));' "$(repo_path "$1")"
}

# run_check KIND [ARG...]: the check's output goes to $out; returns the check's exit status
run_check() {
  local kind="$1"
  shift
  case "$kind" in
    test)
      local status=0
      stage_config
      (cd "$CHECK_DIR" && "$TERRAFORM" test -no-color -filter="tests${SEP}$1.tftest.hcl") >"$out" 2>&1 || status=$?
      # A run of zero tests passes: that is a broken check, never a result
      if ! grep -qE '[1-9][0-9]* (passed|failed)' "$out"; then
        echo "terraform test ran no test for tests${SEP}$1.tftest.hcl:" >&2
        cat "$out" >&2
        exit 2
      fi
      return "$status"
      ;;
    fmt) stage_config && (cd "$CHECK_DIR" && "$TERRAFORM" fmt -check -recursive -no-color) >"$out" 2>&1 ;;
    validate) stage_config && (cd "$CHECK_DIR" && "$TERRAFORM" validate -no-color) >"$out" 2>&1 ;;
    tflint)
      stage_config
      docker run --rm -e TFLINT_PLUGIN_DIR=/plugins -v "$TFLINT_PLUGIN_VOLUME:/plugins" \
        --mount "type=bind,source=$(host_path "$CHECK_DIR"),target=/data,readonly" -w /data "$TFLINT_IMAGE" --format compact >"$out" 2>&1
      ;;
    shellcheck)
      docker run --rm --mount "type=bind,source=$(host_path "$INFRA_DIR"),target=/mnt,readonly" -w /mnt \
        "$SHELLCHECK_IMAGE" "$1" >"$out" 2>&1
      ;;
    check.sh) bash "$TF_DIR/check.sh" >"$out" 2>&1 ;;
    compose) node infra/check-compose.mjs >"$out" 2>&1 ;;
    workflows) node infra/check-workflows.mjs >"$out" 2>&1 ;;
    run-on-host-test) bash infra/vm/tests/run-on-host.test.sh >"$out" 2>&1 ;;
    stage-test) bash infra/vm/tests/stage.test.sh >"$out" 2>&1 ;;
    host-tests)
      docker run --rm --mount "type=bind,source=$(host_path "$REPO_DIR"),target=/repo,readonly" -w /repo \
        "$UBUNTU_IMAGE" bash infra/vm/tests/host-scripts.test.sh >"$out" 2>&1
      ;;
    actionlint)
      docker run --rm --mount "type=bind,source=$(host_path "$REPO_DIR"),target=/repo,readonly" -w /repo \
        "$ACTIONLINT_IMAGE" -no-color >"$out" 2>&1
      ;;
    *)
      echo "unknown check $kind" >&2
      exit 2
      ;;
  esac
}

# fault NAME FILE OLD NEW EXPECTED KIND [ARG]: EXPECTED is text the failing check's output must contain
fault() {
  local name="$1" file="$2" old="$3" new="$4" expected="$5"
  shift 5
  plant "$file" "$old" "$new"
  if run_check "$@"; then
    printf 'FAIL  %-58s check passed with the fault planted\n' "$name"
    failed=$((failed + 1))
  elif ! grep -qF -- "$expected" "$out"; then
    printf 'FAIL  %-58s check failed without "%s":\n' "$name" "$expected"
    sed 's/^/        /' "$out" | head -20
    failed=$((failed + 1))
  else
    printf 'ok    %-58s caught (%s)\n' "$name" "$expected"
    passed=$((passed + 1))
  fi
  git checkout -q -- "$(repo_path "$file")"
}

# fault2 NAME FILE OLD1 NEW1 OLD2 NEW2 EXPECTED KIND [ARG]: a fault that needs two edits of one file
fault2() {
  local name="$1" file="$2"
  plant "$file" "$3" "$4"
  shift 4
  fault "$name" "$file" "$@"
}

stage_config
(cd "$CHECK_DIR" && "$TERRAFORM" init -backend=false -input=false -lockfile=readonly >/dev/null)
if ! run_check test network; then
  echo "the unmodified configuration fails its tests: fix that first" >&2
  cat "$out" >&2
  exit 1
fi

echo "== security group"
fault "sg: tcp 22 from anywhere" terraform/network.tf \
  'http_ipv4       = {' \
  'ssh_ipv4        = { protocol = "tcp", port = 22, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    http_ipv4       = {' \
  'run "web_only_ingress"... fail' test network
fault "sg: port range 0-443" terraform/network.tf \
  'from_port         = each.value.port' 'from_port         = 0' \
  'run "web_only_ingress"... fail' test network
fault "sg: HTTP from 10.0.0.0/8" terraform/network.tf \
  'http_ipv4       = { protocol = "tcp", port = 80, cidr_ipv4 = "0.0.0.0/0"' \
  'http_ipv4       = { protocol = "tcp", port = 80, cidr_ipv4 = "10.0.0.0/8"' \
  'run "web_only_ingress"... fail' test network
fault "sg: all protocols" terraform/network.tf \
  'ip_protocol       = each.value.protocol' 'ip_protocol       = "-1"' \
  'run "web_only_ingress"... fail' test network
fault "subnet: automatic public IP" terraform/network.tf \
  'map_public_ip_on_launch = false' 'map_public_ip_on_launch = true' \
  'run "no_automatic_public_ip"... fail' test network

echo "== instance"
fault "imds: tokens optional" terraform/ec2.tf \
  'http_tokens                 = "required"' 'http_tokens                 = "optional"' \
  'run "imdsv2_required"... fail' test compute
fault "imds: hop limit 1" terraform/ec2.tf \
  'http_put_response_hop_limit = 2' 'http_put_response_hop_limit = 1' \
  'run "imdsv2_required"... fail' test compute
fault "imds: IPv6 endpoint on" terraform/ec2.tf \
  'http_protocol_ipv6          = "disabled"' 'http_protocol_ipv6          = "enabled"' \
  'run "imdsv2_required"... fail' test compute
fault "root volume unencrypted" terraform/ec2.tf \
  'encrypted             = true' 'encrypted             = false' \
  'run "root_volume_encrypted"... fail' test compute
fault "EBS encryption by default off" terraform/ec2.tf \
  'enabled = true' 'enabled = false' \
  'run "root_volume_encrypted"... fail' test compute
fault "cpu_credits default unlimited" terraform/variables.tf \
  'default     = "standard"' 'default     = "unlimited"' \
  'run "cpu_credits_standard_by_default"... fail' test compute
fault "cpu_credits hard-coded unlimited" terraform/ec2.tf \
  'cpu_credits = var.cpu_credits' 'cpu_credits = "unlimited"' \
  'run "cpu_credits_standard_by_default"... fail' test compute
fault "instance_state: an invalid value accepted" terraform/variables.tf \
  'contains(["running", "stopped"], var.instance_state)' 'length(var.instance_state) > 0' \
  'run "rejects_unknown_instance_state"... fail' test variables
fault "instance_state ignored (always running)" terraform/ec2.tf \
  'state       = var.instance_state' 'state       = "running"' \
  'run "instance_stopped_follows_variable"... fail' test compute
fault "instance_state: forced stop" terraform/ec2.tf \
  'force       = false' 'force       = true' \
  'run "instance_running_by_default"... fail' test compute
fault "termination protection hard-coded off" terraform/ec2.tf \
  'disable_api_termination     = var.enable_termination_protection' 'disable_api_termination     = false' \
  'run "termination_protection"... fail' test compute

echo "== buckets"
fault "results/backups: public ACLs allowed" terraform/s3.tf \
  'bucket                  = each.value.id
  block_public_acls       = true' \
  'bucket                  = each.value.id
  block_public_acls       = false' \
  'run "buckets_block_public_access"... fail' test storage
fault "account public access block: restrict off" terraform/s3.tf \
  'ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "this"' \
  'ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket" "this"' \
  'run "buckets_block_public_access"... fail' test storage
fault "ACLs enabled (ObjectWriter)" terraform/s3.tf \
  'object_ownership = "BucketOwnerEnforced"' 'object_ownership = "ObjectWriter"' \
  'run "buckets_block_public_access"... fail' test storage
fault "TLS policy: Allow instead of Deny" terraform/s3.tf \
  'Effect    = "Deny"' 'Effect    = "Allow"' \
  'run "buckets_deny_non_tls"... fail' test storage
fault "TLS policy: objects not covered" terraform/s3.tf \
  'Resource  = ["arn:aws:s3:::${local.buckets[each.key]}", "arn:aws:s3:::${local.buckets[each.key]}/*"]' \
  'Resource  = ["arn:aws:s3:::${local.buckets[each.key]}"]' \
  'run "buckets_deny_non_tls"... fail' test storage
fault "backups kept 30 days" terraform/s3.tf \
  'expiration {
      days = 14' 'expiration {
      days = 30' \
  'run "backups_expire_after_14_days"... fail' test storage

echo "== ECR"
fault "ECR: mutable tags" terraform/ecr.tf \
  '"IMMUTABLE"' '"MUTABLE"' \
  'run "ecr_repositories"... fail' test storage
fault "ECR: no scan on push" terraform/ecr.tf \
  'scan_on_push = true' 'scan_on_push = false' \
  'run "ecr_repositories"... fail' test storage

echo "== IAM"
fault "host role: s3:DeleteObject on backups" terraform/iam_vm.tf \
  'Action   = ["s3:GetObject", "s3:PutObject"]' 'Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]' \
  'run "vm_role_never_deletes"... fail' test iam
fault "host role: s3:* on the buckets" terraform/iam_vm.tf \
  'Action   = "s3:ListBucket"' 'Action   = "s3:*"' \
  'run "vm_role_never_deletes"... fail' test iam
fault "OIDC: StringLike" terraform/github_oidc.tf \
  'StringEquals = {' 'StringLike = {' \
  'run "oidc_trusts_main_branch_only"... fail' test iam
fault "OIDC: any branch (refs/heads/*)" terraform/github_oidc.tf \
  ':ref:refs/heads/main"' ':ref:refs/heads/*"' \
  'run "oidc_trusts_main_branch_only"... fail' test iam
fault "OIDC: no audience condition" terraform/github_oidc.tf \
  '"${local.github_oidc_host}:aud" = "sts.amazonaws.com"
' '' \
  'run "oidc_trusts_main_branch_only"... fail' test iam
fault "OIDC: trust names another provider" terraform/github_oidc.tf   'Federated = data.aws_iam_openid_connect_provider.github.arn'   'Federated = "arn:aws:iam::${local.account_id}:oidc-provider/github.com"'   'run "oidc_trusts_main_branch_only"... fail' test iam
fault "OIDC: provider audience not checked" terraform/github_oidc.tf   'contains(self.client_id_list, "sts.amazonaws.com")' 'length(self.client_id_list) > 0'   'run "oidc_provider_without_sts_audience_fails"... fail' test iam
fault "deploy role: SendCommand on *" terraform/github_oidc.tf \
  'Resource = [aws_instance.app.arn, local.run_shell_document]' 'Resource = "*"' \
  'run "deploy_role_rights"... fail' test iam
fault "deploy role: any document" terraform/github_oidc.tf \
  'document/AWS-RunShellScript"' 'document/*"' \
  'run "deploy_role_rights"... fail' test iam
fault "deploy role: + ssm:StartSession" terraform/github_oidc.tf \
  'Action   = "ssm:SendCommand"' 'Action   = ["ssm:SendCommand", "ssm:StartSession"]' \
  'run "deploy_role_rights"... fail' test iam
fault "deploy role: ECR push on every repository" terraform/github_oidc.tf \
  '"ecr:PutImage",
        ]
        Resource = local.ecr_repository_arns' \
  '"ecr:PutImage",
        ]
        Resource = "*"' \
  'run "deploy_role_rights"... fail' test iam
fault "deploy role: PutObject on the whole backups bucket" terraform/github_oidc.tf \
  '${local.backups_bucket}/transfer/*"' '${local.backups_bucket}/*"' \
  'run "deploy_role_rights"... fail' test iam
fault "deploy role: + s3:GetObject on transfer/" terraform/github_oidc.tf \
  'Action   = "s3:PutObject"' 'Action   = ["s3:PutObject", "s3:GetObject"]' \
  'run "deploy_role_rights"... fail' test iam
fault "deploy role: + s3:DeleteObject in its own statement" terraform/github_oidc.tf \
  '        Sid      = "StageConfig"' '        Sid      = "Cleanup"
        Effect   = "Allow"
        Action   = "s3:DeleteObject"
        Resource = "arn:aws:s3:::${local.backups_bucket}/transfer/*"
      },
      {
        Sid      = "StageConfig"' \
  'run "deploy_role_rights"... fail' test iam

echo "== monitoring and snapshots"
fault "disk alarm at 90%" terraform/monitoring.tf \
  'threshold   = 80
      period      = 300
      periods     = 1' \
  'threshold   = 90
      period      = 300
      periods     = 1' \
  'run "alarms"... fail' test monitoring
fault "disk alarm keeps the device dimension" terraform/monitoring.tf \
  '{ path = "/", fstype = "ext4" }' '{ path = "/", fstype = "ext4", device = "nvme0n1p1" }' \
  'run "alarms"... fail' test monitoring
fault "DLM keeps 14" terraform/dlm.tf \
  'count = 7' 'count = 14' \
  'run "daily_snapshots"... fail' test monitoring
fault "DLM role deletes any snapshot" terraform/dlm.tf \
  'Condition = { StringEquals = { "aws:ResourceTag/forexedge:dlm" = "daily" } }' '' \
  'run "daily_snapshots"... fail' test monitoring

echo "== variables"
fault "github_repo validation accepts wildcards" terraform/variables.tf \
  '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' '^.+/.+$' \
  'run "rejects_wildcard_repo"... fail' test variables

echo "== fmt, validate, tflint, shellcheck, check.sh source rules"
fault "fmt: misaligned argument" terraform/ecr.tf \
  'force_delete         = false' 'force_delete = false' \
  'ecr.tf' fmt
fault "validate: unknown reference" terraform/outputs.tf \
  'value       = aws_instance.app.id' 'value       = aws_instance.missing.id' \
  'Reference to undeclared resource' validate
fault "tflint: invalid instance type" terraform/variables.tf \
  'default     = "t3.medium"' 'default     = "t3.mediun"' \
  'aws_instance_invalid_type' tflint
fault "shellcheck: unquoted variable" vm/setup.sh \
  'rm -rf "$home"' 'rm -rf $home' \
  'SC2086' shellcheck vm/setup.sh
fault "check.sh: key pair on the instance" terraform/ec2.tf \
  'monitoring                  = false' 'monitoring                  = false
  key_name                    = "forexedge"' \
  'key pairs and inline security group rules are not allowed' check.sh
fault "check.sh: OIDC provider owned by the stack" terraform/github_oidc.tf   'data "aws_iam_openid_connect_provider" "github" {'   'resource "aws_iam_openid_connect_provider" "owned" {
  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {'   'never a resource' check.sh
fault "check.sh: instance does not ignore public IP drift" terraform/ec2.tf \
  'ignore_changes = [ami, associate_public_ip_address]' 'ignore_changes = [ami]' \
  'must have associate_public_ip_address in lifecycle ignore_changes' check.sh
fault "check.sh: instance does not ignore a newer AMI" terraform/ec2.tf \
  'ignore_changes = [ami, associate_public_ip_address]' 'ignore_changes = [associate_public_ip_address]' \
  'must have ami in lifecycle ignore_changes' check.sh
fault "check.sh: terraform test runs no test" terraform/check.sh \
  '"$TERRAFORM" test | tee' '"$TERRAFORM" test -filter=none.tftest.hcl | tee' \
  'terraform test ran no test' check.sh
fault "check.sh: compose image missing from ECR" terraform/locals.tf \
  '    "ops",
' '' \
  'images differ' check.sh

echo "== memory limits (check-compose.mjs)"
fault "caddy back to 64 MiB" docker-compose.prod.yml \
  'mem_limit: 128m' 'mem_limit: 64m' \
  'caddy: mem_limit 64 MiB, expected 128 MiB' compose

echo "== the metadata guard's network (check-compose.mjs)"
fault "ws-gateway at another address than the guard's" docker-compose.prod.yml \
  'ipv4_address: 172.30.0.10' 'ipv4_address: 172.30.0.11' \
  'the guard admits 172.30.0.10' compose
fault "ws-gateway's address inside the dynamic range" docker-compose.prod.yml \
  'ip_range: 172.30.0.128/25' 'ip_range: 172.30.0.0/25' \
  'outside the dynamic range' compose
fault "bridge renamed in the guard only" vm/setup.sh \
  'IMDS_GUARD_BRIDGE="fxedge0"' 'IMDS_GUARD_BRIDGE="fxedge1"' \
  'differs from the guard' compose
fault "a service on the host network" docker-compose.prod.yml \
  '    command: redis-server' '    network_mode: host
    command: redis-server' \
  'would bypass the metadata guard' compose
fault "a second fixed address (auth-service)" docker-compose.prod.yml \
  'redis: { condition: service_healthy } }
    mem_limit: 192m' \
  'redis: { condition: service_healthy } }
    networks:
      default:
        ipv4_address: 172.30.0.20
    mem_limit: 192m' \
  'only ws-gateway has a fixed address' compose

echo "== GitHub workflows (check-workflows.mjs, actionlint)"
W=.github/workflows/build-images.yml
fault "workflow: action pinned to a tag" "$W" \
  'docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1' 'docker/setup-buildx-action@v4.4.1' \
  'is not pinned to a full commit SHA' workflows
fault "workflow: action pinned to a short SHA" "$W" \
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' 'actions/checkout@3d3c42e' \
  'is not pinned to a full commit SHA' workflows
fault "workflow: ops missing from the matrix" "$W" \
  '          - { image: ops, dockerfile: infra/docker/node.Dockerfile, target: ops, build-args: "" }
' '' \
  'ops is missing' workflows
fault "workflow: an image that compose doesn't have" "$W" \
  'image: frontend,' 'image: web,' \
  'web is not a compose image' workflows
fault "workflow: wrong Dockerfile for ml-service" "$W" \
  'image: ml-service, dockerfile: infra/docker/python.Dockerfile' 'image: ml-service, dockerfile: infra/docker/node.Dockerfile' \
  'ml-service is' workflows
fault "workflow: build arg differs from compose" "$W" \
  'build-args: "APP=replay-service"' 'build-args: "APP=ws-gateway"' \
  'replay-service is' workflows
fault "workflow: target differs from compose" "$W" \
  'image: frontend, dockerfile: infra/docker/node.Dockerfile, target: frontend' 'image: frontend, dockerfile: infra/docker/node.Dockerfile, target: service' \
  'frontend is' workflows
fault "workflow: contents: write" "$W" \
  'contents: read' 'contents: write' \
  'exactly id-token: write, contents: read' workflows
fault "workflow: runs on any branch" "$W" \
  "    if: github.ref == 'refs/heads/main'
" '' \
  "must run only if github.ref == 'refs/heads/main'" workflows
fault "workflow: push trigger" "$W" \
  'on:
  workflow_call:' 'on:
  push:
  workflow_call:' \
  'workflow_call and workflow_dispatch only' workflows
fault "workflow: cancels a running build" "$W" \
  'cancel-in-progress: false' 'cancel-in-progress: true' \
  'cancel-in-progress: false' workflows
fault "workflow: no job timeout" "$W" \
  '    timeout-minutes: 45
' '' \
  'no timeout-minutes' workflows
fault "workflow: reads a secret" "$W" \
  'role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}' 'role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}' \
  'reads secrets.*' workflows
fault "actionlint: unknown expression context" "$W" \
  'TAG: ${{ github.sha }}
        run: echo' 'TAG: ${{ githb.sha }}
        run: echo' \
  'undefined variable "githb"' actionlint
fault "actionlint: shellcheck in a run block" "$W" \
  'echo "ref=${REGISTRY}/forexedge/${IMAGE}:${TAG}" >>"$GITHUB_OUTPUT"' 'echo "ref=${REGISTRY}/forexedge/${IMAGE}:${TAG}" >>$GITHUB_OUTPUT' \
  'SC2086' actionlint

C=.github/workflows/ci.yml
fault "ci: pull_request_target" "$C" \
  'on:
  pull_request:' 'on:
  pull_request_target:' \
  'triggered by pull_request_target' workflows
fault "ci: a push trigger as well" "$C" \
  'on:
  pull_request:' 'on:
  push:
  pull_request:' \
  'pull_request only' workflows
fault "ci: pull requests to any branch" "$C" \
  '    branches: [main]
' '' \
  'exactly [main]' workflows
fault "ci: contents: write" "$C" \
  'contents: read' 'contents: write' \
  'exactly contents: read' workflows
fault "ci: an OIDC token" "$C" \
  'permissions:
  contents: read' 'permissions:
  contents: read
  id-token: write' \
  'ci.yml: requests id-token: write' workflows
fault "ci: job-level id-token" "$C" \
  '    timeout-minutes: 60
' '    timeout-minutes: 60
    permissions:
      id-token: write
' \
  'ci.yml: requests id-token: write' workflows
fault "ci: reads a secret" "$C" \
  '      BASE: origin/main' '      BASE: ${{ secrets.BASE }}' \
  'ci.yml: reads secrets.*' workflows
fault "ci: job renamed (required check lost)" "$C" \
  '    name: ci
' '    name: checks
' \
  'the required status check is ci' workflows
fault "ci: no job timeout" "$C" \
  '    timeout-minutes: 60
' '' \
  'ci.yml job ci: no timeout-minutes' workflows
fault "ci: an older run not cancelled" "$C" \
  'cancel-in-progress: true' 'cancel-in-progress: false' \
  'cancel-in-progress: true' workflows
fault "ci: action pinned to a tag" "$C" \
  'hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1 (2026-05-12)' 'hashicorp/setup-terraform@v4.0.1' \
  'is not pinned to a full commit SHA' workflows
fault ".nvmrc differs from the images' Node" .nvmrc \
  '24.13.1' '24.11.0' \
  '.nvmrc is 24.11.0' workflows

fault "build-images: workflow_call passes secrets" "$W" \
  'on:
  workflow_call:' 'on:
  workflow_call:
    secrets:
      token:
        required: false' \
  'workflow_call takes no inputs, secrets or outputs' workflows
D=.github/workflows/deploy.yml
fault "deploy: no paths-ignore (docs-only merges deploy)" "$D" \
  "    paths-ignore:
      - 'docs/**'
      - '**/*.md'
" '' \
  'push paths-ignore is []' workflows
fault "deploy: paths-ignore also skips infra/" "$D" \
  "      - '**/*.md'
" "      - '**/*.md'
      - 'infra/**'
" \
  'exactly docs/** and **/*.md' workflows
fault "deploy: push to any branch" "$D" \
  '    branches: [main]' "    branches: ['**']" \
  'push branches are ["**"]; exactly [main]' workflows
fault "deploy: a pull_request trigger" "$D" \
  'on:
  push:' 'on:
  pull_request:
  push:' \
  'push and workflow_dispatch only' workflows
fault "deploy: cancels a running deploy" "$D" \
  'cancel-in-progress: false' 'cancel-in-progress: true' \
  'cancel-in-progress: false (a cancelled deploy' workflows
fault "deploy: the deploy job on any branch" "$D" \
  "    needs: build
    if: github.ref == 'refs/heads/main'
" '    needs: build
' \
  "deploy.yml job deploy: must run only if github.ref == 'refs/heads/main'" workflows
fault "deploy: simulate_failure on by default" "$D" \
  '        default: false' '        default: true' \
  'exactly one input, simulate_failure, boolean, default false' workflows
fault "deploy: build from another repository's workflow" "$D" \
  'uses: ./.github/workflows/build-images.yml' 'uses: someone/forexedge/.github/workflows/build-images.yml@main' \
  'must be uses: ./.github/workflows/build-images.yml' workflows
fault "deploy: deploys without waiting for the build" "$D" \
  '    needs: build
' '' \
  'deploy.yml job deploy: must need build' workflows
fault "deploy: reads a secret" "$D" \
  'role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}' 'role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}' \
  'deploy.yml: reads secrets.*' workflows
fault "deploy: action pinned to a tag" "$D" \
  'aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0' 'aws-actions/configure-aws-credentials@v6' \
  'is not pinned to a full commit SHA' workflows
fault "deploy: no job timeout" "$D" \
  '    timeout-minutes: 45
' '' \
  'deploy.yml job deploy: no timeout-minutes' workflows
fault "deploy: contents: write" "$D" \
  'contents: read' 'contents: write' \
  'deploy.yml: permissions are' workflows

echo "== host tooling (stage.test.sh, run-on-host.test.sh, host-scripts.test.sh)"
fault "stage.sh: mismatched tag accepted" vm/stage.sh \
  '[[ "$tag" == "$head" ]] || die' 'true || die' \
  'FAIL  other tag' stage-test
fault "stage.sh: dirty tree accepted" vm/stage.sh \
  '[[ -z "$(git status --porcelain)" ]] || die' 'true || die' \
  'FAIL  dirty tree' stage-test
fault "run-on-host.sh: any argument passed to the host" vm/run-on-host.sh \
  'if [[ ! "$arg" =~ ^[A-Za-z0-9._:/@,=+-]+$ ]]; then' 'if false; then' \
  'FAIL  bad argument' run-on-host-test
fault "fetch.sh: sha256 mismatch accepted" vm/fetch.sh \
  '(cd "$incoming" && sha256sum --check --quiet --strict entries) || die "sha256 mismatch: nothing was installed"' 'true' \
  'FAIL  fetch: a sha256 mismatch' host-tests
fault "fetch.sh: a file the manifest doesn't list accepted" vm/fetch.sh \
  '[[ -z "$extra" ]] || die' 'true || die' \
  "FAIL  fetch: a file the manifest doesn't list" host-tests
fault "fetch.sh: any path accepted" vm/fetch.sh \
  '[[ "$path" =~ $ALLOWED ]] || die' 'true || die' \
  'FAIL  fetch: a path outside the allowed set' host-tests
fault2 "make-env.sh: .env.prod overwritten" vm/make-env.sh \
  '[[ ! -e "$f" ]] || die "$f exists' 'true || die "$f exists' \
  'ln "$env_tmp" "$ENV_FILE" || die "$ENV_FILE appeared while writing it"' 'mv -f "$env_tmp" "$ENV_FILE"' \
  'FAIL  make-env: second run overwrote' host-tests
fault "make-env.sh: a secret printed" vm/make-env.sh \
  'jwt_refresh="$(random_string 64)"' 'jwt_refresh="$(random_string 64)"; echo "JWT_REFRESH_SECRET=$jwt_refresh"' \
  'FAIL  make-env: files' host-tests
fault "make-env.sh: a tag without a release accepted" vm/make-env.sh \
  '[[ -f "$release_file" ]] || die' 'true || die' \
  'FAIL  make-env: other tag' host-tests
fault "set-secret.sh: short demo password accepted" vm/set-secret.sh \
  '[[ ${#value} -ge 12 && ${#value} -le 32 ]] || die' 'true || die' \
  'FAIL  set-secret: refusals' host-tests
fault "set-secret.sh: the value printed" vm/set-secret.sh \
  'echo "$name set in $file (replaced $previous)"' 'echo "$name set in $file (replaced $previous): $value"' \
  'FAIL  set-secret: GROQ_API_KEY' host-tests
fault "stack.sh: a release recording another commit accepted" vm/stack.sh \
  '[[ "$tag" == "$recorded" ]] || die' 'true || die' \
  'FAIL  stack: release record' host-tests
fault "fetch.sh: history files root only (600)" vm/fetch.sh \
  'install -D -o root -g root -m 0644' 'install -D -o root -g root -m 0600' \
  'FAIL  fetch: history modes' host-tests
fault "bootstrap.sh: a tag without a release accepted" vm/bootstrap.sh \
  '[[ -f "$RELEASES/$tag/release" ]] || die' 'true || die' \
  'FAIL  bootstrap: other tag' host-tests
fault "stack.sh: a secret printed (no redaction)" vm/stack.sh \
  'run() { "$@" 2>&1 | redact; }' 'run() { "$@" 2>&1; }' \
  'FAIL  stack: up' host-tests
fault "stack.sh: up with placeholders" vm/stack.sh \
  '    check_no_placeholders
    check_current' '    check_current' \
  'FAIL  stack: placeholders' host-tests
fault "stack.sh: an env file others can read accepted" vm/stack.sh \
  '[[ "$(stat -c '"'"'%U %a'"'"' "$f")" == "root 600" ]] || die' 'true || die' \
  'FAIL  stack: env file mode' host-tests
fault "stack.sh: readiness ignores a service that stays down" vm/stack.sh \
  'echo "not ready after ${READY_SECONDS} s: ${pending[*]}" >&2
      return 1' 'echo "not ready after ${READY_SECONDS} s: ${pending[*]}" >&2
      return 0' \
  'FAIL  stack: unready' host-tests
fault "bootstrap.sh: goes on after a failed step" vm/bootstrap.sh \
  'step validate tail npm run data:validate ||' 'step validate tail npm run data:validate || true ||' \
  'FAIL  bootstrap: failing step' host-tests
fault "bootstrap.sh: shared block drifts from stack.sh" vm/bootstrap.sh \
  'compose() { docker compose -p forexedge -f' 'compose() { docker compose -p forexedge-old -f' \
  'FAIL  shared block' host-tests

fault "deploy.sh: shared block drifts from stack.sh" vm/deploy.sh \
  'compose() { docker compose -p forexedge -f' 'compose() { docker compose -p forexedge-old -f' \
  'FAIL  shared block' host-tests
fault "deploy.sh: readiness block drifts from stack.sh" vm/deploy.sh \
  'echo "not ready after ${READY_SECONDS} s: ${pending[*]}" >&2' 'echo "not ready after ${READY_SECONDS} s; ${pending[*]}" >&2' \
  'FAIL  readiness block' host-tests
fault "deploy.sh: rollback with the new release's compose file" vm/deploy.sh \
  'if up_release "$previous" && ready; then' 'if IMAGE_TAG="$previous" run compose up -d --remove-orphans --quiet-pull && ready; then' \
  'FAIL  deploy: simulated failure' host-tests
fault "deploy.sh: a failed rollback exits like a rollback" vm/deploy.sh \
  'exit 4' 'exit 3' \
  'FAIL  deploy: rollback failure' host-tests
fault "deploy.sh: --simulate-failure ignored" vm/deploy.sh \
  'elif [[ "$simulate" == true ]]; then' 'elif false; then' \
  'FAIL  deploy: simulated failure' host-tests
fault2 "deploy.sh: switch before the backup" vm/deploy.sh \
  'backup "$tag" "$bucket"
' '' \
  'echo "current -> $tag"
' 'echo "current -> $tag"
backup "$tag" "$bucket"
' \
  'FAIL  deploy: success' host-tests
fault "deploy.sh: a missing release accepted" vm/deploy.sh \
  '[[ -f "$RELEASES/$tag/release" ]] || die' 'true || die' \
  'FAIL  deploy: refusals' host-tests
fault "deploy.sh: an empty table list dumped" vm/deploy.sh \
  '((${#tables[@]} > 0)) || { rm -rf "$work"; die "backup: no app table found"; }' '' \
  'FAIL  deploy: backup failures' host-tests
fault "deploy.sh: pruning removes the previous release" vm/deploy.sh \
  '[[ "$tag" == "$keep" || "$tag" == "$previous" ]] && continue' '[[ "$tag" == "$keep" ]] && continue' \
  'FAIL  deploy: pruning' host-tests
fault "deploy.sh: adoption restarts a container" vm/deploy.sh \
  '  log_deploy "$tag" adopted
' '  log_deploy "$tag" adopted
  compose restart caddy
' \
  'FAIL  deploy: adoption' host-tests
fault "deploy.sh: adoption without the IMAGE_TAG check" vm/deploy.sh \
  '[[ -n "$tag" && "$tag" == "$running" ]] ||' '[[ -n "$tag" ]] ||' \
  'FAIL  deploy: adoption refusals' host-tests
fault "deploy.sh: legacy files removed while mounted" vm/deploy.sh \
  'grep -qF "$ROOT/infra/caddy/"; then' 'grep -qF "/nonexistent/"; then' \
  'FAIL  deploy: legacy removal' host-tests
fault "restore-test.sh: scratch DB not dropped on failure" vm/restore-test.sh \
  'trap restore_cleanup EXIT' 'trap cleanup EXIT' \
  'FAIL  restore-test: failures' host-tests
fault "restore-test.sh: zero tables accepted" vm/restore-test.sh \
  '((${#restored[@]} > 0)) || die "no table restored from $key"' '' \
  'FAIL  restore-test: failures' host-tests
fault "restore-test.sh: a table missing live accepted" vm/restore-test.sh \
  '((${#missing[@]} == 0)) || die' 'true || die' \
  'FAIL  restore-test: failures' host-tests
fault "bootstrap.sh --deploy: dependencies recreated (no --no-deps)" vm/bootstrap.sh \
  'RUN_FLAGS=(--no-deps)' 'RUN_FLAGS=()' \
  'FAIL  bootstrap --deploy' host-tests
fault "fetch.sh: a fetched release changed" vm/fetch.sh \
  'cmp -s "$incoming/$path" "$release/$path" || die' 'true || die' \
  'FAIL  fetch: changed release' host-tests
fault "stage.sh: --bucket ignored (terraform called)" vm/stage.sh \
  'if [[ -z "$bucket" ]]; then bucket=' 'if true; then bucket=' \
  'FAIL  --bucket' stage-test
fault "run-on-host.sh: a paused host not recognised" vm/run-on-host.sh \
  'if grep -q InvalidInstanceId "$send_err"; then' 'if false; then' \
  'FAIL  paused host' run-on-host-test
fault "stack.sh: up starts a tag other than current" vm/stack.sh \
  '[[ "${target##*/}" == "$tag" ]] || die' 'true || die' \
  'FAIL  stack: current release' host-tests
fault "stack.sh: up ignores the Phase 3 layout" vm/stack.sh \
  '[[ ! -f "$ROOT/infra/docker-compose.prod.yml" ]] ||' 'true ||' \
  'FAIL  stack: current release' host-tests

rm -f "$out"
printf '\n%d faults caught, %d missed\n' "$passed" "$failed"
[[ "$failed" -eq 0 && "$passed" -gt 0 ]]
