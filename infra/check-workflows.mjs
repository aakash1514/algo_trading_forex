// Checks the GitHub Actions workflows (npm run infra:check; actionlint runs separately in check.sh):
//   - every `uses:` is pinned to a full 40-character commit SHA (a tag can be moved to other code)
//   - no workflow reads `secrets.` (the deploy role comes from OIDC; its ARN and the region are variables)
//   - every job has timeout-minutes
//   - no workflow is triggered by pull_request_target (it runs a pull request with the base's permissions)
//   - id-token: write appears only where OIDC_WORKFLOWS allows it (top level or job level)
//   - ci.yml: pull_request to main only, permissions exactly contents: read, no id-token, exactly one job
//     named `ci` (branch protection requires that check by name) with timeout-minutes, a concurrency group
//     that cancels; .nvmrc (the Node of CI) equals the images' Node in infra/docker/node.Dockerfile
//   - build-images.yml: workflow_call (deploy.yml) and workflow_dispatch only, permissions exactly id-token:
//     write + contents: read, one concurrency group that never cancels, the job runs only on refs/heads/main,
//     and its matrix equals the images of infra/docker-compose.prod.yml with the same dockerfile, target and
//     build args
//   - deploy.yml: push to main (paths-ignore exactly docs/** and **/*.md) and workflow_dispatch (one boolean
//     input simulate_failure, default false) only, permissions exactly id-token: write + contents: read, one
//     concurrency group that never cancels, every job only on refs/heads/main, build = the local
//     build-images.yml, deploy needs build
// Fails on an empty comparison (no workflow, no `uses:`, no matrix entry).
//
//   node infra/check-workflows.mjs
// The YAML is read with yq from an image pinned by digest (no YAML parser among the repo's dependencies),
// and the compose builds with `docker compose config`, so Docker must be running.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const YQ_IMAGE = 'mikefarah/yq:4.54.1@sha256:4b3d9475d65571d28cbb19544d3820ec2945e4c8b2f18279394282b8dc3a592e';
const REPO = resolve(import.meta.dirname, '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const COMPOSE = join(REPO, 'infra', 'docker-compose.prod.yml');
// The only workflows that may request GitHub's OIDC token (and so assume the deploy role)
const OIDC_WORKFLOWS = ['build-images.yml', 'deploy.yml'];
const MAIN_ONLY = "github.ref == 'refs/heads/main'";

const problems = [];

function yamlToJson(text) {
  const out = execFileSync('docker', ['run', '--rm', '-i', YQ_IMAGE, '-o=json'], { input: text, encoding: 'utf8' });
  return JSON.parse(out);
}

const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
if (files.length === 0) problems.push('no workflow in .github/workflows');

let usesChecked = 0;
const workflows = {};
for (const file of files) {
  const text = readFileSync(join(WORKFLOWS, file), 'utf8');
  const wf = yamlToJson(text);
  workflows[file] = wf;
  if (/\bsecrets\./.test(text)) problems.push(`${file}: reads secrets.* (use OIDC and repository variables)`);
  if (triggersOf(wf).includes('pull_request_target')) problems.push(`${file}: triggered by pull_request_target`);
  const idToken = [wf.permissions, ...Object.values(wf.jobs ?? {}).map((j) => j.permissions)]
    .some((p) => p === 'write-all' || (p && typeof p === 'object' && p['id-token'] === 'write'));
  if (idToken && !OIDC_WORKFLOWS.includes(file)) problems.push(`${file}: requests id-token: write (only ${OIDC_WORKFLOWS.join(', ')} may)`);
  for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
    const where = `${file} job ${jobName}`;
    if (job.uses !== undefined) {
      checkUses(where, job.uses);
    } else if (!Number.isInteger(job['timeout-minutes'])) {
      problems.push(`${where}: no timeout-minutes`);
    }
    for (const [i, step] of (job.steps ?? []).entries()) {
      if (step.uses !== undefined) checkUses(`${where} step ${step.name ?? step.id ?? i + 1}`, step.uses);
    }
  }
}
if (files.length > 0 && usesChecked === 0) problems.push('no `uses:` found in any workflow');

function checkUses(where, uses) {
  usesChecked++;
  if (uses.startsWith('./')) return; // a local action is the repository's own code at this commit
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/.test(uses)) {
    problems.push(`${where}: ${uses} is not pinned to a full commit SHA`);
  }
}

function triggersOf(wf) {
  if (typeof wf.on === 'string') return [wf.on];
  if (Array.isArray(wf.on)) return wf.on;
  return Object.keys(wf.on ?? {});
}

// ── ci.yml ───────────────────────────────────────────────────────────────────
const ci = workflows['ci.yml'];
if (!ci) {
  problems.push('ci.yml: missing');
} else {
  const f = 'ci.yml';
  const triggers = triggersOf(ci);
  if (triggers.join(',') !== 'pull_request') problems.push(`${f}: triggers are ${triggers.join(', ')}; pull_request only`);
  const branches = ci.on?.pull_request?.branches ?? [];
  if (JSON.stringify(branches) !== '["main"]') problems.push(`${f}: pull_request branches are ${JSON.stringify(branches)}; exactly [main]`);
  if (JSON.stringify(ci.permissions ?? {}) !== JSON.stringify({ contents: 'read' })) {
    problems.push(`${f}: permissions are ${JSON.stringify(ci.permissions ?? {})}; exactly contents: read`);
  }
  if (!ci.concurrency?.group || ci.concurrency['cancel-in-progress'] !== true) {
    problems.push(`${f}: needs a concurrency group with cancel-in-progress: true`);
  }
  const jobs = Object.keys(ci.jobs ?? {});
  if (jobs.join(',') !== 'ci') problems.push(`${f}: jobs are ${jobs.join(', ') || 'none'}; exactly one, named ci (the required status check)`);
  const job = ci.jobs?.ci;
  if (job && (job.name ?? 'ci') !== 'ci') problems.push(`${f} job ci: name is ${job.name}; the required status check is ci`);
  if (job?.permissions !== undefined) problems.push(`${f} job ci: sets its own permissions`);
}

// .nvmrc (CI's Node) = the Node of the images
const nvmrc = readFileSync(join(REPO, '.nvmrc'), 'utf8').trim();
const imageNode = /^ARG NODE_IMAGE=node:(\d+\.\d+\.\d+)-/m.exec(readFileSync(join(REPO, 'infra', 'docker', 'node.Dockerfile'), 'utf8'))?.[1];
if (!imageNode || nvmrc !== imageNode) problems.push(`.nvmrc is ${nvmrc || 'empty'}, infra/docker/node.Dockerfile has node ${imageNode ?? '(not found)'}`);

// ── build-images.yml ─────────────────────────────────────────────────────────
const build = workflows['build-images.yml'];
if (!build) {
  problems.push('build-images.yml: missing');
} else {
  const f = 'build-images.yml';
  const triggers = triggersOf(build);
  if ([...triggers].sort().join(',') !== 'workflow_call,workflow_dispatch') {
    problems.push(`${f}: triggers are ${triggers.join(', ')}; workflow_call and workflow_dispatch only`);
  }
  if (build.on?.workflow_call && Object.keys(build.on.workflow_call).length > 0) {
    problems.push(`${f}: workflow_call takes no inputs, secrets or outputs`);
  }
  const perms = build.permissions ?? {};
  if (JSON.stringify(sortKeys(perms)) !== JSON.stringify({ contents: 'read', 'id-token': 'write' })) {
    problems.push(`${f}: permissions are ${JSON.stringify(perms)}; exactly id-token: write, contents: read`);
  }
  if (!build.concurrency?.group || build.concurrency['cancel-in-progress'] !== false) {
    problems.push(`${f}: needs a concurrency group with cancel-in-progress: false`);
  }
  const jobs = Object.entries(build.jobs ?? {});
  if (jobs.length === 0) problems.push(`${f}: no job`);
  for (const [name, job] of jobs) {
    if (job.permissions !== undefined) problems.push(`${f} job ${name}: sets its own permissions`);
    if (String(job.if ?? '').trim() !== MAIN_ONLY) {
      problems.push(`${f} job ${name}: must run only if github.ref == 'refs/heads/main'`);
    }
  }
  const matrix = build.jobs?.build?.strategy?.matrix?.include ?? [];
  const fromWorkflow = Object.fromEntries(matrix.map((m) => [m.image, {
    dockerfile: m.dockerfile,
    target: m.target ?? '',
    args: Object.fromEntries(String(m['build-args'] ?? '').split('\n').filter(Boolean).map((a) => a.split(/=(.*)/s).slice(0, 2))),
  }]));
  if (matrix.length !== Object.keys(fromWorkflow).length) problems.push(`${f}: an image appears twice in the matrix`);
  const fromCompose = composeBuilds();
  compare(`${f} matrix`, fromWorkflow, fromCompose);
}

// ── deploy.yml ───────────────────────────────────────────────────────────────
const deploy = workflows['deploy.yml'];
if (!deploy) {
  problems.push('deploy.yml: missing');
} else {
  const f = 'deploy.yml';
  const triggers = triggersOf(deploy);
  if ([...triggers].sort().join(',') !== 'push,workflow_dispatch') problems.push(`${f}: triggers are ${triggers.join(', ')}; push and workflow_dispatch only`);
  const push = deploy.on?.push ?? {};
  if (JSON.stringify(push.branches ?? []) !== '["main"]') problems.push(`${f}: push branches are ${JSON.stringify(push.branches ?? [])}; exactly [main]`);
  if (push.tags !== undefined || push.paths !== undefined || push['branches-ignore'] !== undefined) {
    problems.push(`${f}: push may set only branches and paths-ignore`);
  }
  const ignored = [...(push['paths-ignore'] ?? [])].sort();
  if (JSON.stringify(ignored) !== JSON.stringify(['**/*.md', 'docs/**'])) {
    problems.push(`${f}: push paths-ignore is ${JSON.stringify(push['paths-ignore'] ?? [])}; exactly docs/** and **/*.md (a docs-only merge deploys nothing, anything else deploys)`);
  }
  const inputs = deploy.on?.workflow_dispatch?.inputs ?? {};
  const drill = inputs.simulate_failure;
  if (Object.keys(inputs).join(',') !== 'simulate_failure' || drill?.type !== 'boolean' || drill?.default !== false) {
    problems.push(`${f}: workflow_dispatch needs exactly one input, simulate_failure, boolean, default false`);
  }
  if (JSON.stringify(sortKeys(deploy.permissions ?? {})) !== JSON.stringify({ contents: 'read', 'id-token': 'write' })) {
    problems.push(`${f}: permissions are ${JSON.stringify(deploy.permissions ?? {})}; exactly id-token: write, contents: read`);
  }
  if (!deploy.concurrency?.group || deploy.concurrency['cancel-in-progress'] !== false) {
    problems.push(`${f}: needs a concurrency group with cancel-in-progress: false (a cancelled deploy could stop mid-switch)`);
  }
  const jobs = deploy.jobs ?? {};
  if (Object.keys(jobs).sort().join(',') !== 'build,deploy') problems.push(`${f}: jobs are ${Object.keys(jobs).join(', ')}; exactly build and deploy`);
  for (const [name, job] of Object.entries(jobs)) {
    if (String(job.if ?? '').trim() !== MAIN_ONLY) problems.push(`${f} job ${name}: must run only if ${MAIN_ONLY}`);
    if (job.permissions !== undefined) problems.push(`${f} job ${name}: sets its own permissions`);
    if (job.secrets !== undefined) problems.push(`${f} job ${name}: passes secrets`);
  }
  if (jobs.build && jobs.build.uses !== './.github/workflows/build-images.yml') {
    problems.push(`${f} job build: must be uses: ./.github/workflows/build-images.yml`);
  }
  if (jobs.deploy && JSON.stringify([jobs.deploy.needs].flat()) !== '["build"]') problems.push(`${f} job deploy: must need build`);
}

// The images built from this repository, as `docker compose config` resolves them (ops included)
function composeBuilds() {
  const text = readFileSync(COMPOSE, 'utf8');
  const required = [...new Set([...text.matchAll(/\$\{([A-Z0-9_]+):\?\}/g)].map((m) => m[1]))];
  const env = { ...process.env, ...Object.fromEntries(required.map((k) => [k, process.env[k] ?? `check-${k.toLowerCase()}`])) };
  const json = execFileSync('docker', ['compose', '-f', COMPOSE, '--profile', 'ops', 'config', '--format', 'json'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const builds = {};
  for (const [name, s] of Object.entries(JSON.parse(json).services ?? {})) {
    if (!s.build) continue;
    const image = /^[^/]+\/([a-z0-9-]+):/.exec(s.image ?? '')?.[1];
    if (image !== name) problems.push(`compose ${name}: image ${s.image} is not <registry>/${name}:<tag>`);
    if (relative(REPO, resolve(s.build.context)) !== '') problems.push(`compose ${name}: build context is not the repository root`);
    builds[name] = { dockerfile: s.build.dockerfile, target: s.build.target ?? '', args: s.build.args ?? {} };
  }
  return builds;
}

function compare(where, actual, expected) {
  const names = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  let compared = 0;
  for (const name of names) {
    if (!(name in expected)) { problems.push(`${where}: ${name} is not a compose image`); continue; }
    if (!(name in actual)) { problems.push(`${where}: ${name} is missing`); continue; }
    const a = JSON.stringify(sortKeys(actual[name]));
    const e = JSON.stringify(sortKeys(expected[name]));
    if (a !== e) problems.push(`${where}: ${name} is ${a}, compose has ${e}`);
    compared++;
  }
  if (compared === 0) problems.push(`${where}: no image compared`);
  return compared;
}

function sortKeys(v) {
  if (Array.isArray(v) || v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}

if (problems.length) {
  console.error(problems.map((p) => `  - ${p}`).join('\n'));
  console.error(`check-workflows: ${problems.length} problem(s)`);
  process.exit(1);
}
const images = Object.keys(workflows['build-images.yml'].jobs.build.strategy.matrix.include).length;
console.log(`check-workflows: ${files.length} workflow(s), ${usesChecked} uses pinned to a SHA, ${images} images = compose`);
