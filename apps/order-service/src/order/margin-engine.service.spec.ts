import { MarginEngineService } from './margin-engine.service';
import { PricingService } from '../pricing/pricing.service';

const account = (overrides: Partial<{ balance: number; unrealizedPnl: number; marginUsed: number; leverage: number }> = {}) => ({
  balance: 10_000, unrealizedPnl: 0, marginUsed: 0, leverage: 100, ...overrides,
});

function makeEngine(row: ReturnType<typeof account> | null) {
  const accountRepo = { findOne: jest.fn().mockResolvedValue(row) };
  const redis = { get: jest.fn().mockResolvedValue(null) };
  const instrumentRepo = {
    findOne: jest.fn(async ({ where }: { where: { pair: string } }) => ({
      'USD/JPY': { pair: 'USD/JPY', lotSize: 100_000, pipSize: 0.01, maxLeverage: null },
      'EUR/USD': { pair: 'EUR/USD', lotSize: 100_000, pipSize: 0.0001, maxLeverage: null },
    })[where.pair] ?? null),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pricing = new PricingService(redis as any, instrumentRepo as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new MarginEngineService(accountRepo as any, pricing);
}

describe('MarginEngineService.canOpenPosition', () => {
  it('rejects a market order when free margin is insufficient', async () => {
    // equity 10,000 - 300 = 9,700; used 9,650 -> free 50; 0.1 lot USD/JPY needs 100.00
    const engine = makeEngine(account({ unrealizedPnl: -300, marginUsed: 9_650 }));
    const result = await engine.canOpenPosition('user-1', 'USD/JPY', 0.1, 150);
    expect(result).toEqual({ valid: false, reason: 'Insufficient margin: need $100.00, free margin $50.00' });
  });

  it('accepts when free margin covers the requirement', async () => {
    const engine = makeEngine(account({ marginUsed: 9_850 })); // free 150
    await expect(engine.canOpenPosition('user-1', 'USD/JPY', 0.1, 150)).resolves.toEqual({ valid: true });
  });

  it('values the order at the entry price it is given (not 0)', async () => {
    // 1 lot EUR/USD @ 1.0851 needs 1,085.10; free margin 1,000
    const engine = makeEngine(account({ marginUsed: 9_000 }));
    const result = await engine.canOpenPosition('user-1', 'EUR/USD', 1, 1.0851);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('need $1085.10');
  });

  it('rejects when the account does not exist', async () => {
    const engine = makeEngine(null);
    await expect(engine.canOpenPosition('user-1', 'EUR/USD', 1, 1.0851)).resolves.toMatchObject({ valid: false });
  });
});
