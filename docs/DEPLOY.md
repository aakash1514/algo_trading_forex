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
| `npm run prod:smoke` | The deployed stack in a browser, over HTTPS, plus memory (laptop stack only) |
| `.github/workflows/build-images.yml` | Builds the ten images for a commit of `main` and pushes them to ECR (sections 8 and 10) |
| `.github/workflows/ci.yml`, `deploy.yml` | Checks every pull request (job `ci`); builds and deploys every push to `main` (section 10) |
| `infra/vm/*.sh` | The host: `setup.sh`, `run-on-host.sh`, `stage.sh` (laptop or deploy.yml) and `fetch.sh`, `make-env.sh`, `set-secret.sh`, `stack.sh`, `bootstrap.sh`, `deploy.sh`, `check-imds-guard.sh` (sections 7, 8 and 10) |

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
| `ec2.tf` | The t3.medium host: Ubuntu 24.04 from Canonical's SSM parameter (later AMIs and the public IP flag the Elastic IP turns on are ignored), IMDSv2 only, hop limit 2, encrypted 40 GB gp3 root, `cpu_credits` standard, termination protection, no key pair, `instance_state` running or stopped (section 9); Elastic IP; EBS encryption by default (account) |
| `iam_vm.tf` | Role and instance profile `forexedge-ec2`: SSM core, CloudWatch agent, ECR pull on the ten repositories, S3 list/get/put (no delete) on the two buckets |
| `ecr.tf` | `forexedge/<image>` for the ten compose images: immutable tags, scan on push, last 5 kept |
| `s3.tf` | `forexedge-results-<account>` and `forexedge-backups-<account>` (versioned, every version gone after 14 days): public access blocked, ACLs off, SSE-S3, TLS only; S3 public access block (account) |
| `github_oidc.tf` | Role `forexedge-github-deploy` for `main` of the repository only: ECR push, `ssm:SendCommand` on this instance with `AWS-RunShellScript`, `ssm:GetCommandInvocation`, `s3:PutObject` on `transfer/*` of the backups bucket only (`stage.sh`; section 10). It trusts GitHub's OIDC provider, which is **not** created here (next paragraph) |
| `monitoring.tf` | SNS topic `forexedge-alerts` → `alert_email`; alarms: CPU > 80% for 15 min, CPU credits < 30, status check, memory > 90%, disk / > 80% |
| `dlm.tf` | Daily snapshot of the root volume at 20:30 UTC, 7 kept, with its own minimal role |

**GitHub OIDC provider (shared, pre-existing):** the account already has the provider for
`https://token.actions.githubusercontent.com` (an account has one per URL), shared with other projects.
This stack reads it with a data source and never creates, changes or destroys it. The plan fails if it is
missing (`no matching IAM OpenID Connect Provider`) or doesn't list the audience `sts.amazonaws.com`;
check with `aws iam list-open-id-connect-providers` and `aws iam get-open-id-connect-provider
--open-id-connect-provider-arn <arn>` (`ClientIDList`). `npm run infra:check` refuses a
`resource "aws_iam_openid_connect_provider"`.

The deploy role can push but not pull: the build cache is GitHub's (`type=gha`). Using ECR as a build cache
(`--cache-from`) would need `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` on the same repositories,
added on purpose.

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
Command needs nothing but the AWS CLI, through `infra/vm/run-on-host.sh` (from the repo root, Git Bash or Linux):

```sh
bash infra/vm/run-on-host.sh infra/vm/setup.sh     # instance id from `terraform output`; or pass it second
```

It copies the script to `/root/<name>` on the host (root only), checks its sha256 there against the laptop's
copy, runs it with bash only if they match, polls every 10 s (15 min by default, `--timeout <s>` up to 2 h; the
host stops it at the same limit), then prints the status, stdout and stderr, and exits non-zero unless the status
is `Success`. Arguments for the script go after `--` (`run-on-host.sh infra/vm/stack.sh -- ps <tag>`): each must
match `[A-Za-z0-9._:/@,=+-]+`, and SSM stores them with the command, as it stores the output, so **never pass a
secret** (secrets are typed on the host with `set-secret.sh`, section 8). It needs no `node` (in Git Bash `node`
may be winpty, which prints "stdout is not a tty" when redirected), runs the AWS CLI with
`PYTHONIOENCODING=utf-8` (the Windows CLI otherwise fails on a non-ASCII byte of the host's output) and prints
nothing but the host's output. `npm run infra:check` runs it against stub `aws`/`terraform` commands
(`infra/vm/tests/run-on-host.test.sh`, with a tampered sha256 that must not run and arguments that must be refused).

Or interactively (needs the Session Manager plugin for the AWS CLI): `aws ssm start-session --target "$ID"`,
`sudo -i`, put the file in `/root/setup.sh`, `bash /root/setup.sh`. A second run must print only the final
`done:` line (nothing changed).

What it does: Docker Engine 29.9.2 + Compose 5.6.1 from Docker's apt repository (key fingerprint
`9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88` checked; packages held), daemon log rotation 3 x 10 MB, a
4 GB `/swapfile` (swappiness 10), unattended-upgrades for security updates without automatic reboot, the
CloudWatch agent 1.300073.2 (sha256 and AWS's signature checked) sending `mem_used_percent` and
`disk_used_percent` for `/`, `/opt/forexedge` (root, 700), the metadata guard (7.4.1), and the AWS CLI 2.39.1
(sha256 checked, and AWS's signature against the key AWS publishes in the CLI install guide, fingerprint
`FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C`, embedded in the script; valid until 2027-07-02). The CLI is
for the host-side tools of section 8 (ECR login, S3 downloads): they run on the host with the instance role,
never in a container, because the guard lets only ws-gateway's container reach the role's credentials. After it: `forexedge-memory-high` and
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
bash infra/vm/run-on-host.sh infra/vm/check-imds-guard.sh
# ok    ws-gateway (172.30.0.10)                             token received
# ok    new container of ws-gateway's image on forexedge_default refused
# ok    auth-service ... (every running Node container)      refused
# ok    ml-service (python), research-agent (python)         refused
# ok    new container on Docker's default bridge             refused
# not probed (neither node nor python): timescaledb redis kafka caddy
# metadata guard: only ws-gateway reaches 169.254.169.254 (N other containers refused: n node, 2 python)
```

The token is never printed. On the laptop, `npm run infra:imds-test` runs the same check against the guard
setup.sh installs, in Docker-in-Docker with a fake metadata service one routed hop away (as on EC2), and
plants four faults (no guard, the guard admitting another address, ws-gateway off its address, a check that
skips the Python containers) that must each make the check fail.

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
3a. **AWS CLI:** the same for `AWSCLI_VERSION` and `AWSCLI_SHA256` in `setup.sh`. Before 2027-07-02 (the key's
   expiry) replace the embedded key with the copy in AWS's install guide ("Verify the integrity and authenticity
   of the downloaded zip file"); its fingerprint must stay `FB5DB77FD5C118B80511ADA8A6310ACC4672475C`.
4. **Security updates applied:** `tail /var/log/unattended-upgrades/unattended-upgrades.log`.
5. **Snapshots:** `aws ec2 describe-snapshots --owner-ids self --filters Name=tag:forexedge:dlm,Values=daily
   --query 'Snapshots[].[StartTime,State]' --output table` shows 7, the newest from last night.
6. **Image scan findings:** `aws ecr describe-image-scan-findings --repository-name forexedge/<image>
   --image-id imageTag=<tag>` for the running tag.
7. **Restore test** (from the laptop; it prints table names and row counts only, so SSM may keep its output):

   ```sh
   bash infra/vm/run-on-host.sh infra/vm/restore-test.sh --timeout 900 -- "$BACKUPS"
   # dump: s3://<backups>/predeploy/20261111T120000Z-<TAG>.sql.gz
   # table                    rows in dump-restore    rows live now
   # users                                       5                6
   # ...
   # restore-test-result: ok
   ```

   It restores the newest pre-deploy dump (or the key given after the bucket) into an empty scratch database
   `restore_test_<UTC>` (nothing copied from the live database: the dump must stand alone), compares each
   table's rows with the live database (restored <= live is expected; fewer live rows is marked, not a
   failure) and always drops the scratch database and deletes its copy of the dump. It fails on no dump, a
   broken, incomplete or not self-contained dump (one made before deploy.sh wrote its prerequisites), a
   restore error, zero tables, a restored table missing live, or no users. Dumps expire after 14 days: with no deploy in that time it fails with "no pre-deploy
   dump"; run it after the next deploy. Section 10.4.

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

## 8. First deploy (Phase 3)

The whole sequence, in order, from Git Bash on the laptop at the repo root with your SSO login
(`export AWS_PROFILE=forexedge && aws sso login`). Every host step goes through `run-on-host.sh` (7.4) except
the secrets, which you type in a Session Manager shell. Nothing secret ever goes into git, an image, a workflow
log, an SSM command's parameters or its output: the scripts print variable names, never values, and
`stack.sh`/`bootstrap.sh` redact every secret of the env files from what they print.

Before starting: the branch is merged into `main` and checked out (`git checkout main && git pull`), the tree is
clean, the two A records of 7.3 resolve (`nslookup forexedge.tech 1.1.1.1`), and

```sh
TAG=$(git rev-parse HEAD)                                  # the commit everything below runs (40 hex)
ID=$(terraform -chdir=infra/terraform output -raw instance_id)
BACKUPS=$(terraform -chdir=infra/terraform output -raw backups_bucket)
REGISTRY=$(terraform -chdir=infra/terraform output -raw image_registry)
RESULTS=$(terraform -chdir=infra/terraform output -raw results_bucket)
```

On the host everything lives under `/opt/forexedge`. Each fetched commit is a release with the repo's layout,
so the compose file's relative paths work unchanged; the secrets and the history are shared by every release:

| Path | From | Mode |
|---|---|---|
| `releases/<sha>/infra/docker-compose.prod.yml`, `…/infra/caddy/Caddyfile`, `…/infra/vm/*.sh` | `stage.sh` + `fetch.sh`; never changed once fetched | root 600 (scripts 700) |
| `releases/<sha>/infra/.env.prod`, `…/.env.demo-users`, `releases/<sha>/data` | `fetch.sh`: links to the shared files below | links |
| `releases/<sha>/release` | `fetch.sh`, last: `commit`, `prefix`, `fetched`; `stack.sh`, `bootstrap.sh`, `make-env.sh` and `deploy.sh` refuse a tag without it | root 600 |
| `current` | `deploy.sh`: link to the running release (section 10) | link |
| `data/history-transfer/` | `stage.sh --history` + `fetch.sh` | root, directory 755, files 644 (the ops container reads it as `node`) |
| `infra/.env.prod`, `infra/.env.demo-users` | `make-env.sh` (once), `set-secret.sh` | root 600 |
| `logs/bootstrap-*.log`, `deploys.log` | `bootstrap.sh` (redacted), `deploy.sh` (one line per deploy) | root 600 |

Until the first `deploy.sh` (section 10), the Phase 3 layout is in place instead: the compose file, the
Caddyfile and the scripts in `/opt/forexedge/infra`, and `/opt/forexedge/staged-commit`. The first deploy
adopts it as a release.

### 8.1 Repository variables

GitHub → the repository → Settings → Secrets and variables → Actions → **Variables** (not Secrets: neither
value is secret, and `npm run infra:check` fails if the workflow reads `secrets.`):

```sh
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(terraform -chdir=infra/terraform output -raw deploy_role_arn)"
gh variable set AWS_REGION --body ap-south-1
gh variable list        # AWS_DEPLOY_ROLE_ARN  arn:aws:iam::805496480789:role/forexedge-github-deploy
                        # AWS_REGION           ap-south-1
```

### 8.2 Build the images

```sh
gh workflow run build-images.yml --ref main
gh run watch "$(gh run list --workflow build-images.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: ten jobs (`auth-service` … `ops`), each green, each job summary one row
`forexedge/<image> | <TAG> | sha256:… | pushed`. The first run has no cache (ml-service's torch and ops take
longest; not measured yet). Running it again for the same commit gives `already pushed` per image (ECR tags are
immutable) and stays green; any other push error fails that job. The "already pushed" match (the
`ImageTagAlreadyExistsException` / "tag invalid … already exists" text) hasn't been seen against ECR yet: check
it on the first re-run. From the laptop:

```sh
for r in auth-service market-service domain-service order-service ws-gateway replay-service ml-service \
         research-agent frontend ops; do
  aws ecr describe-images --repository-name "forexedge/$r" --image-ids imageTag="$TAG" \
    --query 'imageDetails[0].[imageTags[0],imageSizeInBytes]' --output text
done                    # ten lines: <TAG>  <size>
```

### 8.3 CPU credits unlimited

```sh
terraform -chdir=infra/terraform apply -var cpu_credits=unlimited    # 0 to add, 1 to change, 0 to destroy
```

Only `aws_instance.app`'s `credit_specification` changes, in place (7.5). From here to 8.11 the pulls and the
import can use both vCPUs without dropping to the 20% baseline.

### 8.4 Host setup again (AWS CLI)

```sh
bash infra/vm/run-on-host.sh infra/vm/setup.sh
```

Expected: `[setup] installed aws-cli/2.39.1`, then the `done:` line, which now names `aws-cli/2.39.1`
(no other step prints anything: unchanged since 7.4).

### 8.5 Stage and fetch

The history export must be the one `npm run data:transfer -- check` accepts on the dev database.

```sh
bash infra/vm/stage.sh "$TAG" --history
# staged 12 files of commit <TAG> (history: true)
# prefix: transfer/20261111T093000Z/
# next:   bash infra/vm/run-on-host.sh infra/vm/fetch.sh --timeout 1800 -- forexedge-backups-805496480789 transfer/20261111T093000Z/ <region>
PREFIX=transfer/20261111T093000Z/          # the printed prefix
bash infra/vm/run-on-host.sh infra/vm/fetch.sh --timeout 1800 -- "$BACKUPS" "$PREFIX" ap-south-1
# fetched 12 files of commit <TAG> (sha256 verified; 6 history files) into /opt/forexedge/releases/<TAG>
```

12 files: the compose file, the Caddyfile, `stack.sh`, `bootstrap.sh`, `set-secret.sh`, `check-imds-guard.sh`
and the 6 files of `data/history-transfer` (about 423 MB). `stage.sh` refuses a tag other than HEAD and a tree
with changes; `fetch.sh` installs nothing if a sha256 differs, a file isn't in the manifest or a path is outside
the allowed set. The bundle expires from the bucket after 14 days.

### 8.6 Settings

```sh
bash infra/vm/run-on-host.sh infra/vm/make-env.sh -- DOMAIN=forexedge.tech IMAGE_REGISTRY="$REGISTRY" \
  IMAGE_TAG="$TAG" S3_BUCKET="$RESULTS" AWS_REGION=ap-south-1 DEMO_USERS=demo
```

Expected (names only):

```text
/opt/forexedge/infra/.env.prod (root 600):
  DOMAIN                 set
  ...
  JWT_REFRESH_SECRET     set
  ...
  GROQ_API_KEY           placeholder (set-secret.sh)
  DEMO_USERS             set
/opt/forexedge/infra/.env.demo-users (root 600):
  DEMO_DEMO_EMAIL        placeholder (set-secret.sh)
  DEMO_DEMO_PASS         placeholder (set-secret.sh)
```

A second run refuses (`exists: refusing to overwrite it`): the database will hold these passwords.

### 8.7 Secrets, typed on the host

1. **Session Manager plugin** for the AWS CLI (once): AWS's "Install the Session Manager plugin for the AWS CLI"
   page, Windows installer. Check: `session-manager-plugin` prints "The Session Manager plugin was installed
   successfully".
2. **Rotate the Groq key** right before: console.groq.com → API Keys → create a new key for production, copy it,
   and **delete the old key** (it has been on the laptop). If the laptop's `.env` still needs one for
   development, create a separate key for it.
3. In the session (the values are read without echo; nothing reaches SSM Run Command):

```sh
aws ssm start-session --target "$ID"
sudo -i
bash /opt/forexedge/current/infra/vm/set-secret.sh GROQ_API_KEY       # before the first deploy.sh:
bash /opt/forexedge/current/infra/vm/set-secret.sh DEMO_DEMO_EMAIL    # /opt/forexedge/releases/<TAG>/infra/vm/
bash /opt/forexedge/current/infra/vm/set-secret.sh DEMO_DEMO_PASS     # asked twice
exit                                                          # root
exit                                                          # the session
```

Each prints `<NAME> set in /opt/forexedge/infra/.env… (replaced the placeholder)`. Demo passwords: 12-32
characters with a lowercase and an uppercase letter, a digit and one of `@$!%*?&` (letters, digits and those
only). Keep the demo email and password in your password manager: 8.11 needs them.

### 8.8 Database: bootstrap and history

```sh
bash infra/vm/run-on-host.sh infra/vm/bootstrap.sh --timeout 7200 -- "$TAG"
```

Expected (one line per step; times are the host's):

```text
pulled ... / timescaledb, redis, kafka: healthy
  [bootstrap] migrations: ok (...)
  [bootstrap] instruments: ok (...)
  [bootstrap] history loaded failed (exit 1); stopped
bootstrap-1: stopped at the history check, as expected on an empty database
history-check: exit 1 ...
history: not loaded (or not identical): importing
  ... (the import's last lines: identical to the export, 19,187,987 minutes)
history-import: ok (...)
check-only: ok (...)
validate: ok (...)
  [bootstrap] ML login: ok ... [bootstrap] demo users: ok ... [bootstrap] done
bootstrap-2: ok (...)
bootstrap: done (logs in /opt/forexedge/logs)
```

It refuses while any secret is a placeholder, and stops at the first failing step with that step's last 20 lines
(full logs, redacted, in `/opt/forexedge/logs`). The laptop's import took 677 s; on the t3.medium it will take
longer, hence `--timeout 7200`. Run again, it skips the import (`history: already loaded and identical`).

### 8.9 Start the stack

```sh
bash infra/vm/run-on-host.sh infra/vm/stack.sh --timeout 1800 -- up "$TAG"
# ... waiting for: ...
# ready: all 9 apps answer /health/ready with 200
curl -sI https://forexedge.tech/login | head -1      # HTTP/2 200 (Caddy got its Let's Encrypt certificate)
```

`up` refuses while a secret is a placeholder, logs in to ECR with the instance role (token in a temporary
Docker config, deleted at exit) and fails, naming the apps, if any isn't ready within 3 minutes. Then
`stack.sh -- ps "$TAG"` lists the containers; `-- down "$TAG"` stops them (the volumes stay). On a fresh host
the first `up` makes the release current (`current -> <TAG> (first start)`); after that `up` accepts only the
current release's tag, and every later change of release goes through `deploy.sh` (section 10).

### 8.10 Go-live gate: the metadata guard, three times

```sh
bash infra/vm/run-on-host.sh infra/vm/check-imds-guard.sh            # 1. after up (expected output: 7.4.1)
```

2. After a Docker restart, in a Session Manager shell (`aws ssm start-session --target "$ID"`, `sudo -i`):
   `systemctl restart docker`, `exit`, `exit`; then from the laptop
   `bash infra/vm/run-on-host.sh infra/vm/stack.sh -- ready "$TAG"` (every container comes back, `restart:
   unless-stopped`) and `check-imds-guard.sh` again.
3. After a reboot: `aws ec2 reboot-instances --instance-ids "$ID"`, `aws ec2 wait instance-status-ok
   --instance-ids "$ID"`, then `stack.sh -- ready "$TAG"` and `check-imds-guard.sh` again.

Each run must end with `metadata guard: only ws-gateway reaches 169.254.169.254 (N other containers refused: n
node, 2 python)`: the Python services (no node in their images) are probed with Python's urllib.

### 8.11 Smoke test, memory, credits back

```sh
read -r VERIFY_EMAIL; read -rs VERIFY_PASSWORD; export VERIFY_EMAIL VERIFY_PASSWORD   # the demo user, kept out of history
npm run prod:smoke -- --base https://forexedge.tech
bash infra/vm/run-on-host.sh infra/vm/stack.sh -- stats "$TAG"
terraform -chdir=infra/terraform apply -var cpu_credits=standard     # 0 to add, 1 to change, 0 to destroy
```

`prod:smoke` against the deployed site runs sections 1-4 (front door, closed registration and demo login,
backtest with results from S3, replay with one order) and writes `docs/validation/prod-deploy-run.md` ending
`All checks pass.`. It doesn't measure memory there (its Docker is the laptop's): `stack.sh -- stats` prints the
host's `docker stats`, Redis `used_memory` and `free -m` (budget: the stack under 3.5 GB while a replay plays,
as in section 5). Then standard credits again (unlimited bills surplus credits); expect
`forexedge-cpu-credits-low` for a few hours after the switch (7.3).

## 9. Pause and resume

Between demos the host can be stopped: compute stops billing, and everything that matters stays (the root volume
with the database and the history, the Elastic IP and so the DNS records, the instance id, the env files under
`/opt/forexedge`). `instance_state` (`running` by default, or `stopped`; anything else fails validation)
drives `aws_ec2_instance_state` in `ec2.tf`. A stop is a clean shutdown (`force = false`): Docker stops every
container, so Postgres and Kafka close their files.

```sh
terraform -chdir=infra/terraform apply -var instance_state=stopped   # pause: 0 to add, 1 to change, 0 to destroy
terraform -chdir=infra/terraform apply -var instance_state=running   # resume: the same, back
```

**While paused, every `terraform apply` needs `-var instance_state=stopped`** (or the value in
`terraform.tfvars`): an apply without it starts the host again (the default is `running`).

**Cost while stopped (about $8/month):** the Elastic IP (AWS bills every public IPv4 address by the hour, attached
or not), the 40 GB gp3 root volume and its 7 daily snapshots, ECR storage (the last 5 tags of each of the ten
images) and S3 (results, backups for 14 days). These are rough figures: check Cost Explorer after the first month.
No instance hours, no CPU credit charges.

**After a start:**

1. The stack comes back by itself: Docker starts at boot, the metadata guard runs before it (7.4.1), and every
   container has `restart: unless-stopped`. Caddy keeps its certificate (volume `caddy_data`).
2. Check it like after a reboot (8.10), with the running tag (`IMAGE_TAG` in `.env.prod`; `stack.sh -- ps`
   shows it in the images):

   ```sh
   bash infra/vm/run-on-host.sh infra/vm/stack.sh -- ready "$TAG"     # ready: all 9 apps ...
   bash infra/vm/run-on-host.sh infra/vm/check-imds-guard.sh         # metadata guard: only ws-gateway ...
   ```

3. **Alarms to expect:** while stopped, the alarms have no data and sit in INSUFFICIENT_DATA without paging
   (`treat_missing_data = "missing"`). After the start each one sends an OK email as its metric returns
   (status check, CPU, memory, disk). `forexedge-cpu-credits-low` can fire: a t3 in standard mode keeps
   the credits it earned for 7 days after a stop and gets no launch credits, so after a longer pause it starts
   from 0 and earns 24 an hour (it clears itself, as in 7.3). If the start was for heavy work (a new import),
   switch to unlimited credits first (7.5).

## 10. CI/CD (Phase 4)

Every pull request to `main` is checked by `ci.yml`; every merge into `main` is built and deployed by
`deploy.yml`. Nothing secret is in either workflow, their logs, the SSM parameters or the SSM output: AWS is
reached through OIDC (the role trusts `main` only), the four values below are repository variables, and the
host scripts redact every secret of the env files from what they print.

```text
pull request ─▶ ci.yml (job `ci`, required to merge)
                  nx affected lint/typecheck/test/build · Python projects if affected · npm run infra:check
merge to main ─▶ deploy.yml
                  build   build-images.yml: the ten images, tagged with the commit, pushed to ECR
                  deploy  stage.sh <sha> --bucket ...       compose file, Caddyfile, host scripts → s3://<backups>/transfer/<UTC>/
                          run-on-host.sh fetch.sh           → /opt/forexedge/releases/<sha>/ (sha256 checked)
                          run-on-host.sh deploy.sh <sha>    backup → migrations → switch → ready, or rollback
```

A merge that changes only `docs/**` or Markdown files deploys nothing (`paths-ignore`). Actions → deploy →
Run workflow deploys `main`'s HEAD whatever changed.

### 10.1 Before the first merge (once)

1. **Terraform** (the deploy role may now write `transfer/` of the backups bucket, for `stage.sh`):

   ```sh
   terraform -chdir=infra/terraform plan     # 0 to add, 1 to change, 0 to destroy
   terraform -chdir=infra/terraform apply
   ```

   The one change is `aws_iam_role_policy.github_deploy` updated in place: a new statement `StageConfig`,
   `s3:PutObject` on `arn:aws:s3:::forexedge-backups-<account>/transfer/*`. If the plan shows anything else,
   stop. (While the host is paused, add `-var instance_state=stopped`, section 9.)

2. **Two more repository variables** (GitHub → the repository → Settings → Secrets and variables → Actions →
   the **Variables** tab → New repository variable; not Secrets: neither value is secret):

   ```sh
   gh variable set AWS_INSTANCE_ID --body "$(terraform -chdir=infra/terraform output -raw instance_id)"
   gh variable set AWS_BACKUPS_BUCKET --body "$(terraform -chdir=infra/terraform output -raw backups_bucket)"
   gh variable list        # AWS_BACKUPS_BUCKET, AWS_DEPLOY_ROLE_ARN, AWS_INSTANCE_ID, AWS_REGION
   ```

3. **Branch protection for `main`**, after `ci` has run once (open the Phase 4 pull request first: GitHub only
   offers a status check it has seen). GitHub → the repository → **Settings** → **Branches** → **Add classic
   branch protection rule**:
   - **Branch name pattern:** `main`
   - Tick **Require a pull request before merging**. Under it, untick **Require approvals** (you are the only
     reviewer and can't approve your own pull request).
   - Tick **Require status checks to pass before merging**, then **Require branches to be up to date before
     merging**. In **Search for status checks**, type `ci` and pick the check named **ci** (GitHub Actions).
   - Tick **Do not allow bypassing the above settings** (this is the "include administrators" setting: the
     rules apply to you too).
   - Leave the rest as it is (force pushes and deletions stay blocked) → **Create**.

   Check: a pull request shows "Required" next to `ci`, and the merge button stays grey until it passes.

### 10.2 How a deploy works (`infra/vm/deploy.sh`)

On the host, as root, through `run-on-host.sh` (deploy.yml, or by hand from the laptop with the same
arguments):

```sh
bash infra/vm/run-on-host.sh infra/vm/deploy.sh --timeout 1800 -- "$TAG" "$BACKUPS" [--simulate-failure]
```

1. **Adopt (first run only).** The Phase 3 layout (compose file, Caddyfile and scripts in
   `/opt/forexedge/infra`, `staged-commit`) becomes `releases/<that tag>` and `current`, if its commit is
   `IMAGE_TAG` in `.env.prod` and every running app image has that tag. Files are copied; no container is
   started, stopped or recreated. Anything inconsistent: refused, nothing changed.
2. **Refuse** unless `releases/<TAG>/release` (from `fetch.sh`) records commit `<TAG>`.
3. **Backup.** `pg_dump` of the app tables (the ordinary tables of `public`, without `historical_*` and without
   hypertables; the continuous aggregates are views and aren't dumped), run inside the database container,
   gzip, `s3://<backups>/predeploy/<UTC>-<TAG>.sql.gz` with the host's instance role. The dump is
   self-contained: a header line, then what `pg_dump -t` leaves out but the tables need (the extensions of
   their column types and defaults, e.g. `uuid-ossp`; their enum types and domains, read from the live
   catalog; each type created only if missing), then pg_dump's output. It prints the size and the table names,
   never the content. The backups bucket keeps every object 14 days.
4. **Migrations.** `bootstrap.sh <TAG> --deploy` from the new release: pulls the new ops image and runs
   `bootstrap-prod.ts` once with `--no-deps` (migrations, instruments, the DB logins, the demo users) while the
   old release still serves. That is why migrations must be backward compatible (below).
5. **Switch.** `current` → `releases/<TAG>`; `docker compose up -d --remove-orphans` with that release's
   compose file (by its real path, so a changed Caddyfile recreates Caddy); every app ready within 3 minutes.
6. **Rollback** if `up` fails or an app isn't ready: `current` back to the previous release, `up` with the
   previous release's own compose file and tag, ready check.
7. **Success:** `IMAGE_TAG` in `.env.prod` set to the tag, a line in `/opt/forexedge/deploys.log`, the Phase 3
   copies deleted once no container mounts them, the newest 5 releases kept (always `current` and the previous
   one; the local images of the others removed; ECR also keeps 5 tags per image).

Exit codes and the job summary (Actions → the run → Summary: tag, previous tag, result):

| Exit | `deploy-result` | Meaning |
|---|---|---|
| 0 | `deployed` | the new release runs |
| 1 | (none) | refused, or failed before the switch (backup, migrations): the old release still runs, nothing changed |
| 3 | `rolled-back` | the new release failed; the previous one runs again |
| 4 | `rollback-failed` | **ROLLBACK FAILED**: the previous release isn't ready either. Nothing more is tried: 10.5 |
| run-on-host 3 | (none) | "host paused (instance_state=stopped) or not registered in SSM": resume it (section 9), then Run workflow |

GitHub emails you when a run fails (your notification settings → Actions: "Send notifications for failed
workflows only"). That email is the alert.

**Migrations roll forward only.** A rollback restores code and config, never the schema: the previous release
runs against the schema the new release's migrations left. Every migration must therefore work with the
release before it (expand, then contract in a later release: add a nullable column now, drop the old one only
once no running release reads it). The pre-deploy dump (10.4) is the way back for data.

### 10.3 Rollback drill

GitHub → the repository → **Actions** → **deploy** (left) → **Run workflow** (right) → Branch: `main` → tick
**simulate_failure** → **Run workflow**.

It builds (`already pushed` for every image if `main` was deployed already), stages, fetches and runs
`deploy.sh … --simulate-failure`: the release really goes up, its ready check counts as failed, and the
previous release comes back. Success looks like this:

- the run ends **red** (the deploy job fails on purpose; you get the failure email)
- the summary row: `<TAG> | <previous> | rolled back to the previous release`, and "Rollback drill"
- the deploy step's log, after `--- stdout`: `simulated failure (--simulate-failure)`, `current -> <previous>`,
  `ready: all 9 apps answer /health/ready with 200`, `rolled back to <previous>`, `deploy-result: rolled-back`
- the site answers throughout, except for the seconds the containers are recreated:
  `curl -sI https://forexedge.tech/login | head -1` → `HTTP/2 200`

When `main` is already deployed, `<TAG>` and `<previous>` are the same commit: the drill still exercises
the failure detection, the switch back, `up` with the previous release's config and the ready check (the host
tests cover a rollback between two different releases). Afterwards, `deploys.log` has a `rolled back` line.

### 10.4 Restore a pre-deploy dump

The dump holds user data (emails, password hashes): restore it in a Session Manager shell, never through
`run-on-host.sh` (SSM keeps its output). The table list is in the deploy's log line `backup: … tables: …`.

```sh
aws s3 ls "s3://$BACKUPS/predeploy/"                           # laptop: the dumps of the last 14 days
aws ssm start-session --target "$ID"
sudo -i
F=20261111T120000Z-<TAG>.sql.gz                                 # the one to restore
aws s3 cp "s3://<backups bucket>/predeploy/$F" "/root/$F"
dc() { docker compose -p forexedge -f "$(readlink -f /opt/forexedge/current)/infra/docker-compose.prod.yml" \
  --env-file /opt/forexedge/infra/.env.prod "$@"; }
```

1. **Look first, in a scratch database** (the live one is untouched): from the laptop,
   `bash infra/vm/run-on-host.sh infra/vm/restore-test.sh --timeout 900 -- "$BACKUPS" predeploy/$F` restores
   that dump into an empty scratch database, prints its tables with restored and live row counts, and drops
   it again (section 7.6). The dump carries its own extensions and enum types (section 10.2, step 3); one made
   before that (no header line) is refused as not self-contained: it would fail in an empty database
   (`ERROR: type "public.instruments_type_enum" does not exist`). The full undo below works with either kind:
   the live database already has the types, and a self-contained dump creates only the missing ones.

2. **Full undo** (everything written since the dump is lost): stop the apps, keep the database, replace the
   app tables in one transaction, then start the release:

   ```sh
   dc stop auth-service market-service domain-service order-service ws-gateway replay-service ml-service research-agent frontend
   { echo 'DROP TABLE <the tables of the backup line, each as public.name, comma separated> CASCADE;'; gunzip -c "/root/$F"; } |
     dc exec -T timescaledb sh -c 'psql -X -q -1 -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
   rm "/root/$F"
   exit; exit
   bash infra/vm/run-on-host.sh infra/vm/stack.sh --timeout 1800 -- up "<current tag>"     # laptop
   ```

   `-1` makes it all or nothing. The dump includes the `migrations` table, so the schema goes back to what it
   was before that deploy: run it with the release that was running then. After a rollback that is the
   current release. After a successful deploy, the new code expects the new schema, so first revert the merge
   on `main` and let it deploy (that deploy makes its own, newer dump: restore the older one), then restore.
   Not rehearsed against production yet; rehearse it on the laptop stack (section 5) before you need it.

### 10.5 If the rollback fails (exit 4)

Nothing more happens automatically; `current` points to the previous release. From the laptop:

```sh
bash infra/vm/run-on-host.sh infra/vm/stack.sh -- ps "<previous>"      # which containers are down
bash infra/vm/run-on-host.sh infra/vm/stack.sh -- ready "<previous>"   # which apps answer, with their status
```

Then fix the cause (a migration the old code can't read: restore the dump, 10.4; a host problem: memory,
disk, Docker) and `stack.sh -- up "<previous>"`.

### 10.6 Actions minutes

The repository is private: GitHub Pro includes 3,000 Linux minutes a month (Settings → Billing and plans →
Usage shows what is used). Per merge into `main`: the ten build jobs (billed separately, each rounded up to a
minute) plus the deploy job; per pull request push: the `ci` job. A docs-only merge costs nothing.

Measured on the runs of 2026-11-11 (job times from `gh run view <id> --json jobs --jq '.jobs[] | [.name,
.startedAt, .completedAt]'`; billed = each job rounded up to a minute, so the figures are estimates within a
minute per job; Usage in the billing settings is authoritative):

| Run | Jobs | Job time | Billed (est.) | Wall clock |
|---|---|---|---|---|
| `deploy`, merge of PR #14 (43007213642) | 10 builds + deploy | 26.9 min (deploy job 2.0) | 32 min | 5.8 min |
| `deploy`, merge of PR #15 (43020186369) | 10 builds + deploy | 28.4 min (deploy job 2.2) | 32 min | 6.5 min |
| `deploy` rollback drill, `simulate_failure` (43008463819), a commit already built | 10 builds + deploy | 13.8 min (deploy job 1.5) | 19 min | 4.0 min |
| `ci`, pull request (43005672594, 43019690386) | ci | 2.4–2.9 min | 3 min | 2.5–2.9 min |
| `build-images` by hand (42974576157) | 10 builds | 28.5 min | 34 min | 4.4 min |

So a merge into `main` costs about 32 billed minutes and a pull request push about 3: the 3,000 included
minutes cover roughly 85 merges a month, each with one pull request push. The ops image is the slowest
build (3.6–4.2 min); research-agent the fastest (1–1.6 min). A rebuild of a commit whose images exist
(the drill) costs about 60% as much.
