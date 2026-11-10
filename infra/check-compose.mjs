// Checks the production compose file's rules on the resolved configuration (`docker compose config`):
//   - only caddy publishes ports (80 and 443)
//   - every long-running service: an exact image tag (not latest), a memory limit, a healthcheck,
//     restart unless-stopped, json-file logs rotated at 3 x 10 MB
//   - no service runs Prometheus, Grafana or MinIO, and nothing mounts Bull Board (BULL_BOARD_* unset)
//   - one bridge network (forexedge_default) whose bridge name, subnet and ws-gateway's fixed address are
//     those of the host's metadata guard (infra/vm/setup.sh); no other fixed address, no network_mode
// Fails on an empty or partial service list (an empty check proves nothing).
//
//   node infra/check-compose.mjs [compose files...]     (default: infra/docker-compose.prod.yml)
// Needs the variables the file requires: run with --env-file, or the script sets placeholders.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['infra/docker-compose.prod.yml'];
const placeholders = Object.fromEntries(['DOMAIN', 'DB_NAME', 'DB_USER', 'DB_PASS', 'REDIS_PASS', 'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET', 'REPLAY_DB_USER', 'REPLAY_DB_PASS', 'ML_DB_USER', 'ML_DB_PASS', 'RESEARCH_DB_USER',
  'RESEARCH_DB_PASS', 'MINIO_USER', 'MINIO_PASS'].map((k) => [k, process.env[k] ?? `check-${k.toLowerCase()}`]));
const json = execFileSync('docker', ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'],
  { env: { ...process.env, ...placeholders }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const config = JSON.parse(json);
const services = config.services ?? {};

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

// ── The metadata guard's network: only ws-gateway's fixed address may reach 169.254.169.254 ──
const setup = readFileSync(new URL('./vm/setup.sh', import.meta.url), 'utf8');
const guardValue = (name) => setup.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
const guardBridge = guardValue('IMDS_GUARD_BRIDGE');
const guardIp = guardValue('IMDS_GUARD_WS_GATEWAY_IP');
const toInt = (ip) => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
const inCidr = (ip, cidr) => {
  const [base, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  return Math.floor(toInt(ip) / size) === Math.floor(toInt(base) / size);
};
const net = config.networks?.default ?? {};
const ipam = net.ipam?.config ?? [];
if (!guardBridge || !guardIp) problems.push('infra/vm/setup.sh: IMDS_GUARD_BRIDGE or IMDS_GUARD_WS_GATEWAY_IP not found');
if (Object.keys(config.networks ?? {}).join(',') !== 'default') problems.push(`networks: ${Object.keys(config.networks ?? {}).join(', ')} (only default)`);
if (net.name !== 'forexedge_default') problems.push(`default network is named ${net.name}, expected forexedge_default`);
if (net.driver_opts?.['com.docker.network.bridge.name'] !== guardBridge) {
  problems.push(`bridge name ${net.driver_opts?.['com.docker.network.bridge.name']} differs from the guard's ${guardBridge}`);
}
if (ipam.length !== 1 || !ipam[0].subnet || !ipam[0].ip_range) {
  problems.push('default network needs exactly one ipam config with subnet and ip_range');
} else if (guardIp && (!inCidr(guardIp, ipam[0].subnet) || inCidr(guardIp, ipam[0].ip_range))) {
  problems.push(`${guardIp} must be inside ${ipam[0].subnet} and outside the dynamic range ${ipam[0].ip_range}`);
}
for (const [name, s] of Object.entries(services)) {
  if (s.network_mode) problems.push(`${name}: network_mode ${s.network_mode} (would bypass the metadata guard)`);
  const nets = s.networks ?? {};
  if (Object.keys(nets).join(',') !== 'default') problems.push(`${name}: networks ${Object.keys(nets).join(', ') || 'none'} (only default)`);
  const fixed = nets.default?.ipv4_address;
  if (name === 'ws-gateway' ? fixed !== guardIp : fixed) {
    problems.push(`${name}: ipv4_address ${fixed ?? 'unset'}${name === 'ws-gateway' ? `, the guard admits ${guardIp}` : ' (only ws-gateway has a fixed address)'}`);
  }
}

const count = Object.keys(services).length;
if (problems.length) {
  console.error(`Compose check failed (${count} services):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Compose check: ${count} services; only caddy publishes ports; every service limited, health-checked, restarted, rotated; ws-gateway alone at the guard's ${guardIp} on ${guardBridge}`);
