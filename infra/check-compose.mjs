// Checks the production compose file's rules on the resolved configuration (`docker compose config`):
//   - only caddy publishes ports (80 and 443)
//   - every long-running service: an exact image tag (not latest), a memory limit, a healthcheck,
//     restart unless-stopped, json-file logs rotated at 3 x 10 MB
//   - no service runs Prometheus, Grafana or MinIO, and nothing mounts Bull Board (BULL_BOARD_* unset)
// Fails on an empty or partial service list (an empty check proves nothing).
//
//   node infra/check-compose.mjs [compose files...]     (default: infra/docker-compose.prod.yml)
// Needs the variables the file requires: run with --env-file, or the script sets placeholders.
import { execFileSync } from 'node:child_process';

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['infra/docker-compose.prod.yml'];
const placeholders = Object.fromEntries(['DOMAIN', 'DB_NAME', 'DB_USER', 'DB_PASS', 'REDIS_PASS', 'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET', 'REPLAY_DB_USER', 'REPLAY_DB_PASS', 'ML_DB_USER', 'ML_DB_PASS', 'RESEARCH_DB_USER',
  'RESEARCH_DB_PASS', 'MINIO_USER', 'MINIO_PASS'].map((k) => [k, process.env[k] ?? `check-${k.toLowerCase()}`]));
const json = execFileSync('docker', ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'],
  { env: { ...process.env, ...placeholders }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const services = JSON.parse(json).services ?? {};

const EXPECTED = ['timescaledb', 'redis', 'kafka', 'auth-service', 'market-service', 'domain-service', 'order-service',
  'ws-gateway', 'replay-service', 'ml-service', 'research-agent', 'frontend', 'caddy'];
const problems = [];
for (const name of EXPECTED) if (!services[name]) problems.push(`${name}: missing`);

for (const [name, s] of Object.entries(services)) {
  const oneOff = (s.profiles ?? []).length > 0; // ops: docker compose run only
  if (name === 'caddy') {
    const published = (s.ports ?? []).map((p) => `${p.published}/${p.protocol ?? 'tcp'}`).sort();
    if (published.join(',') !== '443/tcp,443/udp,80/tcp') problems.push(`caddy publishes ${published.join(', ') || 'nothing'}`);
  } else if ((s.ports ?? []).length > 0) {
    problems.push(`${name} publishes ports ${JSON.stringify(s.ports)}`);
  }
  if (/prometheus|grafana/i.test(s.image ?? '')) problems.push(`${name}: ${s.image} is not part of production`);
  if (/minio/i.test(s.image ?? '') && files.length === 1) problems.push(`${name}: MinIO is not part of production`);
  for (const key of Object.keys(s.environment ?? {})) {
    if (/^BULL_BOARD_/.test(key)) problems.push(`${name}: ${key} would mount Bull Board`);
  }
  if (oneOff) continue;
  if (!s.image || /:latest$|^[^:]+$/.test(s.image.replace(/^[^/]*\/\//, ''))) problems.push(`${name}: image "${s.image}" has no exact tag`);
  if (!s.mem_limit) problems.push(`${name}: no memory limit`);
  if (!s.healthcheck || s.healthcheck.disable) problems.push(`${name}: no healthcheck`);
  if (s.restart !== 'unless-stopped') problems.push(`${name}: restart is ${s.restart ?? 'unset'}`);
  const log = s.logging ?? {};
  if (log.driver !== 'json-file' || log.options?.['max-size'] !== '10m' || String(log.options?.['max-file']) !== '3') {
    problems.push(`${name}: logs not rotated at 3 x 10m`);
  }
}

const count = Object.keys(services).length;
if (problems.length) {
  console.error(`Compose check failed (${count} services):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Compose check: ${count} services; only caddy publishes ports; every service limited, health-checked, restarted, rotated`);
