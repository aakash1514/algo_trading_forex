import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { NormalizedTick } from '@forexedge/kafka';
import { IForexStreamProvider } from '../interfaces/stream-provider.interface';

// This is the real OANDA implementation.
// Not used: no MARKET_FEED value selects it (there is no OANDA access).
export class OandaStreamProvider implements IForexStreamProvider {
  readonly providerName = 'OANDA';
  private readonly logger = new Logger(OandaStreamProvider.name);
  private connected = false;
  private abortController: AbortController | null = null;

  // OANDA practice (paper) streaming base URL
  private readonly baseUrl = 'https://stream-fxtrade.oanda.com';

  constructor(private readonly config: ConfigService) {}

  async connect(
    instruments: string[],
    onTick: (tick: NormalizedTick) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const apiKey = this.config.get<string>('OANDA_API_KEY');
    const accountId = this.config.get<string>('OANDA_ACCOUNT_ID');

    if (!apiKey || !accountId) {
      throw new Error('OANDA_API_KEY and OANDA_ACCOUNT_ID must be set in .env');
    }

    // OANDA expects instruments as comma-separated EUR_USD,GBP_USD,...
    const instrumentList = instruments.join(',');
    const url = `${this.baseUrl}/v3/accounts/${accountId}/pricing/stream?instruments=${instrumentList}`;

    this.abortController = new AbortController();
    this.connected = true;

    this.logger.log(`Connecting to OANDA stream for ${instruments.length} instruments`);

    try {
      // OANDA streaming API uses Server-Sent Events (SSE)
      // Each line of the response is a complete JSON object
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        responseType: 'stream',
        signal: this.abortController.signal,
      });

      // Process the stream line by line
      response.data.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const raw = JSON.parse(line);

            // OANDA also sends HEARTBEAT messages every 5 seconds
            // We ignore those and only process PRICE ticks
            if (raw.type !== 'PRICE') continue;
            if (!raw.tradeable) continue;

            const tick = this.normalize(raw);
            onTick(tick);
          } catch {
            // Skip malformed lines — OANDA stream occasionally sends
            // partial JSON at chunk boundaries
          }
        }
      });

      response.data.on('error', (err: Error) => {
        this.connected = false;
        onError(err);
      });

      response.data.on('end', () => {
        this.connected = false;
        this.logger.warn('OANDA stream ended — connection closed by server');
      });

    } catch (err) {
      this.connected = false;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.connected = false;
    this.logger.log('OANDA stream disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Convert OANDA's RawTick format to our NormalizedTick
  private normalize(raw: any): NormalizedTick {
    const bid = parseFloat(raw.bids[0].price);
    const ask = parseFloat(raw.asks[0].price);
    const mid = parseFloat(((bid + ask) / 2).toFixed(6));
    const spread = parseFloat((ask - bid).toFixed(6));
    const pair = raw.instrument.replace('_', '/');

    return {
      pair,
      instrument: raw.instrument,
      bid,
      ask,
      mid,
      spread,
      timestamp: new Date(raw.time),
      source: 'OANDA',
    };
  }
}