import {
  effectiveLeverage, marginRequiredUsd, pipValueUsd, pipsBetween, priceDecimals, quoteToUsdRate, type ContractSpec,
} from './money';

// Specs as the instruments rows define them (max_leverage null = no cap).
const FX: ContractSpec = { lotSize: 100_000, pipSize: 0.0001, maxLeverage: null };
const FX_JPY: ContractSpec = { lotSize: 100_000, pipSize: 0.01, maxLeverage: null };
const GOLD: ContractSpec = { lotSize: 100, pipSize: 0.01, maxLeverage: 20 }; // XAU/USD: 100 oz, pip 0.01, 1:20

// All expected values below are hand-calculated with a 100:1 account, 1.00 lot.
describe('money math', () => {
  describe('EUR/USD @ 1.0850 (USD quote)', () => {
    const q = quoteToUsdRate('EUR/USD', 1.085);
    it('quote->USD is 1', () => expect(q).toBe(1));
    it('margin = 100,000 x 1.0850 / 100 = 1,085.00', () => expect(marginRequiredUsd(1, FX, 1.085, q, 100)).toBe(1085));
    it('pip value = 100,000 x 0.0001 = 10.00', () => expect(pipValueUsd(1, FX, q)).toBe(10));
  });

  describe('USD/JPY @ 150.00 (USD base)', () => {
    const q = quoteToUsdRate('USD/JPY', 150);
    it('margin = 100,000 USD / 100 = 1,000.00', () => expect(marginRequiredUsd(1, FX_JPY, 150, q, 100)).toBe(1000));
    it('pip value = 100,000 x 0.01 / 150 = 6.6667', () => expect(pipValueUsd(1, FX_JPY, q)).toBe(6.6667));
    it('0.1 lot needs 100.00 margin (the old formula gave 15,000)', () =>
      expect(marginRequiredUsd(0.1, FX_JPY, 150, q, 100)).toBe(100));
  });

  describe('EUR/GBP @ 0.8500 with GBP/USD 1.2700 (cross)', () => {
    const q = quoteToUsdRate('EUR/GBP', 0.85, 1.27);
    it('margin = 100,000 x 0.85 x 1.27 / 100 = 1,079.50', () => expect(marginRequiredUsd(1, FX, 0.85, q, 100)).toBe(1079.5));
    it('pip value = 100,000 x 0.0001 x 1.27 = 12.70', () => expect(pipValueUsd(1, FX, q)).toBe(12.7));
    it('requires a cross rate', () => expect(() => quoteToUsdRate('EUR/GBP', 0.85)).toThrow(/GBP->USD/));
  });

  describe('XAU/USD @ 2,400.00 (100 oz contract, capped at 1:20)', () => {
    const q = quoteToUsdRate('XAU/USD', 2400);
    it('margin = 100 oz x 2,400 / 20 = 12,000.00 (the 1:100 account is capped)', () =>
      expect(marginRequiredUsd(1, GOLD, 2400, q, 100)).toBe(12000));
    it('pip value = 100 x 0.01 = 1.00', () => expect(pipValueUsd(1, GOLD, q)).toBe(1));
    it('a $3.50 move is 350 pips', () => expect(pipsBetween('LONG', 2400, 2403.5, GOLD)).toBe(350));
  });

  describe('XAU/USD 0.1 lot at an ask of 1,824.25', () => {
    const q = quoteToUsdRate('XAU/USD', 1824.25);
    it('margin = 10 oz x 1,824.25 / 20 = 912.125 -> 912.13 (half up)', () =>
      expect(marginRequiredUsd(0.1, GOLD, 1824.25, q, 100)).toBe(912.13));
    it('pip value = 10 oz x 0.01 = 0.10', () => expect(pipValueUsd(0.1, GOLD, q)).toBe(0.1));
  });

  describe('effectiveLeverage', () => {
    it('applies the account leverage when the instrument has no cap', () => expect(effectiveLeverage(100, null)).toBe(100));
    it('caps at the instrument maximum', () => expect(effectiveLeverage(100, 20)).toBe(20));
    it('never raises the account leverage', () => expect(effectiveLeverage(30, 50)).toBe(30));
    it('leaves uncapped FX margin unchanged (EUR/USD 1 lot at 1.0850 = 1,085.00)', () =>
      expect(marginRequiredUsd(1, FX, 1.085, 1, 100)).toBe(1085));
  });

  describe('pipsBetween', () => {
    it('is positive when a LONG gains', () => expect(pipsBetween('LONG', 1.08, 1.081, FX)).toBe(10));
    it('is positive when a SHORT gains', () => expect(pipsBetween('SHORT', 150.5, 150.2, FX_JPY)).toBe(30));
  });

  it('priceDecimals is pip decimals + 1', () => {
    expect(priceDecimals(FX)).toBe(5);
    expect(priceDecimals(FX_JPY)).toBe(3);
    expect(priceDecimals(GOLD)).toBe(3);
  });
});
