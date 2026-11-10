import { Injectable } from '@nestjs/common';
import {
  feedDisplayState, lastTickAgeMs, LastTick, parseFeedLiveMaxAgeMs, parseMarketFeed,
} from '@forexedge/common';
import type { FeedStatusEvent } from '@forexedge/kafka';

// What the terminal's status dot shows: the configured feed (MARKET_FEED) and the newest tick this
// gateway relayed (forex.ticks). Green only for a real feed with a real tick younger than
// FEED_LIVE_MAX_AGE_S (default 10 s). Both settings are read at startup; a bad value fails it.
@Injectable()
export class FeedStatusService {
  readonly feed = parseMarketFeed(process.env.MARKET_FEED);
  readonly liveMaxAgeMs = parseFeedLiveMaxAgeMs(process.env.FEED_LIVE_MAX_AGE_S);
  now: () => number = () => Date.now();
  private last: LastTick | null = null;

  tickReceived(tick: LastTick): void {
    const at = new Date(tick.timestamp).getTime();
    if (!Number.isFinite(at)) return;
    // ticks of several pairs interleave: keep the newest, so a late older one can't age the feed
    if (this.last && new Date(this.last.timestamp).getTime() >= at) return;
    this.last = { timestamp: tick.timestamp, source: tick.source };
  }

  status(): FeedStatusEvent {
    const now = this.now();
    return { state: feedDisplayState(this.feed, this.last, now, this.liveMaxAgeMs), lastTickAgeMs: lastTickAgeMs(this.last, now) };
  }
}
