import { NormalizedTick } from "@forexedge/kafka";

// This is the contract every provider must fulfill.
// market-service never talks to providers directly —
// it only talks to this interface.
export interface IForexStreamProvider {
  connect(
    instruments: string[],
    onTick: (tick: NormalizedTick) => void,
    onError: (err: Error) => void,
  ): Promise<void>;

  disconnect(): Promise<void>;

  isConnected(): boolean;

  readonly providerName: string;
}

// Injection token — used instead of the interface name
// because TypeScript interfaces don't exist at runtime
export const STREAM_PROVIDER = 'STREAM_PROVIDER';

// The configured MARKET_FEED (libs/common market-feed.ts), injected next to the provider.
export const MARKET_FEED_SETTING = 'MARKET_FEED_SETTING';
