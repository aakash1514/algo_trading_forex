import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SubmitOrderDto } from './submit-order.dto';

// Same options as the global pipe in main.ts.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validate = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: SubmitOrderDto });

const valid = { instrument: 'EUR_USD', direction: 'LONG', orderType: 'MARKET', lots: 0.1 };

async function rejection(body: Record<string, unknown>): Promise<string[]> {
  try {
    await validate(body);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as unknown as string[];
  }
  throw new Error('expected validation to fail');
}

const messages = async (body: Record<string, unknown>) =>
  ((await rejection(body)) as unknown as { message: string[] }).message.join(' | ');

describe('SubmitOrderDto validation', () => {
  it('accepts a minimal market order', async () => {
    await expect(validate(valid)).resolves.toBeInstanceOf(SubmitOrderDto);
  });

  it('accepts optional numeric SL/TP', async () => {
    await expect(validate({ ...valid, stopLoss: 1.08, takeProfit: 1.1 })).resolves.toMatchObject({
      stopLoss: 1.08,
      takeProfit: 1.1,
    });
  });

  it.each(['EUR/USD', 'EURUSD', 'eur_usd'])('rejects instrument %p', async (instrument) => {
    expect(await messages({ ...valid, instrument })).toContain('instrument must look like EUR_USD');
  });

  it.each(['BUY', 'SELL', 'long'])('rejects direction %p', async (direction) => {
    expect(await messages({ ...valid, direction })).toContain('direction');
  });

  it('rejects an unknown order type', async () => {
    expect(await messages({ ...valid, orderType: 'ICEBERG' })).toContain('orderType');
  });

  it.each([0, 0.001, 100.01, -1])('rejects lots %p', async (lots) => {
    expect(await messages({ ...valid, lots })).toContain('lots');
  });

  it('rejects non-numeric stop loss / take profit', async () => {
    const msg = await messages({ ...valid, stopLoss: 'abc', takeProfit: null as unknown as number });
    expect(msg).toContain('stopLoss');
  });

  it('rejects a client-supplied pair (derived server-side)', async () => {
    expect(await messages({ ...valid, pair: 'EUR/USD' })).toContain('property pair should not exist');
  });
});
