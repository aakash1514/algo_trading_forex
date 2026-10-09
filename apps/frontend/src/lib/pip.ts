// Pip size per instrument. Mirrors instruments.pip_size in the DB, which is what
// domain-service's pip calculator reads: 0.01 when JPY is the quote currency,
// 0.0001 otherwise. Metals follow OANDA's convention (XAU_USD pipLocation -2).
const DEFAULT_PIP_SIZE = 0.0001;
const JPY_QUOTE_PIP_SIZE = 0.01;
const PIP_SIZE_OVERRIDES: Record<string, number> = {
  XAU_USD: 0.01,
};

// Accepts both EUR_USD (frontend/socket) and EUR/USD (DB/REST) formats.
function toInstrument(pair: string): string {
  return pair.trim().toUpperCase().replace('/', '_');
}

export function getPipSize(pair: string): number {
  const instrument = toInstrument(pair);
  const override = PIP_SIZE_OVERRIDES[instrument];
  if (override !== undefined) return override;
  return instrument.endsWith('_JPY') ? JPY_QUOTE_PIP_SIZE : DEFAULT_PIP_SIZE;
}

// Converts a price difference (e.g. a spread or a move) into pips.
export function priceToPips(priceDelta: number, pair: string): number {
  return priceDelta / getPipSize(pair);
}

// Quote precision: one digit past the pip (fractional pip), e.g. 1.08345 / 151.234.
export function getPriceDecimals(pair: string): number {
  return Math.round(-Math.log10(getPipSize(pair))) + 1;
}
