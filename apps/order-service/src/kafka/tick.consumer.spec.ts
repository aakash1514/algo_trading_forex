import type { ConfigService } from '@nestjs/config';
import type { KafkaMessage } from 'kafkajs';
import { TickConsumer } from './tick.consumer';
import type { PositionService } from '../position/position.service';
import type { AccountService } from '../account/account.service';

// A forex.ticks message exactly as market-service publishes it
const message = (offset: number, pair: string, mid: number) => ({
  offset: String(offset), key: Buffer.from(pair.replace('/', '_')), timestamp: '0', attributes: 0, headers: {},
  value: Buffer.from(JSON.stringify({
    pair, instrument: pair.replace('/', '_'), bid: mid - 0.0001, ask: mid + 0.0001, mid, spread: 0.0002,
    timestamp: '2026-10-09T14:00:00.000Z', source: 'MOCK',
  })),
}) as KafkaMessage;

describe('TickConsumer.handleBatch', () => {
  const processTicks = jest.fn();
  const checkMarginCall = jest.fn();
  const config = { get: jest.fn((_k: string, d: string) => d) } as unknown as ConfigService;
  const consumer = new TickConsumer(
    config,
    { processTicks } as unknown as PositionService,
    { checkMarginCall } as unknown as AccountService,
  );
  const heartbeat = jest.fn();

  afterEach(() => jest.clearAllMocks());

  it('hands the whole batch to processTicks once, in feed order, then checks margin once per affected user', async () => {
    processTicks.mockResolvedValue(new Set(['user-1', 'user-2']));
    const messages = [message(10, 'EUR/USD', 1.0810), message(11, 'XAU/USD', 1823.5), message(12, 'EUR/USD', 1.0812)];

    await consumer.handleBatch({ batch: { messages, highWatermark: '13' } as never, heartbeat });

    expect(processTicks).toHaveBeenCalledTimes(1);
    expect(processTicks.mock.calls[0][0].map((t: { pair: string; mid: number }) => [t.pair, t.mid]))
      .toEqual([['EUR/USD', 1.0810], ['XAU/USD', 1823.5], ['EUR/USD', 1.0812]]);
    expect(checkMarginCall.mock.calls).toEqual([['user-1'], ['user-2']]);
    expect(heartbeat).toHaveBeenCalled();
  });

  it('skips an unparseable message instead of dropping the batch', async () => {
    processTicks.mockResolvedValue(new Set());
    const bad = { ...message(20, 'EUR/USD', 1.081), value: Buffer.from('{not json') };

    await consumer.handleBatch({ batch: { messages: [bad, message(21, 'EUR/USD', 1.0811)], highWatermark: '22' } as never, heartbeat });

    expect(processTicks.mock.calls[0][0]).toHaveLength(1);
  });

  it('keeps consuming when processing fails (the error is logged, the batch still resolves)', async () => {
    processTicks.mockRejectedValue(new Error('db down'));
    await expect(consumer.handleBatch({ batch: { messages: [message(30, 'EUR/USD', 1.081)], highWatermark: '31' } as never, heartbeat }))
      .resolves.toBeUndefined();
    expect(heartbeat).toHaveBeenCalled();
  });
});
