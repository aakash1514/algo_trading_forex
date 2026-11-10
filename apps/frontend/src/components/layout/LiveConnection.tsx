'use client';

import { useForexSocket } from '../../hooks/useForexSocket';

// The one ws-gateway connection for every signed-in page (prices, positions, account and the feed
// status the Topbar's dot shows). It lives in the dashboard layout, not in a page, so moving between
// pages keeps it open and the dot is real on every page.
export function LiveConnection() {
  useForexSocket();
  return null;
}
