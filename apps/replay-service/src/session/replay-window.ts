// What a replay may start on: the imported history (2010-2022) for four pairs.
export const REPLAY_INSTRUMENTS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'XAU_USD'] as const;
export const REPLAY_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export const DEFAULT_STARTING_BALANCE = 10_000;

// Start times: whole UTC minutes from 2010-01-01 00:00 through 2022-12-30 23:59
export const FIRST_START = new Date('2010-01-01T00:00:00Z');
export const LAST_START = new Date('2022-12-30T23:59:00Z');

const START = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00(?:\.0{1,3})?)?Z$/;

// 'YYYY-MM-DDTHH:MMZ' (seconds, if any, must be :00) -> the instant; impossible
// dates (2022-02-30), other zones and times outside the window are rejected
export function parseStartTime(value: string): Date {
  const m = START.exec(value);
  if (!m) throw new Error('startTime must be a whole UTC minute, e.g. 2022-03-01T09:30Z');
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const time = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (time.getUTCFullYear() !== year || time.getUTCMonth() !== month - 1 || time.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error(`startTime ${value} is not a real date and time`);
  }
  if (time < FIRST_START || time > LAST_START) {
    throw new Error('startTime must be between 2010-01-01T00:00Z and 2022-12-30T23:59Z');
  }
  return time;
}

export const instrumentToPair = (instrument: string) => instrument.replace('_', '/');
export const pairToInstrument = (pair: string) => pair.replace('/', '_');
