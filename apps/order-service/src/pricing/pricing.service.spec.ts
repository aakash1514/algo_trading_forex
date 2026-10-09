import { PricingService, PriceUnavailableError } from './pricing.service';

// Instruments rows as stored in the DB (slash pair format, NUMERIC as numbers).
const INSTRUMENTS: Record<string, { pair: string; lotSize: number; pipSize: number }> = {
  'EUR/USD': { pair: 'EUR/USD', lotSize: 100_000, pipSize: 0.0001 },
  'USD/JPY': { pair: 'USD/JPY', lotSize: 100_000, pipSize: 0.01 },
  'EUR/GBP': { pair: 'EUR/GBP', lotSize: 100_000, pipSize: 0.0001 },
  // Not seeded yet (roadmap step 2); proves metals need only a DB row.
  'XAU/USD': { pair: 'XAU/USD', lotSize: 100, pipSize: 0.01 },
};

// Redis price values as market-service writes them (underscore keys).
const PRICES: Record<string, { bid: number; ask: number; mid: number }> = {
  'price:EUR_USD': { bid: 1.0849, ask: 1.0851, mid: 1.085 },
  'price:USD_JPY': { bid: 149.99, ask: 150.01, mid: 150 },
  'price:EUR_GBP': { bid: 0.8499, ask: 0.8501, mid: 0.85 },
  'price:GBP_USD': { bid: 1.2699, ask: 1.2701, mid: 1.27 },
  'price:XAU_USD': { bid: 2399.9, ask: 2400.1, mid: 2400 },
};

function makeService(prices = PRICES) {
  const redis = { get: jest.fn(async (key: string) => (prices[key] ? JSON.stringify(prices[key]) : null)) };
  const instrumentRepo = { findOne: jest.fn(async ({ where }: { where: { pair: string } }) => INSTRUMENTS[where.pair] ?? null) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new PricingService(redis as any, instrumentRepo as any);
  return { service, redis, instrumentRepo };
}

// Hand-calculated at 1.00 lot, 100:1 leverage.
describe('PricingService.valuePosition', () => {
  it('EUR/USD @ 1.0850: margin 1,085.00, pip 10.00', async () => {
    const { service } = makeService();
    await expect(service.valuePosition('EUR/USD', 1, 1.085, 100)).resolves.toMatchObject({
      units: 100_000, marginRequired: 1085, pipValue: 10,
    });
  });

  it('USD/JPY @ 150.00: margin 1,000.00, pip 6.6667', async () => {
    const { service } = makeService();
    await expect(service.valuePosition('USD/JPY', 1, 150, 100)).resolves.toMatchObject({
      marginRequired: 1000, pipValue: 6.6667,
    });
  });

  it('EUR/GBP @ 0.8500 converts via live GBP/USD 1.2700: margin 1,079.50, pip 12.70', async () => {
    const { service, redis } = makeService();
    await expect(service.valuePosition('EUR/GBP', 1, 0.85, 100)).resolves.toMatchObject({
      marginRequired: 1079.5, pipValue: 12.7, quoteToUsd: 1.27,
    });
    expect(redis.get).toHaveBeenCalledWith('price:GBP_USD');
  });

  it('falls back to the inverse USD/XXX pair for the cross rate', async () => {
    // CHF quote: no CHF/USD feed, only USD/CHF @ 0.8000 -> CHF->USD = 1.25
    const prices = { ...PRICES, 'price:USD_CHF': { bid: 0.7999, ask: 0.8001, mid: 0.8 } };
    const { service } = makeService(prices);
    INSTRUMENTS['EUR/CHF'] = { pair: 'EUR/CHF', lotSize: 100_000, pipSize: 0.0001 };
    await expect(service.valuePosition('EUR/CHF', 1, 0.95, 100)).resolves.toMatchObject({
      marginRequired: 1187.5, // 100,000 x 0.95 x 1.25 / 100
      pipValue: 12.5,
    });
  });

  it('XAU/USD @ 2,400 with a 100 oz contract from the DB: margin 2,400.00, pip 1.00', async () => {
    const { service } = makeService();
    await expect(service.valuePosition('XAU/USD', 1, 2400, 100)).resolves.toMatchObject({
      units: 100, marginRequired: 2400, pipValue: 1,
    });
  });

  it('caches contract specs (static reference data)', async () => {
    const { service, instrumentRepo } = makeService();
    await service.getSpec('EUR/USD');
    await service.getSpec('EUR/USD');
    expect(instrumentRepo.findOne).toHaveBeenCalledTimes(1);
  });
});

describe('PricingService.getQuote', () => {
  it('reads the underscore Redis key for a slash pair', async () => {
    const { service, redis } = makeService();
    await expect(service.getQuote('USD/JPY')).resolves.toEqual({ bid: 149.99, ask: 150.01, mid: 150 });
    expect(redis.get).toHaveBeenCalledWith('price:USD_JPY');
  });

  it('throws PriceUnavailableError when there is no live price', async () => {
    const { service } = makeService({});
    await expect(service.getQuote('EUR/USD')).rejects.toBeInstanceOf(PriceUnavailableError);
  });
});
