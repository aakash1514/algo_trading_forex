// Fails if a production build of the frontend could reach a fixed backend address: every API and
// socket call must go to the page's own origin (Caddy routes them), so no localhost / 127.0.0.1
// address with one of ForexEdge's ports (the services 3000-3008, the frontend 4200, MinIO 9000) may
// appear in what the browser or the server runs, and the build must carry no rewrites (those are
// `next dev` only). The bare word "localhost" is allowed: libraries contain it (socket.io-client's
// URL parser, Next's own server). Scans .next/static (browser code) and .next/server (server code).
//
//   node apps/frontend/scripts/check-production-build.cjs [dist/apps/frontend/.next]
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] ?? 'dist/apps/frontend/.next');
const FORBIDDEN = /(localhost|127\.0\.0\.1):(300[0-9]|4200|9000)\b/;

function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(js|mjs|cjs|json|html|rsc|txt)$/.test(e.name) ? [p] : [];
  });
}

const scanned = [...files(path.join(root, 'static')), ...files(path.join(root, 'server'))];
const problems = [];
// An empty scan proves nothing: fail on it (a wrong path, a build that didn't run)
if (scanned.length < 20) problems.push(`only ${scanned.length} files found under ${root}/static and /server`);
for (const file of scanned) {
  const text = fs.readFileSync(file, 'utf8');
  const match = FORBIDDEN.exec(text);
  if (match) problems.push(`${path.relative(root, file)}: "${text.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, ' ')}"`);
}
const manifest = path.join(root, 'routes-manifest.json');
if (!fs.existsSync(manifest)) problems.push('routes-manifest.json is missing');
else {
  const { rewrites } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const count = Array.isArray(rewrites) ? rewrites.length
    : ['beforeFiles', 'afterFiles', 'fallback'].reduce((n, k) => n + (rewrites?.[k]?.length ?? 0), 0);
  if (count > 0) problems.push(`the build has ${count} rewrites (they belong to next dev only)`);
}

if (problems.length) {
  console.error(`Production build check failed (${scanned.length} files):\n  ${problems.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log(`Production build check: ${scanned.length} files, no localhost backend address, no rewrites`);
