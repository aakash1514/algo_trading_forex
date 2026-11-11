#!/usr/bin/env bash
# infra/vm/run-on-host.sh against stub `aws` and `terraform` commands (no AWS call; part of npm run infra:check):
#
#   bash infra/vm/tests/run-on-host.test.sh
#
#   success          polls through a not-yet-registered invocation and InProgress, prints status, stdout and
#                    stderr, exits 0; the parameters are valid JSON, and their commands, run by sh with /root
#                    replaced by a temporary directory, write the script byte for byte and run it
#   tampered sha256  the same commands with another sha256 fail and never run the script (planted fault)
#   Failed           exits non-zero and prints the stderr
#   AWS error        an error other than InvocationDoesNotExist stops at once
#   time limit       still InProgress at the limit: exits non-zero, prints how to check later
#   default id       the instance id comes from terraform output
#   bad name/id      refused before any AWS call
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$REPO_DIR/infra/vm/run-on-host.sh"
ID="i-0123456789abcdef0"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/root"
export STUB_DIR="$work"

# aws: send-command keeps the parameters file and prints a command id; get-command-invocation answers Status
# queries from $STUB_DIR/statuses, one line per call (the last line repeats; "missing" = InvocationDoesNotExist,
# "denied" = another error)
cat >"$work/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$STUB_DIR/aws.log"
case "$2" in
  send-command)
    for arg in "$@"; do [[ "$arg" == file://* ]] && cp "${arg#file://}" "$STUB_DIR/params.json"; done
    printf 'cmd-1234\r\n' ;;
  get-command-invocation)
    if [[ "$*" == *"--query Status"* ]]; then
      calls=$(( $(cat "$STUB_DIR/calls" 2>/dev/null || echo 0) + 1 )); echo "$calls" >"$STUB_DIR/calls"
      status="$(sed -n "${calls}p" "$STUB_DIR/statuses")"; [[ -n "$status" ]] || status="$(tail -n1 "$STUB_DIR/statuses")"
      case "$status" in
        missing) echo "An error occurred (InvocationDoesNotExist) when calling the GetCommandInvocation operation" >&2; exit 254 ;;
        denied) echo "An error occurred (AccessDeniedException): not authorized" >&2; exit 254 ;;
        *) printf '%s\r\n' "$status" ;;
      esac
    elif [[ "$*" == *StandardOutputContent* ]]; then echo "host stdout line"
    else echo "host stderr line"; fi ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
EOF
cat >"$work/bin/terraform" <<EOF
#!/usr/bin/env bash
[[ "\$*" == "-chdir=infra/terraform output -raw instance_id" ]] || { echo "unexpected terraform call: \$*" >&2; exit 1; }
printf '%s' "$ID"
EOF
chmod +x "$work/bin/aws" "$work/bin/terraform"
export PATH="$work/bin:$PATH"
export RUN_ON_HOST_POLL_SECONDS=0

target="$work/hello-host.sh"
printf '#!/usr/bin/env bash\necho "ran on host"\necho ran >"%s/ran"\n' "$work" >"$target"

failures=0
fail() { echo "FAIL  $1" >&2; failures=$((failures + 1)); }
pass() { echo "ok    $1"; }
# run <statuses...> -- <args...>: fresh stub state, the script's output in $work/out and its exit code in $rc
run() {
  rm -f "$work/aws.log" "$work/calls" "$work/params.json" "$work/ran" "$work/root"/*
  : >"$work/statuses"
  while [[ "$1" != "--" ]]; do echo "$1" >>"$work/statuses"; shift; done
  shift
  rc=0
  (cd "$REPO_DIR" && bash "$SCRIPT" "$@") >"$work/out" 2>&1 || rc=$?
}
has() { grep -qF -- "$1" "$work/out"; }

# The commands of the parameters file, with /root replaced, as one sh script (what AWS-RunShellScript runs)
# (node gets a Windows path in Git Bash, also with MSYS_NO_PATHCONV=1 as check.sh sets it)
host_script() {
  local params="$work/params.json"
  if command -v cygpath >/dev/null 2>&1; then params="$(cygpath -m "$params")"; fi
  node -e '
    const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (Object.keys(p).sort().join() !== "commands,executionTimeout" || p.executionTimeout[0] !== "900") process.exit(3);
    console.log(p.commands.join("\n"));' "$params" | tr -d '\r' | sed "s|/root/|$work/root/|g"
}

run missing InProgress Success -- "$target" "$ID"
if [[ $rc -eq 0 ]] && has "Status: Success" && has "host stdout line" && has "host stderr line" && has "InProgress" \
  && [[ "$(cat "$work/calls")" == 3 ]] && grep -q "send-command --instance-ids $ID " "$work/aws.log"; then
  pass "success"
else fail "success (rc $rc)"; cat "$work/out" >&2; fi

if host_script >"$work/host.sh" && (cd "$work" && sh host.sh >/dev/null 2>&1) \
  && cmp -s "$target" "$work/root/hello-host.sh" && [[ -f "$work/ran" ]]; then
  pass "host commands write the script byte for byte and run it"
else fail "host commands"; fi

rm -f "$work/ran" "$work/root"/*
sed -E 's/[0-9a-f]{64}/0000000000000000000000000000000000000000000000000000000000000000/' "$work/host.sh" >"$work/tampered.sh"
if ! grep -q 0000000000000000 "$work/tampered.sh"; then fail "tampered sha256: no sha256 in the commands"
elif (cd "$work" && sh tampered.sh >/dev/null 2>&1) || [[ -f "$work/ran" ]]; then fail "tampered sha256: the script ran"
else pass "tampered sha256 refused, script not run"; fi

run InProgress Failed -- "$target" "$ID"
if [[ $rc -ne 0 ]] && has "Status: Failed" && has "host stderr line"; then pass "Failed exits non-zero"
else fail "Failed (rc $rc)"; fi

run denied -- "$target" "$ID"
if [[ $rc -ne 0 ]] && has "AccessDeniedException" && [[ "$(cat "$work/calls")" == 1 ]]; then pass "AWS error stops at once"
else fail "AWS error (rc $rc)"; fi

RUN_ON_HOST_MAX_SECONDS=0 run InProgress -- "$target" "$ID"
if [[ $rc -ne 0 ]] && has "still InProgress" && has "get-command-invocation --command-id cmd-1234"; then pass "time limit"
else fail "time limit (rc $rc)"; fi

run Success -- "$target"
if [[ $rc -eq 0 ]] && grep -q "send-command --instance-ids $ID " "$work/aws.log"; then pass "default instance id from terraform"
else fail "default instance id (rc $rc)"; fi

cp "$target" "$work/bad name.sh"
run Success -- "$work/bad name.sh" "$ID"
if [[ $rc -eq 2 && ! -f "$work/aws.log" ]]; then pass "bad script name refused"; else fail "bad script name (rc $rc)"; fi
run Success -- "$target" "i-xyz"
if [[ $rc -eq 2 && ! -f "$work/aws.log" ]]; then pass "bad instance id refused"; else fail "bad instance id (rc $rc)"; fi

if ((failures > 0)); then echo "run-on-host: $failures failed" >&2; exit 1; fi
echo "run-on-host: all checks passed"
