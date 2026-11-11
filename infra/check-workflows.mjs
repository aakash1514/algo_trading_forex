// Checks the GitHub Actions workflows (npm run infra:check; actionlint runs separately in check.sh):
//   - every `uses:` is pinned to a full 40-character commit SHA (a tag can be moved to other code)
//   - no workflow reads `secrets.` (the deploy role comes from OIDC; its ARN and the region are variables)
//   - every job has timeout-minutes
//   - build-images.yml: workflow_dispatch only, permissions exactly id-token: write + contents: read, one
//     concurrency group that never cancels, the job runs only on refs/heads/main, and its matrix equals the
//     images of infra/docker-compose.prod.yml with the same dockerfile, target and build args
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

// ── build-images.yml ─────────────────────────────────────────────────────────
const build = workflows['build-images.yml'];
if (!build) {
  problems.push('build-images.yml: missing');
} else {
  const f = 'build-images.yml';
  const triggers = typeof build.on === 'string' ? [build.on] : Object.keys(build.on ?? {});
  if (triggers.join(',') !== 'workflow_dispatch') problems.push(`${f}: triggers are ${triggers.join(', ')}; workflow_dispatch only`);
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
    if (String(job.if ?? '').trim() !== "github.ref == 'refs/heads/main'") {
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
