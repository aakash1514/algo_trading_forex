import type { KafkaProducerService, NormalizedTick } from '@forexedge/kafka';
import { StreamService } from './stream.service';
import { createStreamProvider } from './stream.module';
import type { IForexStreamProvider } from './interfaces/stream-provider.interface';
import type { InstrumentRepository } from '../market/instrument.repository';
import { DOWN_AFTER_FAILURES, MAX_RETRY_MS, retryDelayMs } from './feed-status';

// Real ticks as market-service published them (Redis price:last:*, recorded 2026-10-10).
const RECORDED: NormalizedTick[] = [
  { pair: 'EUR/USD', instrument: 'EUR_USD', bid: 1.08521, ask: 1.08533, mid: 1.08527, spread: 0.00012,
    timestamp: new Date('2026-10-10T17:54:09.191Z'), source: 'MOCK' },
  { pair: 'USD/JPY', instrument: 'USD_JPY', bid: 148.662, ask: 148.68, mid: 148.671, spread: 0.018,
    timestamp: new Date('2026-10-10T17:54:09.191Z'), source: 'MOCK' },
];

// A provider double whose connect results and callbacks the test drives.
class ScriptedProvider implements IForexStreamProvider {
  readonly providerName = 'SCRIPTED';
  onTick: ((t: NormalizedTick) => void) | null = null;
  onError: ((e: Error) => void) | null = null;
  connectResults: Array<Error | null> = [];
  connects = 0;
  disconnects = 0;
  async connect(_i: string[], onTick: (t: NormalizedTick) => void, onError: (e: Error) => void): Promise<void> {
    this.connects++;
    const result = this.connectResults.shift() ?? null;
    if (result) throw result;
    this.onTick = onTick;
    this.onError = onError;
  }
  async disconnect(): Promise<void> {
    this.disconnects++;
  }
  isConnected(): boolean {
    return this.onTick !== null;
  }
}

function setup(provider: IForexStreamProvider | null, feed: 'none' | 'mock' = 'mock') {
  const kafka = { publishTick: jest.fn().mockResolvedValue(undefined) };
  const instruments = { findActiveInstruments: jest.fn().mockResolvedValue(['EUR_USD', 'USD_JPY']) };
  const service = new StreamService(
    provider, feed, kafka as unknown as KafkaProducerService, instruments as unknown as InstrumentRepository,
  );
  return { service, kafka, instruments };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('createStreamProvider', () => {
  it('builds no provider (and never the simulator) unless mock mode is explicitly configured', () => {
    const makeMock = jest.fn(() => new ScriptedProvider());
    expect(createStreamProvider('none', makeMock)).toBeNull();
    expect(makeMock).not.toHaveBeenCalled();
    expect(createStreamProvider('mock', makeMock)).toBeInstanceOf(ScriptedProvider);
    expect(makeMock).toHaveBeenCalledTimes(1);
  });
});

describe('StreamService', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-12T12:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  it('starts nothing with no feed configured and reports the feed as off', async () => {
    const { service, kafka, instruments } = setup(null, 'none');
    await service.onModuleInit();
    expect(instruments.findActiveInstruments).not.toHaveBeenCalled();
    expect(kafka.publishTick).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({ feed: 'none', source: null, simulated: false, state: 'off' });
  });

  it('publishes ticks while connected and reports the simulated feed', async () => {
    const provider = new ScriptedProvider();
    const { service, kafka } = setup(provider);
    await service.onModuleInit();
    expect(service.getStatus()).toMatchObject({ feed: 'mock', source: 'MOCK', simulated: true, state: 'connected' });
    for (const t of RECORDED) provider.onTick?.(t);
    await flush();
    expect(kafka.publishTick.mock.calls.map((c) => c[0])).toEqual(RECORDED);
    expect(service.getStatus().lastTickAt).toBe('2026-10-10T17:54:09.191Z');
  });

  it('on a provider error publishes nothing more, marks the feed degraded and reconnects with backoff', async () => {
    const provider = new ScriptedProvider();
    const { service, kafka } = setup(provider);
    await service.onModuleInit();
    const staleCallback = provider.onTick;

    provider.onError?.(new TypeError('socket hang up'));
    await flush();
    expect(service.getStatus()).toMatchObject({ state: 'degraded', lastError: 'TypeError' });
    expect(provider.disconnects).toBe(1);

    staleCallback?.(RECORDED[0]); // a late tick from the failed connection
    await flush();
    expect(kafka.publishTick).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(retryDelayMs(1) - 1);
    expect(provider.connects).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(provider.connects).toBe(2);
    expect(service.getStatus().state).toBe('connected');
    provider.onTick?.(RECORDED[1]);
    await flush();
    expect(kafka.publishTick).toHaveBeenCalledWith(RECORDED[1]);
  });

  it('goes down after repeated failures, keeps retrying at the capped backoff, never substitutes a provider', async () => {
    const provider = new ScriptedProvider();
    provider.connectResults = Array.from({ length: 10 }, () => new Error('quota exhausted'));
    const { service, kafka } = setup(provider);
    await service.onModuleInit();
    expect(service.getStatus().state).toBe('degraded');

    let waited = 0;
    for (let attempt = 1; attempt < DOWN_AFTER_FAILURES; attempt++) {
      waited += retryDelayMs(attempt);
      await jest.advanceTimersByTimeAsync(retryDelayMs(attempt));
    }
    expect(provider.connects).toBe(DOWN_AFTER_FAILURES);
    expect(service.getStatus()).toMatchObject({ state: 'down', lastError: 'Error', source: 'MOCK' });
    expect(retryDelayMs(20)).toBe(MAX_RETRY_MS);
    expect(waited).toBeGreaterThan(0);
    expect(kafka.publishTick).not.toHaveBeenCalled();
  });

  it('stops retrying on shutdown', async () => {
    const provider = new ScriptedProvider();
    provider.connectResults = [new Error('down')];
    const { service } = setup(provider);
    await service.onModuleInit();
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(MAX_RETRY_MS);
    expect(provider.connects).toBe(1);
  });
});
