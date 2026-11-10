// GET /health/ready: the frontend server has no dependency of its own (pages call the APIs from the
// browser, through the same origin), so ready means the server answers, as /health/live.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', checks: {} }, { headers: { 'Cache-Control': 'no-store' } });
}
