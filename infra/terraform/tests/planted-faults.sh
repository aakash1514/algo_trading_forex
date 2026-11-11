#!/usr/bin/env bash
# Proves the offline checks catch what they claim to: plants one fault at a time, runs the check that
# must catch it, and fails if that check passes (or fails for a different reason). Each fault is an exact
# text replacement that must match exactly once, and the file is restored from git after every fault.
#
#   bash infra/terraform/tests/planted-faults.sh        (Docker running; TERRAFORM as in check.sh)
#
# Refuses to start with unstaged changes under infra/: every fault is undone with git checkout, which
# restores the staged (or committed) version.
# The fault strings are literal Terraform and shell text: ${...} must not expand (SC2016 throughout)
# shellcheck disable=SC2016
set -euo pipefail

TF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$(dirname "$TF_DIR")"
REPO_DIR="$(dirname "$INFRA_DIR")"
TERRAFORM="${TERRAFORM:-terraform}"
TFLINT_IMAGE="$(sed -n 's/^TFLINT_IMAGE="\(.*\)"$/\1/p' "$TF_DIR/check.sh")"
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
if ! git diff --quiet -- infra/; then
  echo "unstaged changes under infra/: stage or commit them first (faults are undone with git checkout)" >&2
  exit 1
fi
trap 'git checkout -q -- infra/' EXIT

out="$(mktemp)"
passed=0
failed=0

# plant FILE OLD NEW: replace the single occurrence of OLD (relative to infra/)
plant() {
  OLD="$2" NEW="$3" node -e '
    const fs = require("fs"); const f = process.argv[1]; const s = fs.readFileSync(f, "utf8");
    const n = s.split(process.env.OLD).length - 1;
    if (n !== 1) { console.error(`fault not planted: ${n} matches in ${f}`); process.exit(2); }
    fs.writeFileSync(f, s.replace(process.env.OLD, () => process.env.NEW));' "infra/$1"
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
  git checkout -q -- "infra/$file"
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

rm -f "$out"
printf '\n%d faults caught, %d missed\n' "$passed" "$failed"
[[ "$failed" -eq 0 && "$passed" -gt 0 ]]
