'use client';

import { useGetFeedStatusQuery } from '../../store/api/market.api';
import { feedBanner } from '../../lib/feed';
import { cn } from '../../lib/cn';

export const FEED_STATUS_POLL_MS = 5_000;

const TONES = {
  neutral: 'border-terminal-border bg-terminal-elevated text-[#e2e4e9]',
  simulated: 'border-yellow-400/40 bg-yellow-400/10 text-yellow-300',
  warning: 'border-accent-red/40 bg-accent-red/10 text-accent-red',
} as const;

// Which market feed the terminal is on: none (the default), simulated, or a failing one.
export function FeedBanner() {
  const { data, isError } = useGetFeedStatusQuery(undefined, { pollingInterval: FEED_STATUS_POLL_MS });
  const banner = feedBanner(data, isError);
  if (!banner) return null;
  return (
    <div
      role="status"
      data-testid="feed-banner"
      className={cn('shrink-0 border-b px-4 py-2 text-[12px] font-medium', TONES[banner.tone])}
    >
      {banner.text}
    </div>
  );
}
