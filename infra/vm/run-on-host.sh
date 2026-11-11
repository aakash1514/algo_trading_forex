#!/usr/bin/env bash
# Runs a script of the repo as root on the EC2 host through SSM Run Command (docs/DEPLOY.md section 7.4):
#
#   bash infra/vm/run-on-host.sh <script> [instance-id] [--timeout <seconds>] [-- <arg>...]
#
# The instance id defaults to `terraform -chdir=infra/terraform output -raw instance_id` (run from the repo
# root). The script is copied to /root/<name> on the host (mode 600), its sha256 is checked there against the
# laptop's copy, and only then is it run with bash, with the <arg>s given after --. The command is polled every
# 10 s, for at most --timeout seconds (default 900, at most 7200; the host stops it at the same limit), then
# its status, stdout and stderr are printed. Exits non-zero unless the status is Success: 3 when the
# instance can't take commands ("host paused (instance_state=stopped) or not registered in SSM"), 2 for bad
# arguments, 1 otherwise. SSM keeps only the first 24,000 characters of the script's stdout.
#
# SSM stores the arguments with the command (and its output): never pass a secret. Each argument must match
# [A-Za-z0-9._:/@,=+-]+, so it needs no quoting on the host and no escaping in the JSON.
#
# Needs only the AWS CLI (credentials from the environment, e.g. SSO), base64 and sha256sum; works in Git Bash
# and on Linux. No node: in Git Bash `node` may be winpty, which fails when its output is redirected. Nothing
# secret passes through here: the parameters are the script's base64, its name, its sha256 and the
# arguments, and the only output is what the script prints on the host.
#
# RUN_ON_HOST_POLL_SECONDS overrides the poll interval (tests only).
set -euo pipefail

# The Windows AWS CLI decodes and prints output in the console's code page unless told otherwise, and fails
# on a character outside it (the host's output is UTF-8)
export PYTHONIOENCODING=utf-8

POLL_SECONDS="${RUN_ON_HOST_POLL_SECONDS:-10}"
MAX_SECONDS=900
MAX_TIMEOUT=7200

usage() { echo "usage: $0 <script> [instance-id] [--timeout <seconds>] [-- <arg>...]" >&2; exit 2; }
[[ $# -ge 1 ]] || usage
file="$1"
shift
[[ -f "$file" ]] || { echo "no such file: $file" >&2; exit 2; }

instance_id=""
script_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)
      [[ $# -ge 2 ]] || usage
      MAX_SECONDS="$2"
      shift 2
      ;;
    --)
      shift
      script_args=("$@")
      break
      ;;
    -*) usage ;;
    *)
      [[ -z "$instance_id" ]] || usage
      instance_id="$1"
      shift
      ;;
  esac
done
if [[ ! "$MAX_SECONDS" =~ ^[1-9][0-9]{0,3}$ ]] || ((MAX_SECONDS > MAX_TIMEOUT)); then
  echo "--timeout must be 1..${MAX_TIMEOUT} seconds: $MAX_SECONDS" >&2
  exit 2
fi
for arg in "${script_args[@]}"; do
  if [[ ! "$arg" =~ ^[A-Za-z0-9._:/@,=+-]+$ ]]; then
    echo "script arguments must match [A-Za-z0-9._:/@,=+-]+: $arg" >&2
    exit 2
  fi
done

name="$(basename "$file")"
# The name goes into shell commands on the host and into the JSON unescaped: allow only what needs neither
if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "script name must match [A-Za-z0-9][A-Za-z0-9._-]*: $name" >&2
  exit 2
fi

if [[ -z "$instance_id" ]]; then
  instance_id="$(terraform -chdir=infra/terraform output -raw instance_id | tr -d '\r')"
fi
if [[ ! "$instance_id" =~ ^i-[0-9a-f]{8,17}$ ]]; then
  echo "not an EC2 instance id: '$instance_id'" >&2
  exit 2
fi

sum="$(sha256sum "$file" | cut -d' ' -f1)"
# base64 and sha256 output use only [A-Za-z0-9+/=], so neither needs JSON or shell escaping
b64="$(base64 -w0 "$file")"

# The arguments were validated above: nothing in them needs quoting in sh or escaping in JSON
run_cmd="bash /root/${name}"
for arg in "${script_args[@]}"; do run_cmd+=" ${arg}"; done

params="$(mktemp)"
trap 'rm -f "$params"' EXIT
# AWS-RunShellScript runs the commands as one sh script: set -e stops it at the first failure, so a file
# whose sha256 differs is never run. umask 077 keeps it readable by root only.
printf '{"commands":["set -e","umask 077","echo %s | base64 -d > /root/%s","echo \\"%s  /root/%s\\" | sha256sum -c -","%s"],"executionTimeout":["%s"]}\n' \
  "$b64" "$name" "$sum" "$name" "$run_cmd" "$MAX_SECONDS" > "$params"

# The Windows AWS CLI can't open an MSYS path such as /tmp/...
params_arg="$params"
if command -v cygpath >/dev/null 2>&1; then params_arg="$(cygpath -m "$params")"; fi

send_err="$(mktemp)"
trap 'rm -f "$params" "$send_err"' EXIT
if ! command_id="$(aws ssm send-command --instance-ids "$instance_id" --document-name AWS-RunShellScript \
  --comment "forexedge $name $sum" --parameters "file://$params_arg" \
  --query Command.CommandId --output text 2>"$send_err" | tr -d '\r')" || [[ -z "$command_id" ]]; then
  # SSM answers InvalidInstanceId for an instance that is stopped or whose agent isn't registered
  if grep -q InvalidInstanceId "$send_err"; then
    echo "host paused (instance_state=stopped) or not registered in SSM: $instance_id can't run commands" >&2
    echo "  resume it: terraform -chdir=infra/terraform apply -var instance_state=running (docs/DEPLOY.md section 9)" >&2
    exit 3
  fi
  cat "$send_err" >&2
  exit 1
fi
echo "command $command_id: $name${script_args[*]:+ ${script_args[*]}} (sha256 $sum) on $instance_id"

invocation() {
  aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance_id" "$@"
}

status=""
waited=0
while :; do
  # Right after send-command the invocation may not exist yet; any other error is real (e.g. expired SSO)
  if out="$(invocation --query Status --output text 2>&1)"; then
    status="$(tr -d '\r' <<<"$out")"
  elif grep -q InvocationDoesNotExist <<<"$out"; then
    status="Pending"
  else
    echo "$out" >&2
    exit 1
  fi
  case "$status" in
    Success | Failed | TimedOut | Cancelled) break ;;
  esac
  if ((waited >= MAX_SECONDS)); then
    echo "still $status after ${MAX_SECONDS} s; check later with:" >&2
    echo "  aws ssm get-command-invocation --command-id $command_id --instance-id $instance_id --query '[Status, StandardOutputContent, StandardErrorContent]' --output text" >&2
    exit 1
  fi
  echo "$status (${waited} s)"
  sleep "$POLL_SECONDS"
  waited=$((waited + POLL_SECONDS))
done

printf '\nStatus: %s\n' "$status"
printf '\n--- stdout\n'
invocation --query StandardOutputContent --output text | tr -d '\r'
printf '\n--- stderr\n'
invocation --query StandardErrorContent --output text | tr -d '\r'

[[ "$status" == "Success" ]]
