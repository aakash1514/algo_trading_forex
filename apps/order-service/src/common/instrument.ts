// Instrument (OANDA format, e.g. EUR_USD) is the only symbol clients send.
// The DB, Kafka ticks and REST APIs use the slash pair format (EUR/USD), so
// every place order-service needs a pair derives it here.
export const INSTRUMENT_PATTERN = /^[A-Z]{3}_[A-Z]{3}$/;

export function instrumentToPair(instrument: string): string {
  if (!INSTRUMENT_PATTERN.test(instrument)) {
    throw new Error(`Invalid instrument "${instrument}" (expected e.g. EUR_USD)`);
  }
  return instrument.replace('_', '/');
}

// Base and quote currency of a slash-format pair, e.g. EUR/USD -> ['EUR', 'USD'].
export function pairCurrencies(pair: string): [string, string] {
  const [base, quote] = pair.split('/');
  return [base, quote];
}
