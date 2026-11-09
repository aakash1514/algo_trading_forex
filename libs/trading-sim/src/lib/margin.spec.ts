// Margin on real prices: the H1 ask opens of the money spec's trades (real Dukascopy
// bars), contract specs as in the instruments seed.
import { marginRequiredUsd, quoteToUsdRate } from '@forexedge/common/money';
import { checkMargin, DEFAULT_ACCOUNT_LEVERAGE, marginRequiredCents } from './margin';

const FX = { lotSize: 100_000, pipSize: 0.0001, maxLeverage: null };
const JPY = { lotSize: 100_000, pipSize: 0.01, maxLeverage: null };
const GOLD = { lotSize: 100, pipSize: 0.01, maxLeverage: 20 };

describe('margin (the live order-service formula)', () => {
  it('EUR/USD 0.1 lot at 1.13030, 1:100: 10,000 x 1.1303 / 100 = $113.03', () => {
    expect(marginRequiredCents({ pair: 'EUR/USD', lots: 0.1, spec: FX, pricePoints: 113030, priceDecimals: 5 })).toBe(11303n);
  });

  it('USD/JPY 0.1 lot: the base is USD, so 10,000 / 100 = $100.00 at any price', () => {
    expect(marginRequiredCents({ pair: 'USD/JPY', lots: 0.1, spec: JPY, pricePoints: 114929, priceDecimals: 3 })).toBe(10000n);
  });

  it('XAU/USD 0.1 lot (10 oz) at 1812.805, capped at 1:20: 10 x 1812.805 / 20 = $906.40', () => {
    // 906.4025 -> 906.40
    expect(marginRequiredCents({ pair: 'XAU/USD', lots: 0.1, spec: GOLD, pricePoints: 1812805, priceDecimals: 3 })).toBe(90640n);
  });

  it('is exactly marginRequiredUsd from @forexedge/common/money, in cents', () => {
    const price = 1.1303;
    expect(marginRequiredCents({ pair: 'EUR/USD', lots: 2.5, spec: FX, pricePoints: 113030, priceDecimals: 5 }))
      .toBe(BigInt(Math.round(marginRequiredUsd(2.5, FX, price, quoteToUsdRate('EUR/USD', price), DEFAULT_ACCOUNT_LEVERAGE) * 100)));
  });

  it('fits when required <= equity - margin in use', () => {
    expect(checkMargin(11303n, 1_000_000n, 988_697n)).toEqual({ ok: true, requiredCents: 11303n, freeCents: 11303n });
    expect(checkMargin(11304n, 1_000_000n, 988_697n).ok).toBe(false);
    expect(checkMargin(1n, -500n, 0n).ok).toBe(false);
  });
});
