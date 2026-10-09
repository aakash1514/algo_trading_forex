import type { ValueTransformer } from 'typeorm';

// node-pg returns NUMERIC/DECIMAL columns as strings to avoid precision loss.
// Prices (scale 6) and money (scale 2) fit a JS double exactly enough for this
// app, and every API consumer expects numbers, so convert on read.
export const decimalTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};
