# Deploying ForexEdge

One host runs everything with Docker Compose: the nine apps, TimescaleDB, Redis, Kafka and Caddy in front
(HTTPS, one origin). Target: an EC2 t3.medium (2 vCPU, 4 GB RAM + 4 GB swap, x86_64, Ubuntu 24.04) in
ap-south-1, images in ECR, backtest results in S3 with the instance's IAM role. No setting is in the code
or the images: everything comes from `infra/.env.prod` and the domain from `DOMAIN`.

| File | What |
|---|---|
| `infra/docker-compose.prod.yml` | The stack. Only Caddy publishes ports (80, 443) |
| `infra/docker-compose.local.yml` | Laptop only: adds MinIO for backtest results (no instance role on a laptop) |
| `infra/docker/node.Dockerfile` | The six NestJS services, the frontend and the `ops` tools image, from one build |
| `infra/docker/python.Dockerfile` | ml-service and research-agent, from their Linux locks |
| `infra/caddy/Caddyfile` | HTTPS for `DOMAIN`, `www.` → apex, the routes below |
| `infra/check-compose.mjs` | Enforces the compose rules (ports, limits, healthchecks, restart, logs) |
| `tools/ops/bootstrap-prod.ts` | Migrations, instruments, the DB logins, demo users |
| `npm run data:transfer` | The history: export (dev), import (prod), check |
| `npm run prod:smoke` | The deployed stack in a browser, over HTTPS, plus memory |

## 1. Settings (`infra/.env.prod`, never committed)

Every variable is documented in `.env.example`. Production needs:

| Variable | Notes |
|---|---|
| `DOMAIN` | The site's domain. Caddy gets its certificate and redirects `www.DOMAIN`; `CORS_ORIGIN` = `https://DOMAIN` |
| `IMAGE_REGISTRY`, `IMAGE_TAG` | ECR repository prefix and the tag (a git commit) |
| `DB_NAME`, `DB_USER`, `DB_PASS` | The main login (owner of the tables; migrations, the history import) |
| `ML_DB_USER/_PASS`, `RESEARCH_DB_USER/_PASS`, `REPLAY_DB_USER/_PASS` | The restricted logins; passwords ≥ 16 characters |
| `REDIS_PASS` | |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Long random strings, different from each other |
| `STORAGE=s3`, `AWS_REGION`, `S3_BUCKET` | Backtest results; credentials from the instance role (never keys) |
| `GROQ_API_KEY` | research-agent's LLM (free tier) |
| Optional | `MARKET_FEED` (default `none`), `REGISTRATION_ENABLED` (default `false`), `COOKIE_SECURE` (default `true`), `RESEARCH_DAILY_LIMIT` (20), `FEED_LIVE_MAX_AGE_S` (10), `JWT_*_EXPIRES` |

Demo users go in `infra/.env.demo-users` (also ignored by git): `DEMO_USERS=demo` in `.env.prod`, then
`DEMO_DEMO_EMAIL=...` and `DEMO_DEMO_PASS=...` (≥ 12 characters, the sign-up rules). Nothing logs them.

The compose file refuses to start when a required variable is missing (`${VAR:?}`), and with
`NODE_ENV=production` (set by the compose file) a service refuses to start without `CORS_ORIGIN` or
(ws-gateway) `STORAGE`.

## 2. Routes (Caddyfile)

Checked against the controllers: every prefix below reaches its service, and `npm run prod:smoke` checks
each one through Caddy.

| Path | Service |
|---|---|
| `/api/auth*` | auth-service :3000 |
| `/api/market*` | market-service :3002 |
| `/api/domain*` | domain-service :3003 |
| `/api/orders*`, `/api/positions*`, `/api/account*` | order-service :3004 (the step-7 plan listed only `/api/orders`) |
| `/api/backtest*`, `/socket.io/*` | ws-gateway :3005 (the plan listed only the socket) |
| `/api/ml*` | ml-service :3006 |
| `/api/research*` | research-agent :3007 (110 s response timeout for `/ask`) |
| `/api/replay*` (REST and the socket path `/api/replay/socket.io`) | replay-service :3008 |
| `/health*`, `/admin*`, any other `/api/*` | 404 at Caddy |
| everything else (`/replay` page included) | frontend :3000 |

## 3. Health checks

Every app answers `GET /health/live` (the process is up) and `GET /health/ready` (its own dependencies:
DB, Redis, Kafka, the results bucket, ml-service's models), outside the `/api` prefix, without auth, with
the dependency names only (503 when one is down). Caddy doesn't route them: Docker's healthchecks call
`/health/live` inside each container. **The deploy check runs `/health/ready` the same way:**

```sh
C="docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod"
for sp in auth-service:3000 market-service:3002 domain-service:3003 order-service:3004 ws-gateway:3005 \
          replay-service:3008 frontend:3000; do
  $C exec -T ${sp%%:*} node -e "fetch('http://127.0.0.1:${sp##*:}/health/ready').then(async r=>{console.log('${sp%%:*}',r.status,await r.text());process.exit(r.ok?0:1)})"
done
for sp in ml-service:3006 research-agent:3007; do
  $C exec -T ${sp%%:*} python -c "import urllib.request as u; r=u.urlopen('http://127.0.0.1:${sp##*:}/health/ready'); print('${sp%%:*}', r.status, r.read().decode())"
done
```

## 4. A fresh database: bootstrap and the history

```sh
C="docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod"
$C up -d timescaledb redis kafka
$C --profile ops run --rm ops npx ts-node --transpile-only tools/ops/bootstrap-prod.ts   # stops at "history loaded"
$C --profile ops run --rm ops npm run data:transfer -- import --dir /repo/data/history-transfer
$C --profile ops run --rm ops npm run data:import -- --check-only   # rows per pair-year, aggregates vs M1
$C --profile ops run --rm ops npm run data:validate                 # FRED fixings, gold extremes
$C --profile ops run --rm ops npx ts-node --transpile-only tools/ops/bootstrap-prod.ts   # every step now
$C up -d
```

The bootstrap runs, in order: migrations, the instruments seed, a check that the history is loaded, the ML,
research and replay logins, the demo users. Every step is idempotent (a second run changes nothing; tested
twice on `<DB_NAME>_test`). It stops before the logins until the history is in, because each login tool
proves its grants by reading EUR/USD H1 bars, and an empty read would prove nothing.

The history comes from the dev database: `npm run data:transfer -- export` writes
`data/history-transfer/` (4 gzip CSVs of `historical_candles`, one per pair, the import log, and
`manifest.json` with each file's sha256 and, per pair, the row count, first/last minute and the sum of
every value column). Copy that directory to the host (`data/history-transfer` next to `infra/`); the
`ops` container mounts it. The import refuses a missing or altered file and a target that already holds
history, then COPYs, compresses, refreshes the aggregates (5m → 15m → 1h per year, 4h → 1d over one padded
window) and compares the result with the manifest. `check` can be run any time and fails on an empty or
partial import.

**Laptop run (2026-11-10):** export 145 s, 423 MB; import 677 s, identical to the export (19,187,987
minutes); `--check-only` all checks pass (159/159 chunks compressed, 2,700.9 MB → 361.5 MB, database
558.8 MB); `data:validate` all checks pass.

## 5. Local production run (item 13)

```sh
# infra/.env.local-prod: DOMAIN=localhost and random secrets; infra/.env.demo-users: the demo login
C="docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.local.yml --env-file infra/.env.local-prod"
$C --profile ops build && $C up -d          # then section 4 for a fresh database
node infra/check-compose.mjs infra/docker-compose.prod.yml infra/docker-compose.local.yml
set -a; . infra/.env.demo-users; set +a
NODE_OPTIONS=--dns-result-order=ipv4first VERIFY_EMAIL="$DEMO_DEMO_EMAIL" VERIFY_PASSWORD="$DEMO_DEMO_PASS" npm run prod:smoke
```

Caddy serves `https://localhost` with its own local CA (accepted by the smoke run for `localhost` only).
On Windows, Docker Desktop resets IPv6 connections to published ports, hence `ipv4first` (and the smoke
run maps `localhost` to 127.0.0.1 in Chromium).

**Result (`docs/validation/prod-local-run.md`, all checks pass):** HTTP → HTTPS, `www` → apex, every prefix
reaches its service, both Socket.IO paths answer, `/health*`, `/admin*` and unknown `/api` paths 404;
sign-up 403, no Register link, the demo user logs in, the terminal dot says "No live feed"; a backtest
(MA crossover, EUR/USD H1, January 2022) completes and its `results.json` (15 trades) comes back through
Caddy from the store; a replay plays over `/api/replay/socket.io`, a BUY placed at 09:52 (bid 1.11962 /
ask 1.11965 at that minute's close) fills at 09:53's ask open, 1.11963.

**Memory (`docker stats`, MB):**

| Container | Idle | Replay playing | Limit |
|---|---|---|---|
| timescaledb | 435 | 445 | 1024 |
| kafka | 489 | 579 | 800 |
| ml-service | 189 | 189 | 640 |
| minio (laptop only) | 144 | 146 | 256 |
| research-agent | 101 | 101 | 480 |
| ws-gateway | 80 | 81 | 320 |
| domain-service | 75 | 76 | 192 |
| order-service | 74 | 74 | 224 |
| replay-service | 65 | 66 | 288 |
| market-service | 63 | 63 | 192 |
| auth-service | 60 | 61 | 192 |
| frontend | 53 | 54 | 192 |
| caddy | 25 | 33 | 64 |
| redis | 11 | 11 | 160 |
| **Total** | **1,863** | **1,979** | 5,024 |

1.98 GB of the 3.5 GB budget while a replay plays (1.83 GB without MinIO, as in production); Kafka's JVM is
the one that moves (489 → 579 MB of its 800). Redis `used_memory` 2.12 MB (maxmemory 96 MB). A second run gave
1.83 / 1.87 GB. The limits add up to more than the host on purpose: they are
ceilings per container, and swap covers peaks.

Images on disk: NestJS services 450–485 MB, frontend 425 MB, research-agent 376 MB, ml-service 1.71 GB
(CPU torch), ops 2.26 GB (all dev dependencies; run once, never a service).

## 6. Phase 2 (AWS) notes

Everything below is now in Terraform and `infra/vm/setup.sh` (section 7).

- **IMDSv2 hop limit 2** (`ec2.tf`). Containers reach the instance metadata one hop further than the host
  (the Docker bridge is a routed hop, and the IMDSv2 token comes back with IP TTL = hop limit); with the
  default limit of 1 the S3 credential request times out.
- **Instance role policy** (`iam_vm.tf`): `s3:PutObject`, `s3:GetObject` on both buckets' objects,
  `s3:ListBucket` on the buckets (startup and readiness check that the results bucket exists); ECR pull. The
  bucket is private and needs no CORS (the browser never talks to it: ws-gateway returns `results.json` itself).
- **Credentials:** ws-gateway reads them from instance metadata (`ec2-role-credentials.ts`). minio's own
  `IamAwsProvider` (8.0.7) reads the field `AccessKeyID` while the metadata service answers `AccessKeyId`,
  so it isn't used.
- **Security group** (`network.tf`): TCP 80 and 443, UDP 443 (HTTP/3) only. No SSH: Session Manager.
- **DNS:** `DOMAIN` and `www.DOMAIN` → the instance's Elastic IP before the first `up` (Let's Encrypt).
- **Swap:** 4 GB swap file on the host (`setup.sh`).
- **Before a public deployment:** re-check Dukascopy's terms for serving its historical data (roadmap step 7),
  and the Forex Factory exception (portfolio use only).

## 7. AWS infrastructure (Terraform)

`infra/terraform` creates the whole AWS side in `ap-south-1`; `infra/vm/setup.sh` prepares the host. Nothing
in either holds a secret (Terraform state is plain JSON). You run every command against AWS yourself, with
your SSO login; there are no access keys anywhere.

| File | Creates |
|---|---|
| `network.tf` | VPC 10.20.0.0/16, one public subnet (ap-south-1a), internet gateway, the default security group emptied, security group `forexedge-web` (TCP 80/443 and UDP 443 from 0.0.0.0/0 and ::/0; no SSH) |
| `ec2.tf` | The t3.medium host: Ubuntu 24.04 from Canonical's SSM parameter (later AMIs and the public IP flag the Elastic IP turns on are ignored), IMDSv2 only, hop limit 2, encrypted 40 GB gp3 root, `cpu_credits` standard, termination protection, no key pair; Elastic IP; EBS encryption by default (account) |
| `iam_vm.tf` | Role and instance profile `forexedge-ec2`: SSM core, CloudWatch agent, ECR pull on the ten repositories, S3 list/get/put (no delete) on the two buckets |
| `ecr.tf` | `forexedge/<image>` for the ten compose images: immutable tags, scan on push, last 5 kept |
| `s3.tf` | `forexedge-results-<account>` and `forexedge-backups-<account>` (versioned, every version gone after 14 days): public access blocked, ACLs off, SSE-S3, TLS only; S3 public access block (account) |
| `github_oidc.tf` | Role `forexedge-github-deploy` for `main` of the repository only: ECR push, `ssm:SendCommand` on this instance with `AWS-RunShellScript`, `ssm:GetCommandInvocation` (unused until Phase 4). It trusts GitHub's OIDC provider, which is **not** created here (next paragraph) |
| `monitoring.tf` | SNS topic `forexedge-alerts` → `alert_email`; alarms: CPU > 80% for 15 min, CPU credits < 30, status check, memory > 90%, disk / > 80% |
| `dlm.tf` | Daily snapshot of the root volume at 20:30 UTC, 7 kept, with its own minimal role |

**GitHub OIDC provider (shared, pre-existing):** the account already has the provider for
`https://token.actions.githubusercontent.com` (an account has one per URL), shared with other projects.
This stack reads it with a data source and never creates, changes or destroys it. The plan fails if it is
missing (`no matching IAM OpenID Connect Provider`) or doesn't list the audience `sts.amazonaws.com`;
check with `aws iam list-open-id-connect-providers` and `aws iam get-open-id-connect-provider
--open-id-connect-provider-arn <arn>` (`ClientIDList`). `npm run infra:check` refuses a
`resource "aws_iam_openid_connect_provider"`.

Phase 4 note: the deploy role can push but not pull. If the GitHub workflow uses ECR as a build cache
(`--cache-from`), it will need `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` on the same
repositories, added then.

**Versions:** Terraform **1.16.7** exactly (`versions.tf`; `winget install Hashicorp.Terraform --version 1.16.7`),
hashicorp/aws **6.70.0** with `.terraform.lock.hcl` (Windows, Linux, macOS hashes). A newer version is a
deliberate edit plus `terraform providers lock -platform=windows_amd64 -platform=linux_amd64
-platform=darwin_amd64 -platform=darwin_arm64`.

**Offline checks** (no AWS call, Docker running): `npm run infra:check` runs `terraform fmt -check`, the
source rules (compose images = ECR repositories, `check-compose.mjs`, no key pair, no inline security group
rules), `validate`,
`terraform test` (a mocked provider: security group, IMDSv2, encryption, credits, buckets, OIDC trust,
deploy and host role rights, alarms, snapshots, outputs), tflint with the AWS ruleset and shellcheck (both from
images pinned by digest). `bash infra/terraform/tests/planted-faults.sh` plants a fault for every rule and
fails if a check misses one.

### 7.1 State bucket (once, by hand)

Terraform keeps its state in a bucket it doesn't manage (it can't create the bucket it needs to start). In
Git Bash, with the AWS CLI v2 and your SSO profile (here `forexedge`):

```sh
export AWS_PROFILE=forexedge
aws sso login
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET=forexedge-tfstate-$ACCOUNT
aws s3api create-bucket --bucket "$STATE_BUCKET" --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1
aws s3api put-public-access-block --bucket "$STATE_BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls --bucket "$STATE_BUCKET" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
aws s3api put-bucket-versioning --bucket "$STATE_BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$STATE_BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-policy --bucket "$STATE_BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{
  \"Sid\":\"DenyInsecureTransport\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",
  \"Resource\":[\"arn:aws:s3:::$STATE_BUCKET\",\"arn:aws:s3:::$STATE_BUCKET/*\"],
  \"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
# check: Enabled, AES256, all four true
aws s3api get-bucket-versioning --bucket "$STATE_BUCKET"
aws s3api get-bucket-encryption --bucket "$STATE_BUCKET" --query 'ServerSideEncryptionConfiguration.Rules[0]'
aws s3api get-public-access-block --bucket "$STATE_BUCKET"
```

The same in the console: S3 → Create bucket → region Asia Pacific (Mumbai), name `forexedge-tfstate-<account>`,
Object Ownership "ACLs disabled", "Block all public access" on, Bucket Versioning "Enable", Default encryption
SSE-S3 → Create; then Permissions → Bucket policy → the policy above.

### 7.2 Plan and apply

```sh
export AWS_PROFILE=forexedge && aws sso login
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars        # git-ignored; set alert_email (stays out of git)
terraform init -backend-config="bucket=forexedge-tfstate-$ACCOUNT"
terraform plan -out=forexedge.tfplan                 # 68 to add on the first run, 0 to change/destroy
terraform apply forexedge.tfplan
terraform output
```

Read the plan before applying: nothing should be destroyed or replaced after the first apply. A plan that
replaces `aws_instance.app` would delete the database (it lives on the root volume); termination protection
makes such an apply fail.

### 7.3 After the first apply

1. **Confirm the alarm email:** AWS sends "AWS Notification - Subscription Confirmation" to `alert_email`;
   click the link (until then `aws sns list-subscriptions-by-topic` shows `PendingConfirmation`).
2. **DNS at the registrar:** two A records, `forexedge.tech` and `www.forexedge.tech` → `elastic_ip` (the
   `dns_records` output), TTL 300. Check before the first `docker compose up` (Caddy asks Let's Encrypt for the
   certificate at once): `nslookup forexedge.tech 1.1.1.1` and the same for `www`.
3. **Expected alarm:** `forexedge-cpu-credits-low` fires in the first hours. A t3 in standard mode starts
   with no CPU credits and earns 24 an hour; it clears itself.
4. **Host setup** (7.4).

### 7.4 Host setup (`infra/vm/setup.sh`)

The script goes to the host through SSM (the SSM agent comes with Canonical's AMI; no SSH, no key). Run
Command needs nothing but the AWS CLI:

```sh
ID=$(terraform -chdir=infra/terraform output -raw instance_id)
# run_on_host FILE: copies a script of the repo to /root on the host (sha256 checked there) and runs it as root
run_on_host() {
  local name sum cmd
  name=$(basename "$1"); sum=$(sha256sum "$1" | cut -d' ' -f1)
  node -e '
    const [file, name, sum] = process.argv.slice(1);
    const b64 = require("fs").readFileSync(file).toString("base64");
    console.log(JSON.stringify({ commands: [
      `echo ${b64} | base64 -d > /root/${name}`, `echo "${sum}  /root/${name}" | sha256sum -c -`,
      `bash /root/${name}` ] }));' "$1" "$name" "$sum" > ssm-params.json
  cmd=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
    --comment "forexedge $name $sum" --parameters file://ssm-params.json --query Command.CommandId --output text)
  rm ssm-params.json
  aws ssm wait command-executed --command-id "$cmd" --instance-id "$ID" || true   # the waiter gives up at 100 s
  echo "aws ssm get-command-invocation --command-id $cmd --instance-id $ID --query '[Status, StandardOutputContent, StandardErrorContent]' --output text"
  aws ssm get-command-invocation --command-id "$cmd" --instance-id "$ID" \
    --query '[Status, StandardOutputContent, StandardErrorContent]' --output text
}
run_on_host infra/vm/setup.sh      # "InProgress" after 100 s: run the printed command again until Success
```

Or interactively (needs the Session Manager plugin for the AWS CLI): `aws ssm start-session --target "$ID"`,
`sudo -i`, put the file in `/root/setup.sh`, `bash /root/setup.sh`. A second run must print only the final
`done:` line (nothing changed).

What it does: Docker Engine 29.9.2 + Compose 5.6.1 from Docker's apt repository (key fingerprint
`9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88` checked; packages held), daemon log rotation 3 x 10 MB, a
4 GB `/swapfile` (swappiness 10), unattended-upgrades for security updates without automatic reboot, the
CloudWatch agent 1.300073.2 (sha256 and AWS's signature checked) sending `mem_used_percent` and
`disk_used_percent` for `/`, `/opt/forexedge` (root, 700), and the metadata guard (7.4.1). After it: `forexedge-memory-high` and
`forexedge-disk-high` leave INSUFFICIENT_DATA within a few minutes
(`aws cloudwatch describe-alarms --alarm-name-prefix forexedge- --query 'MetricAlarms[].[AlarmName,StateValue]'`).

### 7.4.1 Instance metadata guard (go-live gate)

The hop limit of 2 lets containers reach the instance metadata service, and with it the role's credentials
(ECR pull, S3 read/write on both buckets). Only ws-gateway needs them. So:

- **Compose** gives ws-gateway a fixed address, `172.30.0.10`, on a bridge with a fixed name, `fxedge0`
  (network `forexedge_default`, subnet `172.30.0.0/24`). Every other container gets its address from
  `172.30.0.128/25`, so none can be given ws-gateway's. `check-compose.mjs` fails if these values differ from
  the guard's, if another service has a fixed address, or if a service uses `network_mode` (a host-network
  container's traffic never crosses FORWARD).
- **setup.sh** installs `/usr/local/sbin/forexedge-imds-guard`: a `FOREXEDGE-IMDS` chain, jumped to from
  Docker's `DOCKER-USER`, that lets `172.30.0.10` from `fxedge0` reach `169.254.169.254:80` and answers
  every other container with a TCP reset. A systemd drop-in for `docker.service` runs it before dockerd starts
  (no container runs unguarded, also at boot) and again once it is up, so it survives reboots and Docker
  restarts. The host's own processes (SSM and CloudWatch agents) are not affected.
- A container that forges ws-gateway's source address gets nothing back: the reply goes to the real
  ws-gateway, so no TCP connection is ever made.

**Gate:** the site isn't announced (and DNS isn't shared) until this passes on the host, after the first
`docker compose up` with ws-gateway healthy, again after `systemctl restart docker`, and again after a reboot:

```sh
run_on_host infra/vm/check-imds-guard.sh
# ok    ws-gateway (172.30.0.10)                             token received
# ok    new container of ws-gateway's image on forexedge_default refused
# ok    auth-service ... (every running Node container)      refused
# ok    new container on Docker's default bridge             refused
# metadata guard: only ws-gateway reaches 169.254.169.254 (N other containers refused)
```

The token is never printed. On the laptop, `npm run infra:imds-test` runs the same check against the guard
setup.sh installs, in Docker-in-Docker with a fake metadata service one routed hop away (as on EC2), and
plants three faults (no guard, the guard admitting another address, ws-gateway off its address) that must
each make the check fail.

### 7.5 CPU credits during Phase 3

Pulling the images and importing the history keep both vCPUs busy for a long time, past what standard mode's
credits cover (it would slow to the 20% baseline). For that window only:

```sh
terraform apply -var cpu_credits=unlimited      # before the image pull and the history import
# ... Phase 3 work ...
terraform apply -var cpu_credits=standard       # right after; unlimited bills surplus credits
```

`cpu_credits` changes in place (no restart). The tfvars value stays `standard`.

### 7.6 Monthly manual check

Docker and the reboots after kernel updates are deliberately manual (decisions 4 and 5 of the plan). Once a
month, in a Session Manager shell (`sudo -i`):

1. **Reboot if needed:** `cat /var/run/reboot-required.pkgs 2>/dev/null` lists the packages waiting for one.
   Reboot in a quiet hour (`systemctl reboot`); every container comes back (`restart: unless-stopped`); then
   run the health checks of section 3 and `check-imds-guard.sh` (7.4.1).
2. **Docker:** compare `docker version` with Docker's release notes. To upgrade, pick releases at least 14
   days old, change `DOCKER_VERSION`, `CONTAINERD_VERSION`, `COMPOSE_VERSION` in `setup.sh` (versions from
   `apt-cache madison docker-ce containerd.io docker-compose-plugin`), commit, and run `setup.sh` again (it
   restarts Docker, so the stack restarts), then `check-imds-guard.sh`.
3. **CloudWatch agent:** the same for `CWAGENT_BUILD`, `CWAGENT_PACKAGE_VERSION` and `CWAGENT_SHA256` (and the
   signature check in the script).
4. **Security updates applied:** `tail /var/log/unattended-upgrades/unattended-upgrades.log`.
5. **Snapshots:** `aws ec2 describe-snapshots --owner-ids self --filters Name=tag:forexedge:dlm,Values=daily
   --query 'Snapshots[].[StartTime,State]' --output table` shows 7, the newest from last night.
6. **Image scan findings:** `aws ecr describe-image-scan-findings --repository-name forexedge/<image>
   --image-id imageTag=<tag>` for the running tag.

### 7.7 Destroy (at exit)

```sh
cd infra/terraform
# 1. termination protection off: set enable_termination_protection = false in terraform.tfvars
terraform apply
# 2. empty the buckets (neither is force_destroy); backups is versioned, so delete every version
aws s3 rm "s3://$(terraform output -raw results_bucket)" --recursive
B=$(terraform output -raw backups_bucket)
aws s3api list-object-versions --bucket "$B" --output json \
  --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' > versions.json
aws s3api delete-objects --bucket "$B" --delete file://versions.json && rm versions.json   # skip if empty
# 3. empty the ECR repositories
for r in auth-service market-service domain-service order-service ws-gateway replay-service ml-service \
         research-agent frontend ops; do
  ids=$(aws ecr list-images --repository-name "forexedge/$r" --query imageIds --output json)
  [ "$ids" = "[]" ] || aws ecr batch-delete-image --repository-name "forexedge/$r" --image-ids "$ids" >/dev/null
done
# 4.
terraform destroy
```

`terraform destroy` also turns off the two account-wide settings (EBS encryption by default, the S3 account
public access block). To keep them, run `terraform state rm aws_ebs_encryption_by_default.this
aws_s3_account_public_access_block.this` before step 4.

Left behind, by design or by AWS:

- **The GitHub OIDC provider**: shared and pre-existing, only read by this stack (7, `github_oidc.tf`).

- **DLM snapshots**: deleting the policy doesn't delete them. `aws ec2 describe-snapshots --owner-ids self
  --filters Name=tag:forexedge:dlm,Values=daily --query 'Snapshots[].SnapshotId' --output text`, then
  `aws ec2 delete-snapshot --snapshot-id <id>` for each.
- **The state bucket** (7.1) with every state version: empty it like the backups bucket, then
  `aws s3api delete-bucket --bucket "$STATE_BUCKET"`.
- **CloudWatch custom metrics** (`CWAgent`): kept 15 months by AWS, no charge, can't be deleted.
- **SSM Run Command and Session Manager history**: kept by AWS, no charge.
- **An unconfirmed SNS email subscription**, if the link was never clicked: AWS removes it after 3 days.
- **The A records at the registrar**, and locally `infra/terraform/terraform.tfvars` and `.terraform/`.
