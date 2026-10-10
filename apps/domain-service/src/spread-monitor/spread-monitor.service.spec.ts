import type { SpreadAlertMessage } from '@forexedge/kafka';
import { SpreadMonitorService } from './spread-monitor.service';

// Ticks arrive exactly as market-service publishes them on forex.ticks.
const tick = (bid: number, ask: number, pair = 'XAU/USD') => JSON.stringify({
  pair, instrument: pair.replace('/', '_'), bid, ask, mid: (bid + ask) / 2, spread: ask - bid,
  timestamp: '2026-10-10T12:00:00.000Z', source: 'MOCK',
});

describe('SpreadMonitorService', () => {
  // instruments rows: XAU/USD avg_spread 0.368 (price units); a row without one
  const rows: Record<string, { pair: string; avgSpread: number | null }> = {
    'XAU/USD': { pair: 'XAU/USD', avgSpread: 0.368 },
    'USD/SGD': { pair: 'USD/SGD', avgSpread: null },
  };
  const instrumentRepo = { findOne: jest.fn(async ({ where }: { where: { pair: string } }) => rows[where.pair] ?? null) };
  const publish = jest.fn().mockResolvedValue(undefined);
  let onTick: (topic: string, partition: number, message: string) => Promise<void>;

  beforeEach(async () => {
    publish.mockClear();
    const kafkaConsumer = { subscribe: jest.fn(async (_group, _topics, handler) => { onTick = handler; }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new SpreadMonitorService(instrumentRepo as any, { publish } as any, kafkaConsumer as any);
    await service.onModuleInit();
    expect(kafkaConsumer.subscribe).toHaveBeenCalledWith('domain-service-spread-monitor', ['forex.ticks'], expect.any(Function));
  });

  it('publishes the shared SpreadAlertMessage shape on the first tick and on each status change', async () => {
    await onTick('forex.ticks', 0, tick(1823.463, 1824.199)); // exactly 2x: NORMAL (strict rule)
    await onTick('forex.ticks', 0, tick(1823.463, 1824.150)); // still NORMAL: no new alert
    await onTick('forex.ticks', 0, tick(1823.463, 1824.20268)); // 2.01x: WIDE

    expect(publish).toHaveBeenCalledTimes(2);
    const [topic, key, first] = publish.mock.calls[0] as [string, string, SpreadAlertMessage];
    expect(topic).toBe('forex.spread-alerts');
    expect(key).toBe('XAU_USD');
    expect(first).toEqual({
      type: 'NORMAL', instrument: 'XAU_USD', pair: 'XAU/USD',
      currentSpread: expect.closeTo(0.736, 9), avgSpread: 0.368, ratio: 2,
      timestamp: '2026-10-10T12:00:00.000Z',
    });
    expect((publish.mock.calls[1][2] as SpreadAlertMessage)).toMatchObject({ type: 'WIDE', ratio: 2.01 });
  });

  it('publishes nothing for an instrument without an average spread', async () => {
    await onTick('forex.ticks', 0, tick(1.3450, 1.3455, 'USD/SGD'));
    expect(publish).not.toHaveBeenCalled();
  });
});
