import { MarginEngineService } from './margin-engine.service';
import { PipCalculatorService } from '../pip-calculator/pip-calculator.service';

const SPECS: Record<string, { lotSize: number; pipSize: number }> = {
  'EUR/USD': { lotSize: 100_000, pipSize: 0.0001 },
  'USD/JPY': { lotSize: 100_000, pipSize: 0.01 },
  'EUR/GBP': { lotSize: 100_000, pipSize: 0.0001 },
  'XAU/USD': { lotSize: 100, pipSize: 0.01 },
};

// quote->USD as PipCalculatorService resolves it (GBP via live GBP/USD 1.27)
const QUOTE_TO_USD: Record<string, (price: number) => number> = {
  'EUR/USD': () => 1,
  'USD/JPY': (price) => 1 / price,
  'EUR/GBP': () => 1.27,
  'XAU/USD': () => 1,
};

describe('domain MarginEngineService.calculateMarginRequired', () => {
  const pipCalculator = {
    getContractSpec: jest.fn(async (pair: string) => SPECS[pair]),
    getQuoteToUsd: jest.fn(async (pair: string, price: number) => QUOTE_TO_USD[pair](price)),
  };
  const engine = new MarginEngineService(pipCalculator as unknown as PipCalculatorService);

  // Hand-calculated at 1.00 lot, 100:1
  it.each([
    ['EUR/USD', 1.085, 1085],
    ['USD/JPY', 150, 1000],
    ['EUR/GBP', 0.85, 1079.5],
    ['XAU/USD', 2400, 2400],
  ])('%s @ %d needs $%d', async (pair, price, expected) => {
    await expect(engine.calculateMarginRequired(pair, 1, 100, price)).resolves.toMatchObject({
      pair, marginRequired: expected, currency: 'USD',
    });
  });
});
