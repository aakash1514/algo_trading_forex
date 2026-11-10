// GET /health/live for the host's probes (outside /api, as every ForexEdge service): the Next.js
// server is up. No auth and nothing else in the body.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
